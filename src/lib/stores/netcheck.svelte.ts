// Access-check store (v1.0.36, v1.21 — ADR 0032, v1.22 — ADR 0033): the rules
// table, the servers picked to check rules without a source, the last run and
// the per-host history of the Utilities "access check". Keyed by the HOME host —
// the tab the tool was opened on (server address or "local") — not by session:
// another tab shows its own rules, picks and last answer, never the previous
// server's, and nothing here outlives a session in a way that needs clearing in
// `closeTabFully` (a run keeps a session id only to retry with; a closed one
// answers "no session"). The Utilities window unmounts on close, so rules and
// runs live here: a run started keeps going behind a closed window, its answer
// waits for the reopen. History, probe methods, the rules tables and the
// servers picked (v1.35) persist to localStorage — per-viewer conveniences:
// losing them loses only what was typed, and a stored table is read back
// through `loadTables`, which drops what does not read as a row. Runs don't
// persist: their sessions end with the app.
import {
  checkCount,
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
import { loadTables, saveTables, type NetTables, type RuleRow } from "../netcheck/netcheckform";
import { KNOWN_FACTS_MAX, sanitizeKnownFacts, type HostFacts, type HostPlan } from "../netcheck/netroute";
import { netcheckRun, recordAudit, sftpCancel } from "../api";
import { isRecording } from "./recordings.svelte";
import { notifyInfo, notifySuccess } from "./toasts.svelte";
import { probeError } from "../utilities/probe";
import { isCancelled } from "../sync/sync";
import { reportWords } from "../netcheck/netcheckwords";
import { t } from "../i18n";

const STORAGE_KEY = "vterm.netcheck";
// The probe method picked per checking host (v1.0.37); "auto" isn't stored.
const METHOD_KEY = "vterm.netcheck.method";
// The rules tables and the servers picked, per home host (v1.35).
export const TABLES_KEY = "vterm.netcheck.tables";
// What each server said of itself the last time it was asked (v1.35).
export const KNOWN_KEY = "vterm.netcheck.known";

function loadKnown(): Record<string, HostFacts> {
  try {
    return sanitizeKnownFacts(JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "null"));
  } catch {
    return {};
  }
}

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

/**
 * «Wait for open» (v1.35, ADR 0056): the ports that did not open are checked
 * again every `WAIT_EVERY_SECS` until they all do, the user stops, or
 * `WAIT_FOR_SECS` pass. Started by its button only, for at most
 * `WAIT_MAX_CHECKS` checks — a repeat is part of that act, not a check of its own.
 */
export const WAIT_EVERY_SECS = 10;
export const WAIT_FOR_SECS = 30 * 60;
export const WAIT_MAX_CHECKS = 64;

export interface NetWait {
  id: number;
  /** When it gives up (ms since the epoch). */
  until: number;
  /** When the next attempt starts (ms since the epoch). */
  next: number;
  /** Attempts made so far. */
  attempts: number;
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

function loadSaved(): NetTables {
  try {
    return loadTables(JSON.parse(localStorage.getItem(TABLES_KEY) ?? "null"));
  } catch {
    return { rows: {}, picked: {} };
  }
}

const saved = loadSaved();

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
  /** A «wait for open» under way, per home host. */
  waiting: Record<string, NetWait>;
  history: NetHistory;
  methods: Record<string, MethodChoice>;
  /** What each server said of itself last (hostname, addresses), by host key. */
  known: Record<string, HostFacts>;
}>({
  rows: saved.rows,
  picked: saved.picked,
  runs: {},
  waiting: {},
  history: load(),
  methods: loadMethods(),
  known: loadKnown(),
});

/**
 * Remember what the server `key` said of itself, for when no session to it is
 * open. The same answer again writes nothing.
 */
export function rememberFacts(key: string, facts: HostFacts): void {
  if (!key) return;
  const was = netcheckState.known[key];
  if (was && was.hostname === facts.hostname && was.addrs.join() === facts.addrs.join()) return;
  const next = { ...netcheckState.known };
  delete next[key];
  next[key] = { hostname: facts.hostname, addrs: [...facts.addrs] };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - KNOWN_FACTS_MAX))) delete next[k];
  netcheckState.known = next;
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — the facts just won't outlive the app */
  }
}

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
  // A new run is a new question: a wait for the old one's answer ends.
  delete netcheckState.waiting[home];
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

/** What a retry would check again: what didn't open, and all of a server that answered nothing. */
export function retryChecks(run: NetRun | null): number {
  if (!run) return 0;
  return run.hosts.reduce((n, h) => n + (h.report ? failedKeys(h.rules, h.report).size : checkCount(h.rules)), 0);
}

/**
 * Check again, on every server, only what didn't come back open. `quiet` — a
 * «wait for open» attempt: recorded only when it opened something.
 */
export async function retryRun(home: string, quiet = false): Promise<void> {
  const run = runOf(home);
  if (!run || isRunning(run)) return;
  const jobs = run.hosts
    .map((h, i) => ({ i, keys: h.report ? failedKeys(h.rules, h.report) : null, h }))
    .filter((j) => j.keys === null || j.keys.size > 0);
  if (jobs.length === 0) return;
  run.at = reportStamp(new Date());
  for (const j of jobs) j.h.state = "running";
  await Promise.all(
    jobs.map((j) => probeHost(home, run.id, j.i, checkTargets(j.h.rules, j.keys ?? undefined), j.keys !== null, quiet)),
  );
}

/** The «wait for open» of `home`, if one is under way. */
export function waitOf(home: string): NetWait | null {
  return netcheckState.waiting[home] ?? null;
}

let waitSeq = 0;

/** Sleep until `at`, waking early when `still()` turns false. */
async function sleepUntil(at: number, still: () => boolean): Promise<void> {
  while (still() && Date.now() < at) {
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, at - Date.now()))));
  }
}

/**
 * Wait for what did not open to open (ADR 0056): an attempt every
 * `WAIT_EVERY_SECS`, until every port is open, a server can no longer check,
 * the user stops, or `WAIT_FOR_SECS` pass. Nothing to wait for, or more than
 * `WAIT_MAX_CHECKS` checks, and it does not start.
 */
export async function startWaiting(home: string): Promise<void> {
  const run = runOf(home);
  const todo = retryChecks(run);
  if (!home || !run || isRunning(run) || waitOf(home) || todo === 0 || todo > WAIT_MAX_CHECKS) return;
  const id = ++waitSeq;
  const now = Date.now();
  netcheckState.waiting[home] = { id, until: now + WAIT_FOR_SECS * 1000, next: now + WAIT_EVERY_SECS * 1000, attempts: 0 };
  const still = () => waitOf(home)?.id === id && runOf(home)?.id === run.id;
  while (still()) {
    const w = waitOf(home)!;
    await sleepUntil(w.next, still);
    if (!still()) return;
    if (Date.now() >= w.until) {
      delete netcheckState.waiting[home];
      notifyInfo(t("util.netcheck.waitExpired", { n: WAIT_FOR_SECS / 60 }));
      return;
    }
    w.attempts += 1;
    await retryRun(home, true);
    if (!still()) return;
    const cur = runOf(home)!;
    if (cur.hosts.some((h) => h.state === "error" || h.state === "stopped")) {
      delete netcheckState.waiting[home];
      return;
    }
    if (retryChecks(cur) === 0) {
      delete netcheckState.waiting[home];
      notifySuccess(t("util.netcheck.waitOpened"));
      return;
    }
    w.next = Date.now() + WAIT_EVERY_SECS * 1000;
  }
}

/** Stop waiting for `home`; an attempt under way is stopped too. */
export function stopWaiting(home: string): void {
  if (!waitOf(home)) return;
  delete netcheckState.waiting[home];
  stopRun(home);
}

/** Stop every server of the run that is still checking (ADR 0032) — and a wait. */
export function stopRun(home: string): void {
  delete netcheckState.waiting[home];
  for (const h of runOf(home)?.hosts ?? []) {
    if (h.state === "running" && h.cancelId) void sftpCancel(h.cancelId).catch(() => {});
  }
}

/** The host entry of run `id`, or null once another run replaced it. */
function hostOf(home: string, id: number, i: number): HostRun | null {
  const run = netcheckState.runs[home];
  return run?.id === id ? (run.hosts[i] ?? null) : null;
}

async function probeHost(
  home: string,
  id: number,
  i: number,
  targets: NetTarget[],
  retry: boolean,
  quiet = false,
): Promise<void> {
  const h = hostOf(home, id, i);
  const run = netcheckState.runs[home];
  if (!h || !run) return;
  const failedBefore = h.report ? failedKeys(h.rules, h.report).size : null;
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
  if (!cur) return;
  // A wait's attempt goes into the recording only when it opened something.
  const opened = failedBefore !== null && cur.report !== null && failedKeys(rules, cur.report).size < failedBefore;
  if (!quiet || opened) audit(cur, rules, netcheckState.runs[home]?.at ?? "", timeout, retry);
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

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(saveTables({ rows: netcheckState.rows, picked: netcheckState.picked }));
    try {
      localStorage.setItem(TABLES_KEY, data);
    } catch {
      /* storage blocked — the tables just won't outlive the app */
    }
  });
});
