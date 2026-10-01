// Per-session right-dock state (v1.0.14).
//
// Why this store exists. The dock's panels used to be destroyed on every switch —
// `{#key activeTab}` inside RightDock for a dock-tab switch, `{#key activeId}`
// around the whole dock for a terminal-tab switch. Component-local `$state` dies
// with the component, so coming back meant: the SFTP panel offering its Connect
// button again (the SFTP channel itself was still open on the session — see
// `SshSession::sftp`, which caches it until `disconnect`), the file panel jumping
// back to home, and the k8s panel forgetting the context/namespace the user had
// picked. Not remounting on a dock-tab switch (RightDock keeps visited panels
// mounted) fixes the first half; this store carries the rest across the terminal-tab
// switch, which does remount.
//
// Deliberately small: only what a user would have to redo by hand. Scroll offsets,
// selections and open modals are not worth persisting — they are cheap to recreate
// and would age badly against a directory that changed underneath them.
//
// Keyed by `sessionId`, so it is one of the stores `closeTabFully` has to drop —
// `tabteardown.guard.test.ts` enforces that.

/** Where a file panel (SFTP or local) was left off. */
export interface FilesDockState {
  /** SFTP transport was open. Always true for the local panel, which needs no connect. */
  connected: boolean;
  /** Directory that was listed last — restored instead of re-resolving home. */
  cwd: string;
  /** Home path resolved on connect, kept so `~` expansion survives the remount. */
  home: string;
}

/** The k8s scope selection — the one thing that is genuinely tedious to re-pick. */
export interface K8sScopeState {
  context: string | null;
  namespace: string | null;
  allNamespaces: boolean;
}

/** Dock tabs that own a sub-tab strip. */
export type SubTabPanel = "git" | "docker" | "k8s";

export interface DockSessionState {
  files: FilesDockState | null;
  /**
   * The dock's shared working directory (v1.0.24) — the one folder the file panel
   * and git agree on. Written by the file panel on every successful listing and,
   * while "follow terminal" is on, by the terminal's cwd; git only reads it. Kept
   * separate from `files` because it outlives an SFTP disconnect and is set by the
   * terminal before the file panel was ever opened. null = nothing known yet.
   */
  cwd: string | null;
  k8sScope: K8sScopeState | null;
  /** Active sub-tab per driver panel (`"changes"`, `"images"`, `"pods"`, …). */
  sub: Partial<Record<SubTabPanel, string>>;
  /** Upload batches still running, per destination directory. */
  uploads: Record<string, number>;
  /**
   * Per directory, bumped when the LAST running upload batch into it finishes
   * (v1.0.42). The panel that started an upload can be gone by then — the dock is
   * remounted on every terminal-tab switch, and a remounted panel lists the folder
   * at once, before the upload ended — so "re-list after upload" can't live in the
   * component that started it. Any mounted panel showing the directory re-lists on
   * a bump; a hidden one re-lists when it comes back into view anyway.
   */
  dirRev: Record<string, number>;
}

const sessions = $state<Record<string, DockSessionState>>({});

function empty(): DockSessionState {
  return { files: null, cwd: null, k8sScope: null, sub: {}, uploads: {}, dirRev: {} };
}

/**
 * The dock state for `sessionId`, created empty on first access. Returns a
 * reactive object, so a panel can both read it on mount and write to it as the
 * user works — no explicit save step.
 */
export function dockState(sessionId: string): DockSessionState {
  // Read back through the store: `??=` evaluates to the raw object, and writes to
  // it bypass the reactive proxy (Svelte warns about exactly this).
  if (!sessions[sessionId]) sessions[sessionId] = empty();
  return sessions[sessionId];
}

/**
 * The shared dock directory, read-only: safe inside `$derived`, where `dockState`
 * (which creates the entry) would be a state write during a read.
 */
export function dockCwd(sessionId: string): string | null {
  return sessions[sessionId]?.cwd ?? null;
}

/** Move the shared dock directory — the file panel's listing or the followed terminal. */
export function setDockCwd(sessionId: string, path: string): void {
  const s = dockState(sessionId);
  if (s.cwd !== path) s.cwd = path;
}

/** An upload batch into `dir` started — the listing is about to go stale. */
export function beginUpload(sessionId: string, dir: string): void {
  const s = dockState(sessionId);
  s.uploads[dir] = (s.uploads[dir] ?? 0) + 1;
}

/**
 * An upload batch into `dir` ended (success, failure or cancel alike). Only the
 * last of the overlapping batches bumps the directory's revision, so fifty files —
 * or two batches started back to back — re-list the panel once, at the end.
 */
export function endUpload(sessionId: string, dir: string): void {
  const s = dockState(sessionId);
  const left = (s.uploads[dir] ?? 1) - 1;
  if (left > 0) {
    s.uploads[dir] = left;
    return;
  }
  delete s.uploads[dir];
  s.dirRev[dir] = (s.dirRev[dir] ?? 0) + 1;
}

/** The directory's upload revision, read-only (safe inside `$derived`/`$effect`). */
export function dirRevision(sessionId: string, dir: string): number {
  return sessions[sessionId]?.dirRev[dir] ?? 0;
}

/** Drop everything this session's dock remembered (part of the tab teardown). */
export function removeDockState(sessionId: string): void {
  delete sessions[sessionId];
}

/** Read the stored sub-tab, or `fallback` when this session has none yet. */
export function storedSub<T extends string>(
  sessionId: string,
  panel: SubTabPanel,
  fallback: T,
): T {
  return (dockState(sessionId).sub[panel] as T | undefined) ?? fallback;
}

/** Remember the sub-tab a driver panel is showing. */
export function rememberSub(sessionId: string, panel: SubTabPanel, sub: string): void {
  dockState(sessionId).sub[panel] = sub;
}

/** Reset every session's dock state (tests, and a potential "reset UI" action). */
export function resetDockState(): void {
  for (const id of Object.keys(sessions)) delete sessions[id];
}
