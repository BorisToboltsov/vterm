// Pure directory-sync logic (Phase 12.5): diff a local vs remote hash tree under a
// chosen direction + exclude patterns, producing the list of actions to apply.
// Hashing and applying live in the backend; this module is the testable core.

export interface HashEntry {
  path: string;
  sha256: string;
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
