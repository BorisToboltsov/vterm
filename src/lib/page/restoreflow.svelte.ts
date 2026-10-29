// Tabs of the previous launch, as the page brings them back (v1.6, ADR 0019; out
// of +page.svelte in v1.25.3). A session cannot be restored; its tab can: the
// tabs come back where they stood and wait (`Tab.waiting`). Which of them open
// their session by themselves is the pure `waitReason`, never a decision made
// here — and besides that policy only a tab's own button opens a session.

import { isProdServer } from "../aiexec";
import { connectPlan } from "../api";
import { t } from "../i18n";
import { settings } from "../settings.svelte";
import { startSavingTabs, takeSavedTabs } from "../stores/tabrestore.svelte";
import { findTab, openRestored, reconnectTab, setWaiting, tabsState, type Tab } from "../stores/tabs.svelte";
import { notifyError, notifyInfo } from "../stores/toasts.svelte";
import { restoreSaved, waitReason, type WaitFacts } from "../tabrestore";
import type { ServerProfile } from "../types";

/** What the page tells the restore flow, each read when it is needed. */
export interface RestoreDeps {
  servers: () => ServerProfile[];
  /** Ask for the secret of a waiting tab's server; the answer connects that tab in place. */
  askSecret: (server: ServerProfile, label: string, sessionId: string) => void;
}

export function createRestoreFlow(deps: RestoreDeps) {
  let restored = false;

  /** What `waitReason` is asked about a tab. */
  function factsOf(tab: Pick<Tab, "kind" | "serverId"> & { attach?: unknown }, needsSecret: boolean | null): WaitFacts {
    return {
      kind: tab.kind,
      attach: !!tab.attach,
      prod: isProdServer(deps.servers().find((s) => s.id === tab.serverId)),
      needsSecret,
    };
  }

  /**
   * A waiting tab that may connect unless its server stops to ask for a secret:
   * find out, then connect it or leave it waiting with the reason.
   */
  async function settle(sessionId: string) {
    const asked = findTab(sessionId);
    if (asked?.waiting !== "checking") return;
    const plan = await connectPlan(asked.serverId).catch(() => null);
    // Closed, or opened by its button, while the keychain was being asked.
    const tab = findTab(sessionId);
    if (tab?.waiting !== "checking") return;
    const reason = plan ? waitReason("connect", factsOf(tab, plan.needsSecret)) : "manual";
    if (reason === null) reconnectTab(sessionId);
    else setWaiting(sessionId, reason);
  }

  return {
    /** Bring the saved tabs back — once, with the catalog loaded. The main window calls it. */
    restore() {
      if (restored) return;
      restored = true;
      try {
        const slots = takeSavedTabs();
        if (!slots) return;
        const back = restoreSaved(slots.main, slots.others, (id) => deps.servers().some((s) => s.id === id));
        if (back.missing > 0) notifyInfo(t("restore.serversGone", { n: back.missing }));
        const mode = settings.restoreTabs;
        openRestored(back.tabs, back.layout, (tab) => waitReason(mode, factsOf(tab, null)));
        for (const tab of tabsState.list) {
          if (tab.waiting === "checking") void settle(tab.sessionId);
        }
      } finally {
        // Only now may this window write its slot: before, "no tabs yet" would
        // have replaced the tabs it had.
        startSavingTabs();
      }
    },

    /** The button of a waiting tab (and the same item of its menu): open its
     *  session, asking for the secret if its server takes one. */
    async wake(sessionId: string) {
      const tab = findTab(sessionId);
      if (!tab?.waiting || tab.waiting === "checking") return;
      if (tab.kind === "local") {
        reconnectTab(sessionId);
        return;
      }
      try {
        const plan = await connectPlan(tab.serverId);
        const server = deps.servers().find((s) => s.id === tab.serverId);
        if (plan.needsSecret && server) {
          deps.askSecret(server, plan.secretLabel, sessionId);
          return;
        }
        reconnectTab(sessionId);
      } catch (e) {
        notifyError(String(e));
      }
    },

    /**
     * ⌘K: open every waiting tab that may open without a question. The others
     * keep their place and now say why — a production server and a container are
     * entered by their own button, one at a time.
     */
    wakeAll() {
      for (const tab of tabsState.list) {
        if (!tab.waiting || tab.waiting === "checking") continue;
        const reason = waitReason("connect", factsOf(tab, null));
        if (reason === null) {
          reconnectTab(tab.sessionId);
        } else {
          setWaiting(tab.sessionId, reason);
          if (reason === "checking") void settle(tab.sessionId);
        }
      }
    },
  };
}

export type RestoreFlow = ReturnType<typeof createRestoreFlow>;
