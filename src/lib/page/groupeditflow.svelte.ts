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

import { annotateRecording, isFileChangedError, sftpReadText, sftpWriteText, sudoCheck } from "../api";
import { sudoAnswer } from "../sudo/sudo";
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
  sudoCanTry,
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

  /** What a failed read becomes on the member's row: sudo's answer, or the reason. */
  function failedRead(e: unknown, sudo: boolean): HostEdit {
    // `call()` wrote the refusal; the dialog says it on the member's row.
    writtenByCall();
    const answer = sudo ? sudoAnswer(e) : null;
    return answer ? { kind: "denied", sudo: answer } : readFailure(String(e));
  }

  /**
   * Read the member's copy. Through sudo, each server's own sudo password goes
   * first — what its session took, none, its saved one, its login's (ADR 0073);
   * `typed` only where sudo still asks for one, through `sudoCheck`.
   */
  async function read(n: number, id: string, path: string, hunks: Hunk[], sudo: boolean, typed = "") {
    let edit: HostEdit;
    try {
      edit = patchHost(await sftpReadText(id, path, deps.maxBytes(), sudo), hunks, sudo);
    } catch (e) {
      edit = failedRead(e, sudo);
      if (sudo && typed && edit.kind === "denied" && edit.sudo && edit.sudo.kind !== "refused") {
        try {
          await sudoCheck(id, typed, false);
          edit = patchHost(await sftpReadText(id, path, deps.maxBytes(), true), hunks, true);
        } catch (again) {
          edit = failedRead(again, true);
        }
      }
    }
    setHost(n, id, { edit, picked: pickedAtFirst(edit) });
  }

  function close() {
    asked++;
    ask = null;
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

    /** Read again through sudo where the file could not be read as this user —
     *  each server with its own sudo password, `password` where none works. */
    sudo(password: string) {
      const a = ask;
      if (!a || !a.hunks || a.writing || a.done) return;
      const n = asked;
      const hunks = a.hunks;
      for (const h of a.hosts) {
        if (!sudoCanTry(h.edit)) continue;
        setHost(n, h.id, { edit: { kind: "reading" } });
        void read(n, h.id, a.path, hunks, true, password);
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
    },

    /** A tab closed: a dialog about its file goes with it. */
    forget(sid: string) {
      if (ask && (ask.lead === sid || ask.hosts.some((h) => h.id === sid))) close();
    },
  };
}

export type GroupEditFlow = ReturnType<typeof createGroupEditFlow>;
