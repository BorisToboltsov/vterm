// Tabs across a restart, the storage half (v1.6, ADR 0019): each window keeps
// its tabs and the layout of its centre in a slot of its own in `localStorage`
// (`vterm.tabs:<window label>`), and the main window takes the slots in at
// launch. What a slot holds and how it is read back is pure (`../tabrestore.ts`,
// `loadLayout` in `../splitlayout.ts`); this file only reads and writes.
//
// **Every window writes, only the main one restores.** A window a tab was moved
// out to is not brought back by a restart — its tabs return to the main window —
// so it has nothing to read; but what it holds must not be lost, so it writes.
// One slot per window rather than one shared record: `localStorage` is shared
// by the windows, and two of them rewriting one record would each undo the
// other's last change.
//
// **Nothing is written before the previous launch has been taken in.** The
// store of tabs starts empty; a main window that wrote its slot from the first
// moment would replace "the tabs I had" with "no tabs" before reading them. So
// it writes only from `startSavingTabs` — which the page calls once it has
// restored, or decided not to. If the server catalog cannot be read, that never
// happens, and the slot is still there for the next launch.
//
// Never in a slot: a tab's typed secret, its status, its terminal's contents
// (`savedTab` builds the record field by field — `tabrestore.guard`).

import { isMainLabel, windowLabel } from "../appwindow";
import { settings } from "../settings.svelte";
import type { CenterLayout } from "../splitlayout";
import { otherSlotKeys, savedWindow, slotKey, type RestoreMode } from "../tabrestore";
import { tabsState, type Tab } from "./tabs.svelte";

/** What the slots held when the app started. */
export interface SavedSlots {
  /** The main window's slot. */
  main: unknown;
  /** The slots of the windows that were open beside it. */
  others: unknown[];
}

type SlotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** One window's keeper of its slot. A factory so that both kinds of window can be tested. */
export function tabKeeper(label: string, storage: SlotStorage = localStorage) {
  const own = slotKey(label);
  const main = isMainLabel(label);
  // A window a tab was moved out to has nothing to take in: it writes at once.
  let writing = $state(!main);
  let taken = false;

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
      const slots: SavedSlots = { main: read(own), others: otherSlotKeys(keys(), own).map(read) };
      return slots.main === null && slots.others.every((o) => o === null) ? null : slots;
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
      remove(own);
    },

    /** Write the slot, or clear it when there is nothing to keep. */
    sync(tabs: readonly Tab[], layout: CenterLayout, mode: RestoreMode): void {
      if (!writing) return;
      if (mode === "off" || tabs.length === 0) {
        remove(own);
        return;
      }
      try {
        storage.setItem(own, JSON.stringify(savedWindow(tabs, layout)));
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

$effect.root(() => {
  $effect(() => {
    keeper.sync(tabsState.list, tabsState.center, settings.restoreTabs);
  });
});
