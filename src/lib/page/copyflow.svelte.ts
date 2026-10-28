// Copying files to another session, as the page drives it (v1.12, out of
// +page.svelte in v1.25.2): the sessions a file can be copied to — this window's
// tabs and what the other windows offer — telling the other windows this
// window's, and the dialog that asks where the files go before the transfer
// starts. The transfer itself is a backend job (transferflow.ts, ADR 0025).

import { untrack } from "svelte";
import { announceCopyTargets, localHome, sftpHome } from "../api";
import { copyTargets, defaultDestDir, shareTargets, sideOf, type CopyTarget } from "../copyto";
import { dockCwd } from "../stores/dockstate.svelte";
import {
  pendingCopyRequest,
  setCopyTargets,
  takeCopyRequest,
  type CopyRequest,
} from "../stores/filecopy.svelte";
import type { Tab } from "../stores/tabs.svelte";
import { DISK, startTransfer } from "../transferflow";

/** What the page tells the copy flow, each read when it is needed. */
export interface CopyDeps {
  tabs: () => Tab[];
  findTab: (id: string) => Tab | null | undefined;
  /** A tab's full title (`nginx · Rescalc dev` for a container tab). */
  title: (tab: Tab) => string;
  isProd: (sessionId: string) => boolean;
  /** The folder the terminal of a session is in, when it said so. */
  terminalCwd: (sessionId: string) => string | null;
}

export function createCopyFlow(deps: CopyDeps) {
  // The tabs a file can be copied to, for the file panels' menu.
  const mine = $derived(copyTargets(deps.tabs(), (tab) => deps.title(tab as Tab), deps.isProd));
  // What the other windows offer (v1.13): a file is copied to a session
  // whichever window shows its tab — the transfer is the backend's.
  let others = $state<CopyTarget[]>([]);
  /** Every session a file can be copied to: this window's, then the others'. */
  const all = $derived([...mine, ...others]);

  $effect(() => {
    setCopyTargets(all);
  });
  // This window's are told to the others — when they change, not on every
  // change of a tab that leaves them as they were.
  let told = "";
  $effect(() => {
    const shared = shareTargets(mine);
    const said = JSON.stringify(shared);
    if (said === told) return;
    told = said;
    void announceCopyTargets(shared).catch(() => {});
  });

  // The copy being set up: what, from which tab, to which — and where there.
  // Raw, not deep: `open` recognises its own request by identity once the home
  // folder arrives, and a deep $state hands back a proxy instead — the check
  // never held, and the folder field of a tab with no known folder stayed empty.
  let ask = $state.raw<{ request: CopyRequest; target: CopyTarget } | null>(null);
  let dir = $state("");

  /**
   * Open the dialog for a request: the destination folder comes prefilled —
   * with `into` when the files were dropped on a folder, else with where that
   * tab is.
   */
  async function open(request: CopyRequest, into: string | null = null) {
    const target = all.find((x) => x.sessionId === request.to);
    if (!target) return;
    dir =
      into ??
      defaultDestDir(dockCwd(target.sessionId), deps.terminalCwd(target.sessionId), null) ??
      "";
    ask = { request, target };
    if (dir) return;
    // Nothing known of that tab's folders yet: ask the session for its home.
    try {
      const home = await (target.local ? localHome() : sftpHome(target.sessionId));
      if (ask?.request === request && !dir) dir = home;
    } catch {
      /* the field stays empty — the user types the folder */
    }
  }

  // A file panel filed a request (its row menu): show it.
  $effect(() => {
    if (!pendingCopyRequest()) return;
    untrack(() => {
      const request = takeCopyRequest();
      if (request) void open(request);
    });
  });

  return {
    /** This window's sessions a file can be copied to. */
    get mine() {
      return mine;
    },
    /** Every session a file can be copied to, this window's first. */
    get all() {
      return all;
    },
    /** What another window said it offers. */
    heardOthers(list: CopyTarget[]) {
      others = list;
    },
    get ask() {
      return ask;
    },
    get dir() {
      return dir;
    },
    set dir(value: string) {
      dir = value;
    },
    open,
    cancel() {
      ask = null;
    },

    /** The dialog's "Copy": start the job (asking first about names taken there). */
    confirm(destDir: string) {
      const current = ask;
      ask = null;
      if (!current) return;
      const { request } = current;
      const from = request.from ? deps.findTab(request.from) : null;
      void startTransfer({
        // From the desktop the files belong to no tab; from another window the
        // tab is not this window's, and says what it is called itself.
        src:
          request.from === null
            ? DISK
            : sideOf({
                sessionId: request.from,
                local: request.local,
                title: from ? deps.title(from) : (request.label ?? ""),
              }),
        dst: sideOf(current.target),
        sources: request.entries.map((e) => ({ path: e.path, isDir: e.isDir })),
        destDir,
      });
    },
  };
}

export type CopyFlow = ReturnType<typeof createCopyFlow>;
