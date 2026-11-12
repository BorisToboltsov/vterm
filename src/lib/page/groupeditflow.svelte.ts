// Editing a file on the synchronous-input group (ADR 0064), as the page drives
// it: the edit made in a member's editor — the source — is carried as a patch to
// the same path on every other server of the group. Each server's copy is read,
// the patch applied to it in the app, and the dialog shows what each would
// become; only then, on the user's word, the source is saved and the others
// written — each against the hash it was read with, in its own encoding and
// line endings, so a file changed meanwhile is not overwritten.
//
// What the patch does is `editor/linepatch.ts`; what a member's state means is
// `editor/groupedit.ts`.

import { annotateRecording, isFileChangedError, sftpReadText, sftpWriteText } from "../api";
import { writtenByCall } from "../api/call";
import { diag } from "../api/diag";
import { t } from "../i18n";
import { isRecording } from "../stores/recordings.svelte";
import type { EditorDoc } from "../stores/workspaces.svelte";
import { lineDiffStat } from "../ui/util";
import {
  patchHost,
  pickedAtFirst,
  readFailure,
  writable,
  type EditAsk,
  type EditHost,
  type HostEdit,
} from "../editor/groupedit";
import { hunksOf, type Hunk } from "../editor/linepatch";

/** What the page tells the flow, each read when it is needed. */
export interface GroupEditDeps {
  /** The live members of the group `sid` is in while synchronous input is on for it; null — none. */
  groupOf: (sid: string) => string[] | null;
  /** The member's files are its server's, over SFTP. */
  isSsh: (id: string) => boolean;
  isProd: (id: string) => boolean;
  label: (id: string) => string;
  maxBytes: () => number;
  /** Keep a backup of the file it replaces (`settings.editor.backupOnSave`). */
  backup: () => boolean;
  /** Save the source's own file — its editor's save, without the diff before it. */
  saveLead: (sid: string, doc: EditorDoc) => Promise<boolean>;
}

export function createGroupEditFlow(deps: GroupEditDeps) {
  let ask = $state<EditAsk | null>(null);
  let asked = 0;
  // The sudo password typed into the dialog: in memory, for this dialog only.
  let sudoPassword = "";

  function others(sid: string): string[] | null {
    const group = deps.groupOf(sid);
    if (!group || !group.includes(sid) || !deps.isSsh(sid)) return null;
    const rest = group.filter((id) => id !== sid && deps.isSsh(id));
    return rest.length > 0 ? rest : null;
  }

  function setHost(n: number, id: string, change: Partial<EditHost>) {
    if (!ask || n !== asked) return;
    ask = { ...ask, hosts: ask.hosts.map((h) => (h.id === id ? { ...h, ...change } : h)) };
  }

  async function read(n: number, id: string, path: string, hunks: Hunk[], sudo: boolean) {
    let edit: HostEdit;
    try {
      const file = await sftpReadText(id, path, deps.maxBytes(), sudo, sudo ? sudoPassword : undefined);
      edit = patchHost(file, hunks, sudo);
    } catch (e) {
      // `call()` wrote the refusal; the dialog says it on the member's row.
      writtenByCall();
      edit = readFailure(String(e));
    }
    setHost(n, id, { edit, picked: pickedAtFirst(edit) });
  }

  function close() {
    asked++;
    ask = null;
    sudoPassword = "";
  }

  return {
    get ask() {
      return ask;
    },

    /** How many other servers the edit of `sid`'s file can be carried to; null — none. */
    servers(sid: string): number | null {
      return others(sid)?.length ?? null;
    },

    /** Read the file on every other server of the group and carry the edit into each. */
    open(sid: string, doc: EditorDoc) {
      const rest = others(sid);
      if (!rest || doc.source !== "sftp") return;
      const n = ++asked;
      sudoPassword = "";
      const hunks = hunksOf(doc.baseContent, doc.content);
      ask = {
        lead: sid,
        leadLabel: deps.label(sid),
        docId: doc.id,
        path: doc.path,
        name: doc.name,
        hunks,
        hosts: rest.map((id) => ({ id, label: deps.label(id), prod: deps.isProd(id), edit: { kind: "reading" }, picked: false })),
        writing: false,
        done: false,
        leadFailed: false,
      };
      if (hunks === null) return;
      for (const id of rest) void read(n, id, doc.path, hunks, false);
    },

    toggle(id: string) {
      if (!ask || ask.writing || ask.done) return;
      ask = { ...ask, hosts: ask.hosts.map((h) => (h.id === id && writable(h.edit) ? { ...h, picked: !h.picked } : h)) };
    },

    /** Read again through sudo where the file could not be read as this user. */
    sudo(password: string) {
      const a = ask;
      if (!a || !a.hunks || a.writing || a.done) return;
      sudoPassword = password;
      const n = asked;
      const hunks = a.hunks;
      for (const h of a.hosts) {
        if (h.edit.kind !== "denied") continue;
        setHost(n, h.id, { edit: { kind: "reading" } });
        void read(n, h.id, a.path, hunks, true);
      }
    },

    close,

    /** Save the source, then write every ticked server's copy. */
    async apply(doc: EditorDoc) {
      const a = ask;
      if (!a || a.writing || a.done || doc.id !== a.docId) return;
      const n = asked;
      ask = { ...a, writing: true };
      const saved = await deps.saveLead(a.lead, doc);
      if (!saved) {
        if (n === asked && ask) ask = { ...ask, writing: false, leadFailed: true };
        diag.warn("editor", "edit on the group stopped: the source file was not saved", { servers: a.hosts.length }, { code: "group-edit-stopped" });
        return;
      }
      const go = a.hosts.filter((h) => h.picked && writable(h.edit));
      let written = 0;
      let failed = 0;
      for (const h of go) {
        if (!writable(h.edit)) continue;
        const { file, text, sudo } = h.edit;
        try {
          await sftpWriteText(h.id, a.path, text, file.eol, file.sha256, {
            sudo,
            sudoPassword: sudo ? sudoPassword : undefined,
            backup: deps.backup(),
            encoding: file.encoding,
          });
          setHost(n, h.id, { edit: { kind: "written" } });
          written++;
          if (isRecording(h.id)) {
            const stat = lineDiffStat(file.content, text);
            annotateRecording(h.id, t("editor.auditEdit", { path: a.path, added: stat.added, removed: stat.removed })).catch(
              writtenByCall,
            );
          }
        } catch (e) {
          const error = isFileChangedError(e) ? t("groupEdit.changedMeanwhile") : String(e);
          setHost(n, h.id, { edit: { kind: "notWritten", error } });
          failed++;
          diag.warn(
            "editor",
            `edit on the group not written to a member: ${isFileChangedError(e) ? "the file changed since it was read" : String(e)}`,
            undefined,
            { code: "group-edit-not-written", sid: h.id, server: h.label },
          );
        }
      }
      const already = a.hosts.filter((h) => h.edit.kind === "patched" && h.edit.outcome === "already").length;
      const left = a.hosts.length - written - failed - already;
      diag.info(
        "editor",
        `edit carried to the group: ${written} written, ${failed} not written, ${already} had it, ${left} left`,
        { written, failed, already, left },
        { code: "group-edit" },
      );
      if (n === asked && ask) ask = { ...ask, writing: false, done: true };
      sudoPassword = "";
    },

    /** A tab closed: a dialog about its file goes with it. */
    forget(sid: string) {
      if (ask && (ask.lead === sid || ask.hosts.some((h) => h.id === sid))) close();
    },
  };
}

export type GroupEditFlow = ReturnType<typeof createGroupEditFlow>;
