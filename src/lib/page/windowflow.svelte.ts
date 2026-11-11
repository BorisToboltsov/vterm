// Tabs and panes between windows, as the page drives them (ADR 0017, 0018,
// 0023; out of +page.svelte in v1.25.3). A tab leaves for a new window or an
// open one — by its menu, ⌘K, or dropped outside its window — and a pane leaves
// whole, one tab after another by the same trip. A tab that arrives is taken
// into this window's stores; a tab held over this window from another one is
// drawn by `stores/tabincoming`, and placed by `takeTab` when it comes.
//
// The trip is one function (`handOver`): hold the session's output, snapshot
// the terminal once it has everything sent, hand the packet over and wait for
// the other window, and only then let the tab go — keeping its session. Until
// then any failure gives the held output back and leaves the tab where it was.
// Whether a tab may go is asked before the trip, by whoever sends it.

import {
  announceWindow,
  closeWindow,
  declineHandoff,
  detachAbort,
  detachBegin,
  detachCommit,
  dragDrop,
  dragEnd,
  dragOver,
  takeHandoff,
  type DragAnswer,
  type DragLook,
} from "../api";
import { isMainWindow, otherWindows, windowLabel, windowTarget, type WindowEntry } from "../windows/appwindow";
import { t } from "../i18n";
import { activeChromePanel } from "../settings/settings.svelte";
import { arrivalDrop, besideDrop, findPane, layoutRects, panes } from "../layout/splitlayout";
import { heardStream, peekChat } from "../stores/aichat.svelte";
import { peekSyncJob } from "../stores/syncjob.svelte";
import { onTabDraggedOutside, tabDrag, type ScreenPoint } from "../stores/tabdrag.svelte";
import { describeTab, takeIncomingDrop } from "../stores/tabincoming.svelte";
import { packTab, unpackTab, type PageFacts } from "../stores/tabpacket";
import { findTab, settleArrivedPane, tabsState, type Tab } from "../stores/tabs.svelte";
import { notifyError, notifyInfo } from "../stores/toasts.svelte";
import {
  DETACH_BLOCK_MESSAGE,
  detachBlocker,
  detachErrorKey,
  detachOffered,
  moveOffered,
  paneDetachOffered,
  paneMoveBlocker,
  paneMoveOrder,
  parsePacket,
  windowMoveOffered,
  windowMoveOrder,
  type PaneStep,
  type DetachState,
  type PaneSeat,
  type TermSnapshot,
} from "../windows/tabhandoff";

/** What the page tells the window flow, each read when it is needed. */
export interface WindowDeps {
  /** A tab's full title, and the name on its tab. */
  title: (tab: Tab) => string;
  alias: (tab: Tab) => string;
  /** Whether a file of the session is being read or written now. */
  editorBusy: (sessionId: string) => boolean;
  /** The terminal's snapshot, once it has received the `sent` events of its output. */
  snapshot: (sessionId: string, sent: number) => Promise<TermSnapshot | null>;
  /** What the page keeps of a session outside the stores, for the tab to carry. */
  carried: (sessionId: string) => PageFacts;
  /** A tab arrived: the page takes back what it carried. */
  arrived: (sessionId: string, facts: PageFacts) => void;
  /** The tab's teardown (`closeTabFully`); `keepSession` when another window has it. */
  teardown: (sessionId: string, keepSession: boolean) => void;
  /** Ask the backend once what transfers are under way. */
  refreshTransfers: () => void;
  /** The unseen copy of a dragged tab's label, measured for the floating one. */
  ghostProbe: () => HTMLElement | undefined;
  /** The size of the centre — where an arriving pane would fit. */
  areaBounds: () => { width: number; height: number };
}

export function createWindowFlow(deps: WindowDeps) {
  /** The tab being handed to another window; the page takes no input meanwhile. */
  let detaching = $state<string | null>(null);
  // The app's other windows that take tabs, as the backend lists them.
  let appWindows = $state<WindowEntry[]>([]);
  // This window listens for the offer of a tab (set once its listeners are in place).
  let takesTabs = $state(false);
  /** The windows a tab of this one can be moved to right now. */
  const targets = $derived(moveOffered(appWindows.length) ? appWindows : []);
  /** Whether "move to a new window" is offered for tabs here at all. */
  const canOfferDetach = $derived(detachOffered({ mainWindow: isMainWindow, tabs: tabsState.list.length }));
  /** A tab of this window can be carried out of it at all. */
  const leavesWindow = $derived(canOfferDetach || targets.length > 0);

  // What the other windows show of this one: the tab its focused pane shows and
  // how many it has. Told again as either changes — and only then: both are
  // plain values, so a tab merely changing its status tells nobody anything.
  const title = $derived.by(() => {
    const active = findTab(tabsState.activeId);
    return active ? deps.title(active) : "";
  });
  const count = $derived(tabsState.list.length);
  $effect(() => {
    if (!takesTabs) return;
    void announceWindow(title, count).catch(() => {});
  });

  // A tab dragged outside the window moves to another one — the third way in,
  // next to the tab menu and the palette: onto a window of the app, into it;
  // anywhere else, into a window of its own. Where neither is offered, leaving
  // the window with a tab is not a drop target at all. While it is held over
  // another window, that window draws it: this one only says where it is.
  $effect(() => {
    onTabDraggedOutside(
      leavesWindow
        ? {
            release: (sessionId, at, outside, pane) =>
              void (pane ? dropPaneOutside(pane, at, outside) : dropOutside(sessionId, at, outside)),
            // Told of with or without another window to land in: over the
            // desktop the tab is drawn by the floating label either way.
            over: tellDragOver,
            left: () => void dragEnd().catch(() => {}),
          }
        : null,
    );
    return () => onTabDraggedOutside(null);
  });

  /** The session tabs of a pane, in strip order: what moves when the pane does. */
  const paneSessions = (paneId: string): Tab[] =>
    (findPane(tabsState.center, paneId)?.tabs ?? []).flatMap((id) => findTab(id) ?? []);

  function stateOf(tab: Tab): DetachState {
    const sid = tab.sessionId;
    const chat = peekChat(sid);
    return {
      mainWindow: isMainWindow,
      tabs: tabsState.list.length,
      connected: tab.status.startsWith("Connected"),
      syncComparing: !!peekSyncJob(sid)?.comparing,
      chatStep: !!chat?.stepRunning,
      editorBusy: deps.editorBusy(sid),
    };
  }

  /**
   * How the floating label looks (v1.36): the tab as this page draws it in its
   * strip, read off the unseen copy the page keeps of the dragged tab — its
   * colours, font at the app's scale, dot, name, a container's host and the
   * `prod` chip — with "+N" for a pane's other tabs.
   */
  function dragLook(tab: Tab, others = 0): DragLook | null {
    const probe = deps.ghostProbe();
    if (!probe) return null;
    const box = probe.getBoundingClientRect();
    const style = getComputedStyle(probe);
    const part = (name: string) => probe.querySelector<HTMLElement>(`[data-part="${name}"]`);
    const styleOf = (name: string) => {
      const el = part(name);
      return el ? getComputedStyle(el) : null;
    };
    const title = part("title")?.textContent ?? deps.alias(tab);
    return {
      title: others > 0 ? `${title} +${others}` : title,
      sub: part("sub")?.textContent ?? "",
      chip: part("chip")?.textContent ?? "",
      chipBg: styleOf("chip")?.backgroundColor ?? "",
      chipFg: styleOf("chip")?.color ?? "",
      bg: style.backgroundColor,
      fg: style.color,
      muted: styleOf("sub")?.color ?? style.color,
      accent: style.borderTopColor,
      dot: styleOf("dot")?.backgroundColor ?? style.color,
      font: style.font,
      w: Math.ceil(box.width),
      h: Math.ceil(box.height),
    };
  }

  /**
   * A tab of this window is being dragged: say so, and learn where it is — over
   * another window of the app, or over none of them. A tab that cannot go
   * anywhere right now is shown to nobody — letting go of it says why.
   */
  async function tellDragOver(sessionId: string, pane: string | null = null): Promise<DragAnswer | null> {
    const tab = findTab(sessionId);
    if (!tab || detachBlocker(stateOf(tab), true)) return null;
    // A pane (v1.36) is shown to nobody when one of its tabs cannot go.
    const tabs = pane ? paneSessions(pane) : [tab];
    if (pane && paneMoveBlocker(tabs.map(stateOf), true)) return null;
    // Inside this window, with no other one that could lie over it, there is
    // nothing the backend could add: a tab reordered in its strip asks nobody.
    if (!tabDrag.outside && targets.length === 0) return null;
    return dragOver(describeTab(tab), dragLook(tab, tabs.length - 1));
  }

  /**
   * A whole pane (v1.36) was let go of away from this window's panes: onto
   * another window of the app it moves into it — its first tab where it was
   * dropped, the others around it; anywhere else, into a window of its own.
   */
  async function dropPaneOutside(paneId: string, at: ScreenPoint, outside: boolean) {
    const tabs = paneSessions(paneId);
    const lead = findTab(findPane(tabsState.center, paneId)?.active ?? null) ?? tabs[0];
    if (!lead) return;
    const held = paneMoveBlocker(tabs.map(stateOf), true);
    if (held) {
      void dragEnd().catch(() => {});
      const reason = t(DETACH_BLOCK_MESSAGE[held.block]);
      notifyInfo(t("window.paneBlocked", { tab: deps.title(tabs[held.at]), reason }), { source: "windows" });
      return;
    }
    const under = await dragDrop(describeTab(lead)).catch(() => null);
    if (under && targets.some((w) => w.label === under)) {
      await movePane(paneId, { window: under });
      return;
    }
    if (under) void dragEnd().catch(() => {});
    if (outside && paneDetachOffered({ mainWindow: isMainWindow, tabs: tabsState.list.length }, tabs.length)) {
      await movePane(paneId, { at });
    }
  }

  /**
   * A tab was let go of away from this window's panes, at `at` on the screen:
   * outside the window, or (`outside` false) inside its bounds but over another
   * window lying on top of it.
   */
  async function dropOutside(sessionId: string, at: ScreenPoint, outside: boolean) {
    const tab = findTab(sessionId);
    if (!tab) return;
    // What keeps a tab from every other window keeps it here: said now.
    const block = detachBlocker(stateOf(tab), true);
    if (block) {
      void dragEnd().catch(() => {});
      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]), { source: "windows" });
      return;
    }
    // Asked now, not taken from where the tab was last drawn: the release is
    // the gesture. The window it was dropped on keeps its place from here on.
    // Asked even with no other window to land in: this is also what takes the
    // floating label off the desktop.
    const under = await dragDrop(describeTab(tab)).catch(() => null);
    if (under && targets.some((w) => w.label === under)) {
      // If the tab does not get there after all, that window is told.
      if (!(await detachTab(sessionId, { window: under }))) void dragEnd().catch(() => {});
      return;
    }
    if (under) void dragEnd().catch(() => {});
    // Inside this window after all (the other one was gone by the release):
    // nothing to open a window for.
    if (outside && canOfferDetach) void detachTab(sessionId, { at });
  }

  /**
   * Move a tab to another window: the open one `to.window`, or — without it — a
   * new one, opened at `to.at` when the tab was dropped there (the menu and the
   * palette give no place). Resolves true when it went.
   */
  async function detachTab(sessionId: string, to: { window?: string; at?: ScreenPoint } = {}): Promise<boolean> {
    const tab = findTab(sessionId);
    if (!tab || detaching) return false;
    const toOpenWindow = to.window !== undefined;
    // The only tab of a secondary window may go back to an open window, not to a new one.
    const block = detachBlocker(stateOf(tab), toOpenWindow);
    if (block) {
      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]), { source: "windows" });
      return false;
    }
    detaching = sessionId;
    try {
      await handOver(sessionId, to);
      return true;
    } catch (e) {
      notifyError(t(detachErrorKey(e, toOpenWindow)), { source: "windows" });
      return false;
    } finally {
      detaching = null;
    }
  }

  /**
   * One tab's trip to another window; resolves the label of the window that
   * took it and throws what the backend said when none did. `seat` — its place
   * in the pane it travels with (v1.10). Whether the tab may go at all is the
   * caller's question: this is the trip, and it says nothing to the user.
   */
  async function handOver(
    sessionId: string,
    to: { window?: string; at?: ScreenPoint },
    seat: PaneSeat | null = null,
  ): Promise<string> {
    let held = false;
    try {
      const begun = await detachBegin(sessionId);
      held = true;
      const terminal = await deps.snapshot(sessionId, begun.output);
      // An answer streaming in the tab goes with it (v1.36): packed once every
      // piece sent before the hold was heard here — the rest the backend keeps
      // for the other window.
      const heard = !begun.stream || (await heardStream(sessionId, begun.stream.id, begun.stream.sent));
      const packet = terminal && heard && packTab(sessionId, terminal, deps.carried(sessionId), seat);
      if (!packet) throw new Error("handoff-failed: no snapshot");
      const taken = await detachCommit(sessionId, packet, {
        ...to.at,
        target: to.window,
        background: activeChromePanel(),
      });
      held = false;
      // The other window owns the session now: drop the tab here, keep the
      // session. (A secondary window left with no tab closes behind it.)
      deps.teardown(sessionId, true);
      return taken;
    } catch (e) {
      // Give the held output back (a no-op if the backend already rolled back).
      if (held) await detachAbort(sessionId).catch(() => {});
      throw e;
    }
  }

  // A window opened for a pane's first tab takes the rest once it says that it
  // takes tabs — heard as the list of windows changes.
  let windowsHeard: (() => void) | null = null;
  function windowListed(label: string, timeoutMs = 5000): Promise<boolean> {
    const listed = () => appWindows.some((w) => w.label === label);
    if (listed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const giveUp = setTimeout(() => {
        windowsHeard = null;
        resolve(false);
      }, timeoutMs);
      windowsHeard = () => {
        if (!listed()) return;
        clearTimeout(giveUp);
        windowsHeard = null;
        resolve(true);
      };
    });
  }

  /**
   * Move a pane — every session tab in it, each with its files — to another
   * window: the open one `to.window`, or a new one (opened at `to.at`, when it
   * was dropped there). One handoff per tab, in the order that rebuilds the pane
   * there (`paneMoveOrder`): the tab the pane shows goes first and opens the
   * pane, the others take their seats around it.
   *
   * The pane goes whole or not at all — judged before the first tab leaves.
   * What can still stop it midway is a handoff that fails; the tabs that went
   * stay where they went, the rest stay here, and that is what is said.
   */
  async function movePane(paneId: string, to: { window?: string; at?: ScreenPoint } = {}): Promise<void> {
    const pane = findPane(tabsState.center, paneId);
    const tabs = paneSessions(paneId);
    if (!pane || tabs.length === 0 || detaching) return;
    const toOpenWindow = to.window !== undefined;
    const held = paneMoveBlocker(tabs.map(stateOf), toOpenWindow);
    if (held) {
      const reason = t(DETACH_BLOCK_MESSAGE[held.block]);
      notifyInfo(held.block === "lastTab" ? reason : t("window.paneBlocked", { tab: deps.title(tabs[held.at]), reason }), { source: "windows" });
      return;
    }
    const steps = paneMoveOrder(
      tabs.map((tab) => tab.sessionId),
      pane.active,
    );
    await carry(steps, to, "window.paneMovedPartly");
  }

  /** Every session tab standing in a pane, in reading order. */
  const paneSessionIds = (): string[] => panes(tabsState.center).flatMap((p) => p.tabs);

  /**
   * Hand tabs over one after another, each with its seat — a pane's tabs, or a
   * whole window's. A new window opened for the first one takes the rest once
   * it listens. A failure midway is said in `partly`'s words.
   */
  async function carry(
    steps: PaneStep[],
    to: { window?: string; at?: ScreenPoint },
    partly: "window.paneMovedPartly" | "window.windowMovedPartly",
  ): Promise<void> {
    const toOpenWindow = to.window !== undefined;
    let target = to.window;
    let moved = 0;
    try {
      for (const step of steps) {
        detaching = step.tab;
        // A new window was opened for the first tab: the rest go once it listens.
        if (moved > 0 && !(target && (await windowListed(target)))) throw new Error("handoff-not-taken");
        // Asked again at each tab's turn: its session may have ended meanwhile.
        const tab = findTab(step.tab);
        if (!tab || detachBlocker(stateOf(tab), true)) throw new Error("handoff-not-taken");
        target = await handOver(step.tab, moved === 0 ? to : { window: target }, step.seat);
        moved += 1;
      }
    } catch (e) {
      notifyError(moved === 0 ? t(detachErrorKey(e, toOpenWindow)) : t(partly, { moved, total: steps.length }), { source: "windows" });
    } finally {
      detaching = null;
    }
  }

  /**
   * Put the tab being handed to this window into its stores; false when there
   * is none to take. Its terminal then replays the snapshot and takes the
   * session over (`Terminal.svelte`, `adopt`).
   */
  async function takeTab(): Promise<boolean> {
    const packet = parsePacket(await takeHandoff().catch(() => null));
    if (!packet) return false;
    deps.arrived(packet.tab.sessionId, packet.page);
    // Dropped here, it takes the place this window kept for it; sent by a
    // command, it goes where a new tab goes — and the first tab of a pane that
    // moves whole (v1.10) opens a pane of its own, where there is room for one.
    const leadsPane = packet.seat !== null && packet.seat.lead === null;
    const split = packet.seat?.split ?? null;
    const center = tabsState.center;
    const rects = () => layoutRects(center.root, deps.areaBounds()).panes;
    // A pane of a window moving whole (v1.36) opens beside what came before it.
    const drop =
      takeIncomingDrop() ??
      (split ? besideDrop(center, rects(), split.beside, split.edge) : leadsPane ? arrivalDrop(center, rects()) : null);
    await unpackTab(packet, drop);
    if (split) settleArrivedPane(packet.tab.sessionId, split.ratio);
    // A transfer under way came with the session: its events arrive here from
    // now on, and what it has done so far is asked for once.
    deps.refreshTransfers();
    return true;
  }

  return {
    /** The tab on its way to another window, if any — the page takes no input meanwhile. */
    get detaching() {
      return detaching;
    },
    /** The windows a tab of this one can be moved to right now. */
    get targets() {
      return targets;
    },
    get canOfferDetach() {
      return canOfferDetach;
    },
    get leavesWindow() {
      return leavesWindow;
    },
    /** What a window is called in a menu. */
    targetName(w: WindowEntry): string {
      const name = windowTarget(w);
      return t(name.key, name.params);
    },
    /** Whether a tab could go now, and if not, why. */
    stateOf,
    paneSessions,
    detachTab,

    /** Whether this window can be moved as a whole: it has more than one pane, and a window to go to. */
    get windowMoveOffered() {
      return targets.length > 0 && windowMoveOffered(panes(tabsState.center).length);
    },

    /**
     * Move the whole window — every pane, every session tab in it, each with its
     * files — into the open window `to` (v1.36, ADR 0058), where its panes are
     * built again as they stood (`windowMoveOrder`). Whole or not at all, judged
     * before the first tab leaves; a handoff failing midway leaves what went
     * there and what did not here, and says so — as a pane's move does.
     */
    async moveWindow(to: string): Promise<void> {
      const tabs = tabsState.list.filter((tab) => paneSessionIds().includes(tab.sessionId));
      if (tabs.length === 0 || detaching) return;
      const held = paneMoveBlocker(tabs.map(stateOf), true);
      if (held) {
        notifyInfo(t("window.windowBlocked", { tab: deps.title(tabs[held.at]), reason: t(DETACH_BLOCK_MESSAGE[held.block]) }), { source: "windows" });
        return;
      }
      const steps = windowMoveOrder(tabsState.center.root, (pane) => pane.tabs.filter((id) => findTab(id)));
      await carry(steps, { window: to }, "window.windowMovedPartly");
    },

    movePane,

    /** The backend listed the windows that take tabs. */
    heardWindows(payload: unknown) {
      appWindows = otherWindows(payload, windowLabel);
      windowsHeard?.();
    },

    /** This window listens for the offer of a tab now: it may say it takes tabs. */
    listening() {
      takesTabs = true;
    },

    /** A secondary window, on load: take over the tab it was opened for. */
    async adoptHandoff() {
      // Nothing to show (the handoff was rolled back): a window with no tab goes.
      if (!(await takeTab())) void closeWindow().catch(() => {});
    },

    /**
     * A window that is already open, offered a tab: take it — or say at once that
     * it cannot, so the window giving the tab up is not left to its timeout.
     * Nothing here closes this window: it has tabs of its own.
     */
    async receiveTab() {
      if (!(await takeTab())) void declineHandoff().catch(() => {});
    },

    /**
     * A tab this window was taking did not arrive: it stays with the window that
     * was giving it up, which is told so now. This window's copy of its state
     * goes without ending the session — it was never ours.
     */
    adoptFailed(sessionId: string) {
      void declineHandoff(sessionId).catch(() => {});
      deps.teardown(sessionId, true);
      // A window opened for this tab has nothing else to show and goes. One that
      // was already open keeps its tabs — closing it would end their sessions.
      if (!isMainWindow && tabsState.list.length === 0) void closeWindow().catch(() => {});
    },
  };
}

export type WindowFlow = ReturnType<typeof createWindowFlow>;
