// Path sync, as the page drives it (v1.23, out of +page.svelte in v1.25.3): which
// sessions follow their terminal's folder, the command that makes an SSH shell
// report it, the question a server without an answer asks, and what a session's
// connect and end do to it. When to ask and whether to follow on connect is
// pathsync.ts; the folder the terminal reported is the page's.
//
// Following is this flow's own state and reads out read-only: it starts in
// `start` alone — by hand, from the question, on connect — so no path can skip
// the setup command or type it without the answer that allows it.

import { setServerPathSync, writeToTerminal } from "../api";
import { t } from "../i18n";
import type { PathSyncAsk } from "../pathsync/PathSyncDialog.svelte";
import {
  asksOnEnable,
  choiceMode,
  followsOnConnect,
  pathSyncMode,
  storedPathSync,
  type PathSyncChoice,
  type PathSyncMode,
} from "../pathsync/pathsync";
import { settings } from "../settings/settings.svelte";
import { needsShellSetup, OSC7_SETUP } from "../pathsync/shellintegration";
import { dockConnection, type Tab } from "../stores/tabs.svelte";
import { notifyError } from "../stores/toasts.svelte";
import { submitLine } from "../terminal/terminput";
import type { ServerProfile } from "../types";

/** What a session runs of its own once connected — the setup line would land there. */
export interface SessionRuns {
  attach: boolean;
  pendingCommand: boolean;
}

/** What the page tells the path-sync flow, each read when it is needed. */
export interface PathSyncDeps {
  findTab: (id: string) => Tab | null | undefined;
  servers: () => ServerProfile[];
  /** A profile the backend wrote back: the page puts it in its catalogue. */
  serverSaved: (server: ServerProfile) => void;
  isProd: (sessionId: string) => boolean;
  /** The folder the terminal of a session reported, if it did. */
  terminalCwd: (sessionId: string) => string | null;
  /** The session's shell is gone: forget the folder it reported. */
  forgetCwd: (sessionId: string) => void;
  /** The pause before typing into a freshly connected shell, so its prompt is up. */
  promptDelayMs: number;
}

export function createPathSyncFlow(deps: PathSyncDeps) {
  const following = $state<Record<string, boolean>>({});
  // Sessions whose shell was given the setup command — it lasts as long as the shell.
  const integrated = $state<Record<string, boolean>>({});
  let ask = $state<PathSyncAsk | null>(null);

  /** How path sync starts for a tab: the server's own answer from its profile; a
   *  local tab has no profile, so its answer lives in settings. */
  function modeOf(tab: Tab): PathSyncMode {
    if (tab.kind === "local") return settings.localPathSync;
    return pathSyncMode(deps.servers().find((s) => s.id === tab.serverId)?.pathSync);
  }

  /** Whether this session's shell still needs the setup command — never a local
   *  tab, whose folder comes from the OS. See needsShellSetup. */
  function needsSetup(id: string): boolean {
    return needsShellSetup(deps.findTab(id)?.kind, !!deps.terminalCwd(id), !!integrated[id]);
  }

  /**
   * The one place following starts. `typeSetup` types the setup command into the
   * shell first — for this session only, nothing is saved on the server.
   */
  function start(id: string, typeSetup: boolean) {
    if (typeSetup) {
      writeToTerminal(id, new TextEncoder().encode(submitLine(OSC7_SETUP))).catch(() => {});
      integrated[id] = true;
    }
    following[id] = true;
  }

  /**
   * Turn path sync on for a session — the one dock-wide switch, whether it was
   * flipped in SFTP, in Git's toolbar or by Git's "Enable path sync" button. A
   * server without an answer asks first; one that has answered starts at once.
   */
  function enable(id: string) {
    if (following[id]) return;
    const tab = deps.findTab(id);
    if (!tab) return;
    if (!asksOnEnable(modeOf(tab))) {
      start(id, needsSetup(id));
      return;
    }
    ask = {
      sessionId: id,
      kind: tab.kind,
      target: tab.kind === "local" ? null : (deps.servers().find((s) => s.id === tab.serverId)?.alias ?? tab.alias),
      prod: deps.isProd(id),
      needsSetup: needsSetup(id),
    };
  }

  return {
    /** Which sessions follow their terminal. Read-only: following starts in this flow. */
    get following(): Readonly<Record<string, boolean>> {
      return following;
    },
    /** Whether this session's shell was given the setup command. */
    integrated(id: string): boolean {
      return !!integrated[id];
    },
    needsSetup,
    /** The question awaiting an answer (PathSyncDialog). */
    get ask(): PathSyncAsk | null {
      return ask;
    },
    enable,

    /** The dock's switch: off at once, on through `enable`. */
    toggle(id: string) {
      if (following[id]) {
        following[id] = false;
        return;
      }
      enable(id);
    },

    /** The question's answer: following starts either way — before a lasting
     *  answer is saved where this tab reads it, so a failed save leaves it on. */
    async answer(choice: PathSyncChoice) {
      const current = ask;
      ask = null;
      const tab = current ? deps.findTab(current.sessionId) : undefined;
      if (!current || !tab) return;
      start(current.sessionId, needsSetup(current.sessionId));
      const mode = choiceMode(choice);
      if (!mode) return;
      if (tab.kind === "local") {
        settings.localPathSync = mode;
        return;
      }
      try {
        deps.serverSaved(await setServerPathSync(tab.serverId, storedPathSync(mode)));
      } catch (e) {
        notifyError(t("pathSync.saveFailed", { error: String(e) }));
      }
    },

    cancel() {
      ask = null;
    },

    /**
     * A session just connected: a server set to "always" starts following by
     * itself — typing the setup command into a fresh SSH shell, which has reported
     * no folder yet and knows nothing typed into the last one. Not in a shell
     * running a program of its own (container/pod, `port-forward`): the line would
     * land there — so `runs` is what the tab ran before its pending command was
     * consumed. Typed after the same pause as a pending command, once the prompt is up.
     */
    connected(tab: Tab, runs: SessionRuns) {
      const id = tab.sessionId;
      if (following[id] || !followsOnConnect(modeOf(tab), runs)) return;
      if (!needsShellSetup(tab.kind, false, false)) {
        start(id, false);
        return;
      }
      setTimeout(() => {
        const now = deps.findTab(id);
        if (now && dockConnection(now.status) === "connected" && !following[id]) start(id, true);
      }, deps.promptDelayMs);
    },

    /** A session ended: its shell — and any command typed into it — is gone, so
     *  following stops; a reconnect starts it again only under "always". */
    closed(id: string) {
      following[id] = false;
      delete integrated[id];
      deps.forgetCwd(id);
      if (ask?.sessionId === id) ask = null;
    },

    /** A tab arriving from another window carries what it had — not a start. */
    adopt(id: string, carried: { following: boolean; integrated: boolean }) {
      if (carried.following) following[id] = true;
      if (carried.integrated) integrated[id] = true;
    },

    /** The tab is gone from this window. */
    forget(id: string) {
      delete following[id];
      delete integrated[id];
    },
  };
}

export type PathSyncFlow = ReturnType<typeof createPathSyncFlow>;
