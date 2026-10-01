// Utilities → network access check (v1.0.36). Answers "can THIS host reach
// those ports?" for rules written the way firewall requests are:
//
//     10.64.48.180 -> 10.70.39.10:[22, 80, 443]/tcp
//     10.64.48.180 -> [10.70.39.10, db.internal]:[5432, 8000-8010]
//     10.0.0.1 (gitlab) -> 10.0.0.5:[22, 8200] (vault)
//
// Rules are pasted from tickets, wikis and chats, which "improve" the text: an
// arrow becomes `—>` or `→`, gets a space inside (`- >`), the colon turns
// full-width. `normalizeRuleLine` folds those back before parsing, and a
// parenthesised note names the service on either side.
//
// Everything here is pure (INVARIANTS "чистая логика в .ts"): parsing the rules,
// building the POSIX script the SSH transport runs, parsing the line protocol
// both transports answer with, and the verdicts shown in the UI. The backend is a
// dumb executor (`netcheck_run`): on an SSH tab it runs `netcheckArgs(...)` on the
// server; on a local tab it does the TCP connects natively and prints the same
// protocol, so one parser serves both.
//
// Line protocol (tab-separated, one fact per line; `E` marks a complete run):
//   H  <hostname>                       the checking host
//   A  <ip>[/<prefix>]                  one of its addresses
//   C  <bash|nc|telnet|curl> <ok|missing|notimeout>   whether each probe tool is usable
//   M  <bash|nc|telnet|curl|native|none>  how ports are probed
//   D  <target> <ip or empty>           resolution (empty = failed)
//   S  <target> <src ip>                source address the route to target uses
//   R  <target> <port> <rc> <t0ns> <t1ns> <message>   raw remote attempt
//   N  <target> <port> <status> <ms> <detail>          native (already classified)
//   E                                   end of run

import { shellQuote } from "./probe";

export type Proto = "tcp" | "udp";

/** One parsed input line: from `source` (optional) to every target × port. */
export interface NetRule {
  /** 1-based line number in the input, for error/warning messages. */
  line: number;
  /** Source the user expects the traffic to come from (IP or hostname), if given. */
  source: string | null;
  /** `(gitlab)` written next to the source — a note, never part of the check. */
  sourceLabel?: string;
  targets: string[];
  /** `(vault)` written on the target side — a note, never part of the check. */
  label?: string;
  ports: number[];
  proto: Proto;
}

export interface ParseError {
  line: number;
  /** Stable error code — the UI localizes it (`util.netcheck.err.<code>`). */
  code: "syntax" | "host" | "unspecified" | "port" | "range" | "empty" | "tooMany";
  /** The offending token, for the message. */
  token: string;
}

/** Hard cap on connects per run — a typo like `1-65535` must not become a scan. */
export const MAX_CHECKS = 512;
/** Default per-connect timeout (seconds). */
export const DEFAULT_TIMEOUT_SECS = 3;
/** Parallel connects per batch (remote script and native side agree on this). */
export const BATCH = 32;

const ARROW = /\s*(?:->|=>|→)\s*/;

// Arrows a pasted rule arrives with: any dash (or `=`) run before `>`, spaces
// allowed inside (`- >`, `—>`, `==>`), and the single-glyph arrows editors and
// chat apps substitute. Folded to `->` before parsing.
const ARROW_VARIANTS = /\s*(?:[-‐‑‒–—―−]+\s*>|=+\s*>|[→⟶⟹⇒⇨➔➙➛➜➝➞➟➠➡➤⭢]\ufe0f?)\s*/g;

/**
 * Fold what tickets, wikis and chats do to a rule back into the canonical
 * syntax: arrows (`—>`, `- >`, `➜` → `->`), full-width punctuation (`：`, `，`,
 * `［］`, `（）`), exotic spaces (NBSP, thin, ideographic) and a trailing `.`/`;`.
 * Pure and idempotent; never changes a line that was already canonical.
 */
export function normalizeRuleLine(line: string): string {
  return line
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, " ")
    .replace(/[：꞉∶]/g, ":")
    .replace(/[，、]/g, ",")
    .replace(/［/g, "[")
    .replace(/］/g, "]")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(ARROW_VARIANTS, " -> ")
    .replace(/[.;,]+\s*$/, "")
    .trim();
}

/** Pull `(notes)` out of one side of a rule: the bare side + the joined notes. */
function takeLabels(side: string): { rest: string; label?: string } {
  const notes: string[] = [];
  const rest = side.replace(/\(([^()]*)\)/g, (_, note: string) => {
    if (note.trim()) notes.push(note.trim().replace(/\s+/g, " "));
    return " ";
  });
  return notes.length ? { rest, label: notes.join(", ") } : { rest };
}
// Hostnames and IPv4 only: the script embeds targets, so the alphabet is strict
// (quoted anyway). IPv6 would collide with the `host:port` syntax.
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isIpv4(s: string): boolean {
  return IPV4.test(s);
}

function validHost(s: string): boolean {
  // All-numeric dotted strings must be real IPv4 (`10.70.39.300` is a typo, not a name).
  if (/^[\d.]+$/.test(s)) return IPV4.test(s);
  return HOST.test(s);
}

/** Split a list written as `[a, b]`, `a, b` or `a b`. */
function splitList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expand `22`, `8000-8010` into ports; `null` on a bad token. */
function expandPort(tok: string): number[] | null {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(tok);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (a < 1 || b > 65535 || a > b) return null;
  const out: number[] = [];
  for (let p = a; p <= b && out.length <= MAX_CHECKS; p++) out.push(p);
  return out;
}

/**
 * Parse the rules box. Blank lines and `#` comments are skipped. Each rule is
 * `[SRC ->] TARGETS : PORTS [/tcp|/udp]`, where TARGETS/PORTS are a single item
 * or a `[..]`/comma list and ports may be ranges. Duplicates are dropped while
 * keeping order. Errors are per line so the rest still runs.
 */
export function parseRules(text: string): { rules: NetRule[]; errors: ParseError[] } {
  const rules: NetRule[] = [];
  const errors: ParseError[] = [];
  let total = 0;
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    const body = normalizeRuleLine(rawLine.replace(/#.*$/, ""));
    if (!body) return;
    const parts = body.split(ARROW);
    if (parts.length > 2) return void errors.push({ line, code: "syntax", token: body });
    const src = parts.length === 2 ? takeLabels(parts[0]) : null;
    const source = src ? src.rest.trim() : null;
    const dst = takeLabels(parts.length === 2 ? parts[1] : parts[0]);
    const rhs = dst.rest;
    if (source !== null && (!source || !validHost(source))) {
      return void errors.push({ line, code: "host", token: source });
    }
    const m = /^(.+?)\s*:\s*(\[[^\]]*\]|[\d\s,;-]+?)\s*(?:\/\s*(tcp|udp))?$/i.exec(rhs.trim());
    if (!m) return void errors.push({ line, code: "syntax", token: rhs.trim() });
    const targets = [...new Set(splitList(m[1]))];
    if (targets.length === 0) return void errors.push({ line, code: "empty", token: m[1] });
    const badHost = targets.find((h) => !validHost(h));
    if (badHost) return void errors.push({ line, code: "host", token: badHost });
    // `0.0.0.0` means "any address": a connect to it lands on the checking host
    // itself (Linux routes it to loopback), so an "open" would be about the wrong
    // machine. It's also the builder's placeholder — never let it through unfilled.
    const unspecified = targets.find((h) => h === "0.0.0.0");
    if (unspecified) return void errors.push({ line, code: "unspecified", token: unspecified });
    const portToks = splitList(m[2]);
    if (portToks.length === 0) return void errors.push({ line, code: "empty", token: m[2] });
    const ports: number[] = [];
    for (const tok of portToks) {
      const exp = expandPort(tok);
      if (!exp) {
        return void errors.push({ line, code: /-/.test(tok) ? "range" : "port", token: tok });
      }
      for (const p of exp) if (!ports.includes(p)) ports.push(p);
    }
    const proto = (m[3]?.toLowerCase() ?? "tcp") as Proto;
    // UDP rows are never connected (see `udp` status), so they don't count.
    const cost = proto === "tcp" ? targets.length * ports.length : 0;
    if (total + cost > MAX_CHECKS) {
      return void errors.push({ line, code: "tooMany", token: String(MAX_CHECKS) });
    }
    total += cost;
    const rule: NetRule = { line, source, targets, ports, proto };
    if (src?.label) rule.sourceLabel = src.label;
    if (dst.label) rule.label = dst.label;
    rules.push(rule);
  });
  return { rules, errors };
}

/** A host to probe with its ports — what the native transport receives. */
export interface NetTarget {
  host: string;
  ports: number[];
}

/**
 * Merge every TCP rule into unique host → ports, preserving first-seen order.
 * `only` restricts to `host:port` keys (the "retry unreachable" pass).
 */
export function checkTargets(rules: NetRule[], only?: Set<string>): NetTarget[] {
  const map = new Map<string, number[]>();
  for (const r of rules) {
    if (r.proto !== "tcp") continue;
    for (const h of r.targets) {
      for (const p of r.ports) {
        if (only && !only.has(checkKey(h, p))) continue;
        const list = map.get(h) ?? [];
        if (!list.includes(p)) list.push(p);
        map.set(h, list);
      }
    }
  }
  return [...map].map(([host, ports]) => ({ host, ports }));
}

export function checkKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/** The probe tools a server can be told to use, in "auto" preference order. */
export const PROBE_TOOLS = ["bash", "nc", "telnet", "curl"] as const;
export type ProbeTool = (typeof PROBE_TOOLS)[number];
/** What the user picked: a tool, or the first usable one. */
export type MethodChoice = "auto" | ProbeTool;
/** ok — usable. missing — not installed. notimeout — installed, but needs
 *  `timeout` to be bounded (bash, telnet) and there is none. */
export type ToolState = "ok" | "missing" | "notimeout";

export function isMethodChoice(v: unknown): v is MethodChoice {
  return v === "auto" || (PROBE_TOOLS as readonly unknown[]).includes(v);
}

/**
 * The method a run will use: the picked tool if it's usable, else "none" (never a
 * silent substitute); "auto" → the first usable in `PROBE_TOOLS` order, the same
 * rule the script applies. Null while the host hasn't reported its tools yet.
 */
export function effectiveMethod(
  choice: MethodChoice,
  tools: Partial<Record<ProbeTool, ToolState>>,
): ProbeTool | "none" | null {
  if (Object.keys(tools).length === 0) return null;
  if (choice === "auto") return PROBE_TOOLS.find((tool) => tools[tool] === "ok") ?? "none";
  return tools[choice] === "ok" ? choice : "none";
}

// Shell variable holding each tool's state in the script.
const TOOL_VAR: Record<ProbeTool, string> = { bash: "Cb", nc: "Cn", telnet: "Ct", curl: "Cc" };

/**
 * Build the argv for the SSH transport: one `sh -c` script that reports identity
 * (H/A), whether each probe tool is usable (C), the method it will use (M),
 * resolves each target and its route source (D/S), then probes ports in batches
 * of `BATCH` in parallel (R) and ends with E. `choice` "auto" takes the first
 * usable of `bash /dev/tcp` under `timeout` (on nearly every server, nothing to
 * install) → `nc -z` → `telnet` under `timeout` → `curl`; a named tool is used
 * only if usable — otherwise M is `none`, never a silent substitute. The script
 * only prints raw readings — rc, timestamps and the tool's own message; the
 * verdict (open / refused / timeout …) is `classifyAttempt`'s job here, where it's
 * tested. With no targets it is an identity probe (the header before the first run).
 */
export function netcheckArgs(
  targets: NetTarget[],
  timeoutSecs = DEFAULT_TIMEOUT_SECS,
  choice: MethodChoice = "auto",
): string[] {
  const T = Math.max(1, Math.min(30, Math.round(timeoutSecs)));
  const pick = isMethodChoice(choice) ? choice : "auto";
  const select =
    pick === "auto"
      ? PROBE_TOOLS.map(
          (tool, i) => `${i === 0 ? "if" : "elif"} [ "$${TOOL_VAR[tool]}" = ok ]; then M=${tool};`,
        ).join(" ") + " fi"
      : `[ "$${TOOL_VAR[pick]}" = ok ] && M=${pick}`;
  const lines: string[] = [
    `T=${T}`,
    `h=$(hostname 2>/dev/null || uname -n 2>/dev/null); printf 'H\\t%s\\n' "$h"`,
    `if command -v ip >/dev/null 2>&1; then ip -o addr show 2>/dev/null | awk '$3=="inet"||$3=="inet6"{print "A\\t" $4}';`,
    `else for a in $(hostname -I 2>/dev/null); do printf 'A\\t%s\\n' "$a"; done; fi`,
    // bash and telnet are only bounded under `timeout`; nc and curl bound themselves.
    `TO=; command -v timeout >/dev/null 2>&1 && TO=1`,
    `av() { if ! command -v "$1" >/dev/null 2>&1; then echo missing; elif [ -n "$2" ] && [ -z "$TO" ]; then echo notimeout; else echo ok; fi; }`,
    `Cb=$(av bash t); Cn=$(av nc); Ct=$(av telnet t); Cc=$(av curl)`,
    `printf 'C\\tbash\\t%s\\nC\\tnc\\t%s\\nC\\ttelnet\\t%s\\nC\\tcurl\\t%s\\n' "$Cb" "$Cn" "$Ct" "$Cc"`,
    `M=none`,
    select,
    `printf 'M\\t%s\\n' "$M"`,
    // A minimal curl build (curl-minimal, RHEL 9) has no telnet://; http:// connects
    // just the same, and the connect time is what's read either way.
    `CU=telnet; [ "$M" = curl ] && ! curl -V 2>/dev/null | grep -qw telnet && CU=http`,
    // BSD/macOS nc: -w does not bound the connect itself, -G does.
    `G=; [ "$M" = nc ] && nc -h 2>&1 | grep -q -- '-G' && G="-G $T"`,
  ];
  if (targets.length > 0) {
    lines.push(
      `now() { date +%s%N 2>/dev/null; }`,
      `chk() {`,
      `  s=$(now)`,
      `  case $M in`,
      `    bash) o=$(timeout $T bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>&1 </dev/null); r=$? ;;`,
      `    nc) o=$(nc -z -v -w $T $G "$1" "$2" 2>&1 </dev/null); r=$? ;;`,
      `    telnet) o=$(timeout $T telnet "$1" "$2" 2>&1 </dev/null); r=$? ;;`,
      // time_connect > 0 ⇔ the TCP handshake completed (the transfer after it may
      // then time out on a silent service — that's still "open").
      `    curl) o=$(curl -sS -o /dev/null -w 'TC=%{time_connect} ' --connect-timeout $T -m $T "$CU://$1:$2" 2>&1 </dev/null); r=$? ;;`,
      `    *) o=; r=127 ;;`,
      `  esac`,
      `  e=$(now)`,
      `  o=$(printf '%s' "$o" | tr '\\t\\r\\n' '   ' | cut -c1-240)`,
      `  printf 'R\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$r" "$s" "$e" "$o"`,
      `}`,
      `res() {`,
      `  a=$1`,
      `  case $1 in *[!0-9.]*)`,
      `    if command -v getent >/dev/null 2>&1; then a=$(getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'); printf 'D\\t%s\\t%s\\n' "$1" "$a"; else a=; fi ;;`,
      `  esac`,
      `  if [ -n "$a" ] && command -v ip >/dev/null 2>&1; then`,
      `    sr=$(ip route get "$a" 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')`,
      `    [ -n "$sr" ] && printf 'S\\t%s\\t%s\\n' "$1" "$sr"`,
      `  fi`,
      `}`,
    );
    for (const t of targets) lines.push(`res ${shellQuote(t.host)}`);
    let n = 0;
    for (const t of targets) {
      for (const p of t.ports) {
        lines.push(`chk ${shellQuote(t.host)} ${p} &`);
        if (++n % BATCH === 0) lines.push("wait");
      }
    }
    lines.push("wait");
  }
  lines.push(`printf 'E\\n'`);
  return ["sh", "-c", lines.join("\n")];
}

/** Exec budget for a run: every batch may wait the full timeout, plus slack. */
export function runBudgetSecs(checks: number, timeoutSecs = DEFAULT_TIMEOUT_SECS): number {
  return Math.ceil(checks / BATCH) * (timeoutSecs + 1) + 10;
}

export type Method = "bash" | "nc" | "telnet" | "curl" | "native" | "none";

/**
 * open — handshake completed. refused — the host answered with RST (reachable,
 * nothing listens). timeout — no answer (typically a firewall dropping packets).
 * unreachable — no route / host down (ICMP). dns — name didn't resolve.
 * error — something else, detail carries the tool's message. udp — not probed:
 * silence on UDP means nothing, so claiming "open" would be a lie (principle 5).
 * missing — no answer for this port in the output (the run was cut short).
 */
export type PortStatus =
  | "open"
  | "refused"
  | "timeout"
  | "unreachable"
  | "dns"
  | "error"
  | "udp"
  | "missing";

export interface PortResult {
  host: string;
  port: number;
  status: PortStatus;
  /** Connect time; null when unknown (e.g. busybox `date` without `%N`). */
  ms: number | null;
  detail: string;
}

export interface NetReport {
  hostname: string;
  /** Host addresses without the prefix length. */
  addrs: string[];
  method: Method | null;
  /** target → resolved IP; "" = resolution failed; missing = not checked. */
  resolved: Record<string, string>;
  /** target → source IP the kernel routes from. */
  routeSrc: Record<string, string>;
  results: PortResult[];
  /** False when the `E` marker never arrived — the output was cut short. */
  complete: boolean;
  /** Which probe tools the host can use (SSH only; the native transport has none). */
  tools: Partial<Record<ProbeTool, ToolState>>;
}

const DNS_RE = /Name or service not known|Unknown host|could not resolve|nodename nor servname|Temporary failure in name resolution|No address associated|getaddrinfo|bad address/i;
const UNREACH_RE = /No route to host|Network is unreachable|Host is unreachable|Network unreachable/i;
const TIMEOUT_RE = /timed out|TIMEOUT|Operation now in progress/i;

/**
 * Verdict for one raw remote attempt. `elapsedMs` catches tools that fail a
 * timed-out connect silently (some `nc` builds print nothing on `-w` expiry).
 */
export function classifyAttempt(
  method: Method | null,
  rc: number,
  msg: string,
  elapsedMs: number | null,
  timeoutSecs: number,
): PortStatus {
  if (method === "telnet") {
    if (/Connected to|Escape character/i.test(msg)) return "open";
  } else if (method === "curl") {
    // The handshake is the answer; whatever the service did after it (silence
    // until -m, a non-HTTP reply) doesn't make the port less open.
    if ((curlConnectSecs(msg) ?? 0) > 0) return "open";
    if (rc === 6) return "dns";
    if (rc === 28) return "timeout";
    // 7 = couldn't connect: newer curl no longer says "refused" — a route error
    // says so, anything else was an answer from the host (RST).
    if (rc === 7) return UNREACH_RE.test(msg) ? "unreachable" : "refused";
  } else if (rc === 0) {
    return "open";
  }
  if (/refused/i.test(msg)) return "refused";
  if (DNS_RE.test(msg)) return "dns";
  if (UNREACH_RE.test(msg)) return "unreachable";
  if (rc === 124 || TIMEOUT_RE.test(msg)) return "timeout";
  if (elapsedMs !== null && elapsedMs >= timeoutSecs * 1000 * 0.9) return "timeout";
  // busybox `nc -z` prints nothing on a refused port; failing silently well
  // before the timeout means the host answered with a reset.
  if (method === "nc" && !msg && elapsedMs !== null && elapsedMs < timeoutSecs * 1000 * 0.5) {
    return "refused";
  }
  return "error";
}

/** Nanosecond-epoch pair → whole ms, or null when either isn't a real reading. */
export function elapsedMs(t0: string, t1: string): number | null {
  if (!/^\d{16,}$/.test(t0) || !/^\d{16,}$/.test(t1)) return null;
  const d = BigInt(t1) - BigInt(t0);
  if (d < 0n) return null;
  return Number(d / 1_000_000n);
}

/**
 * Whole-second epochs (busybox `date` ignores `%N`) → elapsed ms at 1 s
 * resolution. Too coarse to display, good enough to tell "instant" from "waited
 * out the timeout" when classifying.
 */
export function coarseElapsedMs(t0: string, t1: string): number | null {
  if (!/^\d{9,11}$/.test(t0) || !/^\d{9,11}$/.test(t1)) return null;
  const d = Number(t1) - Number(t0);
  return d < 0 ? null : d * 1000;
}

const STATUSES: readonly PortStatus[] = ["open", "refused", "timeout", "unreachable", "dns", "error"];
const METHODS: readonly Method[] = ["bash", "nc", "telnet", "curl", "native", "none"];
const TOOL_STATES: readonly ToolState[] = ["ok", "missing", "notimeout"];

/** curl's `-w 'TC=%{time_connect} '` stamp: seconds to the completed handshake
 *  (0 when it never connected). Null when absent. */
export function curlConnectSecs(msg: string): number | null {
  const m = /TC=(\d+(?:[.,]\d+)?)/.exec(msg);
  return m ? Number(m[1].replace(",", ".")) : null;
}

/** Parse the line protocol (both transports) into a report. */
export function parseNetReport(stdout: string, timeoutSecs = DEFAULT_TIMEOUT_SECS): NetReport {
  const rep: NetReport = {
    hostname: "",
    addrs: [],
    method: null,
    resolved: {},
    routeSrc: {},
    results: [],
    complete: false,
    tools: {},
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const f = raw.split("\t");
    switch (f[0]) {
      case "H":
        rep.hostname = (f[1] ?? "").trim();
        break;
      case "A": {
        const ip = (f[1] ?? "").trim().replace(/\/\d+$/, "");
        if (ip && !rep.addrs.includes(ip)) rep.addrs.push(ip);
        break;
      }
      case "M":
        rep.method = METHODS.includes(f[1] as Method) ? (f[1] as Method) : null;
        break;
      case "C": {
        const tool = f[1] as ProbeTool;
        const st = (f[2] ?? "").trim() as ToolState;
        if (PROBE_TOOLS.includes(tool) && TOOL_STATES.includes(st)) rep.tools[tool] = st;
        break;
      }
      case "D":
        if (f[1]) rep.resolved[f[1]] = (f[2] ?? "").trim();
        break;
      case "S":
        if (f[1] && f[2]) rep.routeSrc[f[1]] = f[2].trim();
        break;
      case "R": {
        const port = Number(f[2]);
        if (!f[1] || !Number.isInteger(port)) break;
        const raw = (f.slice(6).join(" ") ?? "").trim();
        let ms = elapsedMs(f[4] ?? "", f[5] ?? "");
        const took = ms ?? coarseElapsedMs(f[4] ?? "", f[5] ?? "");
        const rc = Number(f[3]);
        const status = classifyAttempt(rep.method, Number.isFinite(rc) ? rc : -1, raw, took, timeoutSecs);
        let msg = raw;
        if (rep.method === "curl") {
          // curl holds an open port until -m, so wall time says nothing: the
          // connect time it measured itself is the reading.
          const tc = curlConnectSecs(raw);
          ms = status === "open" && tc !== null ? Math.round(tc * 1000) : status === "open" ? null : ms;
          msg = raw.replace(/TC=\S+\s*/, "").replace(/^curl: /, "").trim();
        }
        rep.results.push({ host: f[1], port, status, ms, detail: status === "open" ? "" : msg });
        break;
      }
      case "N": {
        const port = Number(f[2]);
        if (!f[1] || !Number.isInteger(port)) break;
        const status = STATUSES.includes(f[3] as PortStatus) ? (f[3] as PortStatus) : "error";
        const ms = /^\d+$/.test(f[4] ?? "") ? Number(f[4]) : null;
        rep.results.push({ host: f[1], port, status, ms, detail: (f[5] ?? "").trim() });
        break;
      }
      case "E":
        rep.complete = true;
        break;
    }
  }
  return rep;
}

/**
 * Fold a partial re-run (the "retry" pass) into an earlier report: host facts
 * come from the newer run, the retried ports are replaced in place.
 */
export function mergeReports(base: NetReport, next: NetReport): NetReport {
  const byKey = new Map(next.results.map((r) => [checkKey(r.host, r.port), r]));
  return {
    ...next,
    resolved: { ...base.resolved, ...next.resolved },
    routeSrc: { ...base.routeSrc, ...next.routeSrc },
    results: base.results.map((r) => byKey.get(checkKey(r.host, r.port)) ?? r),
  };
}

/**
 * Keys of every TCP port in the rules that did not come back open — including
 * ports the (cut-short) run never answered for. The "retry unreachable" set.
 */
export function failedKeys(rules: NetRule[], rep: NetReport): Set<string> {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (rule.proto !== "tcp") continue;
    for (const host of rule.targets) {
      for (const r of rowsFor(rule, host, rep)) {
        if (r.status !== "open") keys.add(checkKey(host, r.port));
      }
    }
  }
  return keys;
}

// ── Source checks ───────────────────────────────────────────────────────────

/**
 * ok — the rule's source is this host. foreign — it isn't (the check still runs
 * from here, so the answer may not be the one the user wanted). unknown — the
 * host's addresses weren't reported, so we can't tell. none — no source given.
 */
export type SourceMatch = "ok" | "foreign" | "unknown" | "none";

export function sourceMatch(source: string | null, rep: Pick<NetReport, "hostname" | "addrs">): SourceMatch {
  if (!source) return "none";
  const s = source.toLowerCase();
  if (rep.addrs.some((a) => a.toLowerCase() === s)) return "ok";
  const host = rep.hostname.toLowerCase();
  if (host && (host === s || host.split(".")[0] === s)) return "ok";
  return rep.addrs.length === 0 ? "unknown" : "foreign";
}

/**
 * Whether the route to a target leaves from a different address than the rule's
 * source — the classic multi-homed trap: the firewall rule names `.180`, the
 * packets leave from `.181`. Only meaningful for an IP source that IS ours.
 */
export function egressDiffers(source: string | null, target: string, rep: NetReport): boolean {
  if (!source || !isIpv4(source)) return false;
  const src = rep.routeSrc[target];
  return !!src && src !== source && sourceMatch(source, rep) === "ok";
}

// ── Presentation helpers ────────────────────────────────────────────────────

/** Result rows for one rule target, in the rule's port order. */
export function rowsFor(rule: NetRule, host: string, rep: NetReport | null): PortResult[] {
  return rule.ports.map((port) => {
    if (rule.proto === "udp") return { host, port, status: "udp" as const, ms: null, detail: "" };
    const hit = rep?.results.find((r) => r.host === host && r.port === port);
    return hit ?? { host, port, status: "missing" as const, ms: null, detail: "" };
  });
}

// Well-known ports, as a hint next to the number. Protocol/product names are
// domain terms and stay untranslated.
const SERVICES: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 110: "pop3",
  123: "ntp", 143: "imap", 389: "ldap", 443: "https", 465: "smtps", 514: "syslog",
  587: "submission", 636: "ldaps", 993: "imaps", 995: "pop3s", 1433: "mssql",
  1521: "oracle", 2049: "nfs", 2181: "zookeeper", 2379: "etcd", 2380: "etcd-peer",
  3000: "grafana", 3100: "loki", 3306: "mysql", 3389: "rdp", 4317: "otlp-grpc",
  4318: "otlp-http", 5044: "beats", 5432: "postgres", 5601: "kibana", 5672: "amqp",
  6379: "redis", 6443: "kube-apiserver", 8080: "http-alt", 8200: "vault",
  8443: "https-alt", 8500: "consul", 9000: "minio", 9090: "prometheus",
  9092: "kafka", 9093: "alertmanager", 9100: "node-exporter", 9200: "elasticsearch",
  9300: "es-transport", 10250: "kubelet", 11211: "memcached", 15672: "rabbitmq-ui",
  27017: "mongodb",
};

export function serviceName(port: number): string {
  return SERVICES[port] ?? "";
}

/** Counts for a rule target's summary pill. */
export function tally(rows: PortResult[]): { open: number; checked: number } {
  const checked = rows.filter((r) => r.status !== "udp" && r.status !== "missing").length;
  return { open: rows.filter((r) => r.status === "open").length, checked };
}

/** Localized words for the report — passed in, so formatting stays pure and
 *  the output follows the UI language. */
export interface ReportWords {
  title: string;
  /** "3 of 4 open" — the checked ports, UDP and missing ones left out. */
  tally: (open: number, total: number) => string;
  /** "Method: bash /dev/tcp · timeout 3 s". */
  method: string;
  ms: (n: number) => string;
  /** "rule says 10.64.48.181" — the rule's source differs from the real one. */
  ruleSource: (source: string) => string;
  status: Record<PortStatus, string>;
  /** Markdown table headers. */
  cols: { source: string; target: string; port: string; status: string; time: string; service: string };
}

export type ReportFormat = "text" | "markdown";

/** `2026-09-30 14:12 +03:00` — unambiguous across locales and time zones. */
export function reportStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${tz}`;
}

/** ✓ open, ✗ a real negative answer, · nothing was checked (UDP, no answer). */
function mark(st: PortStatus): string {
  if (st === "open") return "✓";
  return st === "udp" || st === "missing" ? "·" : "✗";
}

interface ReportRow {
  mark: string;
  /** The address the traffic actually leaves from (the route's source), else the rule's. */
  source: string;
  /** The rule's source when it differs from `source` — a firewall rule for it won't match. */
  ruleSource: string | null;
  /** The note written next to the rule's source (`(gitlab)`), if any. */
  sourceLabel: string;
  host: string;
  /** The note written on the target side (`(vault)`), if any. */
  label: string;
  resolved: string | null;
  port: number;
  proto: Proto;
  status: PortStatus;
  ms: number | null;
  service: string;
}

function reportRows(rules: NetRule[], rep: NetReport): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const rule of rules) {
    for (const host of rule.targets) {
      const route = rep.routeSrc[host] ?? "";
      const source = route || rule.source || "";
      const resolved = rep.resolved[host] && rep.resolved[host] !== host ? rep.resolved[host] : null;
      for (const r of rowsFor(rule, host, rep)) {
        rows.push({
          mark: mark(r.status),
          source,
          ruleSource: rule.source && route && rule.source !== route ? rule.source : null,
          sourceLabel: rule.sourceLabel ?? "",
          host,
          label: rule.label ?? "",
          resolved,
          port: r.port,
          proto: rule.proto,
          status: r.status,
          ms: r.ms,
          service: serviceName(r.port),
        });
      }
    }
  }
  return rows;
}

/**
 * The report for a ticket or a chat, one line per checked port in the same
 * `source -> host:port/proto` shape the request was written in, so any line can be
 * forwarded on its own. Header: who checked (loopback/link-local hidden, like the
 * UI), when, the tally, then how (method + timeout — without them "timeout"
 * can't be read). `markdown` renders the same rows as a table for issue trackers.
 */
export function formatReport(
  rules: NetRule[],
  rep: NetReport,
  words: ReportWords,
  opts: { at: string; format?: ReportFormat },
): string {
  const rows = reportRows(rules, rep);
  const checked = rows.filter((r) => r.status !== "udp" && r.status !== "missing");
  const tallyText = words.tally(checked.filter((r) => r.status === "open").length, checked.length);
  const addrs = visibleAddrs(rep.addrs).join(", ");
  const time = (r: ReportRow) => (r.ms === null ? "" : words.ms(r.ms));

  if (opts.format === "markdown") {
    const who = [rep.hostname && `\`${rep.hostname}\``, addrs && `(${addrs})`].filter(Boolean).join(" ");
    const out = [
      [`**${words.title}**`, who, opts.at, tallyText].filter(Boolean).join(" · "),
      words.method,
      "",
      `| | ${words.cols.source} | ${words.cols.target} | ${words.cols.port} | ${words.cols.status} | ${words.cols.time} | ${words.cols.service} |`,
      "|---|---|---|---|---|---|---|",
    ];
    for (const r of rows) {
      // The source note names the rule's source: it follows that address, which
      // is the one in brackets when the route leaves from elsewhere.
      const ruleSrc = r.ruleSource && [r.ruleSource, r.sourceLabel].filter(Boolean).join(" ");
      const src = ruleSrc
        ? `${r.source} (${words.ruleSource(ruleSrc)})`
        : [r.source, r.sourceLabel && `(${r.sourceLabel})`].filter(Boolean).join(" ");
      const target = [r.host, r.resolved && `(${r.resolved})`, r.label && `— ${r.label}`]
        .filter(Boolean)
        .join(" ");
      out.push(
        `| ${r.mark} | ${src || "—"} | ${target} | ${r.port}/${r.proto} | ${words.status[r.status]} | ${time(r) || "—"} | ${r.service || "—"} |`,
      );
    }
    return out.join("\n");
  }

  const who = [rep.hostname, addrs && `(${addrs})`].filter(Boolean).join(" ");
  const out = [[words.title, who, opts.at, tallyText].filter(Boolean).join(" · "), words.method, ""];
  // Same shape the rule was written in: `src (note) → host:port/proto`, the
  // target's note joining the tail next to the service name.
  const srcNote = (r: ReportRow) => (r.sourceLabel && !r.ruleSource ? ` (${r.sourceLabel})` : "");
  const rule = (r: ReportRow) =>
    `${r.source ? `${r.source}${srcNote(r)} → ` : ""}${r.host}:${r.port}/${r.proto}`;
  const ruleW = Math.max(0, ...rows.map((r) => rule(r).length));
  const statusW = Math.max(0, ...rows.map((r) => words.status[r.status].length));
  const timeW = Math.max(0, ...rows.map((r) => time(r).length));
  for (const r of rows) {
    const ruleSrc = r.ruleSource && [r.ruleSource, r.sourceLabel].filter(Boolean).join(" ");
    const tail = [
      r.label,
      r.service,
      r.resolved ? `(${r.resolved})` : "",
      ruleSrc ? `(${words.ruleSource(ruleSrc)})` : "",
    ].filter(Boolean);
    const line = `${r.mark} ` + [
      rule(r).padEnd(ruleW),
      words.status[r.status].padEnd(statusW),
      time(r).padStart(timeW),
      ...tail,
    ].join("  ");
    out.push(line.trimEnd());
  }
  return out.join("\n");
}

// ── History ─────────────────────────────────────────────────────────────────

/** Recent rule sets kept per checking host. */
export const HISTORY_MAX = 10;
/** Checking hosts remembered at all (oldest dropped first). */
export const HISTORY_HOSTS_MAX = 50;

export type NetHistory = Record<string, string[]>;

/** Put `text` first in `host`'s list (deduped, capped); blank text is ignored. */
export function pushHistory(hist: NetHistory, host: string, text: string): NetHistory {
  const entry = text.trim();
  if (!entry || !host) return hist;
  const list = [entry, ...(hist[host] ?? []).filter((e) => e !== entry)].slice(0, HISTORY_MAX);
  const rest = Object.entries(hist).filter(([h]) => h !== host);
  // Re-insert the touched host last so key order = recency; trim the oldest.
  return Object.fromEntries([...rest, [host, list]].slice(-HISTORY_HOSTS_MAX));
}

/** Accept only the persisted shape — anything else from storage is dropped. */
export function sanitizeHistory(raw: unknown): NetHistory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: NetHistory = {};
  for (const [host, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const items = list.filter((e): e is string => typeof e === "string" && e.trim() !== "");
    if (items.length) out[host] = items.slice(0, HISTORY_MAX);
  }
  return out;
}

/** Per-host method choice as persisted: anything unknown is dropped (= "auto",
 *  which isn't stored at all). */
export function sanitizeMethods(raw: unknown): Record<string, MethodChoice> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, MethodChoice> = {};
  for (const [host, v] of Object.entries(raw as Record<string, unknown>)) {
    if (host && isMethodChoice(v) && v !== "auto") out[host] = v;
  }
  return out;
}

/** One-line preview of a saved rule set for the history menu. */
export function historyLabel(text: string, max = 80): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const more = lines.length > 1 ? ` (+${lines.length - 1})` : "";
  const head = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return head + more;
}

/** Addresses worth showing in the header: no loopback, no IPv6 link-local. */
export function visibleAddrs(addrs: string[]): string[] {
  return addrs.filter((a) => !/^127\./.test(a) && a !== "::1" && !/^fe80:/i.test(a));
}
