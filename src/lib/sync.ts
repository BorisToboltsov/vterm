// Pure directory-sync logic (Phase 12.5): diff a local vs remote hash tree under a
// chosen direction + exclude patterns, producing the list of actions to apply.
// Hashing and applying live in the backend; this module is the testable core.

export interface HashEntry {
  path: string;
  sha256: string;
}

/**
 * One side of a sync as the backend hashed it (`sync::HashTree`). `skipped` counts
 * files and folders that could not be read — they are absent from the plan, and the
 * dialog has to say so rather than let "nothing to do" stand for them.
 */
export interface HashTree {
  entries: HashEntry[];
  skipped: number;
}

export type SyncDirection = "push" | "pull" | "bi";

/** Actionable ops are applied by the backend; `conflict` is shown but skipped. */
export type SyncOp = "upload" | "download" | "deleteRemote" | "deleteLocal" | "conflict";
export type SyncReason = "new" | "changed" | "removed" | "conflict";

export interface SyncAction {
  path: string;
  op: SyncOp;
  reason: SyncReason;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deleted: number;
  /** The user stopped the run: the counts above are partial. */
  stopped: boolean;
}

/** One content-search hit (grep over SSH). */
export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** Translate a single glob (`*`, `?`) into an anchored regex (no `/` crossing). */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** A matcher for one exclude pattern (gitignore-lite). */
function toMatcher(pattern: string): (path: string) => boolean {
  // No slash → match any single path segment (so `.git` / `*.tfstate` hit anywhere).
  if (!pattern.includes("/")) {
    const rx = globToRegex(pattern);
    return (path) => path.split("/").some((seg) => rx.test(seg));
  }
  // Has a slash → match the relative path (and everything under it, for a dir).
  const pat = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const rx = globToRegex(pat);
  return (path) => rx.test(path) || path.startsWith(pat + "/");
}

/**
 * Build a predicate that is true for paths matching any exclude pattern. Blank
 * lines / whitespace are ignored; an empty list excludes nothing.
 */
export function compileExclude(patterns: string[]): (path: string) => boolean {
  const compiled = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map(toMatcher);
  return (path) => compiled.some((m) => m(path));
}

/** Split a textarea of exclude patterns (newline/comma separated) into a list. */
export function parseExcludes(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Diff the two trees and return the actions to perform. `bi` adds files missing on
 * either side but flags content differences as conflicts (hash alone can't pick a
 * winner). `deleteExtraneous` enables removing files absent from the source side.
 */
export function diffTrees(
  local: HashEntry[],
  remote: HashEntry[],
  direction: SyncDirection,
  excludes: string[],
  deleteExtraneous: boolean,
): SyncAction[] {
  const excluded = compileExclude(excludes);
  const localMap = new Map(local.filter((e) => !excluded(e.path)).map((e) => [e.path, e.sha256]));
  const remoteMap = new Map(remote.filter((e) => !excluded(e.path)).map((e) => [e.path, e.sha256]));

  const actions: SyncAction[] = [];
  const paths = new Set([...localMap.keys(), ...remoteMap.keys()]);
  for (const path of paths) {
    const l = localMap.get(path);
    const r = remoteMap.get(path);
    if (l !== undefined && r !== undefined) {
      if (l === r) continue; // identical → nothing to do
      if (direction === "push") actions.push({ path, op: "upload", reason: "changed" });
      else if (direction === "pull") actions.push({ path, op: "download", reason: "changed" });
      else actions.push({ path, op: "conflict", reason: "conflict" });
    } else if (l !== undefined) {
      // Local only.
      if (direction === "push" || direction === "bi")
        actions.push({ path, op: "upload", reason: "new" });
      else if (deleteExtraneous) actions.push({ path, op: "deleteLocal", reason: "removed" });
    } else {
      // Remote only.
      if (direction === "pull" || direction === "bi")
        actions.push({ path, op: "download", reason: "new" });
      else if (deleteExtraneous) actions.push({ path, op: "deleteRemote", reason: "removed" });
    }
  }
  actions.sort((a, b) => a.path.localeCompare(b.path));
  return actions;
}

/** The subset of a plan the backend will actually apply (conflicts are skipped). */
export function applicable(actions: SyncAction[]): SyncAction[] {
  return actions.filter((a) => a.op !== "conflict");
}

// ── run progress (Phase 39.8) ─────────────────────────────────────────────────

/**
 * Transfer id for one file of a sync run. Mirrors `sync::sync_transfer_id` in
 * [sync.rs](../../src-tauri/src/sync.rs) — the two must agree byte for byte, since
 * this is the only link between an `sftp://progress` event and the plan row that
 * drew it (the event's `name` is a base name and collides across folders).
 */
export function syncTransferId(path: string): string {
  return `sync:${path}`;
}

/** Whether a run is under way, and if not, how it ended. */
export type SyncRunPhase = "idle" | "running" | "stopped" | "done";

/**
 * What one plan row shows. `skipped` is a conflict (never applied), `notRun` is a
 * row the user's stop got to first — deliberately distinct from `pending`, so a
 * stopped run reads as "not done" rather than "still coming".
 */
export type SyncRowStatus = "pending" | "running" | "done" | "skipped" | "notRun";

/** Minimal shape of a progress event this module folds over (see `SftpProgress`). */
export interface SyncProgress {
  transferred: number;
  total: number;
  done: boolean;
}

/** Per-file progress of a run, keyed by {@link syncTransferId}. */
export type SyncProgressMap = Record<string, SyncProgress>;

/** Row status from the run phase plus whatever progress has arrived for it. */
export function syncRowStatus(
  op: SyncOp,
  progress: SyncProgress | undefined,
  phase: SyncRunPhase,
): SyncRowStatus {
  if (op === "conflict") return "skipped";
  if (progress?.done) return "done";
  if (progress) return "running";
  return phase === "stopped" || phase === "done" ? "notRun" : "pending";
}

/** Row completion in percent (0–100); a zero-byte total counts as complete. */
export function syncRowPct(progress: SyncProgress | undefined): number {
  if (!progress) return 0;
  if (progress.done) return 100;
  if (progress.total <= 0) return 0;
  return Math.min(100, Math.round((progress.transferred / progress.total) * 100));
}

export interface SyncRunSummary {
  /** Files finished, out of the applicable (non-conflict) plan. */
  filesDone: number;
  filesTotal: number;
  /** Overall percent, weighted by bytes where known and by files otherwise. */
  pct: number;
}

/**
 * Roll the per-file progress up into the dialog's header line. Files whose size
 * isn't known yet (nothing transferred, or a delete with no bytes at all) count as
 * one whole file each, so the bar can't stall at 0 % on a plan full of deletes.
 */
export function syncRunSummary(
  actions: SyncAction[],
  progress: SyncProgressMap,
): SyncRunSummary {
  const rows = applicable(actions);
  let done = 0;
  let fraction = 0;
  for (const a of rows) {
    const p = progress[syncTransferId(a.path)];
    if (p?.done) {
      done++;
      fraction += 1;
    } else if (p && p.total > 0) {
      fraction += Math.min(1, p.transferred / p.total);
    }
  }
  return {
    filesDone: done,
    filesTotal: rows.length,
    pct: rows.length === 0 ? 0 : Math.round((fraction / rows.length) * 100),
  };
}

/** Count actions by op, for the preview summary. */
export function summarize(actions: SyncAction[]): Record<SyncOp, number> {
  const out: Record<SyncOp, number> = {
    upload: 0,
    download: 0,
    deleteRemote: 0,
    deleteLocal: 0,
    conflict: 0,
  };
  for (const a of actions) out[a.op]++;
  return out;
}

// ── what an empty or one-sided plan means (v1.0.24) ─────────────────────────────

/** Counts behind a plan, after excludes — what the verdict and warnings read. */
export interface PlanFacts {
  localFiles: number;
  remoteFiles: number;
  /** Distinct paths (either side) dropped by an exclude pattern. */
  excluded: number;
  /**
   * Files that exist only on the target side of a one-way sync — what
   * delete-extraneous would remove. Always 0 for `bi`, which has no target side.
   */
  extraneous: number;
}

export function planFacts(
  local: HashEntry[],
  remote: HashEntry[],
  direction: SyncDirection,
  excludes: string[],
): PlanFacts {
  const excluded = compileExclude(excludes);
  const drop = new Set<string>();
  const keep = (list: HashEntry[]) =>
    new Set(
      list
        .filter((e) => {
          if (!excluded(e.path)) return true;
          drop.add(e.path);
          return false;
        })
        .map((e) => e.path),
    );
  const l = keep(local);
  const r = keep(remote);
  const onlyIn = (a: Set<string>, b: Set<string>) => [...a].filter((p) => !b.has(p)).length;
  const extraneous = direction === "push" ? onlyIn(r, l) : direction === "pull" ? onlyIn(l, r) : 0;
  return { localFiles: l.size, remoteFiles: r.size, excluded: drop.size, extraneous };
}

/**
 * Why a compared plan came out empty. "Already in sync" is only one of four
 * answers, and saying it for the other three is the plausible stub principle 5
 * forbids: two empty folders are not "in sync", a filter that ate everything
 * compared nothing, and target-only files the user chose to keep still differ.
 */
export type EmptyPlanReason = "bothEmpty" | "allExcluded" | "onlyExtraneous" | "identical";

export function emptyPlanReason(f: PlanFacts): EmptyPlanReason {
  if (f.localFiles + f.remoteFiles === 0) return f.excluded > 0 ? "allExcluded" : "bothEmpty";
  // Reached only with delete-extraneous off: with it on, these would be actions.
  if (f.extraneous > 0) return "onlyExtraneous";
  return "identical";
}

/**
 * The plan would empty the target side: the source is empty and delete-extraneous
 * is on, so every target file is queued for deletion. A legitimate plan, but one
 * that a wrong folder pick produces just as readily — so it gets a red line.
 * Returns the source side, or null when the plan is not a wipe.
 */
export function wipesTarget(
  f: PlanFacts,
  direction: SyncDirection,
  deleteExtraneous: boolean,
): "local" | "remote" | null {
  if (!deleteExtraneous || direction === "bi") return null;
  if (direction === "push") return f.localFiles === 0 && f.remoteFiles > 0 ? "local" : null;
  return f.remoteFiles === 0 && f.localFiles > 0 ? "remote" : null;
}

/** Everything that decides whether Compare / Apply can run right now. */
export interface SyncButtonState {
  localPath: string;
  remotePath: string;
  hasPlan: boolean;
  applicableCount: number;
  conflictCount: number;
  phase: SyncRunPhase;
  busy: boolean;
}

/**
 * Why Compare and Apply are disabled, as i18n keys (null = enabled). A greyed-out
 * button with no reason is the "everything is blurred and nothing explains it"
 * report this exists to answer; `busy` needs no text, the button says it itself.
 */
export function syncBlockReasons(s: SyncButtonState): {
  compare: "sync.needLocal" | "sync.needRemote" | null;
  apply:
    | "sync.needLocal"
    | "sync.needRemote"
    | "sync.needCompare"
    | "sync.compareAfterStop"
    | "sync.onlyConflicts"
    | "sync.nothingToApply"
    | null;
} {
  const compare = !s.localPath ? "sync.needLocal" : !s.remotePath ? "sync.needRemote" : null;
  let apply: ReturnType<typeof syncBlockReasons>["apply"] = null;
  if (compare) apply = compare;
  else if (!s.hasPlan) apply = "sync.needCompare";
  else if (s.phase === "stopped") apply = "sync.compareAfterStop";
  else if (s.applicableCount === 0)
    apply = s.conflictCount > 0 ? "sync.onlyConflicts" : "sync.nothingToApply";
  return { compare, apply };
}

/**
 * Map a hashing error from the backend to a localizable message. The markers come
 * from `AppError`'s `Display` (`sync-dir-unreadable: cannot read folder <path>`,
 * `hash-tool-missing`, `hash-incomplete`); anything else is shown as is.
 */
export function syncErrorView(
  err: string,
):
  | { key: "sync.errDirUnreadable"; path: string }
  | { key: "sync.errHashTool" | "sync.errIncomplete" }
  | { key: null; raw: string } {
  const dir = /sync-dir-unreadable: cannot read folder (.*)$/s.exec(err);
  if (dir) return { key: "sync.errDirUnreadable", path: dir[1] };
  if (err.includes("hash-tool-missing")) return { key: "sync.errHashTool" };
  if (err.includes("hash-incomplete")) return { key: "sync.errIncomplete" };
  return { key: null, raw: err };
}

/** The folders a remote-folder picker lists: directories only, by name. */
export function pickerDirs<T extends { name: string; isDir: boolean }>(entries: T[]): T[] {
  return entries
    .filter((e) => e.isDir && e.name !== "." && e.name !== "..")
    .sort((a, b) => a.name.localeCompare(b.name));
}
