// Tabs of the previous launch, as the page brings them back (v1.6, ADR 0019; out
// of +page.svelte in v1.25.3). A session cannot be restored; its tab can: the
// tabs come back where they stood and wait (`Tab.waiting`). Which of them open
// their session by themselves is the pure `waitReason`, never a decision made
// here — and besides that policy only a tab's own button opens a session.
//
// Since v1.36 (ADR 0057) a tab also comes back where it was — its folders, the
// k8s scope, the files open in it, a grid as a grid — and the windows of the
// previous launch come back with theirs. What a tab printed and its
// conversation come back only under `restoreOutput`, never for a production
// server: this flow is what writes them down, and the only one.

import { nullWrittenByCall, writtenByCall } from "../api/call";
import { orNull } from "../api/diag";
import { isProdServer } from "../ai/aiexec";
import {
  connectPlan,
  readLocalText,
  reopenWindows,
  sftpReadText,
  sftpWriteAccess,
  tabContentForget,
  tabContentKeepOnly,
  tabContentLoad,
  tabContentSave,
  takeRestore,
  writeToTerminal,
} from "../api";
import { editorLangOrPlain, editorLangWithDialect } from "../editor/editorlang";
import { t } from "../i18n";
import { savedLayout } from "../layout/splitlayout";
import { cdCommand } from "../pathsync/cdterminal";
import { settings } from "../settings/settings.svelte";
import { peekChat, restoreChat } from "../stores/aichat.svelte";
import { restoreDockState } from "../stores/dockstate.svelte";
import { startSavingTabs, takeSavedTabs } from "../stores/tabrestore.svelte";
import {
  clearRestored,
  findTab,
  openRestored,
  reconnectTab,
  setWaiting,
  tabsState,
  type RestoredOutput,
  type Tab,
} from "../stores/tabs.svelte";
import { notifyError, notifyInfo } from "../stores/toasts.svelte";
import {
  awaitingDocs,
  failEditor,
  fillEditor,
  restoreWorkspace,
  setEditorWriteAccess,
  startLoading,
} from "../stores/workspaces.svelte";
import { contentRecord, keepsContent, parseContent, type TabContent, CONTENT_SAVE_MS } from "../tabs/tabcontent";
import {
  parseSavedWindow,
  restoreSaved,
  waitReason,
  windowRecord,
  withWindows,
  type Restored,
  type SavedTab,
  type WaitFacts,
} from "../tabs/tabrestore";
import { submitLine } from "../terminal/terminput";
import type { ServerProfile } from "../types";
import type { TermSnapshot } from "../windows/tabhandoff";

/** What the page tells the restore flow, each read when it is needed. */
export interface RestoreDeps {
  servers: () => ServerProfile[];
  /** Ask for the secret of a waiting tab's server; the answer connects that tab in place. */
  askSecret: (server: ServerProfile, label: string, sessionId: string) => void;
  /** What a session's terminal holds, as it is kept across a restart (`Terminal.keepsake`). */
  keepsake?: (sessionId: string) => Promise<TermSnapshot | null>;
  /** The theme's panel colour, for the windows opened again (so they never flash another). */
  background?: () => string | null;
}

/** A quit waits this long for the terminals to be written down, then goes anyway. */
const FLUSH_TIMEOUT_MS = 2000;

export function createRestoreFlow(deps: RestoreDeps) {
  let restored = false;
  // Sessions whose terminal printed since it was last written down.
  const printed = new Set<string>();
  // What each session's conversation looked like when it was last written down.
  const chatSeen = new Map<string, string>();
  // Sessions something is kept for — so a production tab, or one the setting
  // no longer keeps, has it removed once.
  const kept = new Set<string>();

  /** What `waitReason` is asked about a tab. */
  function factsOf(tab: Pick<Tab, "kind" | "serverId"> & { attach?: unknown }, needsSecret: boolean | null): WaitFacts {
    return {
      kind: tab.kind,
      attach: !!tab.attach,
      prod: isProdServer(deps.servers().find((s) => s.id === tab.serverId)),
      needsSecret,
    };
  }

  const isProd = (tab: Pick<Tab, "serverId">) =>
    isProdServer(deps.servers().find((s) => s.id === tab.serverId));

  /**
   * A waiting tab that may connect unless its server stops to ask for a secret:
   * find out, then connect it or leave it waiting with the reason.
   */
  async function settle(sessionId: string) {
    const asked = findTab(sessionId);
    if (asked?.waiting !== "checking") return;
    const plan = await connectPlan(asked.serverId).catch(nullWrittenByCall);
    // Closed, or opened by its button, while the keychain was being asked.
    const tab = findTab(sessionId);
    if (tab?.waiting !== "checking") return;
    const reason = plan ? waitReason("connect", factsOf(tab, plan.needsSecret)) : "manual";
    if (reason === null) reconnectTab(sessionId);
    else setWaiting(sessionId, reason);
  }

  /** What was kept of the tabs `ids`, read back — only where it is still kept. */
  async function loadContent(tabs: readonly SavedTab[]): Promise<Map<string, TabContent>> {
    const out = new Map<string, TabContent>();
    await Promise.all(
      tabs.map(async (tab) => {
        if (!keepsContent(settings, isProd(tab))) return;
        const content = parseContent(await tabContentLoad(tab.id).catch(nullWrittenByCall));
        if (content) {
          out.set(tab.id, content);
          kept.add(tab.id);
        }
      }),
    );
    return out;
  }

  /** Bring tabs of the previous launch into this window, with where they were. */
  function bringBack(tabs: readonly SavedTab[], layout: unknown, beforeTile: unknown, content: Map<string, TabContent>) {
    const mode = settings.restoreTabs;
    const replay = (id: string): RestoredOutput | null => {
      const c = content.get(id);
      return c?.term ? { term: c.term, savedAt: c.savedAt } : null;
    };
    openRestored(tabs, layout, (tab) => waitReason(mode, factsOf(tab, null)), { beforeTile, replay });
    for (const tab of tabs) {
      if (!findTab(tab.id)) continue;
      if (tab.dock) restoreDockState(tab.id, tab.dock);
      if (tab.docs) {
        const docs = tab.docs.map((d) => ({ ...d, lang: editorLangOrPlain(d.path) }));
        restoreWorkspace(tab.id, docs, tab.views ?? null);
      }
      const chat = content.get(tab.id)?.chat;
      if (chat) {
        restoreChat(tab.id, chat);
        chatSeen.set(tab.id, chatMark(tab.id));
      }
    }
    for (const tab of tabsState.list) {
      if (tab.waiting === "checking") void settle(tab.sessionId);
    }
  }

  /** The mark of a conversation with no turns — a tab that never asked has nothing new to write. */
  const NO_CHAT = "0:0:0";

  /** A cheap mark of a conversation: it changed when this did. */
  function chatMark(sessionId: string): string {
    const messages = peekChat(sessionId)?.messages ?? [];
    const last = messages.at(-1);
    return `${messages.length}:${last?.content.length ?? 0}:${last?.reasoning?.length ?? 0}`;
  }

  /** Write down what a tab holds now (or remove what was kept, where it no longer is). */
  async function keep(tab: Tab, now: number): Promise<void> {
    const sid = tab.sessionId;
    if (!keepsContent(settings, isProd(tab))) {
      if (kept.delete(sid)) await tabContentForget([sid]).catch(writtenByCall);
      printed.delete(sid);
      return;
    }
    const mark = chatMark(sid);
    if (!printed.has(sid) && (chatSeen.get(sid) ?? NO_CHAT) === mark) return;
    printed.delete(sid);
    const term = (await deps.keepsake?.(sid).catch(orNull("terminal", "the terminal's output was not kept for the next launch"))) ?? null;
    const messages = peekChat(sid)?.messages ?? [];
    if (!term && messages.length === 0) return;
    // Closed while its terminal was being read: nothing to keep.
    if (!findTab(sid)) return;
    try {
      await tabContentSave(sid, contentRecord({ savedAt: now, term, chat: messages }));
      chatSeen.set(sid, mark);
      kept.add(sid);
    } catch {
      // Over the limit or the disk refused: tried again with the next output.
      printed.add(sid);
    }
  }

  /** Write down every tab of this window whose terminal or conversation changed. */
  async function keepAll(): Promise<void> {
    const now = Date.now();
    await Promise.all(tabsState.list.map((tab) => keep(tab, now)));
  }

  /** Read the files a connection had open, now that it is open. */
  async function openDocs(sessionId: string) {
    const maxBytes = settings.sftp.maxOpenMb * 1024 * 1024;
    for (const doc of awaitingDocs(sessionId)) {
      startLoading(sessionId, doc.id);
      try {
        const file =
          doc.source === "local"
            ? await readLocalText(doc.path, maxBytes)
            : await sftpReadText(sessionId, doc.path, maxBytes);
        fillEditor(sessionId, doc.id, file, editorLangWithDialect(doc.lang, file.content));
        if (doc.source === "sftp") {
          void sftpWriteAccess(sessionId, doc.path)
            .then((access) => setEditorWriteAccess(sessionId, doc.id, access))
            .catch(() => setEditorWriteAccess(sessionId, doc.id, "unknown"));
        }
      } catch (e) {
        failEditor(sessionId, doc.id, String(e));
      }
    }
  }

  /** The main window's part of a restore: the slots read, its own tabs brought back. */
  async function takeMain(): Promise<Restored | null> {
    const slots = takeSavedTabs();
    if (!slots) {
      // Nothing comes back: nothing kept is anyone's.
      void tabContentKeepOnly([]).catch(writtenByCall);
      return null;
    }
    const back = restoreSaved(slots.main, slots.others, (id) => deps.servers().some((s) => s.id === id));
    if (back.missing > 0) notifyInfo(t("restore.serversGone", { n: back.missing }), { source: "connection" });
    const everyTab = [...back.tabs, ...back.windows.flatMap((w) => w.window.tabs)];
    // What a tab that did not come back held goes; so does all of it when it is not kept.
    void tabContentKeepOnly(settings.restoreOutput ? everyTab.map((tab) => tab.id) : []).catch(writtenByCall);
    bringBack(back.tabs, back.layout, back.beforeTile, await loadContent(back.tabs));
    return back;
  }

  return {
    /**
     * Bring the saved tabs back — once, with the catalog loaded. The main window
     * calls it: it reads every slot, keeps its own tabs and has the backend open
     * the other windows again with theirs.
     */
    async restore() {
      if (restored) return;
      restored = true;
      let back: Restored | null;
      try {
        back = await takeMain();
      } finally {
        // Only now may this window write its slot: before, "no tabs yet" would
        // have replaced the tabs it had. (It also drops the other windows'
        // slots — those that come back are handed their tabs, not their slot,
        // so this comes before they are opened and start writing theirs.)
        startSavingTabs();
      }
      if (!back || back.windows.length === 0) return;
      const ask = back.windows.map((w) => ({ label: w.label, record: windowRecord(w.window) }));
      const opened = await reopenWindows(ask, deps.background?.() ?? null).catch(() => [] as string[]);
      const stay = withWindows({ ...back, tabs: [] }, opened);
      if (stay.length === 0) return;
      // A window that did not open again: its tabs join this one, in the pane in focus.
      bringBack(stay, savedLayout(tabsState.center), null, await loadContent(stay));
    },

    /**
     * A window reopened at launch (v1.36): the tabs the main window handed it.
     * Resolves with how many came back — none, and the window has nothing to
     * show; null when this window was not reopened (it was opened for a tab).
     */
    async restoreWindow(): Promise<number | null> {
      const record = await takeRestore().catch(nullWrittenByCall);
      if (record === null) return null;
      restored = true;
      // Written by the main window a moment ago — and read like any slot.
      const raw = safeJson(record);
      if (!parseSavedWindow(raw)) return 0;
      const back = restoreSaved(raw, [], (id) => deps.servers().some((s) => s.id === id));
      bringBack(back.tabs, back.layout, back.beforeTile, await loadContent(back.tabs));
      return tabsState.list.length;
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
        notifyError(String(e), { source: "connection" });
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

    /**
     * A tab's session is open. What it brought from the previous launch is used:
     * its files are read now, its replayed output is not replayed again. An SSH
     * shell is taken to its folder once it says where it is (`shellAt`).
     */
    connected(sessionId: string) {
      const tab = findTab(sessionId);
      if (!tab) return;
      clearRestored(sessionId, tab.kind === "ssh");
      if (awaitingDocs(sessionId).length > 0) void openDocs(sessionId);
    },

    /**
     * The shell of a session said where it is (OSC 7). A restored SSH tab whose
     * shell was elsewhere at the end of the previous launch is taken there —
     * once, and only now: a prompt that reports its folder is a shell, not a
     * login menu that the line would answer. A local shell was started there.
     */
    shellAt(sessionId: string, path: string) {
      const tab = findTab(sessionId);
      if (!tab?.startDir || tab.kind !== "ssh" || tab.attach) return;
      const dir = tab.startDir;
      clearRestored(sessionId);
      if (dir === path) return;
      const cmd = cdCommand(dir, "posix");
      if (cmd) void writeToTerminal(sessionId, new TextEncoder().encode(submitLine(cmd))).catch(writtenByCall);
    },

    /** The session printed: its terminal is written down with the next round. */
    printed(sessionId: string) {
      printed.add(sessionId);
    },

    /**
     * Write down, every `CONTENT_SAVE_MS`, what changed in this window's tabs —
     * while `restoreOutput` is on. Returns the stop.
     */
    startKeeping(): () => void {
      const timer = setInterval(() => void keepAll(), CONTENT_SAVE_MS);
      return () => clearInterval(timer);
    },

    /** The app quits: write down what changed now — no longer than `FLUSH_TIMEOUT_MS`. */
    async flush(): Promise<void> {
      if (!settings.restoreOutput) return;
      await Promise.race([keepAll(), new Promise<void>((done) => setTimeout(done, FLUSH_TIMEOUT_MS))]);
    },

    /** The tab's session ended (it was closed): what was kept of it goes. */
    forget(sessionId: string) {
      printed.delete(sessionId);
      chatSeen.delete(sessionId);
      if (kept.delete(sessionId) || settings.restoreOutput) void tabContentForget([sessionId]).catch(writtenByCall);
    },

    /**
     * The setting changed. Turned off — or tabs no longer coming back at all —
     * what was kept goes at once; nothing waits for the next launch to remove it.
     */
    settingsChanged() {
      if (settings.restoreOutput && settings.restoreTabs !== "off") return;
      printed.clear();
      chatSeen.clear();
      if (kept.size === 0 && !restored) return;
      kept.clear();
      void tabContentKeepOnly([]).catch(writtenByCall);
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type RestoreFlow = ReturnType<typeof createRestoreFlow>;
