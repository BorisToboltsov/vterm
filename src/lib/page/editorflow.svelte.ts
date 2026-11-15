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
  gitRun,
  isBackupFailedError,
  isFileChangedError,
  isPermissionError,
  nginxConfigFiles,
  pickSavePath,
  readLocalText,
  saveEditorCopy,
  sftpReadText,
  sftpWriteAccess,
  sftpWriteText,
  sudoCheck,
  sudoRoute,
  writeLocalText,
} from "../api";
import { orNull, swallow } from "../api/diag";
import { isProdServer } from "../ai/aiexec";
import { elevateStep, REFUSAL_HINT, REFUSAL_TITLE, savesThroughSudo, sudoAnswer, triedNote, type SudoAnswer } from "../sudo/sudo";
import type { ServerProfile, SudoRoute } from "../types";
import { tabLoginName } from "../servers/logins";
import type { MessageKey } from "../i18n";
import { couldBeNginxInclude, editorLangOrPlain, editorLangWithDialect, editorLangWithIncludes } from "../editor/editorlang";
import { baseName, parentOf } from "../files/fspath";
import { pipelineKindOf } from "../pipeline/pipefiles";
import type { Repo } from "../ci/forge";
import { repoRootArgs } from "../git/git";
import { askOnSchema, askRunOnSchema } from "../stores/ci.svelte";
import { t } from "../i18n";
import { settings } from "../settings/settings.svelte";
import { isRecording } from "../stores/recordings.svelte";
import type { Tab } from "../stores/tabs.svelte";
import { notifyError, notifyInfo, notifySuccess } from "../stores/toasts.svelte";
import {
  addEditor,
  addPipelinesView,
  addScratchEditor,
  closeEditor,
  fillEditor,
  findEditorByPath,
  gotoEditorLine,
  isDirty,
  markSaved,
  setEditorSaveIssue,
  setEditorSudo,
  setEditorSudoRoute,
  setEditorWriteAccess,
  showEditorSchema,
  showSessionView,
  type EditorDoc,
  type PipelineTarget,
} from "../stores/workspaces.svelte";
import { lineDiffStat } from "../ui/util";

/** What the page tells the editor flow, each read when it is needed. */
export interface EditorDeps {
  findTab: (id: string) => Tab | null | undefined;
  /** Whether the terminal of `sid` has room for a zone beside it (v1.35); absent — never. */
  roomBeside?: (sid: string) => boolean;
  /** The server profile of an SSH tab — whether it is prod, whose sudo. */
  serverOf?: (sid: string) => ServerProfile | null | undefined;
}

/** What getting sudo going is for: reopening a file as root, editing one as root
 *  ahead of a save, or a save (and, from the close question, closing after it). */
export type SudoAction =
  | { kind: "open"; sid: string; path: string; name: string; gotoLine?: number; gotoColumn?: number }
  | { kind: "save" | "check"; sid: string; doc: EditorDoc; closeAfter?: boolean };

/**
 * The sudo prompt (ADR 0073): a password to type (`type`), or — sudo needs no
 * typing, but the server is prod — one explicit "yes" (`confirm`), naming
 * whose password goes (`source`). `note` says why it asks: a saved password
 * turned down, a wrong one typed.
 */
export type SudoAsk = SudoAction & {
  mode: "type" | "confirm";
  note: MessageKey | null;
  source: "none" | "typed" | "saved" | "login" | null;
};

export interface OpenOptions {
  gotoLine?: number;
  /** 1-based column on `gotoLine` (`x.c:42:5`); without a line it means nothing. */
  gotoColumn?: number;
  sudo?: boolean;
  gitBase?: string;
  /** A pipeline file opened on its schema (ADR 0068). */
  view?: "schema";
}

export function createEditorFlow(deps: EditorDeps) {
  let savingId = $state<string | null>(null);
  let closeAsk = $state<{ sid: string; doc: EditorDoc } | null>(null);
  // Pre-save diff confirmation (settings-gated) and conflict resolution.
  // `closeAfter`: the save came from the close-with-changes dialog — close the
  // file once the write lands (and only then: a failed save keeps it open).
  let diffSave = $state<{ sid: string; doc: EditorDoc; closeAfter?: boolean } | null>(null);
  let conflict = $state<{ sid: string; doc: EditorDoc; serverText: string } | null>(null);
  // Sudo prompt: reopen, check access ahead of editing, or retry a save. The
  // typed password lives here until it goes to `sudoCheck` — once.
  let sudo = $state<SudoAsk | null>(null);
  let sudoPassword = $state("");
  let sudoRemember = $state(true);
  let sudoBusy = $state(false);

  const serverOf = (sid: string) => deps.serverOf?.(sid) ?? null;
  const prodOf = (sid: string) => isProdServer(serverOf(sid));

  /** Configured editor open-size limit, in bytes. */
  const maxBytes = () => settings.sftp.maxOpenMb * 1024 * 1024;
  // The first file beside the terminal (v1.35): asked of the setting, and of the
  // room the terminal has — a zone too narrow for two opens the file over it.
  const beside = (sid: string) => settings.editor.openBeside && (deps.roomBeside?.(sid) ?? false);

  // Per-session cache of the paths nginx actually loads (`nginx -T`), so files that
  // include-outside `/etc/nginx/` still get nginx highlighting + lint. Fetched lazily
  // once per session, best-effort (empty set on error). Dropped with the tab.
  const nginxConfigs = new Map<string, { promise: Promise<ReadonlySet<string>>; sudo: boolean }>();
  async function ensureNginxConfigs(sid: string, asRoot = false): Promise<ReadonlySet<string>> {
    const cached = nginxConfigs.get(sid);
    if (cached) {
      const set = await cached.promise;
      // Reuse the cached result, except retry under sudo when a plain fetch came
      // back empty and a file is now opened as root (it can read a config tree the
      // plain user can't) — silent: with what sudo already took, no prompt.
      if (!(set.size === 0 && asRoot && !cached.sudo)) return set;
    }
    const promise = nginxConfigFiles(sid, asRoot)
      .then((list) => new Set(list) as ReadonlySet<string>)
      .catch(() => new Set<string>() as ReadonlySet<string>);
    nginxConfigs.set(sid, { promise, sudo: asRoot });
    return promise;
  }

  /** What is known of sudo for a file the login user cannot write — the badge. */
  function learnRoute(sid: string, path: string, id: string) {
    void sudoRoute(sid)
      .then((route) => {
        if (findEditorByPath(sid, path)?.id === id) setEditorSudoRoute(sid, id, route);
      })
      .catch(swallow("editor", "what sudo will take was not asked: the badge stays on «checking» and Save tries as it is"));
  }

  /** The document of an action as it is now (it may have changed while sudo was asked). */
  const docNow = (a: SudoAction): EditorDoc | null => (a.kind === "open" ? null : (findEditorByPath(a.sid, a.doc.path) ?? null));

  /** sudo will not: said where it happened — beside Save, on the badge, or as a message. */
  function refusedOn(a: SudoAction, why: Extract<SudoAnswer, { kind: "refused" }>) {
    const route: SudoRoute = { kind: "refused", why: why.why, said: why.said };
    const doc = docNow(a);
    if (doc) {
      setEditorSudoRoute(a.sid, doc.id, route);
      if (a.kind === "save" || isDirty(doc)) {
        setEditorSaveIssue(a.sid, doc.id, "sudo");
        return;
      }
    }
    notifyError(`${t(REFUSAL_TITLE[why.why])}. ${t(REFUSAL_HINT[why.why])}${why.said ? ` — ${why.said}` : ""}`, {
      source: "editor",
      sessionId: a.sid,
    });
  }

  /** sudo agreed: do what it was for. */
  function proceed(a: SudoAction) {
    if (a.kind === "open") {
      void openFile(a.sid, a.path, a.name, { gotoLine: a.gotoLine, gotoColumn: a.gotoColumn, sudo: true });
      return;
    }
    const doc = docNow(a);
    if (!doc) return;
    setEditorSudo(a.sid, doc.id);
    if (a.kind === "save") {
      void write(a.sid, { ...doc, sudo: true }, doc.baseSha256).then((ok) => {
        if (ok && a.closeAfter) closeEditor(a.sid, doc.id);
      });
    }
  }

  /** A sudo answer that came back from a step (read, write, check): ask, or say no. */
  function answered(a: SudoAction, answer: SudoAnswer) {
    if (answer.kind === "refused") {
      sudo = null;
      refusedOn(a, answer);
      return;
    }
    const doc = docNow(a);
    if (doc && answer.kind === "password") setEditorSudoRoute(a.sid, doc.id, { kind: "password", tried: answer.tried });
    sudoPassword = "";
    sudo = {
      ...a,
      mode: "type",
      note: answer.kind === "wrong" ? "sudo.wrongPassword" : triedNote(answer.tried),
      source: null,
    };
  }

  /** Get sudo going for `a`: typed password or none (the session's, the saved). */
  async function getGoing(a: SudoAction, typed: string | null, remember: boolean) {
    sudoBusy = true;
    try {
      const checked = await sudoCheck(a.sid, typed, remember);
      if (checked.rememberFailed) notifyInfo(t("sudo.rememberFailed"), { source: "editor", sessionId: a.sid });
      const doc = docNow(a);
      if (doc) setEditorSudoRoute(a.sid, doc.id, { kind: "ready", via: checked.via });
    } catch (e) {
      const answer = sudoAnswer(e);
      if (answer) answered(a, answer);
      else {
        sudo = null;
        notifyError(String(e), { source: "editor", sessionId: a.sid });
      }
      return;
    } finally {
      sudoBusy = false;
    }
    sudo = null;
    sudoPassword = "";
    proceed(a);
  }

  /**
   * Get sudo going for an action, from what is known of it (`elevateStep`): at
   * once, after one question on prod, with a typed password, or — sudo will not —
   * said, not asked.
   */
  async function elevate(a: SudoAction) {
    let route = docNow(a)?.sudoRoute ?? null;
    if (!route) {
      route = await sudoRoute(a.sid).catch(
        orNull("editor", "what sudo will take was not asked: sudo is tried as it is, and its answer says the rest"),
      );
    }
    const step = elevateStep(route, prodOf(a.sid));
    if (step === "refused" && route?.kind === "refused") {
      refusedOn(a, { kind: "refused", why: route.why, said: route.said });
      return;
    }
    sudoPassword = "";
    sudoRemember = true;
    if (step === "ask") {
      sudo = { ...a, mode: "type", note: route?.kind === "password" ? triedNote(route.tried) : null, source: null };
      return;
    }
    if (step === "confirm") {
      const source = route?.kind === "ready" ? route.via : route?.kind === "saved" ? route.from : null;
      sudo = { ...a, mode: "confirm", note: null, source };
      return;
    }
    await getGoing(a, null, false);
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
      if (opts.gotoLine) gotoEditorLine(sid, existing.id, opts.gotoLine, opts.gotoColumn);
      if (opts.view) showEditorSchema(sid, existing.id);
      return;
    }
    // For a config-shaped file not already recognised as nginx, also consult the set
    // of configs nginx actually loads (nginx -T) — catches includes outside the
    // `/etc/nginx/` tree. Fetched in parallel with the read; resolved just before open.
    const nginxSetP =
      lang.kind !== "nginx" && couldBeNginxInclude(path) ? ensureNginxConfigs(sid, opts.sudo) : null;
    // Read first, so binary/too-large files just toast instead of opening a tab.
    let file;
    try {
      file = await sftpReadText(sid, path, maxBytes(), opts.sudo);
    } catch (e) {
      const open: SudoAction = { kind: "open", sid, path, name, gotoLine: opts.gotoLine, gotoColumn: opts.gotoColumn };
      // No read access on a non-sudo read → reopen as root (asked when it must be).
      if (!opts.sudo && isPermissionError(e)) {
        void elevate(open);
        return;
      }
      // A read as root that sudo answered: ask for its password, or say why not.
      const answer = opts.sudo ? sudoAnswer(e) : null;
      if (answer) {
        answered(open, answer);
        return;
      }
      notifyError(String(e), { source: "editor" });
      return;
    }
    if (nginxSetP) lang = editorLangWithIncludes(path, await nginxSetP);
    // Content-based YAML dialects (k8s/Ansible) have no distinguishing name — upgrade
    // once the buffer is read so kubeconform/ansible-lint can run (no-op for non-YAML).
    lang = editorLangWithDialect(lang, file.content);
    const id = addEditor(sid, path, name, lang, "sftp", {
      beside: beside(sid),
      gotoLine: opts.gotoLine,
      gotoColumn: opts.gotoColumn,
      sudo: opts.sudo,
      gitBase: opts.gitBase,
      view: opts.view,
    });
    fillEditor(sid, id, file);
    // Whether a save will land is asked ahead of editing, not found out at Save.
    if (!opts.sudo) {
      void sftpWriteAccess(sid, path)
        .then((access) => {
          if (findEditorByPath(sid, path)?.id !== id) return;
          setEditorWriteAccess(sid, id, access);
          // What saving it will take is asked now, not found out at Save (ADR 0073).
          if (access === "restricted") learnRoute(sid, path, id);
        })
        .catch(() => {
          if (findEditorByPath(sid, path)?.id === id) setEditorWriteAccess(sid, id, "unknown");
        });
    }
  }

  /** Open a file on this computer in a session's editor. */
  async function openLocal(
    sid: string,
    path: string,
    opts: { gitBase?: string; gotoLine?: number; gotoColumn?: number; view?: "schema" } = {},
  ) {
    const name = path.split(/[\\/]/).pop() ?? path;
    const existing = findEditorByPath(sid, path);
    if (existing) {
      showSessionView(sid, existing.id);
      if (opts.gotoLine) gotoEditorLine(sid, existing.id, opts.gotoLine, opts.gotoColumn);
      if (opts.view) showEditorSchema(sid, existing.id);
      return;
    }
    let file;
    try {
      file = await readLocalText(path, maxBytes());
    } catch (e) {
      notifyError(String(e), { source: "editor" });
      return;
    }
    const id = addEditor(sid, path, name, editorLangOrPlain(path), "local", {
      beside: beside(sid),
      gitBase: opts.gitBase,
      gotoLine: opts.gotoLine,
      gotoColumn: opts.gotoColumn,
      view: opts.view,
    });
    fillEditor(sid, id, file);
  }

  /**
   * "Pipeline schema" from the file panel (ADR 0068): one pipeline file opens in
   * the editor on its schema; a folder or several files open the map of their
   * pipelines, in the connection's file zone.
   */
  function openPipelines(sid: string, source: "sftp" | "local", targets: readonly PipelineTarget[]) {
    if (targets.length === 0) return;
    const one = targets.length === 1 && !targets[0].isDir ? targets[0].path : null;
    if (one && pipelineKindOf(one)) {
      if (source === "sftp") void openFile(sid, one, baseName(one), { view: "schema" });
      else void openLocal(sid, one, { view: "schema" });
      return;
    }
    const named = targets.length === 1 ? targets[0].path : parentOf(targets[0].path);
    addPipelinesView(sid, source, targets, t("pipeline.group.docName", { name: baseName(named) }));
  }

  /**
   * Save as the file wants (ADR 0073): a file the login user cannot write, whose
   * sudo needs no typing, goes through sudo at once (after one question on prod);
   * one whose sudo refused shows why beside Save; the rest is written as it is.
   * `closeAfter` closes the file once a write through sudo lands. Resolves `true`
   * only when the file was written here and now.
   */
  async function writeOrElevate(sid: string, doc: EditorDoc, closeAfter = false): Promise<boolean> {
    if (doc.source === "sftp" && !doc.sudo && doc.writeAccess === "restricted") {
      if (savesThroughSudo(doc.sudoRoute) || doc.sudoRoute?.kind === "password") {
        await elevate({ kind: "save", sid, doc, closeAfter });
        return false;
      }
      if (doc.sudoRoute?.kind === "refused") {
        setEditorSaveIssue(sid, doc.id, "sudo");
        return false;
      }
    }
    return write(sid, doc, doc.baseSha256);
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
              backup: settings.editor.backupOnSave,
              // Write the file back in the encoding it was opened in (textenc.rs).
              encoding: doc.encoding,
            });
      const stat = lineDiffStat(before, doc.content);
      markSaved(sid, doc.id, res);
      notifySuccess(t("editor.saved", { name: doc.name }), { source: "editor" });
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
              : await sftpReadText(sid, doc.path, maxBytes(), doc.sudo);
          conflict = { sid, doc, serverText: cur.content };
        } catch {
          notifyError(t("editor.conflict", { name: doc.name }), { source: "editor" });
        }
      } else if (!doc.sudo && doc.source === "sftp" && isPermissionError(e)) {
        // Keep the buffer and offer explicit recovery next to Save.
        setEditorSaveIssue(sid, doc.id, "permission");
      } else if (doc.sudo && sudoAnswer(e)) {
        // sudo answered the save as root: its password (changed meanwhile), or why not.
        answered({ kind: "save", sid, doc }, sudoAnswer(e)!);
      } else if (isBackupFailedError(e)) {
        // The save was abandoned with the file untouched — say that plainly, or
        // the user reads it as "save failed" and cannot tell what state the
        // server is in. The cause is carried along; the way out is in the hint.
        notifyError(t("editor.backupFailed", { name: doc.name, detail: String(e) }), { source: "editor" });
        setEditorSaveIssue(sid, doc.id, "other");
      } else {
        notifyError(String(e), { source: "editor" });
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
    /** "Remember in the keychain" of the sudo prompt — on by default, as at login. */
    get sudoRemember() {
      return sudoRemember;
    },
    set sudoRemember(value: boolean) {
      sudoRemember = value;
    },
    /** A check of sudo is on its way: the prompt waits. */
    get sudoBusy() {
      return sudoBusy;
    },
    /** Whose sudo the prompt asks for (`user@server`), and whether it is prod. */
    sudoWho(sid: string): { who: string; prod: boolean } {
      const server = serverOf(sid);
      return { who: server ? `${tabLoginName(server, deps.findTab(sid)?.login)}@${server.alias}` : "", prod: prodOf(sid) };
    },
    maxBytes,
    openFile,
    openLocal,
    openPipelines,

    /** A file of the session's repository, at a line (the CI panel's "go to the line"). */
    openAt(sid: string, absPath: string, line: number) {
      if (deps.findTab(sid)?.kind === "ssh") void openFile(sid, absPath, baseName(absPath), { gotoLine: line });
      else void openLocal(sid, absPath, { gotoLine: line });
    },

    /** A workflow file on its schema, showing a run of it (ADR 0069). */
    openRunSchema(sid: string, absPath: string, repo: Repo, runId: string) {
      askRunOnSchema(sid, absPath, repo, runId);
      if (deps.findTab(sid)?.kind === "ssh") void openFile(sid, absPath, baseName(absPath), { view: "schema" });
      else void openLocal(sid, absPath, { view: "schema" });
    },

    /**
     * A pipeline file on its schema from the CI panel (ADR 0070): as it is, with
     * the event that starts it played, or on the form to start it by hand.
     */
    openPipelineSchema(sid: string, absPath: string, ask: "play" | "start" | null = null) {
      if (ask) askOnSchema(sid, absPath, { kind: ask });
      if (deps.findTab(sid)?.kind === "ssh") void openFile(sid, absPath, baseName(absPath), { view: "schema" });
      else void openLocal(sid, absPath, { view: "schema" });
    },

    /**
     * ⌘K "Pipelines of the repository" (ADR 0070): the map of the repository the
     * terminal stands in. Not in one — said, nothing opened.
     */
    async openRepoPipelines(sid: string, cwd: string | null) {
      const top = cwd ? await gitRun(sid, cwd, repoRootArgs()) : null;
      if (!top || top.exitCode !== 0) {
        notifyInfo(t("ci.pipes.noRepo"), { source: "editor", sessionId: sid });
        return;
      }
      openPipelines(sid, deps.findTab(sid)?.kind === "ssh" ? "sftp" : "local", [{ path: top.stdout.trim(), isDir: true }]);
    },

    /** A CI job's whole log, as a document to read — never saved, never reopened. */
    openLog(sid: string, name: string, text: string) {
      const source = deps.findTab(sid)?.kind === "ssh" ? "sftp" : "local";
      addScratchEditor(sid, name, { kind: "plain", label: "Log" }, text, source, { readOnly: true });
    },

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
        notifyInfo(t("git.alreadyIgnored"), { source: "editor" });
        return;
      }
      const sep = current && !current.endsWith("\n") ? "\n" : "";
      const next = `${current}${sep}${pattern}\n`;
      try {
        if (ssh) await sftpWriteText(sid, gitignorePath, next, "lf", null);
        else await writeLocalText(gitignorePath, next, "lf", null);
        notifySuccess(t("git.ignored", { pattern }), { source: "editor" });
      } catch (e) {
        notifyError(String(e), { source: "editor" });
      }
    },

    /**
     * Write the file now, without the diff before saving: the edit on the group
     * (ADR 0064) has shown it already, beside every other server's. Resolves
     * whether it was written; a failure is said and kept beside Save as ever.
     */
    saveNow(sid: string, doc: EditorDoc): Promise<boolean> {
      if (doc.readOnly || savingId || doc.content === doc.baseContent) return Promise.resolve(false);
      return write(sid, doc, doc.baseSha256);
    },

    /** Save: nothing to do if unchanged; show the diff first when enabled. */
    save(sid: string, doc: EditorDoc) {
      if (doc.readOnly || savingId || doc.content === doc.baseContent) return;
      if (settings.editor.diffBeforeSave) {
        diffSave = { sid, doc };
        return;
      }
      void writeOrElevate(sid, doc);
    },

    async confirmDiffSave() {
      const s = diffSave;
      diffSave = null;
      if (!s) return;
      const ok = await writeOrElevate(s.sid, s.doc, s.closeAfter);
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
        notifySuccess(t("editor.copySaved", { name: path.split(/[\\/]/).pop() ?? path }), { source: "editor" });
      } catch (e) {
        notifyError(String(e).includes("dest-exists") ? t("editor.copyExists") : String(e), { source: "editor" });
      }
    },

    /** Get sudo going for a file: to edit it as root ahead of a save, or to save it as root. */
    askSudo(sid: string, doc: EditorDoc, kind: "check" | "save") {
      void elevate({ kind, sid, doc });
    },

    /** The sudo prompt's answer: a typed password goes to the check once; a
     *  confirmation gets sudo going with what the session has. */
    async confirmSudo() {
      const p = sudo;
      if (!p || sudoBusy) return;
      if (p.mode === "type" && !sudoPassword) return;
      const typed = p.mode === "type" ? sudoPassword : null;
      const action: SudoAction =
        p.kind === "open"
          ? { kind: "open", sid: p.sid, path: p.path, name: p.name, gotoLine: p.gotoLine, gotoColumn: p.gotoColumn }
          : { kind: p.kind, sid: p.sid, doc: p.doc, closeAfter: p.closeAfter };
      await getGoing(action, typed, p.mode === "type" && sudoRemember);
    },

    cancelSudo() {
      sudo = null;
      sudoPassword = "";
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
      if (await writeOrElevate(c.sid, c.doc, true)) closeEditor(c.sid, c.doc.id);
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
      else void openFile(c.sid, c.doc.path, c.doc.name, { sudo: c.doc.sudo });
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
