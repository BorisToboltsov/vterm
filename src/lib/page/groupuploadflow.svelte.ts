// Upload to the synchronous-input group (ADR 0064), as the page drives it: the
// file panel of a member uploads into the folder it shows, on every member's
// server, by that folder's absolute path. Before anything is sent, each server
// is asked what that folder holds and the user is asked once, for all of them;
// then each server gets its own transfer job through `startTransfer`, the one
// path to a job. The panel can also lay its folder beside the group's.
//
// What a listing means is `files/groupupload.ts`; the jobs and their progress are
// the backend's and the transfers store's.

import { sftpList } from "../api";
import { writtenByCall } from "../api/call";
import { diag } from "../api/diag";
import {
  canReceive,
  elsewhere,
  hostCheck,
  hostSources,
  listFailure,
  markOf,
  type Mark,
  type UploadAsk,
  type UploadHost,
  type UploadSource,
} from "../files/groupupload";
import { DISK, startTransfer } from "../files/transferflow";
import type { FileEntry } from "../types";

/** The panel's folder laid beside the group's. */
export interface GroupCompare {
  dir: string;
  loading: boolean;
  /** The panel's own server's listing of the folder (null — not read). */
  lead: FileEntry[] | null;
  members: { id: string; label: string; entries: FileEntry[] | null }[];
}

/** What the page tells the flow, each read when it is needed. */
export interface GroupUploadDeps {
  /**
   * The live members of the group `sid` is in while synchronous input is on for
   * it; null — none. Members whose file panel is no server's folder (a local
   * shell, a container's) are named in the question, not sent to.
   */
  groupOf: (sid: string) => string[] | null;
  /** The member's file panel is its server's folder over SFTP. */
  isSsh: (id: string) => boolean;
  isProd: (id: string) => boolean;
  label: (id: string) => string;
}

export function createGroupUploadFlow(deps: GroupUploadDeps) {
  let ask = $state<UploadAsk | null>(null);
  let asked = 0;
  const compares = $state<Record<string, GroupCompare>>({});
  let compareSeq = 0;

  /** The group's servers for `sid` — its own first — and the members that are none. */
  function serversOf(sid: string): { ssh: string[]; outside: string[] } | null {
    const group = deps.groupOf(sid);
    if (!group || !group.includes(sid) || !deps.isSsh(sid)) return null;
    const ssh = [sid, ...group.filter((id) => id !== sid && deps.isSsh(id))];
    return ssh.length > 1 ? { ssh, outside: group.filter((id) => !deps.isSsh(id)) } : null;
  }

  async function listOrNull(id: string, dir: string): Promise<FileEntry[] | null> {
    try {
      return await sftpList(id, dir);
    } catch {
      // `call()` wrote it; the comparison shows the member as "not read".
      writtenByCall();
      return null;
    }
  }

  function setHost(n: number, id: string, change: Partial<UploadHost>) {
    if (!ask || n !== asked) return;
    ask = { ...ask, hosts: ask.hosts.map((h) => (h.id === id ? { ...h, ...change } : h)) };
  }

  function cancel() {
    asked++;
    ask = null;
  }

  function compared(sid: string, dir: string): GroupCompare | null {
    const c = compares[sid];
    return c && c.dir === dir ? c : null;
  }

  function clearCompare(sid: string) {
    compareSeq++;
    delete compares[sid];
  }

  return {
    get ask() {
      return ask;
    },

    /** How many servers an upload from `sid`'s panel would go to; null — only its own. */
    servers(sid: string): number | null {
      return serversOf(sid)?.ssh.length ?? null;
    },

    /** Upload `sources` into `destDir` on every server of `sid`'s group. False — `sid` uploads alone. */
    upload(sid: string, destDir: string, sources: UploadSource[]): boolean {
      const group = serversOf(sid);
      if (!group) return false;
      if (sources.length === 0) return true;
      const n = ++asked;
      ask = {
        lead: sid,
        destDir,
        sources,
        hosts: group.ssh.map((id) => ({ id, label: deps.label(id), prod: deps.isProd(id), check: null, picked: false })),
        outside: group.outside.map((id) => deps.label(id)),
        replace: false,
      };
      for (const id of group.ssh) {
        void sftpList(id, destDir).then(
          (entries) => {
            const check = hostCheck(sources, entries);
            setHost(n, id, { check, picked: canReceive(check) });
          },
          (e: unknown) => setHost(n, id, { check: listFailure(String(e)), picked: false }),
        );
      }
      return true;
    },

    setReplace(replace: boolean) {
      if (ask) ask = { ...ask, replace };
    },

    toggle(id: string) {
      if (!ask) return;
      ask = { ...ask, hosts: ask.hosts.map((h) => (h.id === id && h.check && canReceive(h.check) ? { ...h, picked: !h.picked } : h)) };
    },

    cancel,

    /** Start one job per ticked server that has something to receive. */
    async confirm() {
      const a = ask;
      if (!a) return;
      cancel();
      const go = a.hosts.flatMap((h) => {
        const plan = h.picked && h.check ? hostSources(a.sources, h.check, a.replace) : null;
        return plan ? [{ host: h, plan }] : [];
      });
      if (go.length === 0) return;
      diag.info(
        "transfer",
        `upload to the group: ${a.sources.length} items to ${go.length} servers`,
        { servers: go.length, items: a.sources.length, replace: a.replace },
        { code: "group-upload" },
      );
      await Promise.all(
        go.map(({ host, plan }) =>
          startTransfer({
            src: DISK,
            dst: { session: host.id, local: false, label: "" },
            sources: plan.sources.map((s) => ({ path: s.path, isDir: s.isDir })),
            destDir: a.destDir,
            // The group's question was the answer: "replace" was ticked in it.
            agreed: plan.replace,
          }),
        ),
      );
    },

    /** Lay the folder `dir` of `sid`'s panel beside the same folder on the group's servers. */
    async compare(sid: string, dir: string) {
      const group = serversOf(sid);
      if (!group) return;
      const seq = ++compareSeq;
      const others = group.ssh.filter((id) => id !== sid);
      compares[sid] = {
        dir,
        loading: true,
        lead: null,
        members: others.map((id) => ({ id, label: deps.label(id), entries: null })),
      };
      const [lead, ...lists] = await Promise.all([sid, ...others].map((id) => listOrNull(id, dir)));
      if (seq !== compareSeq || compares[sid]?.dir !== dir) return;
      compares[sid] = {
        dir,
        loading: false,
        lead,
        members: others.map((id, i) => ({ id, label: deps.label(id), entries: lists[i] })),
      };
    },

    /** The comparison of `sid`'s panel, while it is in the folder compared. */
    compared,

    /** A row against the group: how each other server's copy compares, in the group's order. */
    marks(sid: string, dir: string, entry: FileEntry): { label: string; mark: Mark }[] | null {
      const c = compared(sid, dir);
      if (!c || c.loading) return null;
      return c.members.map((m) => ({ label: m.label, mark: markOf(entry, m.entries) }));
    },

    /** Names only the other servers hold in the compared folder. */
    elsewhere(sid: string, dir: string) {
      const c = compared(sid, dir);
      return c && !c.loading && c.lead ? elsewhere(c.lead, c.members) : [];
    },

    clearCompare,

    /** A tab closed: its comparison goes, and a question it asked. */
    forget(sid: string) {
      if (sid in compares) clearCompare(sid);
      if (ask?.lead === sid) cancel();
    },
  };
}

export type GroupUploadFlow = ReturnType<typeof createGroupUploadFlow>;
