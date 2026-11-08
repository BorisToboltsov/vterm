// Tabs across a restart, the storage half (v1.6, ADR 0019): each window keeps
// its tabs and the layout of its centre in a slot of its own in `localStorage`
// (`vterm.tabs:<window label>`), and the main window takes the slots in at
// launch. What a slot holds and how it is read back is pure (`../tabrestore.ts`,
// `loadLayout` in `../splitlayout.ts`); this file only reads and writes.
//
// **Every window writes, only the main one reads.** Since v1.36 (ADR 0057) the
// windows of the previous launch come back: the main window reads their slots
// with its own and has the backend open each one again, handing it its tabs —
// a reopened window is given them, it does not read a slot. One slot per window
// rather than one shared record: `localStorage` is shared by the windows, and
// two of them rewriting one record would each undo the other's last change.
//
// **Nothing is written before the previous launch has been taken in.** The
// store of tabs starts empty; a main window that wrote its slot from the first
// moment would replace "the tabs I had" with "no tabs" before reading them. So
// it writes only from `startSavingTabs` — which the page calls once it has
// restored, or decided not to. If the server catalog cannot be read, that never
// happens, and the slot is still there for the next launch.
//
// Never in a slot: a tab's typed secret, its status, its terminal's contents,
// the text of its files (`savedTab` builds the record field by field —
// `tabrestore.guard`). Where the tab was is: the folders of its shell and its
// dock, the k8s scope, the files open in it and their zones (v1.36).

import { isMainLabel, windowLabel } from "../windows/appwindow";
import { settings } from "../settings/settings.svelte";
import type { CenterLayout, SavedLayout } from "../layout/splitlayout";
import {
  otherSlotKeys,
  savedWindow,
  slotKey,
  slotLabel,
  type RestoreMode,
  type TabFacts,
} from "../tabs/tabrestore";
import { peekDockState } from "./dockstate.svelte";
import { tabsState, type Tab } from "./tabs.svelte";
import { peekWorkspace } from "./workspaces.svelte";

/** What the slots held when the app started. */
export interface SavedSlots {
  /** The main window's slot. */
  main: unknown;
  /** The slots of the windows that were open beside it, by window label. */
  others: { label: string; raw: unknown }[];
}

type SlotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** One window's keeper of its slot. A factory so that both kinds of window can be tested. */
export function tabKeeper(label: string, storage: SlotStorage = localStorage) {
  const own = slotKey(label);
  const main = isMainLabel(label);
  // A window a tab was moved out to has nothing to take in: it writes at once.
  let writing = $state(!main);
  let taken = false;
  // What was written last: the effect runs on every keystroke in an open file
  // (the workspace changes), and the slot only when what it says does.
  let last: string | null = null;

  const keys = (): string[] => {
    const out: string[] = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) out.push(key);
      }
    } catch {
      /* storage unavailable — nothing was saved */
    }
    return out;
  };
  const read = (key: string): unknown => {
    try {
      return JSON.parse(storage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  };
  const remove = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      /* storage unavailable — non-fatal */
    }
  };

  return {
    /** Whether this window writes its slot yet. */
    get writing(): boolean {
      return writing;
    },

    /**
     * What the previous launch left, for the main window to restore — once.
     * Null when there is nothing to bring back: restoring is off, nothing was
     * saved, or this is not the main window.
     */
    take(mode: RestoreMode): SavedSlots | null {
      if (!main || taken) return null;
      taken = true;
      if (mode === "off") return null;
      const others = otherSlotKeys(keys(), own).map((key) => ({ label: slotLabel(key), raw: read(key) }));
      const slots: SavedSlots = { main: read(own), others };
      return slots.main === null && slots.others.every((o) => o.raw === null) ? null : slots;
    },

    /**
     * From now on this window keeps its slot up to date. In the main window
     * this also drops the slots of the windows of the previous launch: their
     * tabs have just been taken in here (or restoring is off), and no window
     * of this launch can exist yet — one appears only by moving a connected tab.
     */
    start(): void {
      if (writing) return;
      if (main) for (const key of otherSlotKeys(keys(), own)) remove(key);
      writing = true;
    },

    /**
     * This window is being closed on purpose and its sessions end with it: its
     * tabs are not something to bring back.
     */
    forget(): void {
      writing = false;
      last = null;
      remove(own);
    },

    /** Write the slot, or clear it when there is nothing to keep. */
    sync(
      tabs: readonly Tab[],
      layout: CenterLayout,
      mode: RestoreMode,
      factsOf?: (sessionId: string) => TabFacts,
      beforeTile?: SavedLayout | null,
    ): void {
      if (!writing) return;
      if (mode === "off" || tabs.length === 0) {
        if (last !== "") remove(own);
        last = "";
        return;
      }
      const text = JSON.stringify(savedWindow(tabs, layout, factsOf, beforeTile));
      if (text === last) return;
      try {
        storage.setItem(own, text);
        last = text;
      } catch {
        /* storage unavailable or full — non-fatal */
      }
    },
  };
}

const keeper = tabKeeper(windowLabel);

/** The tabs of the previous launch, for the main window to restore (once; null — none). */
export const takeSavedTabs = (): SavedSlots | null => keeper.take(settings.restoreTabs);

/** The previous launch has been taken in (or there was nothing to take): keep the slot current. */
export const startSavingTabs = (): void => keeper.start();

/** This window closes for good — its tabs are not to come back. */
export const forgetSavedTabs = (): void => keeper.forget();

// The folder a session's shell last said it was in is the page's (it hears the
// terminal); it says so through this, read while the slot is written.
let shellCwdOf = $state.raw<(sessionId: string) => string | null>(() => null);

/** The page tells the keeper where each session's shell is (v1.36). */
export function provideShellCwd(of: (sessionId: string) => string | null): void {
  shellCwdOf = of;
}

/** What is written down of a session besides its tab — read, never created. */
function factsOf(sessionId: string): TabFacts {
  return {
    shellCwd: shellCwdOf(sessionId),
    dock: peekDockState(sessionId),
    workspace: peekWorkspace(sessionId),
  };
}

$effect.root(() => {
  $effect(() => {
    keeper.sync(tabsState.list, tabsState.center, settings.restoreTabs, factsOf, tabsState.beforeTile);
  });
});
