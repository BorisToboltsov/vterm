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
  k8sScope: K8sScopeState | null;
  /** Active sub-tab per driver panel (`"changes"`, `"images"`, `"pods"`, …). */
  sub: Partial<Record<SubTabPanel, string>>;
}

const sessions = $state<Record<string, DockSessionState>>({});

function empty(): DockSessionState {
  return { files: null, k8sScope: null, sub: {} };
}

/**
 * The dock state for `sessionId`, created empty on first access. Returns a
 * reactive object, so a panel can both read it on mount and write to it as the
 * user works — no explicit save step.
 */
export function dockState(sessionId: string): DockSessionState {
  return (sessions[sessionId] ??= empty());
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
