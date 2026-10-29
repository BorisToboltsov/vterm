// Access-check store (v1.0.36, v1.21 — ADR 0032, v1.22 — ADR 0033): the rules
// table, the servers picked to check rules without a source, the last run and
// the per-host history of the Utilities "access check". Keyed by the HOME host —
// the tab the tool was opened on (server address or "local") — not by session:
// another tab shows its own rules, picks and last answer, never the previous
// server's, and nothing here outlives a session in a way that needs clearing in
// `closeTabFully` (a run keeps a session id only to retry with; a closed one
// answers "no session"). The Utilities window unmounts on close, so rules and
// runs live here: a run started keeps going behind a closed window, its answer
// waits for the reopen. History and probe methods persist to localStorage
// (per-viewer conveniences; losing them only loses suggestions); rules, picks
// and runs don't.
import {
  checkTargets,
  failedKeys,
  localToolOf,
  mergeReports,
  netcheckArgs,
  netcheckAudit,
  netcheckFailureAudit,
  netcheckStoppedAudit,
  parseNetReport,
  pushHistory,
  reportStamp,
  runBudgetSecs,
  sanitizeHistory,
  sanitizeMethods,
  type MethodChoice,
  type NetHistory,
  type NetReport,
  type NetRule,
  type NetTarget,
} from "../netcheck/netcheck";
import type { RuleRow } from "../netcheck/netcheckform";
import type { HostPlan } from "../netcheck/netroute";
import { netcheckRun, recordAudit, sftpCancel } from "../api";
import { isRecording } from "./recordings.svelte";
import { probeError } from "../utilities/probe";
import { isCancelled } from "../sync/sync";
import { reportWords } from "../netcheck/netcheckwords";
import { t } from "../i18n";

const STORAGE_KEY = "vterm.netcheck";
// The probe method picked per checking host (v1.0.37); "auto" isn't stored.
const METHOD_KEY = "vterm.netcheck.method";

/**
 * running — the check is under way; done — it answered; error — it couldn't run
 * (no session, no answer); stopped — the user stopped it.
 */
export type HostRunState = "running" | "done" | "error" | "stopped";

/** One server's part of a run. */
export interface HostRun {
  key: string;
  name: string;
  kind: "ssh" | "local";
  sessionId: string;
  isProd: boolean;
  rules: NetRule[];
  method: MethodChoice;
  state: HostRunState;
  /** Its answer — kept through a retry or a stopped retry. */
  report: NetReport | null;
  error: string;
  /** The handle `sftpCancel` stops it with. */
  cancelId: string;
}

/** A run from one or more servers. */
export interface NetRun {
  id: number;
  /** When it ran (re-stamped by a retry), with the zone — `reportStamp`. */
  at: string;
  timeout: number;
  hosts: HostRun[];
}

function loadMethods(): Record<string, MethodChoice> {
  try {
    return sanitizeMethods(JSON.parse(localStorage.getItem(METHOD_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function load(): NetHistory {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export const netcheckState = $state<{
  /** The rules table, per home host. */
  rows: Record<string, RuleRow[]>;
  /** The host keys picked to check rules without a source, per home host;
   *  absent = the home host itself. */
  picked: Record<string, string[]>;
  /** The last run, per home host. */
  runs: Record<string, NetRun>;
  history: NetHistory;
  methods: Record<string, MethodChoice>;
}>({
  rows: {},
  picked: {},
  runs: {},
  history: load(),
  methods: loadMethods(),
});

/** The rules table of `home`. */
export function rowsOf(home: string): RuleRow[] {
  return netcheckState.rows[home] ?? [];
}

/** Replace the rules table of `home`. */
export function setRows(home: string, rows: RuleRow[]): void {
  if (!home) return;
  netcheckState.rows[home] = rows;
}

/** The servers `home` checks rules without a source from: the home host itself
 *  until something else is picked. */
export function pickedOf(home: string): string[] {
  return netcheckState.picked[home] ?? (home ? [home] : []);
}

/** Pick `key` to check rules without a source from `home`, or unpick it. */
export function togglePicked(home: string, key: string): void {
  if (!home || !key) return;
  const now = pickedOf(home);
  netcheckState.picked[home] = now.includes(key) ? now.filter((k) => k !== key) : [...now, key];
}

/** The last run from `home`, if any. */
export function runOf(home: string): NetRun | null {
  return netcheckState.runs[home] ?? null;
}

export function isRunning(run: NetRun | null): boolean {
  return !!run && run.hosts.some((h) => h.state === "running");
}

/** The method picked for `host` ("auto" when none was). */
export function methodFor(host: string): MethodChoice {
  return netcheckState.methods[host] ?? "auto";
}

/** Remember the method picked for `host`. */
export function setMethod(host: string, choice: MethodChoice): void {
  if (!host) return;
  const next = { ...netcheckState.methods };
  if (choice === "auto") delete next[host];
  else next[host] = choice;
  netcheckState.methods = next;
  try {
    localStorage.setItem(METHOD_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — the choice just won't persist */
  }
}

/** Remember a rule set that was run from `host`. */
export function rememberRules(host: string, text: string): void {
  netcheckState.history = pushHistory(netcheckState.history, host, text);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(netcheckState.history));
  } catch {
    /* storage blocked — history just won't persist */
  }
}

let runSeq = 0;

/**
 * Run `plan` (its ready servers) from `home`: every server at once, each on its
 * own session, each with its own stop handle. Resolves when all have answered,
 * failed or been stopped. `text` is the rules as written, for the history.
 */
export async function startRun(home: string, plan: HostPlan[], timeout: number, text: string): Promise<void> {
  if (!home || plan.length === 0 || isRunning(runOf(home))) return;
  rememberRules(home, text);
  const id = ++runSeq;
  netcheckState.runs[home] = {
    id,
    at: reportStamp(new Date()),
    timeout,
    hosts: plan.map((p) => ({
      key: p.host.key,
      name: p.host.name,
      kind: p.host.kind,
      sessionId: p.host.sessionId ?? "",
      isProd: p.host.isProd,
      rules: p.rules,
      method: methodFor(p.host.key),
      state: "running",
      report: null,
      error: "",
      cancelId: "",
    })),
  };
  await Promise.all(plan.map((p, i) => probeHost(home, id, i, checkTargets(p.rules), false)));
}

/** Check again, on every server, only what didn't come back open. */
export async function retryRun(home: string): Promise<void> {
  const run = runOf(home);
  if (!run || isRunning(run)) return;
  const jobs = run.hosts
    .map((h, i) => ({ i, keys: h.report ? failedKeys(h.rules, h.report) : null, h }))
    .filter((j) => j.keys === null || j.keys.size > 0);
  if (jobs.length === 0) return;
  run.at = reportStamp(new Date());
  for (const j of jobs) j.h.state = "running";
  await Promise.all(
    jobs.map((j) => probeHost(home, run.id, j.i, checkTargets(j.h.rules, j.keys ?? undefined), j.keys !== null)),
  );
}

/** Stop every server of the run that is still checking (ADR 0032). */
export function stopRun(home: string): void {
  for (const h of runOf(home)?.hosts ?? []) {
    if (h.state === "running" && h.cancelId) void sftpCancel(h.cancelId).catch(() => {});
  }
}

/** The host entry of run `id`, or null once another run replaced it. */
function hostOf(home: string, id: number, i: number): HostRun | null {
  const run = netcheckState.runs[home];
  return run?.id === id ? (run.hosts[i] ?? null) : null;
}

async function probeHost(home: string, id: number, i: number, targets: NetTarget[], retry: boolean): Promise<void> {
  const h = hostOf(home, id, i);
  const run = netcheckState.runs[home];
  if (!h || !run) return;
  h.state = "running";
  h.error = "";
  h.cancelId = `netcheck:${id}:${i}:${Date.now().toString(36)}`;
  const { sessionId, cancelId, method, rules, kind } = h;
  const timeout = run.timeout;
  const count = targets.reduce((n, x) => n + x.ports.length, 0);
  try {
    const out = await netcheckRun(
      sessionId,
      netcheckArgs(targets, timeout, method),
      targets,
      timeout,
      runBudgetSecs(count, timeout),
      cancelId,
      localToolOf(kind, method),
    );
    const cur = hostOf(home, id, i);
    if (!cur) return;
    const rep = parseNetReport(out.stdout, timeout);
    if (!rep.hostname && rep.results.length === 0) {
      cur.state = "error";
      cur.error = probeError(out.stdout, out.stderr, out.exitCode) || t("util.probe.noOutput");
    } else {
      cur.report = retry && cur.report ? mergeReports(cur.report, rep) : rep;
      cur.state = "done";
    }
  } catch (e) {
    const cur = hostOf(home, id, i);
    if (!cur) return;
    if (isCancelled(String(e))) cur.state = "stopped";
    else {
      cur.state = "error";
      cur.error = String(e);
    }
  }
  const cur = hostOf(home, id, i);
  if (cur) audit(cur, rules, netcheckState.runs[home]?.at ?? "", timeout, retry);
}

/**
 * Record one server's part into that session's recording, if one runs: the
 * rules and the same report "Copy report" gives (`netcheckAudit`), the error,
 * or that it was stopped — never the raw line protocol.
 */
function audit(h: HostRun, rules: NetRule[], at: string, timeout: number, retry: boolean): void {
  if (!isRecording(h.sessionId)) return;
  const entry =
    h.state === "stopped"
      ? netcheckStoppedAudit(rules, t("util.netcheck.stoppedAudit"), retry)
      : h.state === "done" && h.report
        ? netcheckAudit(rules, h.report, reportWords(h.report.method, timeout), at, retry)
        : netcheckFailureAudit(rules, h.error || t("util.probe.noOutput"), retry);
  void recordAudit(h.sessionId, entry).catch(() => {});
}
