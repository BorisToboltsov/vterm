// Per-session dock state (v1.0.14).
//
// Why this store exists. The dock's panels used to be destroyed on every switch —
// `{#key activeTab}` inside the dock for a dock-tab switch, `{#key activeId}`
// around the whole dock for a terminal-tab switch. Component-local `$state` dies
// with the component, so coming back meant: the SFTP panel offering its Connect
// button again (the SFTP channel itself was still open on the session — see
// `SshSession::sftp`, which caches it until `disconnect`), the file panel jumping
// back to home, and the k8s panel forgetting the context/namespace the user had
// picked. Not remounting on a dock-tab switch (Dock.svelte keeps visited panels
// mounted) fixes the first half; this store carries the rest across the terminal-tab
// switch — which does rebuild the session panels — and, since v1.1, across a move
// of the panel to another dock, which rebuilds it too.
//
// Deliberately small: only what a user would have to redo by hand. Selections and
// open modals are not worth persisting — they are cheap to recreate and would age
// badly against a directory that changed underneath them. Since v1.34 what stands
// beside a driver panel's list (a container's, a pod's, a node's details and their
// view), how its log is read — scroll included — and the file panel's content
// search are kept: a terminal-tab switch used to drop a log mid-read and the
// results of a search that took a minute.
//
// Keyed by `sessionId`, so it is one of the stores `closeTabFully` has to drop —
// `tabteardown.guard.test.ts` enforces that.

import { NO_FILTER, type ListFilter } from "../ui/listview";
import { freshLogView, type LogView } from "../ui/loglines";
import type { DockerDetailTab } from "../docker/docker";
import type { DockerItem } from "../docker/dockeritems";
import type { K8sDetailTab, K8sWorkload, K8sWorkloadTab } from "../k8s/k8s";
import type { GrepOutcome } from "../sync/sync";

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

/**
 * Dock tabs that own a sub-tab strip — and, since v1.5, the two sub-tabs that
 * have a view switch of their own (k8s Network: list / route, Docker networks:
 * list / graph). Same kind of choice, so it is remembered the same way.
 */
export type SubTabPanel = "git" | "docker" | "k8s" | "k8sNet" | "dockerNet";

/**
 * What a list of the session is narrowed to and which of its groups are folded
 * (v1.29, ADR 0050). Per session, unlike the list's order: the containers looked
 * for on one server are not the ones looked for on the next.
 */
export interface ListSessionState {
  filter: ListFilter;
  collapsed: string[];
}

/** The driver panels whose details stand beside their list (v1.34). */
export type AsidePanel = "docker" | "k8s";

/** What the Docker panel had open beside its list: a container's details in a view, or an image, network, volume, stack. */
export type DockerAside = { kind: "container"; id: string; tab: DockerDetailTab } | { kind: "item"; item: DockerItem };

/** What the k8s panel had open beside its list: a pod (and the container picked in it), a workload, a node. */
export type K8sAside =
  | { kind: "pod"; namespace: string; name: string; tab: K8sDetailTab; container: string | null }
  | { kind: "workload"; workload: K8sWorkload["kind"]; namespace: string; name: string; tab: K8sWorkloadTab }
  | { kind: "node"; name: string; tab: K8sWorkloadTab };

interface AsideOf {
  docker: DockerAside;
  k8s: K8sAside;
}

/** The file panel's content search (v1.34): the question as typed, and the answer on screen with what it was asked. */
export interface FileSearchState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  outcome: GrepOutcome | null;
  /** What the results on screen were searched for: the field may have been edited since. */
  searched: { query: string; caseSensitive: boolean; regex: boolean; dir: string; limit: number };
}

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
  /** Active sub-tab per driver panel (`"changes"`, `"images"`, `"pods"`, …) and view per sub-tab. */
  sub: Partial<Record<SubTabPanel, string>>;
  /**
   * Per directory, bumped when a transfer into it ends (v1.0.42; since v1.12 —
   * when the backend says the job has ended, `stores/transfers`). The panel that
   * started a transfer can be gone by then — the dock is remounted on every
   * terminal-tab switch, and a remounted panel lists the folder at once, before
   * the transfer ended — so "re-list after upload" can't live in the component
   * that started it. Any mounted panel showing the directory re-lists on a bump;
   * a hidden one re-lists when it comes back into view anyway.
   */
  dirRev: Record<string, number>;
  /** Per list (`ListId` of `stores/listview`), its filter and folded groups. */
  lists: Record<string, ListSessionState>;
  /** What stands beside each driver panel's list (v1.34); absent — nothing. */
  aside: Partial<{ [P in AsidePanel]: AsideOf[P] }>;
  /** How each driver panel's log is read (v1.34). */
  logs: Partial<Record<AsidePanel, LogView>>;
  /** The file panel's content search (v1.34); null — none asked yet. */
  search: FileSearchState | null;
}

const sessions = $state<Record<string, DockSessionState>>({});

function empty(): DockSessionState {
  return { files: null, cwd: null, k8sScope: null, sub: {}, dirRev: {}, lists: {}, aside: {}, logs: {}, search: null };
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

/**
 * A transfer into `dir` has ended (done, failed or stopped alike — some of its
 * files may have landed): the listing of that folder is stale. One bump per
 * job, so fifty files re-list the panel once, at the end.
 */
export function touchDir(sessionId: string, dir: string): void {
  const s = dockState(sessionId);
  s.dirRev[dir] = (s.dirRev[dir] ?? 0) + 1;
}

/** The directory's revision, read-only (safe inside `$derived`/`$effect`). */
export function dirRevision(sessionId: string, dir: string): number {
  return sessions[sessionId]?.dirRev[dir] ?? 0;
}

/** What the session's dock remembers, as stored; null when nothing yet. */
export function peekDockState(sessionId: string): DockSessionState | null {
  return sessions[sessionId] ?? null;
}

/**
 * Take over the dock state of a tab moved here from another window (ADR 0017):
 * the file panel's connection and folder, the k8s scope, the sub-tabs. A
 * transfer under way is not part of it — it is the backend's, and its events
 * follow the tab (`stores/transfers`).
 */
export function adoptDockState(sessionId: string, state: DockSessionState): void {
  sessions[sessionId] = { ...empty(), ...state, dirRev: {} };
}

/**
 * Put back what a tab's dock remembered at the end of the previous launch
 * (v1.36, ADR 0057): its shared folder, the file panel's folder — it lists it
 * once the session is open, and falls back to its empty start if the folder is
 * gone — and the k8s scope, which the panel checks against the kubeconfig
 * before it uses it. Nothing else: what stood beside a list and how a log was
 * read belong to a session that ended.
 */
export function restoreDockState(
  sessionId: string,
  saved: { cwd?: string; files?: { cwd: string; home: string }; k8s?: K8sScopeState },
): void {
  if (sessions[sessionId]) return;
  const s = empty();
  if (saved.cwd) s.cwd = saved.cwd;
  if (saved.files) s.files = { connected: true, cwd: saved.files.cwd, home: saved.files.home };
  if (saved.k8s) s.k8sScope = { ...saved.k8s };
  sessions[sessionId] = s;
}

/**
 * A folder the session's file panel is asked to open (v1.24: a folder named
 * in terminal output was clicked). Held here, not in the panel: the panel may
 * not be mounted yet — opening the "Files" tab mounts it, and it takes the
 * request then — and a panel of another session must not take it.
 */
const openDirs = $state<Record<string, string>>({});

export function requestFilesDir(sessionId: string, path: string): void {
  openDirs[sessionId] = path;
}

/** The folder waiting for the session's file panel, read-only (reactive). */
export function pendingFilesDir(sessionId: string | null): string | null {
  return sessionId ? (openDirs[sessionId] ?? null) : null;
}

/** Take the waiting folder off — the panel is opening it now. */
export function takeFilesDir(sessionId: string): string | null {
  const path = openDirs[sessionId] ?? null;
  delete openDirs[sessionId];
  return path;
}

/** Drop everything this session's dock remembered (part of the tab teardown). */
export function removeDockState(sessionId: string): void {
  delete sessions[sessionId];
  delete openDirs[sessionId];
}

function listState(sessionId: string, list: string): ListSessionState {
  const s = dockState(sessionId);
  if (!s.lists[list]) s.lists[list] = { filter: NO_FILTER, collapsed: [] };
  return s.lists[list];
}

/** What the session's list is narrowed to, read-only (safe inside `$derived`). */
export function listFilter(sessionId: string, list: string): ListFilter {
  return sessions[sessionId]?.lists[list]?.filter ?? NO_FILTER;
}

export function setListFilter(sessionId: string, list: string, filter: ListFilter): void {
  listState(sessionId, list).filter = filter;
}

/** The keys of the session's folded groups of the list, read-only. */
export function collapsedGroups(sessionId: string, list: string): readonly string[] {
  return sessions[sessionId]?.lists[list]?.collapsed ?? [];
}

/** Fold or unfold one group — or, given several keys, those (the «View» menu's fold all). */
export function setGroupsCollapsed(sessionId: string, list: string, keys: readonly string[], collapsed: boolean): void {
  const state = listState(sessionId, list);
  const rest = state.collapsed.filter((k) => !keys.includes(k));
  state.collapsed = collapsed ? [...rest, ...keys] : rest;
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

/** What the panel had open beside its list, read-only (safe inside `$derived`). */
export function keptAside<P extends AsidePanel>(sessionId: string, panel: P): AsideOf[P] | null {
  return (sessions[sessionId]?.aside[panel] as AsideOf[P] | undefined) ?? null;
}

/** Remember what the panel has open beside its list now; null — nothing. Written only when it changed. */
export function keepAside<P extends AsidePanel>(sessionId: string, panel: P, next: AsideOf[P] | null): void {
  const s = dockState(sessionId);
  const was = s.aside[panel] ?? null;
  if (JSON.stringify(was) === JSON.stringify(next)) return;
  if (next) s.aside[panel] = next;
  else delete s.aside[panel];
}

/**
 * How the panel's log is read — the store's own object, created fresh on first
 * use. The log reads and writes it in place, so a detail rebuilt across the width
 * threshold or after a terminal-tab switch picks it up where it was.
 */
export function logView(sessionId: string, panel: AsidePanel): LogView {
  const s = dockState(sessionId);
  if (!s.logs[panel]) s.logs[panel] = freshLogView();
  return s.logs[panel];
}

/**
 * The session's content search — the store's own object, created closed on first
 * use. The file panel reads and writes it in place: results survive the panel
 * being rebuilt by a terminal-tab switch.
 */
export function fileSearch(sessionId: string): FileSearchState {
  const s = dockState(sessionId);
  if (!s.search) {
    s.search = {
      open: false,
      query: "",
      caseSensitive: false,
      regex: false,
      outcome: null,
      searched: { query: "", caseSensitive: false, regex: false, dir: "", limit: 0 },
    };
  }
  return s.search;
}

/** Reset every session's dock state (tests, and a potential "reset UI" action). */
export function resetDockState(): void {
  for (const id of Object.keys(sessions)) delete sessions[id];
  for (const id of Object.keys(openDirs)) delete openDirs[id];
}
