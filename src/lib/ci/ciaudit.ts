// What in a GitHub Actions workflow lets someone else run code with its token
// (ADR 0069) — read from the file alone, without the network: the checks of
// zizmor that need nothing but the YAML. A finding names its lines and says
// what to do; "pin by SHA" is the one fix the app makes, and only by a button,
// because finding the commit of a tag asks GitHub. A guard, not a boundary
// (principle 7): it over-flags rather than misses. Pure.

import type { YamlFile } from "../pipeline/yamldoc";
import { isObj, str, strList } from "../pipeline/yamldoc";

export type FindingCode =
  | "prTarget"
  | "injection"
  | "unpinned"
  | "noPermissions"
  | "writeAll"
  | "secretsInherit"
  | "persistCredentials";

export type FindingLevel = "error" | "warn" | "info";

/** An action used by a tag or branch, which "pin by SHA" can fix. */
export interface Pin {
  line: number;
  /** `owner/repo` — where the commit is asked for. */
  repo: string;
  /** As written: `actions/checkout@v4`, `owner/repo/path@v1`. */
  uses: string;
  ref: string;
}

export interface Finding {
  code: FindingCode;
  level: FindingLevel;
  /** 1-based, ascending, each once. */
  lines: number[];
  /** What it is about, for the text: `actions/checkout@v4, …`, an expression. */
  detail: string;
  pins: Pin[];
}

const LEVEL: Record<FindingCode, FindingLevel> = {
  prTarget: "error",
  injection: "error",
  unpinned: "warn",
  noPermissions: "warn",
  writeAll: "warn",
  secretsInherit: "info",
  persistCredentials: "info",
};

/** The order findings are listed in: the worst first. */
const ORDER: FindingCode[] = ["prTarget", "injection", "unpinned", "noPermissions", "writeAll", "secretsInherit", "persistCredentials"];

/**
 * Contexts anyone who can open an issue or a pull request writes: an expression
 * of one inside `run:` is pasted into the shell as code.
 */
const UNTRUSTED =
  /\$\{\{[^}]*?\b(github\.event\.(?:issue\.(?:title|body)|pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))|comment\.body|review\.body|review_comment\.body|discussion\.(?:title|body)|pages\.[\w*[\]]+\.page_name|commits\.[\w*[\]]+\.(?:message|author\.(?:email|name))|head_commit\.(?:message|author\.(?:email|name))|workflow_run\.(?:head_branch|display_title|head_commit\.(?:message|author\.(?:email|name))))|github\.head_ref)\b[^}]*?\}\}/g;

/** The head of a pull request, as a checkout's `ref:` names it. */
const PR_HEAD = /github\.event\.pull_request\.head|github\.head_ref|github\.event\.workflow_run\.head/;

const SHA = /^[0-9a-f]{40}$/;

interface Step {
  uses: string | null;
  run: string | null;
  script: string | null;
  with: Record<string, unknown>;
}

const steps = (job: Record<string, unknown>): Step[] =>
  Array.isArray(job.steps)
    ? job.steps.filter(isObj).map((s) => ({
        uses: str(s.uses),
        run: str(s.run),
        script: isObj(s.with) ? str(s.with.script) : null,
        with: isObj(s.with) ? s.with : {},
      }))
    : [];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An action from another repository, not pinned to a commit. */
export function unpinnedRef(uses: string): { repo: string; ref: string } | null {
  if (uses.startsWith("./") || uses.startsWith("$/") || uses.startsWith("docker://")) return null;
  const at = uses.lastIndexOf("@");
  if (at < 0) return null;
  const ref = uses.slice(at + 1);
  const [owner, name] = uses.slice(0, at).split("/");
  if (!owner || !name || SHA.test(ref)) return null;
  return { repo: `${owner}/${name}`, ref };
}

/** The findings of a GitHub workflow; none when the file did not parse. */
export function auditWorkflow(doc: YamlFile, text: string): Finding[] {
  const root = doc.value;
  if (doc.error || !isObj(root)) return [];
  const lines = text.split("\n");
  const found = new Map<FindingCode, { lines: Set<number>; details: string[]; pins: Pin[] }>();
  const add = (code: FindingCode, at: number[], detail?: string, pin?: Pin) => {
    const f = found.get(code) ?? { lines: new Set<number>(), details: [], pins: [] };
    at.filter((l) => l > 0).forEach((l) => f.lines.add(l));
    if (detail && !f.details.includes(detail)) f.details.push(detail);
    if (pin) f.pins.push(pin);
    found.set(code, f);
  };
  // The line in `from..to` (1-based) that `re` finds, not one already taken.
  const lineOf = (re: RegExp, from: number, to: number, taken?: Set<number>): number => {
    for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) {
      if (!taken?.has(i) && re.test(lines[i - 1])) {
        taken?.add(i);
        return i;
      }
    }
    return 0;
  };

  const on = root.on;
  const events = typeof on === "string" || Array.isArray(on) ? (strList(on) ?? []) : isObj(on) ? Object.keys(on) : [];
  const risky = events.filter((e) => e === "pull_request_target" || e === "workflow_run");
  const onLine = (e: string) => doc.span(["on", e])?.line ?? doc.span(["on"])?.line ?? 1;

  const jobs = isObj(root.jobs) ? root.jobs : {};
  const rootPermissions = root.permissions;
  if (rootPermissions === "write-all") add("writeAll", [doc.span(["permissions"])?.line ?? 1]);
  let unguarded = false;

  for (const id of doc.keys(["jobs"])) {
    const job = jobs[id];
    if (!isObj(job)) continue;
    const span = doc.span(["jobs", id]) ?? { line: 1, endLine: lines.length };
    const taken = new Set<number>();
    if (job.permissions === undefined && rootPermissions === undefined) unguarded = true;
    if (job.permissions === "write-all") add("writeAll", [doc.span(["jobs", id, "permissions"])?.line ?? span.line]);
    if (job.secrets === "inherit") add("secretsInherit", [doc.span(["jobs", id, "secrets"])?.line ?? span.line], id);

    const called = str(job.uses);
    if (called) {
      const pin = unpinnedRef(called);
      if (pin) {
        const line = doc.span(["jobs", id, "uses"])?.line ?? span.line;
        add("unpinned", [line], called, { line, ...pin, uses: called });
      }
    }

    for (const step of steps(job)) {
      const usesLine = step.uses ? lineOf(new RegExp(`^\\s*(?:-\\s*)?uses:\\s*["']?${escapeRe(step.uses)}["']?\\s*(?:#.*)?$`), span.line, span.endLine, taken) : 0;
      if (step.uses) {
        const pin = unpinnedRef(step.uses);
        if (pin) add("unpinned", [usesLine], step.uses, { line: usesLine, ...pin, uses: step.uses });
        else if (step.uses.startsWith("docker://") && !step.uses.includes("@sha256:")) add("unpinned", [usesLine], step.uses);
      }
      const checkout = step.uses?.split("@")[0] === "actions/checkout";
      if (checkout) {
        const persist = step.with["persist-credentials"];
        if (persist !== false && persist !== "false") add("persistCredentials", [usesLine]);
        const ref = str(step.with.ref);
        if (risky.length && ref && PR_HEAD.test(ref)) {
          const refLine = lineOf(new RegExp(`^\\s*ref:.*${escapeRe(ref.trim().slice(0, 40))}`), usesLine || span.line, span.endLine);
          add("prTarget", [...risky.map(onLine), usesLine, refLine], risky.join(", "));
        }
      }
      for (const body of [step.run, step.uses?.split("@")[0] === "actions/github-script" ? step.script : null]) {
        if (!body) continue;
        for (const m of body.matchAll(UNTRUSTED)) {
          const line = lineOf(new RegExp(escapeRe(m[0])), span.line, span.endLine);
          add("injection", [line], m[1]);
        }
      }
    }
  }
  if (unguarded) add("noPermissions", [1]);

  return ORDER.filter((c) => found.has(c)).map((code) => {
    const f = found.get(code)!;
    return {
      code,
      level: LEVEL[code],
      lines: [...f.lines].sort((a, b) => a - b),
      detail: f.details.join(", "),
      pins: f.pins,
    };
  });
}

/**
 * The text with each pinned action's tag replaced by its commit, the tag kept
 * as a comment (`uses: actions/checkout@<sha> # v4`) — the form Dependabot
 * keeps up to date. A line that no longer says what the pin was found on is
 * left alone.
 */
export function pinText(text: string, pins: readonly (Pin & { sha: string })[]): string {
  const lines = text.split("\n");
  for (const p of pins) {
    const i = p.line - 1;
    const line = lines[i];
    if (line === undefined || !SHA.test(p.sha)) continue;
    const re = new RegExp(`(uses:\\s*["']?)${escapeRe(p.uses)}(["']?)(\\s*#.*)?$`);
    if (!re.test(line)) continue;
    const head = p.uses.slice(0, p.uses.lastIndexOf("@"));
    lines[i] = line.replace(re, (_m, pre: string, quote: string) => `${pre}${head}@${p.sha}${quote} # ${p.ref}`);
  }
  return lines.join("\n");
}
