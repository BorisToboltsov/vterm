// Utilities → network access check (v1.0.36). Answers "can THIS host reach
// those ports?" for rules written the way firewall requests are:
//
//     10.64.48.180 -> 10.70.39.10:[22, 80, 443]/tcp
//     10.64.48.180 -> [10.70.39.10, db.internal]:[5432, 8000-8010]
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
//   M  <bash|nc|telnet|native|none>     how ports are probed
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
  targets: string[];
  ports: number[];
  proto: Proto;
}

export interface ParseError {
  line: number;
  /** Stable error code — the UI localizes it (`util.netcheck.err.<code>`). */
  code: "syntax" | "host" | "port" | "range" | "empty" | "tooMany";
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
    const body = rawLine.replace(/#.*$/, "").trim();
    if (!body) return;
    const parts = body.split(ARROW);
    if (parts.length > 2) return void errors.push({ line, code: "syntax", token: body });
    const source = parts.length === 2 ? parts[0].trim() : null;
    const rhs = parts.length === 2 ? parts[1] : parts[0];
    if (source !== null && (!source || !validHost(source))) {
      return void errors.push({ line, code: "host", token: source });
    }
    const m = /^(.+?)\s*:\s*(\[[^\]]*\]|[\d\s,;-]+?)\s*(?:\/\s*(tcp|udp))?$/i.exec(rhs.trim());
    if (!m) return void errors.push({ line, code: "syntax", token: rhs.trim() });
    const targets = [...new Set(splitList(m[1]))];
    if (targets.length === 0) return void errors.push({ line, code: "empty", token: m[1] });
    const badHost = targets.find((h) => !validHost(h));
    if (badHost) return void errors.push({ line, code: "host", token: badHost });
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
    rules.push({ line, source, targets, ports, proto });
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

/**
 * Build the argv for the SSH transport: one `sh -c` script that reports identity
 * (H/A), picks the probe method (M), resolves each target and its route source
 * (D/S), then probes ports in batches of `BATCH` in parallel (R) and ends with E.
 * Method order: `bash /dev/tcp` under `timeout` (on nearly every server, nothing
 * to install) → `nc -z` → `telnet` under `timeout` → `none`. The script only
 * prints raw readings — rc, timestamps and the tool's own message; the verdict
 * (open / refused / timeout …) is `classifyAttempt`'s job here, where it's tested.
 * With no targets it is an identity probe (the header before the first run).
 */
export function netcheckArgs(targets: NetTarget[], timeoutSecs = DEFAULT_TIMEOUT_SECS): string[] {
  const T = Math.max(1, Math.min(30, Math.round(timeoutSecs)));
  const lines: string[] = [
    `T=${T}`,
    `h=$(hostname 2>/dev/null || uname -n 2>/dev/null); printf 'H\\t%s\\n' "$h"`,
    `if command -v ip >/dev/null 2>&1; then ip -o addr show 2>/dev/null | awk '$3=="inet"||$3=="inet6"{print "A\\t" $4}';`,
    `else for a in $(hostname -I 2>/dev/null); do printf 'A\\t%s\\n' "$a"; done; fi`,
    `M=none`,
    `if command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then M=bash;`,
    `elif command -v nc >/dev/null 2>&1; then M=nc;`,
    `elif command -v timeout >/dev/null 2>&1 && command -v telnet >/dev/null 2>&1; then M=telnet; fi`,
    `printf 'M\\t%s\\n' "$M"`,
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

export type Method = "bash" | "nc" | "telnet" | "native" | "none";

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
const METHODS: readonly Method[] = ["bash", "nc", "telnet", "native", "none"];

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
      case "D":
        if (f[1]) rep.resolved[f[1]] = (f[2] ?? "").trim();
        break;
      case "S":
        if (f[1] && f[2]) rep.routeSrc[f[1]] = f[2].trim();
        break;
      case "R": {
        const port = Number(f[2]);
        if (!f[1] || !Number.isInteger(port)) break;
        const msg = (f.slice(6).join(" ") ?? "").trim();
        const ms = elapsedMs(f[4] ?? "", f[5] ?? "");
        const took = ms ?? coarseElapsedMs(f[4] ?? "", f[5] ?? "");
        const rc = Number(f[3]);
        const status = classifyAttempt(rep.method, Number.isFinite(rc) ? rc : -1, msg, took, timeoutSecs);
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

/**
 * Plain-text report for a ticket. Words are passed in (localized by the caller),
 * so this stays pure and the output matches the UI language.
 */
export function formatReport(
  rules: NetRule[],
  rep: NetReport,
  words: { from: string; ms: (n: number) => string; status: Record<PortStatus, string> },
): string {
  const out: string[] = [];
  const who = [rep.hostname, rep.addrs.join(", ")].filter(Boolean).join(" · ");
  out.push(`${words.from}: ${who || "—"}`);
  for (const rule of rules) {
    for (const host of rule.targets) {
      out.push("");
      const src = rule.source ? `${rule.source} -> ` : "";
      const via = rep.resolved[host] && rep.resolved[host] !== host ? ` (${rep.resolved[host]})` : "";
      out.push(`${src}${host}${via} /${rule.proto}`);
      for (const r of rowsFor(rule, host, rep)) {
        const ms = r.ms === null ? "" : ` ${words.ms(r.ms)}`;
        const svc = serviceName(r.port);
        out.push(`  ${String(r.port).padEnd(5)} ${words.status[r.status]}${ms}${svc ? `  (${svc})` : ""}`);
      }
    }
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
