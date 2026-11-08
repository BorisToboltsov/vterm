// Tabs across a restart (v1.6, ADR 0019): what is written down of a window's
// tabs, how it is read back, and which of the tabs that came back may open
// their session without being asked.
//
// A session cannot be restored — its process ended with the app, its
// connection is closed. What comes back is the **tab**: what it was (a server,
// a local shell, a shell inside a container), which pane it stood in and what
// that pane showed. Its session is opened anew. Since v1.36 (ADR 0057) the tab
// also brings back where it was: the folder its shell and its dock were in, the
// k8s scope, the files open in it and the zones they stood in, and a grid as a
// grid. Its terminal output and its conversation never go into a slot: they are
// kept — only when the user asked (`restoreOutput`) — by the backend, in
// `tabs/tabcontent.ts`'s shape.
//
// Pure: no runes, no DOM, no storage. The store that reads and writes the slots
// is `stores/tabrestore.svelte.ts`; the page applies the result.

import type { MessageKey } from "../i18n";
import type { IconName } from "../ui/icons";
import { savedLayout, type CenterLayout, type SavedLayout } from "../layout/splitlayout";
import type { DockSessionState, K8sScopeState } from "../stores/dockstate.svelte";
import type { Tab } from "../stores/tabs.svelte";
import type { EditorDoc, Workspace } from "../stores/workspaces.svelte";
import { attachIcon, type TabAttach } from "./tabattach";

// ── The setting ────────────────────────────────────────────────────────────

/**
 * What happens to the tabs of the previous launch:
 * `off` — nothing comes back; `manual` — the tabs come back and wait, each
 * session is opened by its button; `connect` — the tabs come back and those
 * that may (`waitReason`) open their session at once.
 */
export type RestoreMode = "off" | "manual" | "connect";
export const RESTORE_MODES: readonly RestoreMode[] = ["off", "manual", "connect"];
export const DEFAULT_RESTORE_MODE: RestoreMode = "manual";

export const isRestoreMode = (v: unknown): v is RestoreMode =>
  RESTORE_MODES.includes(v as RestoreMode);

// ── What is saved ──────────────────────────────────────────────────────────

/**
 * Bumped when the saved shape changes; a slot of another version is not read.
 * Fields added since (v1.36) are optional: a build before them reads a slot
 * with them and leaves them, and this one reads a slot without them.
 */
export const SAVE_VERSION = 1;

/**
 * A tab as it is written down. Deliberately not `Tab`: the typed secret, the
 * "remember" flag, the status and the terminal snapshot of a tab on its way to
 * another window must never reach the disk — so the record is built field by
 * field (`savedTab`), never by spreading a tab.
 */
export interface SavedTab {
  /** The tab's session id: what the saved layout calls it. */
  id: string;
  kind: "ssh" | "local";
  /** SSH only: the server profile id ("" for a local tab). */
  serverId: string;
  /** The alias at save time — the title until the catalog names the server. */
  alias: string;
  /** A shell inside a container/pod: the target and the argv that enters it. */
  attach?: TabAttach;
  /** The folder the shell last said it was in (OSC 7, or the OS for a local shell). */
  shellCwd?: string;
  /** What the dock remembered of the session: its folder, the file panel's, the k8s scope. */
  dock?: SavedDock;
  /** Files open in the connection — what they are, not what they hold. */
  docs?: SavedDoc[];
  /** The zones of the connection: where the terminal and each file stood. */
  views?: SavedLayout;
}

/** The dock of a tab as it is written down (v1.36). */
export interface SavedDock {
  /** The folder the file panel and Git agree on. */
  cwd?: string;
  /** The file panel was connected, in this folder; `home` is what `~` meant. */
  files?: { cwd: string; home: string };
  k8s?: K8sScopeState;
}

/**
 * A file open in a connection, as it is written down (v1.36): where it is,
 * never its text — what is unsaved is asked about when quitting. A file opened
 * through sudo (the password lives in memory only), a diff against a commit and
 * a new buffer that was never saved are not written down at all.
 */
export interface SavedDoc {
  id: string;
  source: "sftp" | "local";
  path: string;
  name: string;
}

/** One window's tabs and the layout of its centre. */
export interface SavedWindow {
  v: typeof SAVE_VERSION;
  tabs: SavedTab[];
  layout: SavedLayout;
  /** Tabs were tiled into a grid: the layout to go back to (v1.36). */
  beforeTile?: SavedLayout;
}

/** What a window knows of a tab's session besides the tab itself, for `savedTab`. */
export interface TabFacts {
  shellCwd: string | null;
  dock: Pick<DockSessionState, "cwd" | "files" | "k8sScope"> | null;
  workspace: Pick<Workspace, "editors" | "layout"> | null;
}

/** An absolute path, POSIX or Windows (a drive or a UNC share) — not a buffer's bare name. */
export const isAbsolutePath = (path: string): boolean =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");

/** Whether a document is written down: a file opened as it is, through its connection. */
export function keepsDoc(doc: Pick<EditorDoc, "path" | "sudo" | "gitBase">): boolean {
  return !doc.sudo && doc.gitBase === undefined && isAbsolutePath(doc.path);
}

/** More files than this in one connection is not something to reopen at launch. */
export const MAX_SAVED_DOCS = 50;

function copyAttach(a: TabAttach): TabAttach {
  const out: TabAttach = { kind: a.kind, name: a.name, argv: [...a.argv] };
  if (a.image !== undefined) out.image = a.image;
  if (a.container !== undefined) out.container = a.container;
  return out;
}

function savedDock(dock: TabFacts["dock"]): SavedDock | undefined {
  if (!dock) return undefined;
  const out: SavedDock = {};
  if (dock.cwd) out.cwd = dock.cwd;
  if (dock.files?.connected && dock.files.cwd) out.files = { cwd: dock.files.cwd, home: dock.files.home };
  if (dock.k8sScope) {
    const k = dock.k8sScope;
    out.k8s = { context: k.context, namespace: k.namespace, allNamespaces: k.allNamespaces };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The record of a tab — the fields listed here and no others. `facts` adds
 * where the tab was (v1.36); a shell inside a container keeps none of its
 * folders — they are the container's, and it is entered anew.
 */
export function savedTab(
  tab: Pick<Tab, "sessionId" | "kind" | "serverId" | "alias" | "attach">,
  facts?: TabFacts,
): SavedTab {
  const out: SavedTab = {
    id: tab.sessionId,
    kind: tab.kind,
    serverId: tab.kind === "ssh" ? tab.serverId : "",
    alias: tab.alias,
  };
  if (tab.attach) out.attach = copyAttach(tab.attach);
  if (!facts) return out;
  if (!tab.attach && facts.shellCwd) out.shellCwd = facts.shellCwd;
  const dock = tab.attach ? undefined : savedDock(facts.dock);
  if (dock) out.dock = dock;
  const ws = facts.workspace;
  const docs = (ws?.editors ?? [])
    .filter(keepsDoc)
    .slice(0, MAX_SAVED_DOCS)
    .map((d): SavedDoc => ({ id: d.id, source: d.source, path: d.path, name: d.name }));
  if (ws && docs.length > 0) {
    out.docs = docs;
    out.views = savedLayout(ws.layout);
  }
  return out;
}

/** What a window writes into its slot. */
export function savedWindow(
  tabs: readonly Tab[],
  layout: CenterLayout,
  factsOf?: (sessionId: string) => TabFacts,
  beforeTile?: SavedLayout | null,
): SavedWindow {
  const out: SavedWindow = {
    v: SAVE_VERSION,
    tabs: tabs.map((tab) => savedTab(tab, factsOf?.(tab.sessionId))),
    layout: savedLayout(layout),
  };
  if (beforeTile) out.beforeTile = beforeTile;
  return out;
}

// ── The slots ──────────────────────────────────────────────────────────────

/** Every window writes its own slot: `vterm.tabs:main`, `vterm.tabs:win-2`, … */
export const SLOT_PREFIX = "vterm.tabs:";

export const slotKey = (windowLabel: string): string => `${SLOT_PREFIX}${windowLabel}`;

/** The slots of the other windows among the keys of a storage. */
export const otherSlotKeys = (keys: readonly string[], own: string): string[] =>
  keys.filter((key) => key.startsWith(SLOT_PREFIX) && key !== own).sort();

// ── Reading it back ────────────────────────────────────────────────────────

/** More tabs than this in one slot is not something a window wrote. */
export const MAX_SAVED_TABS = 200;
const MAX_TEXT = 512;
const MAX_ARGV = 64;
const MAX_ARG = 4096;
const MAX_PATH = 4096;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Session ids go into event names (`term://out/<id>`), which take few characters. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const text = (v: unknown, max = MAX_TEXT): v is string =>
  typeof v === "string" && v.length <= max && !CONTROL.test(v);

/**
 * A saved attachment, or null when it is not one. Its argv is typed into a
 * shell when the tab is opened, so a damaged record is not repaired — the tab
 * it belongs to is not restored at all.
 */
function parseAttach(raw: unknown): TabAttach | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "container" && raw.kind !== "pod") return null;
  if (!text(raw.name) || raw.name === "") return null;
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) return null;
  if (!argv.every((arg) => text(arg, MAX_ARG) && arg !== "")) return null;
  const out: TabAttach = { kind: raw.kind, name: raw.name, argv: [...(argv as string[])] };
  if (raw.image !== undefined) {
    if (!text(raw.image)) return null;
    out.image = raw.image;
  }
  if (raw.container !== undefined) {
    if (!text(raw.container)) return null;
    out.container = raw.container;
  }
  return out;
}

/** A folder or file path: an absolute one, without control characters. */
const absPath = (v: unknown): v is string => text(v, MAX_PATH) && isAbsolutePath(v);

/** A k8s context or namespace: a name, or null for "the current one". */
const scopeName = (v: unknown): v is string | null => v === null || (text(v) && v !== "");

function parseDock(raw: unknown): SavedDock | undefined {
  if (!isRecord(raw)) return undefined;
  const out: SavedDock = {};
  if (absPath(raw.cwd)) out.cwd = raw.cwd;
  const files = raw.files;
  if (isRecord(files) && absPath(files.cwd) && (files.home === "" || absPath(files.home))) {
    out.files = { cwd: files.cwd, home: files.home as string };
  }
  const k8s = raw.k8s;
  if (isRecord(k8s) && scopeName(k8s.context) && scopeName(k8s.namespace) && typeof k8s.allNamespaces === "boolean") {
    out.k8s = { context: k8s.context, namespace: k8s.namespace, allNamespaces: k8s.allNamespaces };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDocs(raw: unknown): SavedDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedDoc[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of raw.slice(0, MAX_SAVED_DOCS)) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id)) continue;
    if (item.source !== "sftp" && item.source !== "local") continue;
    if (!absPath(item.path) || !text(item.name) || item.name === "") continue;
    const key = `${item.source}:${item.path}`;
    if (ids.has(item.id) || paths.has(key)) continue;
    ids.add(item.id);
    paths.add(key);
    out.push({ id: item.id, source: item.source, path: item.path, name: item.name });
  }
  return out;
}

/**
 * One saved tab, read. What it was is required — a tab that cannot say is not
 * restored; where it was (v1.36) is not: a damaged folder or file list is left
 * out and the tab comes back without it. Nothing of that is run as it is read —
 * a folder goes to the backend, which checks it, or into `cdCommand`, which
 * quotes it.
 */
function parseTab(raw: unknown): SavedTab | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return null;
  if (raw.kind !== "ssh" && raw.kind !== "local") return null;
  const serverId = raw.kind === "ssh" ? raw.serverId : "";
  if (!text(serverId) || (raw.kind === "ssh" && serverId === "")) return null;
  const out: SavedTab = { id: raw.id, kind: raw.kind, serverId, alias: text(raw.alias) ? raw.alias : "" };
  if (raw.attach !== undefined) {
    const attach = parseAttach(raw.attach);
    if (!attach) return null;
    out.attach = attach;
    return out;
  }
  if (absPath(raw.shellCwd)) out.shellCwd = raw.shellCwd;
  const dock = parseDock(raw.dock);
  if (dock) out.dock = dock;
  const docs = parseDocs(raw.docs);
  if (docs.length > 0) {
    out.docs = docs;
    // Rebuilt against the files on the way in (`loadViews`), like the centre's tree.
    if (isRecord(raw.views)) out.views = raw.views as unknown as SavedLayout;
  }
  return out;
}

/**
 * What a slot holds, read — not trusted: it sat in `localStorage`, written by
 * this build, an older one or a newer one. A slot of another version, or one
 * that is not a slot, gives null; a tab that cannot be read is left out. The
 * layout is passed on as it is — `loadLayout` rebuilds it against the tabs.
 */
/** A window's slot, read: its tabs, and its layouts as they were written (rebuilt later). */
export interface ReadWindow {
  tabs: SavedTab[];
  layout: unknown;
  beforeTile: unknown;
}

export function parseSavedWindow(raw: unknown): ReadWindow | null {
  if (!isRecord(raw) || raw.v !== SAVE_VERSION || !Array.isArray(raw.tabs)) return null;
  const tabs: SavedTab[] = [];
  const seen = new Set<string>();
  for (const item of raw.tabs.slice(0, MAX_SAVED_TABS)) {
    const tab = parseTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  return { tabs, layout: raw.layout ?? null, beforeTile: raw.beforeTile ?? null };
}

/** A window of the previous launch, as a reopened window is handed it: its slot, re-written. */
export function windowRecord(win: ReadWindow): string {
  return JSON.stringify({ v: SAVE_VERSION, tabs: win.tabs, layout: win.layout, beforeTile: win.beforeTile });
}

/** The tabs to bring back, and the layout they stood in. */
export interface Restored {
  /** The main window's tabs — each once. */
  tabs: SavedTab[];
  /** The main window's saved layout, unread (`loadLayout` takes it from here). */
  layout: unknown;
  /** The layout before the grid the main window's tabs stood in, unread; null — no grid. */
  beforeTile: unknown;
  /** The other windows of the previous launch that bring tabs back, by label. */
  windows: { label: string; window: ReadWindow }[];
  /** Tabs left out because their server is no longer in the catalog. */
  missing: number;
}

/** The label of a window's slot (`vterm.tabs:win-3` → `win-3`). */
export const slotLabel = (key: string): string => key.slice(SLOT_PREFIX.length);

/**
 * What the main window restores: its own slot and the slots of the windows
 * that were open beside it. Since v1.36 those windows come back too, each with
 * its tabs (`windows`); a window that cannot be opened again gives its tabs to
 * the main one (`withWindows`). A tab whose server is gone is counted, not
 * restored: there is nothing to connect it to. Each session id comes back once,
 * in the first window that names it.
 */
export function restoreSaved(
  main: unknown,
  others: readonly { label: string; raw: unknown }[],
  hasServer: (serverId: string) => boolean,
): Restored {
  const seen = new Set<string>();
  let missing = 0;
  let count = 0;
  const keep = (win: ReadWindow | null): ReadWindow | null => {
    if (!win) return null;
    const tabs: SavedTab[] = [];
    for (const tab of win.tabs) {
      if (seen.has(tab.id) || count >= MAX_SAVED_TABS) continue;
      seen.add(tab.id);
      if (tab.kind === "ssh" && !hasServer(tab.serverId)) {
        missing += 1;
        continue;
      }
      tabs.push(tab);
      count += 1;
    }
    return { ...win, tabs };
  };
  const own = keep(parseSavedWindow(main));
  const windows: Restored["windows"] = [];
  for (const { label, raw } of others) {
    const win = keep(parseSavedWindow(raw));
    if (win && win.tabs.length > 0) windows.push({ label, window: win });
  }
  return {
    tabs: own?.tabs ?? [],
    layout: own?.layout ?? null,
    beforeTile: own?.beforeTile ?? null,
    windows,
    missing,
  };
}

/**
 * The main window's tabs once the other windows were asked to open again:
 * those of a window that did not open (`opened` lacks its label) join the main
 * window — they stand in no pane of its layout, so they go to the pane in focus.
 */
export function withWindows(restored: Restored, opened: readonly string[]): SavedTab[] {
  const back = restored.windows.filter((w) => !opened.includes(w.label));
  return [...restored.tabs, ...back.flatMap((w) => w.window.tabs)];
}

// ── Which tabs open their session at once ──────────────────────────────────

/**
 * Why a tab that came back has not opened its session:
 * `manual` — the setting says every tab waits for its button;
 * `attach` — entering a container types a command on the host;
 * `prod` — a production server is never connected to unasked;
 * `secret` — connecting would stop to ask for a password or passphrase;
 * `checking` — whether it would is being asked right now.
 */
export type WaitReason = "manual" | "attach" | "prod" | "secret" | "checking";

export interface WaitFacts {
  kind: "ssh" | "local";
  /** The tab is a shell inside a container or pod. */
  attach: boolean;
  /** Its server is a production one. */
  prod: boolean;
  /** Connecting needs a secret the keychain does not hold; null — not asked yet. */
  needsSecret: boolean | null;
}

/**
 * Why a restored tab waits, or null when its session may be opened without
 * asking. The order is the order of what cannot be waived: a container tab and
 * a production server wait in every mode — the first runs a command, the second
 * is exactly where "it connected by itself" must not happen.
 */
export function waitReason(mode: RestoreMode, f: WaitFacts): WaitReason | null {
  if (f.attach) return "attach";
  if (mode !== "connect") return "manual";
  if (f.kind === "local") return null;
  if (f.prod) return "prod";
  if (f.needsSecret === null) return "checking";
  return f.needsSecret ? "secret" : null;
}

/** What the place of a waiting tab says: an icon, a line of explanation, its button. */
export interface WaitView {
  icon: IconName;
  hint: MessageKey;
  /** Label of the button that opens the session; null while there is nothing to press. */
  action: MessageKey | null;
}

export function waitView(
  reason: WaitReason,
  tab: Pick<Tab, "kind"> & { attach?: Pick<TabAttach, "kind"> },
): WaitView {
  if (tab.attach) {
    return {
      icon: attachIcon(tab.attach.kind),
      hint: tab.attach.kind === "pod" ? "restore.hintPod" : "restore.hintContainer",
      action: "restore.enter",
    };
  }
  if (tab.kind === "local") {
    return { icon: "terminal", hint: "restore.hintLocal", action: "restore.startShell" };
  }
  switch (reason) {
    case "prod":
      return { icon: "server", hint: "restore.hintProd", action: "common.connect" };
    case "secret":
      return { icon: "server", hint: "restore.hintSecret", action: "common.connect" };
    case "checking":
      return { icon: "server", hint: "restore.hintChecking", action: null };
    default:
      return { icon: "server", hint: "restore.hintManual", action: "common.connect" };
  }
}
