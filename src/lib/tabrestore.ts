// Tabs across a restart (v1.6, ADR 0019): what is written down of a window's
// tabs, how it is read back, and which of the tabs that came back may open
// their session without being asked.
//
// A session cannot be restored — its process ended with the app, its
// connection is closed. What comes back is the **tab**: what it was (a server,
// a local shell, a shell inside a container), which pane it stood in and what
// that pane showed. Its session is opened anew, and its terminal starts empty:
// terminal output is never written to disk (it holds whatever was typed and
// printed; keeping it is what session recordings are for).
//
// Pure: no runes, no DOM, no storage. The store that reads and writes the slots
// is `stores/tabrestore.svelte.ts`; the page applies the result.

import type { MessageKey } from "./i18n";
import type { IconName } from "./icons";
import { savedLayout, type CenterLayout, type SavedLayout } from "./splitlayout";
import type { Tab } from "./stores/tabs.svelte";
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

/** Bumped when the saved shape changes; a slot of another version is not read. */
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
}

/** One window's tabs and the layout of its centre. */
export interface SavedWindow {
  v: typeof SAVE_VERSION;
  tabs: SavedTab[];
  layout: SavedLayout;
}

function copyAttach(a: TabAttach): TabAttach {
  const out: TabAttach = { kind: a.kind, name: a.name, argv: [...a.argv] };
  if (a.image !== undefined) out.image = a.image;
  if (a.container !== undefined) out.container = a.container;
  return out;
}

/** The record of a tab — the fields listed here and no others. */
export function savedTab(tab: Pick<Tab, "sessionId" | "kind" | "serverId" | "alias" | "attach">): SavedTab {
  const out: SavedTab = {
    id: tab.sessionId,
    kind: tab.kind,
    serverId: tab.kind === "ssh" ? tab.serverId : "",
    alias: tab.alias,
  };
  if (tab.attach) out.attach = copyAttach(tab.attach);
  return out;
}

/** What a window writes into its slot. */
export function savedWindow(tabs: readonly Tab[], layout: CenterLayout): SavedWindow {
  return { v: SAVE_VERSION, tabs: tabs.map(savedTab), layout: savedLayout(layout) };
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
  }
  return out;
}

/**
 * What a slot holds, read — not trusted: it sat in `localStorage`, written by
 * this build, an older one or a newer one. A slot of another version, or one
 * that is not a slot, gives null; a tab that cannot be read is left out. The
 * layout is passed on as it is — `loadLayout` rebuilds it against the tabs.
 */
export function parseSavedWindow(raw: unknown): { tabs: SavedTab[]; layout: unknown } | null {
  if (!isRecord(raw) || raw.v !== SAVE_VERSION || !Array.isArray(raw.tabs)) return null;
  const tabs: SavedTab[] = [];
  const seen = new Set<string>();
  for (const item of raw.tabs.slice(0, MAX_SAVED_TABS)) {
    const tab = parseTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  return { tabs, layout: raw.layout ?? null };
}

/** The tabs to bring back, and the layout they stood in. */
export interface Restored {
  /** The main window's tabs, then the other windows' — each once. */
  tabs: SavedTab[];
  /** The main window's saved layout, unread (`loadLayout` takes it from here). */
  layout: unknown;
  /** Tabs left out because their server is no longer in the catalog. */
  missing: number;
}

/**
 * What the main window restores: its own slot and the slots of the windows
 * that were open beside it. Windows themselves are not brought back — their
 * tabs return to the main one (they stand in no pane of its layout, so they
 * join the pane in focus). A tab whose server is gone is counted, not restored:
 * there is nothing to connect it to.
 */
export function restoreSaved(
  main: unknown,
  others: readonly unknown[],
  hasServer: (serverId: string) => boolean,
): Restored {
  const own = parseSavedWindow(main);
  const tabs: SavedTab[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (const win of [own, ...others.map(parseSavedWindow)]) {
    for (const tab of win?.tabs ?? []) {
      if (seen.has(tab.id) || tabs.length >= MAX_SAVED_TABS) continue;
      seen.add(tab.id);
      if (tab.kind === "ssh" && !hasServer(tab.serverId)) missing += 1;
      else tabs.push(tab);
    }
  }
  return { tabs, layout: own?.layout ?? null, missing };
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
