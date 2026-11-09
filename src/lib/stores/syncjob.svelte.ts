// A session's directory sync, owned by a store rather than the dialog (v1.0.25).
//
// Why. "Run in the background" closes the dialog while a compare or a run goes on,
// and the dialog lives inside the SFTP panel, which the dock remounts on every
// terminal-tab switch. Component state would die with it: the result of a compare
// would land nowhere, and re-opening would show an empty form over a run still
// going. So the form, the plan and the in-flight operation live here, keyed by
// `sessionId`; the dialog is a view of it. Keyed by session, so `closeTabFully`
// drops it (and stops what it was doing) — tabteardown.guard.
//
// One run at a time app-wide: per-file progress ids are `sync:<path>` with no
// session in them (sync.rs `sync_transfer_id`), so two concurrent runs would draw
// each other's bars. Compares may overlap; they report on their own ids.
//
// Since v1.36 (ADR 0058) a run is the backend's: `apply` only starts it, and how
// it goes and ends arrives as `sync://run` to the window that shows the session
// (`runHeard`) — so the tab may move to another window mid-run, and the window
// that takes it asks once how the run stands (`adoptSyncJob`). A compare is
// still this window's: it holds the tab until it ends or is stopped.

import { localHashTree, sftpHashTree, sftpSyncStart, sftpCancel, syncRunOf, type SyncRunView } from "../api";
import {
  applicable,
  diffTrees,
  isCancelled,
  isSyncBusy,
  parseExcludes,
  planFacts,
  syncErrorView,
  type PlanFacts,
  type SyncAction,
  type SyncDirection,
  type SyncRunPhase,
} from "../sync/sync";
import { dockCwd, touchDir } from "./dockstate.svelte";
import { clearSyncRun } from "./syncrun.svelte";
import { notifyError, notifyInfo, notifySuccess } from "./toasts.svelte";
import { t } from "../i18n";

export interface SyncJob {
  localPath: string;
  remote: string;
  direction: SyncDirection;
  excludeText: string;
  deleteExtraneous: boolean;
  plan: SyncAction[] | null;
  facts: PlanFacts | null;
  skipped: { local: number; remote: number };
  error: string;
  /** Compare in flight; its id keys one backend stop flag per side. */
  comparing: boolean;
  compareId: string;
  /** Files hashed so far on each side (`sync://scan`). */
  scan: { local: number; remote: number };
  applying: boolean;
  stopping: boolean;
  runId: string;
  /** How many actions the run was started with — what "done N of M" counts against. */
  runTotal: number;
  phase: SyncRunPhase;
  /** The dialog is showing this job — a finish while it's closed gets a toast. */
  dialogOpen: boolean;
}

const jobs = $state<Record<string, SyncJob>>({});

/**
 * Which session's run the shared per-file progress (`syncRunState`) belongs to.
 * Kept after the run ends — the ticks of a stopped run are its report — and only
 * replaced by the next run; whether that owner is still running is its job's
 * `applying`.
 */
export const syncRunOwner = $state<{ sessionId: string | null }>({ sessionId: null });

function fresh(): SyncJob {
  return {
    localPath: "",
    remote: "",
    direction: "push",
    excludeText: ".git\nnode_modules\n*.tfstate",
    deleteExtraneous: false,
    plan: null,
    facts: null,
    skipped: { local: 0, remote: 0 },
    error: "",
    comparing: false,
    compareId: "",
    scan: { local: 0, remote: 0 },
    applying: false,
    stopping: false,
    runId: "",
    runTotal: 0,
    phase: "idle",
    dialogOpen: false,
  };
}

/** The job for `sessionId`, created on first access. Not for use inside `$derived`. */
export function syncJob(sessionId: string): SyncJob {
  // Read back through the store: `??=` would hand out the raw object, and writes
  // to that bypass the reactive proxy the dialog renders from.
  if (!jobs[sessionId]) jobs[sessionId] = fresh();
  return jobs[sessionId];
}

/** Read-only peek (safe inside `$derived`): null when this session never synced. */
export function peekSyncJob(sessionId: string): SyncJob | null {
  return jobs[sessionId] ?? null;
}

/**
 * Take over the sync form (and the compared plan) of a tab moved here from
 * another window (ADR 0017). A compare does not travel (a tab does not move
 * while one goes); a run does (v1.36): it is the backend's, its events come
 * here from now on, and how it stands is asked once — it may have ended while
 * the tab was on its way, its last word told to the window it left.
 */
export function adoptSyncJob(sessionId: string, job: SyncJob): void {
  const running = job.applying && job.runId !== "";
  jobs[sessionId] = {
    ...fresh(),
    ...job,
    comparing: false,
    compareId: "",
    applying: running,
    stopping: running && job.stopping,
    dialogOpen: false,
    phase: job.phase === "running" && !running ? "idle" : job.phase,
  };
  if (!running) return;
  syncRunOwner.sessionId = sessionId;
  void syncRunOf(sessionId)
    .then((view) => view && runHeard(view))
    .catch(() => {});
}

/** A compare or a run is going on. */
export function isBusy(job: SyncJob | null): boolean {
  return !!job && (job.comparing || job.applying);
}

/** Inputs changed: the old plan no longer describes them. */
export function invalidate(job: SyncJob): void {
  job.plan = null;
  job.facts = null;
  job.error = "";
  job.phase = "idle";
}

/**
 * Stop the session's work and forget it — part of the tab teardown. A tab handed
 * to another window (`keepRun`) leaves its run going: that window shows it now.
 */
export function removeSyncJob(sessionId: string, keepRun = false): void {
  const job = jobs[sessionId];
  if (!job) return;
  if (job.comparing) stopCompare(job);
  if (job.applying && !keepRun) void sftpCancel(job.runId);
  if (syncRunOwner.sessionId === sessionId) syncRunOwner.sessionId = null;
  delete jobs[sessionId];
}

/** Test hook. */
export function resetSyncJobs(): void {
  for (const id of Object.keys(jobs)) delete jobs[id];
  syncRunOwner.sessionId = null;
}

/** Fold a `sync://scan` count into whichever job's compare it belongs to. */
export function applyScanProgress(p: { id: string; files: number }): void {
  const [base, side] = splitScanId(p.id);
  for (const job of Object.values(jobs)) {
    if (job.comparing && job.compareId === base && (side === "local" || side === "remote")) {
      job.scan[side] = p.files;
    }
  }
}

function splitScanId(id: string): [string, string] {
  const i = id.lastIndexOf(":");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

/** A hashing failure in words — never shown as an empty folder (see sync.rs). */
function errorText(err: string): string {
  const v = syncErrorView(err);
  if (v.key === "sync.errDirUnreadable") return t(v.key, { path: v.path });
  if (v.key) return t(v.key);
  return v.raw;
}

function cancelCompareIds(id: string) {
  void sftpCancel(`${id}:local`);
  void sftpCancel(`${id}:remote`);
}

/** Hash both sides and build the plan. A stopped compare's late result is dropped. */
export async function compare(sessionId: string): Promise<void> {
  const job = syncJob(sessionId);
  if (!job.localPath || !job.remote || job.comparing || job.applying) return;
  const id = `sync-cmp-${crypto.randomUUID()}`;
  job.compareId = id;
  job.comparing = true;
  job.error = "";
  job.scan = { local: 0, remote: 0 };
  const excludes = parseExcludes(job.excludeText);
  try {
    const [local, rem] = await Promise.all([
      localHashTree(job.localPath, excludes, `${id}:local`),
      sftpHashTree(sessionId, job.remote, excludes, `${id}:remote`),
    ]);
    if (job.compareId !== id) return; // stopped meanwhile
    job.plan = diffTrees(local.entries, rem.entries, job.direction, excludes, job.deleteExtraneous);
    job.facts = planFacts(
      local.entries,
      rem.entries,
      job.direction,
      excludes,
      local.excluded + rem.excluded,
    );
    job.skipped = { local: local.skipped, remote: rem.skipped };
    job.phase = "idle";
    if (!job.dialogOpen) notifyInfo(t("sync.compareReadyBg", { n: job.plan.length }));
  } catch (e) {
    // One side failed: the other would only burn time for a plan nobody gets.
    cancelCompareIds(id);
    if (job.compareId !== id || isCancelled(String(e))) return;
    job.error = errorText(String(e));
    job.plan = null;
    job.facts = null;
    if (!job.dialogOpen) notifyError(job.error);
  } finally {
    if (job.compareId === id) {
      job.comparing = false;
      job.compareId = "";
    }
  }
}

/** Stop the compare in flight; its result, if it still arrives, is dropped. */
export function stopCompare(job: SyncJob): void {
  const id = job.compareId;
  job.compareId = "";
  job.comparing = false;
  if (id) cancelCompareIds(id);
}

/**
 * Start the compared plan. Resolves once the backend has it — or refused it;
 * how the run goes is told by `runHeard`.
 */
export async function apply(sessionId: string): Promise<void> {
  const job = syncJob(sessionId);
  const toApply = job.plan ? applicable(job.plan) : [];
  if (toApply.length === 0 || job.applying || otherRunHolds(sessionId)) return;
  job.applying = true;
  job.stopping = false;
  job.phase = "running";
  job.runId = `sync-run-${crypto.randomUUID()}`;
  job.runTotal = toApply.length;
  syncRunOwner.sessionId = sessionId;
  clearSyncRun();
  try {
    await sftpSyncStart(sessionId, job.runId, job.localPath, job.remote, toApply);
  } catch (e) {
    const err = String(e);
    job.applying = false;
    job.stopping = false;
    if (isSyncBusy(err)) {
      // Refused before it started (a run in another window holds the slot): the
      // plan is untouched, so this is not a stopped run.
      job.phase = "idle";
      notifyError(t("sync.otherRunning"));
    } else {
      job.phase = "stopped";
      notifyError(err);
    }
  }
}

/**
 * The backend told how a run stands (`sync://run`, to the window that shows
 * its session). Its end is taken once — the same end may also come as the
 * answer to `syncRunOf` after the tab moved here.
 */
export function runHeard(view: SyncRunView): void {
  const job = jobs[view.sessionId];
  if (!job || job.runId !== view.runId) return;
  if (view.state === "running") {
    job.applying = true;
    job.phase = "running";
    syncRunOwner.sessionId = view.sessionId;
    return;
  }
  if (!job.applying) return;
  job.applying = false;
  job.stopping = false;
  // What the run wrote is listed again by any panel showing it — in whichever
  // window the tab is now (the dialog that started the run may be long gone).
  touchDir(view.sessionId, job.remote);
  const cwd = dockCwd(view.sessionId);
  if (cwd && cwd !== job.remote) touchDir(view.sessionId, cwd);
  const stats = view.stats;
  if (view.state === "stopped") {
    // The ticked rows ARE the report of what got through, and the plan is stale
    // afterwards — keep both until the user compares again.
    job.phase = "stopped";
    notifyInfo(
      t("sync.stoppedToast", {
        done: stats.uploaded + stats.downloaded + stats.deleted,
        total: job.runTotal,
      }),
    );
    return;
  }
  if (view.state === "failed") {
    job.phase = "stopped";
    notifyError(view.error ?? "");
    return;
  }
  // Drop the finished plan: re-opening would otherwise redraw every row of it.
  job.plan = null;
  job.facts = null;
  job.phase = "done";
  notifySuccess(t("sync.applied", { up: stats.uploaded, down: stats.downloaded, del: stats.deleted }));
}

/** Another session's run is going on and holds the (single) progress feed. */
export function otherRunHolds(sessionId: string): boolean {
  const owner = syncRunOwner.sessionId;
  return !!owner && owner !== sessionId && !!jobs[owner]?.applying;
}

/** Ask the backend to stop the run after the file currently in flight. */
export function stopRun(job: SyncJob): void {
  if (!job.runId || !job.applying) return;
  job.stopping = true;
  void sftpCancel(job.runId);
}
