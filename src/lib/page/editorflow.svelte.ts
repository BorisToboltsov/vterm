// The config editor, as the page drives it (Phase 12; out of +page.svelte in
// v1.25.3): opening a file of a session — over SFTP or on this computer — and
// writing it back, with what stands around that: the access check ahead of
// editing, sudo, the diff before saving, the conflict when the file changed on
// the server, the question when a file with unsaved edits is closed. Documents
// and their views are the workspaces store's; this flow decides when to touch them.
//
// A write goes through `write` alone. A failed save keeps the buffer and puts the
// way out next to Save (`saveIssue`) — it opens no dialog by itself.

import {
  annotateRecording,
  isBackupFailedError,
  isFileChangedError,
  isPermissionError,
  nginxConfigFiles,
  pickSavePath,
  readLocalText,
  saveEditorCopy,
  sftpCheckSudo,
  sftpReadText,
  sftpWriteAccess,
  sftpWriteText,
  writeLocalText,
} from "../api";
import { couldBeNginxInclude, editorLangOrPlain, editorLangWithDialect, editorLangWithIncludes } from "../editor/editorlang";
import { t } from "../i18n";
import { settings } from "../settings/settings.svelte";
import { isRecording } from "../stores/recordings.svelte";
import type { Tab } from "../stores/tabs.svelte";
import { notifyError, notifyInfo, notifySuccess } from "../stores/toasts.svelte";
import {
  addEditor,
  closeEditor,
  fillEditor,
  findEditorByPath,
  gotoEditorLine,
  isDirty,
  markSaved,
  setEditorSaveIssue,
  setEditorSudo,
  setEditorWriteAccess,
  showSessionView,
  type EditorDoc,
} from "../stores/workspaces.svelte";
import { lineDiffStat } from "../ui/util";

/** What the page tells the editor flow, each read when it is needed. */
export interface EditorDeps {
  findTab: (id: string) => Tab | null | undefined;
}

export type SudoAsk =
  | { kind: "open"; sid: string; path: string; name: string; gotoLine?: number }
  | { kind: "save" | "check"; sid: string; doc: EditorDoc };

export interface OpenOptions {
  gotoLine?: number;
  sudo?: boolean;
  sudoPassword?: string;
  gitBase?: string;
}

export function createEditorFlow(deps: EditorDeps) {
  let savingId = $state<string | null>(null);
  let closeAsk = $state<{ sid: string; doc: EditorDoc } | null>(null);
  // Pre-save diff confirmation (settings-gated) and conflict resolution.
  // `closeAfter`: the save came from the close-with-changes dialog — close the
  // file once the write lands (and only then: a failed save keeps it open).
  let diffSave = $state<{ sid: string; doc: EditorDoc; closeAfter?: boolean } | null>(null);
  let conflict = $state<{ sid: string; doc: EditorDoc; serverText: string } | null>(null);
  // Sudo prompt: reopen, check access ahead of editing, or retry a save.
  let sudo = $state<SudoAsk | null>(null);
  let sudoPassword = $state("");

  /** Configured editor open-size limit, in bytes. */
  const maxBytes = () => settings.sftp.maxOpenMb * 1024 * 1024;

  // Per-session cache of the paths nginx actually loads (`nginx -T`), so files that
  // include-outside `/etc/nginx/` still get nginx highlighting + lint. Fetched lazily
  // once per session, best-effort (empty set on error). Dropped with the tab.
  const nginxConfigs = new Map<string, { promise: Promise<ReadonlySet<string>>; sudo: boolean }>();
  async function ensureNginxConfigs(sid: string, password?: string): Promise<ReadonlySet<string>> {
    const cached = nginxConfigs.get(sid);
    if (cached) {
      const set = await cached.promise;
      // Reuse the cached result, except retry with sudo when a plain fetch came back
      // empty and we now hold a password (an open-as-root can read a config tree the
      // plain user can't) — this is silent, no fresh prompt.
      if (!(set.size === 0 && password && !cached.sudo)) return set;
    }
    const promise = nginxConfigFiles(sid, password)
      .then((list) => new Set(list) as ReadonlySet<string>)
      .catch(() => new Set<string>() as ReadonlySet<string>);
    nginxConfigs.set(sid, { promise, sudo: !!password });
    return promise;
  }

  /** Open a remote file of session `sid` in the in-app editor. */
  async function openFile(sid: string, path: string, name: string, opts: OpenOptions = {}) {
    // Any file opens in the editor; unknown/extensionless types fall back to plain
    // text (binary/oversize files are still rejected by the backend read below).
    // Pass the full path so custom nginx configs (conf.d, sites-available…) are
    // detected by directory, not just `nginx.conf` by name.
    let lang = editorLangOrPlain(path);
    const existing = findEditorByPath(sid, path);
    if (existing) {
      showSessionView(sid, existing.id);
      if (opts.gotoLine) gotoEditorLine(sid, existing.id, opts.gotoLine);
      return;
    }
    // For a config-shaped file not already recognised as nginx, also consult the set
    // of configs nginx actually loads (nginx -T) — catches includes outside the
    // `/etc/nginx/` tree. Fetched in parallel with the read; resolved just before open.
    const nginxSetP =
      lang.kind !== "nginx" && couldBeNginxInclude(path) ? ensureNginxConfigs(sid, opts.sudoPassword) : null;
    // Read first, so binary/too-large files just toast instead of opening a tab.
    let file;
    try {
      file = await sftpReadText(sid, path, maxBytes(), opts.sudo, opts.sudoPassword);
    } catch (e) {
      // No read access on a non-sudo read → offer to reopen as root.
      if (!opts.sudo && isPermissionError(e)) {
        sudoPassword = "";
        sudo = { kind: "open", sid, path, name, gotoLine: opts.gotoLine };
        return;
      }
      notifyError(String(e));
      return;
    }
    if (nginxSetP) lang = editorLangWithIncludes(path, await nginxSetP);
    // Content-based YAML dialects (k8s/Ansible) have no distinguishing name — upgrade
    // once the buffer is read so kubeconform/ansible-lint can run (no-op for non-YAML).
    lang = editorLangWithDialect(lang, file.content);
    const id = addEditor(sid, path, name, lang, "sftp", {
      gotoLine: opts.gotoLine,
      sudo: opts.sudo,
      sudoPassword: opts.sudoPassword,
      gitBase: opts.gitBase,
    });
    fillEditor(sid, id, file);
    // Whether a save will land is asked ahead of editing, not found out at Save.
    if (!opts.sudo) {
      void sftpWriteAccess(sid, path)
        .then((access) => {
          if (findEditorByPath(sid, path)?.id === id) setEditorWriteAccess(sid, id, access);
        })
        .catch(() => {
          if (findEditorByPath(sid, path)?.id === id) setEditorWriteAccess(sid, id, "unknown");
        });
    }
  }

  /** Open a file on this computer in a session's editor. */
  async function openLocal(sid: string, path: string, opts: { gitBase?: string; gotoLine?: number } = {}) {
    const name = path.split(/[\\/]/).pop() ?? path;
    const existing = findEditorByPath(sid, path);
    if (existing) {
      showSessionView(sid, existing.id);
      if (opts.gotoLine) gotoEditorLine(sid, existing.id, opts.gotoLine);
      return;
    }
    let file;
    try {
      file = await readLocalText(path, maxBytes());
    } catch (e) {
      notifyError(String(e));
      return;
    }
    const id = addEditor(sid, path, name, editorLangOrPlain(path), "local", {
      gitBase: opts.gitBase,
      gotoLine: opts.gotoLine,
    });
    fillEditor(sid, id, file);
  }

  /**
   * Actually write the file. `expectedSha` null = force overwrite (conflict).
   * Resolves `true` only when the file was written.
   */
  async function write(sid: string, doc: EditorDoc, expectedSha: string | null): Promise<boolean> {
    if (savingId) return false;
    savingId = doc.id;
    try {
      const before = doc.baseContent;
      const res =
        doc.source === "local"
          ? await writeLocalText(doc.path, doc.content, doc.eol, expectedSha, doc.encoding)
          : await sftpWriteText(sid, doc.path, doc.content, doc.eol, expectedSha, {
              sudo: doc.sudo,
              sudoPassword: doc.sudoPassword,
              backup: settings.editor.backupOnSave,
              // Write the file back in the encoding it was opened in (textenc.rs).
              encoding: doc.encoding,
            });
      const stat = lineDiffStat(before, doc.content);
      markSaved(sid, doc.id, res);
      notifySuccess(t("editor.saved", { name: doc.name }));
      // Audit trail (Phase 11 tie-in): record the edit if the session is recording.
      if (isRecording(sid)) {
        void annotateRecording(sid, t("editor.auditEdit", { path: doc.path, added: stat.added, removed: stat.removed }));
      }
      return true;
    } catch (e) {
      if (isFileChangedError(e)) {
        // Fetch the current on-disk text and let the user resolve the conflict.
        try {
          const cur =
            doc.source === "local"
              ? await readLocalText(doc.path, maxBytes())
              : await sftpReadText(sid, doc.path, maxBytes(), doc.sudo, doc.sudoPassword);
          conflict = { sid, doc, serverText: cur.content };
        } catch {
          notifyError(t("editor.conflict", { name: doc.name }));
        }
      } else if (!doc.sudo && doc.source === "sftp" && isPermissionError(e)) {
        // Keep the buffer and offer explicit recovery next to Save.
        setEditorSaveIssue(sid, doc.id, "permission");
      } else if (isBackupFailedError(e)) {
        // The save was abandoned with the file untouched — say that plainly, or
        // the user reads it as "save failed" and cannot tell what state the
        // server is in. The cause is carried along; the way out is in the hint.
        notifyError(t("editor.backupFailed", { name: doc.name, detail: String(e) }));
        setEditorSaveIssue(sid, doc.id, "other");
      } else {
        notifyError(String(e));
        setEditorSaveIssue(sid, doc.id, "other");
      }
      return false;
    } finally {
      savingId = null;
    }
  }

  return {
    /** The document being written now, if any. */
    get savingId() {
      return savingId;
    },
    get closeAsk() {
      return closeAsk;
    },
    get diffSave() {
      return diffSave;
    },
    get conflict() {
      return conflict;
    },
    get sudo() {
      return sudo;
    },
    /** The password field of the sudo prompt. */
    get sudoPassword() {
      return sudoPassword;
    },
    set sudoPassword(value: string) {
      sudoPassword = value;
    },
    maxBytes,
    openFile,
    openLocal,

    /** Open a git-changed file as an editable inline diff (from the git panel). */
    openGitDiff(sid: string, absPath: string, gitBase: string) {
      if (deps.findTab(sid)?.kind === "ssh") {
        void openFile(sid, absPath, absPath.split("/").pop() ?? absPath, { gitBase });
      } else {
        void openLocal(sid, absPath, { gitBase });
      }
    },

    /** Append a pattern to the repo's .gitignore (git panel "Ignore" action). */
    async appendGitignore(sid: string, gitignorePath: string, pattern: string) {
      const ssh = deps.findTab(sid)?.kind === "ssh";
      let current: string;
      try {
        const f = ssh ? await sftpReadText(sid, gitignorePath, maxBytes()) : await readLocalText(gitignorePath, maxBytes());
        current = f.content;
      } catch {
        current = ""; // no .gitignore yet → create it
      }
      if (current.split(/\r?\n/).some((l) => l.trim() === pattern)) {
        notifyInfo(t("git.alreadyIgnored"));
        return;
      }
      const sep = current && !current.endsWith("\n") ? "\n" : "";
      const next = `${current}${sep}${pattern}\n`;
      try {
        if (ssh) await sftpWriteText(sid, gitignorePath, next, "lf", null);
        else await writeLocalText(gitignorePath, next, "lf", null);
        notifySuccess(t("git.ignored", { pattern }));
      } catch (e) {
        notifyError(String(e));
      }
    },

    /** Save: nothing to do if unchanged; show the diff first when enabled. */
    save(sid: string, doc: EditorDoc) {
      if (doc.readOnly || savingId || doc.content === doc.baseContent) return;
      if (settings.editor.diffBeforeSave) {
        diffSave = { sid, doc };
        return;
      }
      void write(sid, doc, doc.baseSha256);
    },

    async confirmDiffSave() {
      const s = diffSave;
      diffSave = null;
      if (!s) return;
      const ok = await write(s.sid, s.doc, s.doc.baseSha256);
      if (ok && s.closeAfter) closeEditor(s.sid, s.doc.id);
    },

    cancelDiffSave() {
      diffSave = null;
    },

    /** A copy on this computer, where a save cannot land (never over another file). */
    async saveCopy(doc: EditorDoc) {
      const path = await pickSavePath(doc.name);
      if (!path) return;
      try {
        await saveEditorCopy(path, doc.content, doc.eol, doc.encoding);
        notifySuccess(t("editor.copySaved", { name: path.split(/[\\/]/).pop() ?? path }));
      } catch (e) {
        notifyError(String(e).includes("dest-exists") ? t("editor.copyExists") : String(e));
      }
    },

    /** Ask for the sudo password: to check access ahead of editing, or to save as root. */
    askSudo(sid: string, doc: EditorDoc, kind: "check" | "save") {
      sudoPassword = "";
      sudo = { kind, sid, doc };
    },

    /** The sudo prompt's answer: the password is checked before it is kept. */
    async confirmSudo() {
      const p = sudo;
      const pw = sudoPassword;
      sudo = null;
      sudoPassword = "";
      if (!p) return;
      if (p.kind === "open") {
        void openFile(p.sid, p.path, p.name, { gotoLine: p.gotoLine, sudo: true, sudoPassword: pw });
        return;
      }
      let usable: boolean;
      try {
        usable = await sftpCheckSudo(p.sid, pw);
      } catch {
        usable = false;
      }
      if (!usable) {
        const updated = findEditorByPath(p.sid, p.doc.path);
        if (p.kind === "check" && updated && isDirty(updated)) {
          setEditorSaveIssue(p.sid, updated.id, "sudo");
        } else {
          notifyError(t("editor.sudoUnavailable"));
        }
        return;
      }
      setEditorSudo(p.sid, p.doc.id, pw);
      const updated = findEditorByPath(p.sid, p.doc.path);
      if (p.kind === "save" && updated) void write(p.sid, updated, updated.baseSha256);
    },

    cancelSudo() {
      sudo = null;
    },

    /** Close a file, asking first when it has unsaved changes. */
    requestClose(sid: string, doc: EditorDoc) {
      if (isDirty(doc)) closeAsk = { sid, doc };
      else closeEditor(sid, doc.id);
    },

    /** "Save" in the close-with-changes dialog: write, then close on success. */
    async saveAndClose() {
      const c = closeAsk;
      closeAsk = null;
      if (!c) return;
      if (settings.editor.diffBeforeSave) {
        diffSave = { sid: c.sid, doc: c.doc, closeAfter: true };
        return;
      }
      if (await write(c.sid, c.doc, c.doc.baseSha256)) closeEditor(c.sid, c.doc.id);
    },

    /** "Don't save" in the close-with-changes dialog. */
    discardAndClose() {
      const c = closeAsk;
      closeAsk = null;
      if (c) closeEditor(c.sid, c.doc.id);
    },

    cancelClose() {
      closeAsk = null;
    },

    /** Conflict: overwrite the server's newer version with mine (skip the hash check). */
    overwriteConflict() {
      const c = conflict;
      conflict = null;
      if (c) void write(c.sid, c.doc, null);
    },

    /** Conflict: discard my changes and reopen the file fresh from the server. */
    reopenConflict() {
      const c = conflict;
      conflict = null;
      if (!c) return;
      closeEditor(c.sid, c.doc.id);
      if (c.doc.source === "local") void openLocal(c.sid, c.doc.path);
      else void openFile(c.sid, c.doc.path, c.doc.name, { sudo: c.doc.sudo, sudoPassword: c.doc.sudoPassword });
    },

    cancelConflict() {
      conflict = null;
    },

    /** The tab is gone: its nginx config list goes with it. */
    forget(sid: string) {
      nginxConfigs.delete(sid);
    },
  };
}

export type EditorFlow = ReturnType<typeof createEditorFlow>;
