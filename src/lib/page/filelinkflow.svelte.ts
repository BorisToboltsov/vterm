// Files named in terminal output, as the page drives them (v1.24, ADR 0035; out
// of +page.svelte in v1.25.3): what a click on a name does, the question asked
// before opening, and opening — a file the way the file panel opens one, a
// folder in the file panel itself. What a click means is `fileLinkClick`
// (termfiles.ts); which names are links is the terminal's.
//
// Opening is this flow's alone and runs only as `fileLinkClick` decided or as
// the question was answered; "don't ask again" is the only writer of the mode.

import { t } from "../i18n";
import { settings } from "../settings/settings.svelte";
import { requestFilesDir } from "../stores/dockstate.svelte";
import { revealPanel } from "../stores/layout.svelte";
import { activateTab, tabsState, type Tab } from "../stores/tabs.svelte";
import { notifyInfo } from "../stores/toasts.svelte";
import { fileLinkClick, type FileLinkQuestion, type FileLinkTarget, type NamedPath } from "../terminal/termfiles";
import type { ServerProfile } from "../types";

/** What the page tells the file-link flow, each read when it is needed. */
export interface FileLinkDeps {
  findTab: (id: string) => Tab | null | undefined;
  servers: () => ServerProfile[];
  isProd: (sessionId: string) => boolean;
  /** Path sync: whether the session follows its terminal, and turning it on. */
  following: (sessionId: string) => boolean;
  enablePathSync: (sessionId: string) => void;
  /** The editor's own ways in: over the session's SFTP, and on this computer. */
  openFile: (sessionId: string, path: string, opts: { gotoLine?: number }) => void;
  openLocalFile: (sessionId: string, path: string, opts: { gotoLine?: number }) => void;
}

export function createFileLinkFlow(deps: FileLinkDeps) {
  let ask = $state<FileLinkQuestion | null>(null);

  /** The server a tab runs on, by name; null for a local tab — this computer. */
  function where(tab: Tab): string | null {
    return tab.kind === "local" ? null : (deps.servers().find((s) => s.id === tab.serverId)?.alias ?? tab.alias);
  }

  /** Open what a link names: a file in the session's editor — on the line the
   *  output named, if it named one — a folder in its file panel. */
  function open(id: string, target: NamedPath) {
    const tab = deps.findTab(id);
    if (!tab) return;
    if (tabsState.activeId !== id) activateTab(id);
    if (target.kind === "dir") {
      requestFilesDir(id, target.path);
      revealPanel("files");
    } else if (tab.kind === "ssh") {
      deps.openFile(id, target.path, { gotoLine: target.line });
    } else {
      deps.openLocalFile(id, target.path, { gotoLine: target.line });
    }
  }

  return {
    /** The question awaiting an answer (FileLinkDialog). */
    get ask(): FileLinkQuestion | null {
      return ask;
    },

    /** A click the terminal let through: open, ask, or offer path sync. */
    clicked(id: string, target: FileLinkTarget) {
      const tab = deps.findTab(id);
      if (!tab) return;
      const action = fileLinkClick(settings.terminalFileLinks, target);
      if (action.kind === "open") {
        open(id, action.target);
      } else if (action.kind === "ask") {
        ask = { kind: "open", sessionId: id, target: action.target, where: where(tab), prod: deps.isProd(id) };
      } else if (action.kind === "offerSync") {
        ask = { kind: "sync", sessionId: id, where: where(tab), following: deps.following(id) };
      }
    },

    answer(answer: "open" | "sync" | "cancel", silence: boolean) {
      const current = ask;
      ask = null;
      if (!current || answer === "cancel" || !deps.findTab(current.sessionId)) return;
      if (current.kind === "open" && answer === "open") {
        if (silence) settings.terminalFileLinks = "direct";
        open(current.sessionId, current.target);
      } else if (current.kind === "sync" && answer === "sync") {
        // The server's own answer decides whether this asks first (v1.23); once
        // following is on, the next command reports its folder.
        deps.enablePathSync(current.sessionId);
        if (deps.following(current.sessionId)) notifyInfo(t("filelink.syncThen"));
      }
    },

    /** The tab is gone: a question about it has nothing left to open. */
    forget(id: string) {
      if (ask?.sessionId === id) ask = null;
    },
  };
}

export type FileLinkFlow = ReturnType<typeof createFileLinkFlow>;
