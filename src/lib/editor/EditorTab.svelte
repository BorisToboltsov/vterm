<script module lang="ts">
  import { orNull } from "../api/diag";
  // `.editorconfig` texts by connection and path, kept a minute: every file
  // opened in a project would otherwise read the same files up the tree again.
  const EC_TTL = 60_000;
  const ecCache = new Map<string, { at: number; text: Promise<string | null> }>();

  function ecRead(conn: string, path: string, read: () => Promise<string>): Promise<string | null> {
    const k = `${conn}\u0000${path}`;
    const hit = ecCache.get(k);
    if (hit && Date.now() - hit.at < EC_TTL) return hit.text;
    // A missing file is the usual answer, not a failure: written at debug only.
    const text = read().catch(orNull("editor", "no .editorconfig at this level"));
    ecCache.set(k, { at: Date.now(), text });
    if (ecCache.size > 500) ecCache.delete(ecCache.keys().next().value as string);
    return text;
  }
</script>

<script lang="ts">
  import { swallow, swallowed } from "../api/diag";
  import { onDestroy, onMount, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { EditorState, Compartment, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
  import { unifiedMergeView } from "@codemirror/merge";
  import { ICONS } from "../ui/icons";
  import {
    Decoration,
    EditorView,
    keymap,
    type DecorationSet,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
  } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import { closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
  import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
  import {
    bracketMatching,
    foldKeymap,
    indentOnInput,
    syntaxTree,
  } from "@codemirror/language";
  import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
  import { jsonParseLinter } from "@codemirror/lang-json";
  import { loadLanguage } from "./editorlangs";
  import { editorTheme } from "./cmtheme";
  import { cspNonceExtension } from "./cspnonce";
  import { readClipboard, writeClipboard } from "../app/clipboard";
  import { activeTerminalTheme, settings } from "../settings/settings.svelte";
  import { setEditorContent, type EditorDoc } from "../stores/workspaces.svelte";
  import { collectImages, renderMarkdown } from "../markdown/markdown";
  import { mdLinks } from "../actions/mdlinks";
  import { classifyImage, dataUrl, MAX_IMAGES, MAX_IMAGE_BYTES } from "../markdown/mdimage";
  import { parseStaticBadge } from "../markdown/badge";
  import { snippetsForLang } from "./snippets";
  import { columnOffset } from "./editorplace";
  import { connectionFiles, lintRemote, readLocalBytes, sftpReadBytes } from "../api";
  import PipelineView from "../pipeline/PipelineView.svelte";
  import { looksLikeGitlab, pipelineKindOf } from "../pipeline/pipefiles";
  import type { SourceSpan } from "../pipeline/pipeline";
  import { hasRemoteLinter, parseLint, type LintMsg } from "./remotelint";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../i18n";
  import { REFUSAL_HINT, REFUSAL_TITLE, sudoBadge } from "../sudo/sudo";
  import { formatRun } from "../api/editor";
  import { notifyInfo } from "../stores/toasts.svelte";
  import { setEditorLang } from "../stores/workspaces.svelte";
  import { parentOf } from "../files/fspath";
  import EditorStatusBar from "./EditorStatusBar.svelte";
  import OutlinePalette from "./OutlinePalette.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { OpenMenu } from "../ui/ctxmenu";
  import {
    baseTheme,
    brackets,
    completion,
    folding,
    foldsByIndent,
    indentGuides,
    indentation,
    multiCursor,
    trailingSpace,
    wrapping,
    type EditorWords,
  } from "./editorbase";
  import { reindent, resolveIndent, type IndentInfo, type IndentSource } from "./indent";
  import { editorconfigDir, editorconfigPaths, parseEditorConfig, resolveEditorConfig, type EditorConfigProps } from "./editorconfig";
  import { langOfKind, type EditorLang, type EditorLangKind } from "./editorlang";
  import { langKey, withOverride } from "./editorprefs";
  import { hasTemplates, jinjaLayer } from "./jinja";
  import { vaultArgv, vaultHeader } from "./vault";
  import { breadcrumbs, outline } from "./outline";
  import {
    changedLines,
    fixerFor,
    formatArgv,
    formatOrder,
    formatResult,
    formattersFor,
    minimalChange,
    runBuiltin,
    type Formatter,
  } from "./format";
  import { FLASH_MS, changeFlash, changedLineNumbers, flashLines } from "./flash";
  import { checkYaml, schemaCompletions, schemaFor, schemaRoot, type SchemaRef } from "./yamlschema";
  import { isYamlKind } from "./outline";
  import { minimapExtension } from "./minimap";
  import { acquireLsp, forgetMissing, lspEntryKey, lspSaid, lspStatus, releaseLsp, type LspRequest } from "../stores/lsp.svelte";
  import { fileUri, findRoot, languageId, lspKey, serversFor } from "./lspservers";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";

  let {
    sessionId,
    doc,
    saving = false,
    onsave,
    onCheckSudo,
    onSaveWithSudo,
    onSaveCopy,
    openAs = [],
    onOpenAs,
    onDismissSaveIssue,
    onLintMissing,
    groupServers = null,
    onGroup,
    onOpenFileAt,
    onScenario,
    onToLibrary,
    terminalHere = false,
    onTerminal,
    hostKey = "local",
    prod = false,
  }: {
    sessionId: string;
    doc: EditorDoc;
    /** True while a save is in flight (disables the button). */
    saving?: boolean;
    /** Invoked by the Save button / Ctrl+S. */
    onsave?: () => void;
    onCheckSudo?: () => void;
    onSaveWithSudo?: () => void;
    onSaveCopy?: () => void;
    /** The server's other logins this file can be opened as when sudo will not (ADR 0074). */
    openAs?: { id: string; username: string }[];
    onOpenAs?: (loginId: string) => void;
    onDismissSaveIssue?: () => void;
    /** Server linter isn't installed — let the page offer to install it. */
    onLintMissing?: (tool: string) => void;
    /** Other servers of the synchronous-input group with this file's path (ADR 0064); null — none. */
    groupServers?: number | null;
    /** Carry the unsaved edit to the same file on the group's other servers. */
    onGroup?: () => void;
    /** Open another file of the connection on a line (a pipeline's include, ADR 0068). */
    onOpenFileAt?: (path: string, line: number) => void;
    /** A playbook or a `.tf` file: its project's run dialog or plan (ADR 0071). */
    onScenario?: (action: "check" | "run" | "plan") => void;
    /** A shell script not yet a file (the assistant's): into the recipe library. */
    onToLibrary?: () => void;
    /** The terminal of this tab sees the file (it is on its server, or a local file of a local tab). */
    terminalHere?: boolean;
    /** Type a command into this tab's terminal (`ansible-vault view` of a vault). */
    onTerminal?: (argv: string[]) => void;
    /** The server the file is on (`local` for this computer) — what «start by itself» is remembered for. */
    hostKey?: string;
    /** A prod server: a language server there starts only after a question (ADR 0079). */
    prod?: boolean;
  } = $props();

  // What this file is to the Scenarios (ADR 0071): a playbook to run, a
  // Terraform file whose folder is planned — or nothing.
  const scenarioKind = $derived(
    !onScenario
      ? null
      : doc.lang.kind === "ansible" && /^\s*-?\s*hosts:\s*\S/m.test(doc.content.slice(0, 4000))
        ? "ansible"
        : doc.lang.kind === "hcl" && /\.tf$/i.test(doc.path)
          ? "terraform"
          : null,
  );

  let host: HTMLDivElement;
  // Reactive, so the effects that configure it run again once it exists.
  let view = $state.raw<EditorView | undefined>();
  const themeC = new Compartment();
  const lintC = new Compartment();
  // The grammar arrives after the view (editorlangs.ts loads it on first use).
  const langC = new Compartment();
  // The working set of ADR 0076, each switchable without rebuilding the view.
  const foldC = new Compartment();
  const bracketsC = new Compartment();
  const completeC = new Compartment();
  const indentC = new Compartment();
  const guidesC = new Compartment();
  const trailingC = new Compartment();
  const wrapC = new Compartment();
  const jinjaC = new Compartment();
  const minimapC = new Compartment();
  const schemaC = new Compartment();
  const lspC = new Compartment();

  const WORDS: EditorWords = {
    folded: (n) => t("editor.fold.folded", { n }),
    fold: t("editor.fold.fold"),
    unfold: t("editor.fold.unfold"),
    snippet: t("editor.snippets"),
  };

  // How the file indents (`.editorconfig`, then the file, then the language).
  let indentInfo = $state<IndentInfo>({ tabs: false, width: 2 });
  let indentSource = $state<IndentSource>("language");
  let ecProps = $state<EditorConfigProps>({});
  // What the file was detected as, before a language set by hand.
  let detected = $state<EditorLang>(untrack(() => doc.lang));
  const key = $derived(langKey(doc.source, doc.path));
  const override = $derived(settings.editor.langOverrides[key] ?? null);
  // The cursor, for the status bar.
  let cursorCol = $state(1);
  let selections = $state(1);
  let outlineOpen = $state(false);

  /** The `.editorconfig` files above the file, nearest first — read once a minute per connection. */
  async function readEditorConfig(): Promise<EditorConfigProps> {
    const reader = connectionFiles(doc.source === "sftp" ? sessionId : null, 64 * 1024);
    const found: { dir: string; parsed: ReturnType<typeof parseEditorConfig> }[] = [];
    for (const path of editorconfigPaths(doc.path)) {
      const text = await ecRead(doc.source === "sftp" ? sessionId : "local", path, () => reader.read(path));
      if (text === null) continue;
      const parsed = parseEditorConfig(text);
      found.push({ dir: editorconfigDir(path), parsed });
      if (parsed.root) break;
    }
    return resolveEditorConfig(doc.path, found);
  }

  function applyIndent(info: IndentInfo, source: IndentSource) {
    indentInfo = info;
    indentSource = source;
    view?.dispatch({ effects: indentC.reconfigure(indentation(info)) });
  }

  /** The status bar's indent: a new unit, and — asked — the file rewritten to it. */
  function setIndent(info: IndentInfo, convert: boolean) {
    if (convert && view && !doc.readOnly) {
      const cur = view.state.doc.toString();
      const change = minimalChange(cur, reindent(cur, indentInfo, info));
      if (change) view.dispatch({ changes: change });
    }
    applyIndent(info, indentSource);
  }

  /** A language picked in the status bar (null — back to the detected one), remembered for the path. */
  function pickLang(kind: EditorLangKind | null) {
    settings.editor.langOverrides = withOverride(settings.editor.langOverrides, key, kind);
    setEditorLang(sessionId, doc.id, kind ? langOfKind(kind, detected.jinja === true) : detected);
  }

  // A remembered language wins over detection — at open, and when a restore
  // or a read re-detects the file.
  $effect(() => {
    const want = override;
    const lang = doc.lang;
    if (!want) {
      detected = lang;
      return;
    }
    if (lang.kind !== want) {
      detected = lang;
      setEditorLang(sessionId, doc.id, langOfKind(want, lang.jinja === true));
    }
  });

  // The grammar, the template layer and how the file folds follow its language.
  let loadedKind: EditorLangKind | null = null;
  $effect(() => {
    const lang = doc.lang;
    if (!view) return;
    const v = view;
    v.dispatch({
      effects: [
        jinjaC.reconfigure(hasTemplates(lang, doc.path) ? jinjaLayer() : []),
        foldC.reconfigure(folding(WORDS, foldsByIndent(lang.kind))),
        completeC.reconfigure(completion(settings.editor.autocomplete, snippets, WORDS)),
      ],
    });
    if (loadedKind === lang.kind) return;
    loadedKind = lang.kind;
    loadLanguage(lang.kind)
      .then((ext) => {
        if (view === v && doc.lang.kind === lang.kind) v.dispatch({ effects: langC.reconfigure(ext) });
      })
      .catch(swallow("editor", "the language's grammar did not load: plain text is shown"));
  });

  // Switches of «Settings → Editor» and the status bar, live.
  $effect(() => {
    const e = settings.editor;
    const effects = [
      bracketsC.reconfigure(brackets(e.closeBrackets)),
      guidesC.reconfigure(indentGuides(e.indentGuides)),
      trailingC.reconfigure(trailingSpace(e.trailingSpace && !doc.readOnly)),
      wrapC.reconfigure(wrapping(e.wrap)),
    ];
    view?.dispatch({ effects });
  });

  $effect(() => {
    const on = settings.editor.minimap;
    const v = view;
    if (!v) return;
    if (!on) {
      v.dispatch({ effects: minimapC.reconfigure([]) });
      return;
    }
    minimapExtension()
      .then((ext) => {
        if (view === v && settings.editor.minimap) v.dispatch({ effects: minimapC.reconfigure(ext) });
      })
      .catch(swallow("editor", "the minimap did not load: the file is shown without it"));
  });

  // YAML against its schema (ADR 0078): which one, and what the last check said.
  let siblings = $state<string[]>([]);
  let schemaState = $state<{ issues: number } | { unavailable: "url" | "unread" } | null>(null);
  const schemaRef = $derived(
    isYamlKind(doc.lang.kind) && !doc.lang.jinja && !vaultHeader(doc.content)
      ? schemaFor(doc.path, doc.lang.kind, doc.content.slice(0, 2000), siblings)
      : null,
  );
  const schemaKey = $derived(schemaRef ? JSON.stringify(schemaRef) : "");
  const schemaReader = $derived(connectionFiles(doc.source === "sftp" ? sessionId : null, 512 * 1024));

  function schemaExt(ref: SchemaRef | null) {
    if (!ref) return [];
    const read = (path: string) => schemaReader.read(path);
    return [
      linter(
        async (v) => {
          const res = await checkYaml(ref, v.state.doc.toString(), read);
          if ("unavailable" in res) {
            schemaState = res;
            return [];
          }
          schemaState = { issues: res.issues.length };
          return res.issues.map((i) => ({ from: i.from, to: i.to, severity: i.severity, message: t(i.key, i.params), source: ref.label }));
        },
        { delay: 700 },
      ),
      EditorState.languageData.of(() => [
        {
          autocomplete: async (ctx: import("@codemirror/autocomplete").CompletionContext) => {
            const text = ctx.state.doc.toString();
            const root = await schemaRoot(ref, text, ctx.pos, read);
            if (!root) return null;
            const res = schemaCompletions(root, text, ctx.pos);
            if (!res || (!ctx.explicit && res.from === ctx.pos && !/:\s$/.test(text.slice(ctx.pos - 2, ctx.pos)))) return null;
            return { from: res.from, options: res.options, validFor: /^[\w.$/-]*$/ };
          },
        },
      ]),
    ];
  }

  $effect(() => {
    void schemaKey;
    const ref = untrack(() => schemaRef);
    schemaState = null;
    view?.dispatch({ effects: schemaC.reconfigure(schemaExt(ref)) });
  });

  // A language server for the file (ADR 0079): started by a click, or by itself
  // when asked to be on this server; one per folder, shared by its editors.
  const lspCandidates = $derived(doc.lang.jinja || vaultHeader(doc.content) ? [] : serversFor(doc.lang.kind, doc.path));
  let lspPick = $state(0);
  let lspHeld = $state<LspRequest | null>(null);
  let lspRoot: string | null = null;
  let lspAsk = $state(false);
  let lspMenu = $state<OpenMenu | null>(null);
  const lspServer = $derived(lspCandidates[lspPick] ?? null);
  const lspAutoKey = $derived(lspServer ? lspKey(hostKey, "*", lspServer.id) : null);
  const lspAuto = $derived(lspAutoKey ? settings.editor.lspAuto.includes(lspAutoKey) : false);
  const lspState = $derived(lspHeld ? lspStatus(lspEntryKey(lspHeld)) : lspServer && lspRoot ? lspStatus(lspEntryKey(lspRequest(lspServer.id, lspRoot))) : null);

  function lspRequest(server: string, root: string): LspRequest {
    return { sessionId, local: doc.source !== "sftp", server, root };
  }

  async function startLsp(confirmed = false) {
    if (!view || lspHeld || !lspServer) return;
    if (prod && !confirmed) {
      lspAsk = true;
      return;
    }
    const v = view;
    const kind = doc.lang.kind;
    const reader = connectionFiles(doc.source === "sftp" ? sessionId : null, 0);
    lspRoot ??= await findRoot(doc.path, kind, (dir) => reader.list(dir).then((es) => es.map((e) => e.name)));
    for (let i = lspPick; i < lspCandidates.length; i++) {
      lspPick = i;
      const req = lspRequest(lspCandidates[i].id, lspRoot);
      lspHeld = req;
      const handle = await acquireLsp(req);
      if (view !== v || doc.lang.kind !== kind) {
        releaseLsp(req);
        return;
      }
      if (handle) {
        v.dispatch({
          effects: [
            lspC.reconfigure(handle.extension(fileUri(doc.path), languageId(kind))),
            // yaml-language-server checks schemas itself: the built-in check steps aside.
            ...(req.server === "yaml-language-server" ? [schemaC.reconfigure([])] : []),
          ],
        });
        return;
      }
      lspHeld = null;
      if (lspStatus(lspEntryKey(req)) !== "missing") return;
    }
    lspPick = 0;
    if (doc.source === "sftp" && lspCandidates[0]) onLintMissing?.(lspCandidates[0].program);
  }

  function stopLspHere() {
    const held = lspHeld;
    if (!held) return;
    lspHeld = null;
    releaseLsp(held);
    view?.dispatch({ effects: [lspC.reconfigure([]), schemaC.reconfigure(schemaExt(schemaRef))] });
  }

  function openLspMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const key = lspAutoKey;
    lspMenu = {
      x: r.left,
      y: r.top - 8,
      items: [
        lspHeld
          ? { icon: "stop" as const, label: t("lsp.stop"), onSelect: stopLspHere }
          : { icon: "play" as const, label: t("lsp.start", { server: lspServer?.program ?? "" }), onSelect: () => void startLsp() },
        ...(lspState === "missing" && lspServer && doc.source === "sftp"
          ? [{ icon: "download" as const, label: t("lsp.install", { server: lspServer.program }), onSelect: () => onLintMissing?.(lspServer!.program) }]
          : []),
        ...(lspState === "missing" && lspServer
          ? [{ icon: "refresh" as const, label: t("lsp.retry"), onSelect: () => {
              if (lspRoot && lspServer) forgetMissing(lspRequest(lspServer.id, lspRoot));
              lspPick = 0;
              void startLsp();
            } }]
          : []),
        { kind: "separator" as const },
        {
          label: t("lsp.auto"),
          checked: lspAuto,
          onSelect: () => {
            if (!key) return;
            const list = settings.editor.lspAuto.filter((k) => k !== key);
            settings.editor.lspAuto = lspAuto ? list : [...list, key];
          },
        },
      ],
    };
  }

  // Start by itself where asked to — never on a prod server without the question.
  $effect(() => {
    if (view && lspServer && lspAuto && !prod && !untrack(() => lspHeld)) void untrack(() => startLsp());
  });

  // The language changed: the server of the old one is let go.
  let lspKind: EditorLangKind | null = null;
  $effect(() => {
    const kind = doc.lang.kind;
    if (lspKind !== null && lspKind !== kind) {
      untrack(stopLspHere);
      lspPick = 0;
      lspRoot = null;
    }
    lspKind = kind;
  });

  // An Ansible Vault file: what it is, and the user's own tool to read it.
  const vault = $derived(vaultHeader(doc.content));

  // Formatting (ADR 0076): the project's tool where the file lives, or a built-in.
  let formatting = $state(false);
  let formatMenu = $state<OpenMenu | null>(null);
  const formatters = $derived(formattersFor(doc.lang.kind));
  const fixer = $derived(fixerFor(doc.lang.kind));
  const pickedFormatter = $derived(settings.editor.formatters[doc.lang.kind] ?? formatters[0]?.id);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Format the buffer: the picked tool, then the rest of the language's list
   * when one is not installed. One change, one undo; the lines it changed are
   * lit for a moment. On save a missing tool is no reason to stop the save, and
   * «whitespace» runs only when it is the one picked.
   */
  async function formatBuffer(opts: { onSave?: boolean; fix?: boolean } = {}): Promise<void> {
    if (!view || doc.readOnly || formatting) return;
    let order: Formatter[] = opts.fix && fixer ? [fixer] : formatOrder(doc.lang.kind, settings.editor.formatters[doc.lang.kind]);
    if (opts.onSave) order = order.filter((f) => !f.builtin || f.id === pickedFormatter);
    if (order.length === 0) return;
    formatting = true;
    const before = view.state.doc.toString();
    const target = { name: doc.name, path: doc.path, indent: indentInfo, finalNewline: ecProps.finalNewline };
    const missing: Formatter[] = [];
    try {
      for (const f of order) {
        let next: string;
        if (f.builtin) {
          try {
            next = runBuiltin(f.id, before, target);
          } catch (e) {
            notifyError(t("editor.format.failed", { tool: f.label, error: String(e instanceof Error ? e.message : e) }), {
              source: "editor",
              sessionId,
            });
            return;
          }
        } else {
          const argv = formatArgv(f, target);
          if (!argv) continue;
          const run = await formatRun(doc.source === "sftp" ? sessionId : null, argv, parentOf(doc.path), doc.name, before);
          if (!run.found) {
            missing.push(f);
            continue;
          }
          const res = formatResult(f, run);
          if ("error" in res) {
            notifyError(t("editor.format.failed", { tool: f.label, error: res.error }), { source: "editor", sessionId });
            return;
          }
          next = res.text;
        }
        if (!view) return;
        // The buffer moved on while the tool ran: its answer is for an older text.
        if (view.state.doc.toString() !== before) {
          notifyInfo(t("editor.format.stale"), { source: "editor", sessionId });
          return;
        }
        const change = minimalChange(before, next);
        if (!change) {
          if (!opts.onSave) notifyInfo(t("editor.format.unchanged", { tool: f.label }), { source: "editor", sessionId });
          return;
        }
        view.dispatch({ changes: change });
        const lit = changedLineNumbers(before, next);
        view.dispatch({ effects: flashLines.of(lit) });
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => view?.dispatch({ effects: flashLines.of(null) }), FLASH_MS);
        notifySuccess(t("editor.format.done", { tool: f.label, n: changedLines(before, next) }), { source: "editor", sessionId });
        return;
      }
      if (missing.length > 0) {
        notifyError(t("editor.format.missing", { tools: missing.map((f) => f.program ?? f.label).join(", ") }), {
          source: "editor",
          sessionId,
        });
        if (doc.source === "sftp" && missing[0].program) onLintMissing?.(missing[0].program);
      }
    } catch (e) {
      notifyError(String(e), { source: "editor", sessionId });
    } finally {
      formatting = false;
    }
  }

  function openFormatMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    formatMenu = {
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...formatters.map((f) => ({
          label: f.builtin ? t(f.id === "json" ? "editor.format.json" : "editor.format.whitespace") : f.label,
          checked: f.id === pickedFormatter,
          onSelect: () => {
            settings.editor.formatters = { ...settings.editor.formatters, [doc.lang.kind]: f.id };
            void formatBuffer();
          },
        })),
        ...(fixer
          ? [
              { kind: "separator" as const },
              { icon: "wrench" as const, label: t("editor.format.fix", { tool: fixer.label }), onSelect: () => void formatBuffer({ fix: true }) },
            ]
          : []),
        { kind: "separator" as const },
        {
          label: t("editor.format.onSave"),
          checked: settings.editor.formatOnSave,
          onSelect: () => (settings.editor.formatOnSave = !settings.editor.formatOnSave),
        },
      ],
    };
  }

  /** Save — formatted first when «format on save» is on. */
  async function saveNow() {
    if (doc.readOnly) return;
    if (settings.editor.formatOnSave && doc.content !== doc.baseContent) await formatBuffer({ onSave: true });
    onsave?.();
  }

  // Custom merge-chunk controls for the git inline diff. The buffer IS the
  // working-tree file (diffed against HEAD), so CodeMirror's "accept" ("keep my
  // version") is a no-op — we drop it and expose only "revert this hunk to HEAD".
  // Staging (git add) stays in the Changes tab. Save (Ctrl+S) writes the buffer.
  function gitMergeControl(type: "accept" | "reject", action: (e: MouseEvent) => void): HTMLElement {
    if (type === "accept") return document.createElement("span"); // nothing rendered
    const btn = document.createElement("button");
    btn.name = "revert";
    btn.className = "cm-gitMergeBtn cm-gitMergeBtn-revert";
    const label = t("git.revertHunk");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.history}</svg>`;
    btn.addEventListener("mousedown", action);
    return btn;
  }

  const gitMergeTheme = EditorView.theme({
    ".cm-chunkButtons .cm-gitMergeBtn svg": { width: "0.875rem", height: "0.875rem" },
    ".cm-chunkButtons .cm-gitMergeBtn": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "1.375rem",
      height: "1.375rem",
      padding: "0",
      margin: "0 2px",
      border: "1px solid transparent",
      borderRadius: "6px",
      cursor: "pointer",
      background: "transparent",
      transition: "background 120ms ease",
    },
    ".cm-chunkButtons .cm-gitMergeBtn-revert": {
      color: "#9fb0c4",
      borderColor: "#2b3444",
      background: "transparent",
    },
    ".cm-chunkButtons .cm-gitMergeBtn-revert:hover": {
      color: "#ef6f74",
      borderColor: "#7a3336",
      background: "rgba(210,70,70,0.14)",
    },
  });

  // Markdown files get a Code ⇄ Preview toggle; they open in preview by default
  // (set once in onMount). `lang.kind` never changes for a mounted editor.
  const isMarkdown = $derived(doc.lang.kind === "markdown");
  let preview = $state(false);

  // Inline images for the preview (Phase 44.4), keyed by their raw markdown
  // target. Filled asynchronously by `loadPreviewImages`; a target that is absent
  // renders as a placeholder, so the preview is correct before, during and after
  // the reads — nothing waits on them.
  let mdImages = $state<ReadonlyMap<string, string>>(new Map());
  // Targets already dealt with, resolved or refused. The effect below re-runs on
  // every edit, and without this a file that failed to read would be re-requested
  // on each keystroke.
  let mdSeen = new Set<string>();
  // True when the document points at images that cannot load here at all (remote
  // http(s), other than the static badges we draw ourselves). Drives the one-line
  // note under the preview — without it, a remote screenshot silently turns into a
  // little grey box and the reader is left to guess whether the app is broken.
  let mdHasRemote = $state(false);

  // Live-rendered HTML (CodeMirror stays mounted, so doc.content tracks edits).
  // `html: true` admits the sanitised HTML subset (htmlsan.ts) so a README's
  // `<div align="center">`, `<sub>`, tables… render instead of showing as text.
  // Only this preview opts in — LLM/notes markdown stays fully escaped.
  const previewHtml = $derived(
    isMarkdown && preview ? renderMarkdown(doc.content, { images: mdImages, html: true }) : "",
  );

  /**
   * Resolve the document's image targets to `data:` URLs, one read per target.
   *
   * Reads go over the same channel the document itself came from, so a README
   * opened over SFTP shows the screenshots sitting next to it on that server. The
   * budget is per document, not per read: `MAX_IMAGES` caps the fan-out, and the
   * backend caps each file's size.
   */
  async function loadPreviewImages(md: string) {
    const targets = collectImages(md).filter((s) => !mdSeen.has(s));
    if (targets.length === 0) return;
    let budget = MAX_IMAGES - mdSeen.size;
    for (const target of targets) {
      if (budget <= 0) break;
      mdSeen.add(target);
      const ref = classifyImage(doc.path, target);
      if (ref.kind === "remote") {
        // A static shields badge is drawn from its own URL, so it is not one of
        // the images the note below has to apologise for.
        if (!parseStaticBadge(target)) mdHasRemote = true;
        continue;
      }
      if (ref.kind === "unsupported") continue;
      budget--;
      if (ref.kind === "data") {
        mdImages = new Map(mdImages).set(target, ref.url);
        continue;
      }
      try {
        const b64 =
          doc.source === "sftp"
            ? await sftpReadBytes(sessionId, ref.path, MAX_IMAGE_BYTES)
            : await readLocalBytes(ref.path, MAX_IMAGE_BYTES);
        mdImages = new Map(mdImages).set(target, dataUrl(ref.mime, b64));
      } catch (e) {
        // A missing or oversized image is not an error worth a toast — the
        // placeholder already says this one did not render, and a .md commonly
        // outlives the files it references.
        swallowed("editor", "an image of the preview did not load", e);
      }
    }
  }

  $effect(() => {
    if (!isMarkdown || !preview) return;
    void loadPreviewImages(doc.content);
  });

  /**
   * Re-read the preview's inline images from source. The document text itself is
   * always live (CodeMirror tracks edits), but images are cached by markdown
   * target in `mdImages`/`mdSeen`, so a *file* that changed on disk keeps its
   * stale `data:` URL until the cache is dropped. This gives the reader the
   * close-and-reopen effect without losing their buffer. Markdown preview only.
   */
  function reloadPreview() {
    mdImages = new Map();
    mdSeen = new Set();
    mdHasRemote = false;
    void loadPreviewImages(doc.content);
    notifySuccess(t("editor.previewReloaded"), { source: "editor", sessionId: sessionId });
  }

  // A CI pipeline (ADR 0068) gets Code ⇄ Schema ⇄ Side by side: named by its
  // path (workflows, .gitlab-ci.yml), or — a GitLab fragment — by what it holds.
  const pipelineKind = $derived(
    pipelineKindOf(doc.path) ?? (/\.ya?ml$/i.test(doc.path) && looksLikeGitlab(doc.content) ? "gitlab" : null),
  );
  let pipeView = $state<"code" | "schema" | "split">("code");
  const PIPE_VIEWS = [
    { v: "code", icon: "code", key: "editor.viewCode" },
    { v: "schema", icon: "hierarchy", key: "editor.viewSchema" },
    { v: "split", icon: "splitRight", key: "editor.viewSplit" },
  ] as const;
  /** The editor's cursor line, for the schema beside it to pick the job. */
  let cursorLine = $state<number | null>(null);
  const codeHidden = $derived(preview || (!!pipelineKind && pipeView === "schema"));
  // The symbols and the path to the cursor (ADR 0076) — skipped on a huge file.
  const BIG = 1_000_000;
  const crumbs = $derived(
    !codeHidden && doc.content.length < BIG && cursorLine ? breadcrumbs(doc.lang.kind, doc.content, cursorLine, doc.name) : [],
  );
  const syms = $derived(outlineOpen ? outline(doc.lang.kind, doc.content, doc.name) : []);

  const pipeReader = $derived(connectionFiles(doc.source === "sftp" ? sessionId : null, settings.sftp.maxOpenMb * 1024 * 1024));
  // Asked again for the schema of a file already open ("Pipeline schema" in the file panel).
  $effect(() => {
    if (doc.viewSeq && doc.startView === "schema") pipeView = "schema";
  });

  // The job picked in the schema, lit in the code beside it.
  const setJobLines = StateEffect.define<{ from: number; to: number } | null>();
  const jobLine = Decoration.line({ class: "cm-pipeline-job" });
  const jobLines = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      let next = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setJobLines)) continue;
        if (!e.value) {
          next = Decoration.none;
          continue;
        }
        const b = new RangeSetBuilder<Decoration>();
        for (let n = e.value.from; n <= e.value.to; n++) {
          const line = tr.state.doc.line(n);
          b.add(line.from, line.from, jobLine);
        }
        next = b.finish();
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const jobLineTheme = EditorView.theme({
    ".cm-pipeline-job": { backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)" },
  });

  function lightJob(span: SourceSpan | null) {
    if (!view) return;
    if (!span || span.file !== doc.path || pipeView !== "split") {
      view.dispatch({ effects: setJobLines.of(null) });
      return;
    }
    const last = view.state.doc.lines;
    const from = Math.min(Math.max(1, span.line), last);
    const to = Math.min(Math.max(from, span.endLine), last);
    view.dispatch({
      effects: [setJobLines.of({ from, to }), EditorView.scrollIntoView(view.state.doc.line(from).from, { y: "nearest" })],
    });
  }

  /** "Open in code" from the schema: this file beside the schema, another file in its own editor. */
  /**
   * The schema's fix (pin by SHA, ADR 0069): one change of the buffer — only the
   * part that differs — so one undo takes it back.
   */
  function editFromSchema(next: string) {
    if (doc.readOnly || !view) return;
    const cur = view.state.doc.toString();
    if (cur === next) return;
    let from = 0;
    while (from < cur.length && from < next.length && cur[from] === next[from]) from++;
    let tail = 0;
    while (tail < cur.length - from && tail < next.length - from && cur[cur.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    view.dispatch({ changes: { from, to: cur.length - tail, insert: next.slice(from, next.length - tail) } });
  }

  function jumpFromSchema(file: string, line: number) {
    if (file !== doc.path) {
      onOpenFileAt?.(file, line);
      return;
    }
    if (pipeView === "schema") pipeView = "split";
    jumpTo(line);
    view?.focus();
  }

  // Config snippets/templates relevant to this file's language (from settings).
  const snippets = $derived(snippetsForLang(doc.lang.kind, settings.snippets));
  let showSnippets = $state(false);

  /** Insert a snippet body at the cursor (replacing any selection). */
  function insertSnippet(body: string) {
    showSnippets = false;
    if (doc.readOnly || !view) return;
    view.dispatch(view.state.replaceSelection(body));
    view.focus();
  }

  // Server-side lint (Phase 12.7): run a real tool on the buffer over SSH.
  const canRemoteLint = $derived(doc.source === "sftp" && hasRemoteLinter(doc.lang.kind));
  let linting = $state(false);
  let lintMessages = $state<LintMsg[] | null>(null);

  async function runRemoteLint() {
    linting = true;
    try {
      const res = await lintRemote(sessionId, doc.content, doc.lang.kind, {
        name: doc.name,
        // sshd -t needs root to read host keys — under sudo when the file is
        // edited as root, with what sudo took (never a fresh prompt just to lint).
        sudo: doc.sudo,
      });
      if (!res.found) {
        lintMessages = null;
        notifyError(t("editor.lintMissing", { tool: res.tool || doc.lang.label }), { source: "editor", sessionId: sessionId });
        if (res.tool) onLintMissing?.(res.tool);
        return;
      }
      const msgs = parseLint(res.output, res.format);
      lintMessages = msgs;
      if (msgs.length === 0) notifySuccess(t("editor.lintClean", { tool: res.tool }), { source: "editor", sessionId: sessionId });
    } catch (e) {
      notifyError(String(e), { source: "editor", sessionId: sessionId });
    } finally {
      linting = false;
    }
  }

  /** Jump the cursor to a 1-based line (from a lint result). */
  function jumpToLine(line: number) {
    if (!view) return;
    const n = Math.min(Math.max(1, line), view.state.doc.lines);
    const l = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    view.focus();
  }

  /** Generic linter: flag error nodes in the syntax tree (works for any Lezer
   *  language — YAML/JSON/Python/JS/…; StreamLanguage modes simply yield none). */
  function syntaxErrorLinter() {
    return linter((v) => {
      const diags: Diagnostic[] = [];
      syntaxTree(v.state).iterate({
        enter: (node) => {
          if (!node.type.isError) return;
          const to =
            node.to > node.from ? node.to : Math.min(node.from + 1, v.state.doc.length);
          diags.push({ from: node.from, to, severity: "error", message: t("editor.syntaxError") });
        },
      });
      return diags;
    });
  }

  /** Lint extensions for the current doc (always on). JSON gets precise parse
   *  messages; everything else uses the generic syntax-error linter. */
  function lintExt() {
    const which = doc.lang.kind === "json" ? linter(jsonParseLinter()) : syntaxErrorLinter();
    return [lintGutter(), which];
  }

  function triggerSave(): boolean {
    void saveNow();
    return true;
  }

  // CodeMirror lives in a contenteditable, so the global input clipboard handler
  // skips it; and on WKWebView (no Edit menu) the native copy/paste accelerators
  // are absent. Wire Cmd/Ctrl+C/X/V to the backend clipboard (clipboard.ts), as
  // Terminal.svelte does for xterm. Returning true preventDefaults the keydown so
  // the browser's own paste/copy event doesn't also fire (no double-handling).
  function cmCopy(v: EditorView): boolean {
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    if (sel) writeClipboard(sel);
    return true;
  }
  function cmCut(v: EditorView): boolean {
    if (doc.readOnly) return cmCopy(v);
    const { from, to } = v.state.selection.main;
    const sel = v.state.sliceDoc(from, to);
    if (sel) {
      writeClipboard(sel);
      v.dispatch({ changes: { from, to, insert: "" } });
    }
    return true;
  }
  // Paste via `replaceSelection`, never a hand-rolled change plus a cursor offset
  // measured on the clipboard string. CodeMirror normalizes line breaks on insert,
  // so CRLF text (every multi-line paste from a Windows app) lands SHORTER in the
  // document than the string it came from; a cursor computed from the raw string
  // then points past the end and `state.update` throws before applying anything —
  // a silent, total paste failure that only reproduces off macOS. Held by the
  // lint rule `vterm/paste-caret`.
  function cmPaste(v: EditorView): boolean {
    if (doc.readOnly) return true;
    void readClipboard().then((text) => {
      if (!text) return;
      v.dispatch(v.state.replaceSelection(text));
    });
    return true;
  }

  onMount(() => {
    preview = isMarkdown; // markdown opens in preview by default
    if (doc.startView === "schema") pipeView = "schema";
    const state = EditorState.create({
      doc: doc.content,
      extensions: [
        // Let CodeMirror's runtime style element pass the packaged-build CSP (cspnonce.ts).
        cspNonceExtension(),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        bracketMatching(),
        indentOnInput(),
        highlightSelectionMatches(),
        multiCursor(),
        baseTheme,
        changeFlash(),
        foldC.of(folding(WORDS, foldsByIndent(doc.lang.kind))),
        bracketsC.of(brackets(settings.editor.closeBrackets)),
        completeC.of(completion(settings.editor.autocomplete, snippets, WORDS)),
        indentC.of(indentation(indentInfo)),
        guidesC.of(indentGuides(settings.editor.indentGuides)),
        trailingC.of(trailingSpace(settings.editor.trailingSpace && !doc.readOnly)),
        wrapC.of(wrapping(settings.editor.wrap)),
        jinjaC.of([]),
        minimapC.of([]),
        schemaC.of([]),
        lspC.of([]),
        EditorState.readOnly.of(doc.readOnly),
        // Opened from the git panel → editable inline diff against the HEAD
        // version (deletions shown struck-through, additions highlighted, with
        // accept/reject chunk controls). Absent for ordinary file opens.
        ...(doc.gitBase !== undefined
          ? [
              unifiedMergeView({ original: doc.gitBase, mergeControls: gitMergeControl }),
              gitMergeTheme,
            ]
          : []),
        langC.of([]),
        jobLines,
        jobLineTheme,
        lintC.of(lintExt()),
        themeC.of(editorTheme(activeTerminalTheme())),
        // Mod+S saves; Mod+C/X/V use the backend clipboard. These sit before the
        // default keymap so they win.
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: triggerSave },
          { key: "Mod-c", run: cmCopy },
          { key: "Mod-x", run: cmCut },
          { key: "Mod-v", run: cmPaste },
          {
            key: "Mod-Shift-o",
            preventDefault: true,
            run: () => {
              outlineOpen = true;
              return true;
            },
          },
          {
            key: "Shift-Alt-f",
            preventDefault: true,
            run: () => {
              void formatBuffer();
              return true;
            },
          },
        ]),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setEditorContent(sessionId, doc.id, u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            cursorLine = line.number;
            cursorCol = head - line.from + 1;
            selections = u.state.selection.ranges.length;
          }
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    cursorLine = 1;
    // How the file indents: what it does now, then `.editorconfig` when it is read.
    const first = resolveIndent(doc.content, doc.lang.kind, doc.name, {});
    applyIndent(first.info, first.source);
    const created = view;
    // A chart's values file is checked against the chart's own schema beside it.
    if (/^values.*\.ya?ml$/i.test(doc.name)) {
      void connectionFiles(doc.source === "sftp" ? sessionId : null, 0)
        .list(parentOf(doc.path))
        .then((entries) => {
          if (view === created) siblings = entries.map((e) => e.name);
        })
        .catch(swallow("editor", "the folder of a values file was not listed: it is not checked against the chart's schema"));
    }
    void readEditorConfig()
      .then((ec) => {
        if (view !== created) return;
        ecProps = ec;
        const r = resolveIndent(doc.content, doc.lang.kind, doc.name, ec);
        applyIndent(r.info, r.source);
      })
      .catch(swallow("editor", "the .editorconfig files were not read: the file's own indentation is used"));
    // Jump to a requested place (a content-search hit, `x.c:42:5` in output).
    if (doc.gotoLine && (doc.gotoLine > 1 || (doc.gotoColumn ?? 1) > 1)) jumpTo(doc.gotoLine, doc.gotoColumn);
  });

  /** Put the cursor on 1-based `line` and `column` (both clamped; no column — the line's start) and scroll to it. */
  function jumpTo(lineNo: number, column?: number | null) {
    if (!view) return;
    const n = Math.min(Math.max(1, lineNo), view.state.doc.lines);
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: line.from + columnOffset(line.length, column) }, scrollIntoView: true });
  }

  // A jump asked for once the file was open (v1.24: `file:line` clicked in
  // terminal output, a search hit on a file already open) — `gotoEditorLine`.
  $effect(() => {
    const seq = doc.gotoSeq;
    const lineNo = doc.gotoLine;
    const column = doc.gotoColumn;
    if (seq && lineNo) jumpTo(lineNo, column);
  });

  // Re-theme live when the user switches themes (settings.theme is a rune).
  $effect(() => {
    // Touch the dependency so the effect re-runs on theme change.
    void settings.theme;
    void settings.customTheme;
    view?.dispatch({ effects: themeC.reconfigure(editorTheme(activeTerminalTheme())) });
  });

  onDestroy(() => {
    if (lspHeld) releaseLsp(lspHeld);
    view?.destroy();
  });

  /** The colour of the sudo badge's tone, from the theme's tokens. */
  const BADGE_TONE = {
    muted: "border-transparent text-muted",
    accent: "border-accent/50 text-accent",
    warn: "border-warn/50 text-warn",
    danger: "border-bad/50 text-bad",
  } as const;

  /** sudo will not: the Save button offers the copy instead (the change is kept). */
  const sudoRefused = $derived(
    doc.source === "sftp" && !doc.sudo && doc.writeAccess === "restricted" && doc.sudoRoute?.kind === "refused",
  );
</script>

<div class="flex h-full flex-col">
  <!-- Editor toolbar: path, language, read-only / dirty state, Save. -->
  <div class="relative flex items-center gap-2 border-b border-edge px-2 py-1 text-xs">
    <Icon name="file" size={13} class="shrink-0 text-muted" />
    <span class="truncate text-muted" title={doc.path}>{doc.path}</span>
    <span class="shrink-0 rounded bg-panel px-1.5 py-0.5 text-caption uppercase tracking-wider text-muted">
      {doc.lang.label}
    </span>
    {#if doc.readOnly}
      <span class="shrink-0 text-caption uppercase tracking-wider text-warn">
        {t("editor.readOnly")}
      </span>
    {/if}
    {#if doc.sudo}
      <!-- Edited and saved as root (ADR 0073): never quietly. -->
      <span
        class="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-caption text-warn"
        data-testid="editor-root"
        use:tooltip={t("sudo.rootHint")}
      >{t("sudo.root")}</span>
    {/if}
    <div class="ml-auto flex shrink-0 items-center gap-2">
      {#if doc.source === "sftp" && !doc.sudo && doc.writeAccess === "restricted"}
        <!-- What saving it will take (ADR 0073): asked on open, not found at Save. -->
        {@const badge = sudoBadge(doc.sudoRoute)}
        {#if badge.acts}
          <button
            class="shrink-0 rounded border px-1.5 py-0.5 text-caption hover:bg-edge {BADGE_TONE[badge.tone]}"
            data-testid="editor-sudo-badge"
            use:tooltip={t("sudo.elevate")}
            onclick={() => onCheckSudo?.()}
          >{#if doc.sudoRoute?.kind === "saved"}<Icon name="key" size={11} class="mr-1 inline" />{/if}{t(badge.key)}</button>
        {:else}
          <span
            class="shrink-0 rounded border px-1.5 py-0.5 text-caption {BADGE_TONE[badge.tone]}"
            data-testid="editor-sudo-badge"
            use:tooltip={doc.sudoRoute?.kind === "refused" ? `${t(REFUSAL_HINT[doc.sudoRoute.why])} ${doc.sudoRoute.said}`.trim() : t(badge.key)}
          >{#if doc.sudoRoute?.kind === "refused"}<Icon name="lock" size={11} class="mr-1 inline" />{/if}{t(badge.key)}</span>
        {/if}
      {:else if doc.source === "sftp" && !doc.sudo && doc.writeAccess === "checking"}
        <span class="shrink-0 text-caption text-muted">{t("editor.accessChecking")}</span>
      {:else if doc.source === "sftp" && !doc.sudo && doc.writeAccess === "unknown"}
        <span class="shrink-0 text-caption text-muted" title={t("editor.writeUnknown")}>{t("editor.writeUnknown")}</span>
      {/if}
      {#if doc.content !== doc.baseContent && !doc.readOnly}
        <span class="text-caption text-muted">{t("editor.unsaved")}</span>
      {/if}
      {#if isMarkdown}
        <!-- Code ⇄ Preview segmented toggle (markdown only). -->
        <div class="flex overflow-hidden rounded border border-edge">
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-0.5 {preview
              ? 'text-muted hover:text-accent'
              : 'bg-edge text-text'}"
            aria-pressed={!preview}
            use:tooltip={t("editor.viewCode")}
            onclick={() => (preview = false)}
          >
            <Icon name="code" size={13} />
            {t("editor.viewCode")}
          </button>
          <button
            type="button"
            class="flex items-center gap-1 px-2 py-0.5 {preview
              ? 'bg-edge text-accent'
              : 'text-muted hover:text-accent'}"
            aria-pressed={preview}
            use:tooltip={t("editor.viewPreview")}
            onclick={() => (preview = true)}
          >
            <Icon name="eye" size={13} />
            {t("editor.viewPreview")}
          </button>
        </div>
      {/if}
      {#if pipelineKind}
        <!-- Code ⇄ Schema ⇄ Side by side (CI pipelines, ADR 0068). -->
        <div class="flex overflow-hidden rounded border border-edge" data-testid="editor-pipeline-view">
          {#each PIPE_VIEWS as b (b.v)}
            <button
              type="button"
              class="flex items-center gap-1 px-2 py-0.5 {b.v !== 'code' ? 'border-l border-edge' : ''} {pipeView === b.v
                ? 'bg-edge text-accent'
                : 'text-muted hover:text-accent'}"
              aria-pressed={pipeView === b.v}
              use:tooltip={t(b.key)}
              onclick={() => {
                pipeView = b.v;
                if (b.v !== "split") view?.dispatch({ effects: setJobLines.of(null) });
              }}
            >
              <Icon name={b.icon} size={13} />
              {t(b.key)}
            </button>
          {/each}
        </div>
      {/if}
      {#if isMarkdown && preview}
        <!-- Re-read inline images from source (close/reopen without losing edits). -->
        <button
          type="button"
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text"
          use:tooltip={t("editor.reloadPreview")}
          aria-label={t("editor.reloadPreview")}
          onclick={reloadPreview}
        >
          <Icon name="refresh" size={13} />
        </button>
      {/if}
      {#if canRemoteLint && !codeHidden}
        <button
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
          use:tooltip={t("editor.lintServer")}
          aria-label={t("editor.lintServer")}
          disabled={linting}
          onclick={runRemoteLint}
        >
          <Icon name="check" size={13} />
          {linting ? t("editor.linting") : t("editor.lintServer")}
        </button>
      {/if}
      {#if !doc.readOnly && !codeHidden}
        <!-- Format (ADR 0076): the picked tool on a click, the list and the fixer on ▾. -->
        <div class="flex overflow-hidden rounded border border-edge" data-testid="editor-format">
          <button
            class="flex items-center gap-1 px-2 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
            use:tooltip={t("editor.format.hint")}
            disabled={formatting}
            onclick={() => void formatBuffer()}
          >
            <Icon name="alignLeft" size={13} />
            {formatting ? t("editor.format.running") : t("editor.format.button")}
          </button>
          <button
            class="border-l border-edge px-1 text-muted hover:bg-edge hover:text-text"
            aria-label={t("editor.format.menu")}
            use:tooltip={t("editor.format.menu")}
            data-testid="editor-format-menu"
            onclick={openFormatMenu}
          ><Icon name="chevronDown" size={12} /></button>
        </div>
      {/if}
      {#if snippets.length > 0 && !doc.readOnly && !codeHidden}
        <div class="relative">
          <button
            class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text"
            use:tooltip={t("editor.snippets")}
            aria-label={t("editor.snippets")}
            onclick={() => (showSnippets = !showSnippets)}
          >
            <Icon name="filePlus" size={13} />
            {t("editor.snippets")}
          </button>
          {#if showSnippets}
            <div
              class="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded border border-edge bg-panel-alt shadow-lg"
            >
              {#each snippets as s (s.id)}
                <button
                  class="block w-full truncate px-3 py-1.5 text-left text-xs text-muted hover:bg-edge hover:text-text"
                  onclick={() => insertSnippet(s.body)}
                >
                  {s.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if scenarioKind === "ansible"}
        <button
          class="rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text"
          data-testid="editor-playbook-check"
          onclick={() => onScenario?.("check")}>{t("scenarios.editor.check")}</button
        >
        <button
          class="flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent"
          data-testid="editor-playbook-run"
          onclick={() => onScenario?.("run")}
        >
          <Icon name="play" size={12} />{t("scenarios.editor.run")}
        </button>
      {:else if scenarioKind === "terraform"}
        <button
          class="flex items-center gap-1 rounded border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent"
          data-testid="editor-tf-plan"
          onclick={() => onScenario?.("plan")}
        >
          <Icon name="play" size={12} />{t("scenarios.editor.plan")}
        </button>
      {/if}
      {#if onToLibrary}
        <button
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text"
          data-testid="editor-to-library"
          onclick={() => onToLibrary?.()}
        >
          <Icon name="listCheck" size={13} />{t("scenarios.editor.toLibrary")}
        </button>
      {/if}
      {#if groupServers && onGroup && !codeHidden}
        <button
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
          data-testid="editor-group"
          use:tooltip={t("groupEdit.buttonHint", { count: groupServers })}
          aria-label={t("groupEdit.buttonHint", { count: groupServers })}
          disabled={doc.readOnly || saving || doc.content === doc.baseContent}
          onclick={() => onGroup?.()}
        >
          <Icon name="broadcast" size={13} />
          {t("groupEdit.button")}
        </button>
      {/if}
      {#if sudoRefused}
        <!-- sudo will not write it: the way out is the copy, not a Save that cannot land. -->
        <button
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
          data-testid="editor-save-copy"
          disabled={doc.content === doc.baseContent}
          onclick={() => onSaveCopy?.()}
        >
          <Icon name="copy" size={13} />
          {t("editor.saveCopy")}
        </button>
      {:else}
        <button
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
          use:tooltip={t("editor.save")}
          aria-label={t("editor.save")}
          disabled={doc.readOnly || saving || doc.content === doc.baseContent}
          onclick={() => onsave?.()}
        >
          <Icon name="save" size={13} />
          {t("editor.save")}
        </button>
      {/if}
    </div>
    {#if doc.saveIssue !== "none"}
      {@const refusal = doc.saveIssue === "sudo" && doc.sudoRoute?.kind === "refused" ? doc.sudoRoute : null}
      <div
        class="absolute right-1 top-full z-30 mt-1 w-64 max-w-[calc(100%-0.5rem)] rounded border border-edge bg-panel-alt p-3 shadow-lg"
        role="alert"
      >
        <div class="flex items-start justify-between gap-2">
          <strong class="text-xs {refusal ? 'text-bad' : 'text-text'}" data-testid="editor-save-issue">
            {refusal ? t(REFUSAL_TITLE[refusal.why]) : t("editor.saveFailed")}
          </strong>
          <button
            class="text-muted hover:text-text"
            aria-label={t("common.dismiss")}
            onclick={() => onDismissSaveIssue?.()}
          ><Icon name="close" size={13} /></button>
        </div>
        {#if refusal}
          <p class="mt-1 text-xs text-muted">{t(REFUSAL_HINT[refusal.why])}</p>
        {/if}
        <p class="mt-1 text-xs text-muted">{t("editor.changesKept")}</p>
        {#if refusal?.said}
          <details class="mt-1 text-meta text-muted">
            <summary class="cursor-pointer text-accent">{t("sudo.serverSaid")}</summary>
            <p class="mt-1 break-words font-mono" data-testid="editor-sudo-said">{refusal.said}</p>
          </details>
        {/if}
        <div class="mt-3 flex flex-wrap gap-2">
          {#if doc.saveIssue === "permission" && doc.source === "sftp" && !doc.sudo}
            <button class="rounded bg-accent px-2 py-1 text-caption text-panel-alt" onclick={() => onSaveWithSudo?.()}>{t("editor.saveWithSudo")}</button>
          {/if}
          {#if refusal}
            <!-- sudo will not here: the same file under another login of the server (ADR 0074). -->
            {#each openAs.slice(0, 2) as l (l.id)}
              <button
                class="flex items-center gap-1 rounded bg-accent px-2 py-1 text-caption text-panel-alt"
                data-testid="editor-open-as"
                onclick={() => onOpenAs?.(l.id)}
              ><Icon name="users" size={12} />{t("logins.openAs", { user: l.username })}</button>
            {/each}
          {/if}
          <button class="rounded border border-edge px-2 py-1 text-caption text-text hover:bg-edge" onclick={() => onSaveCopy?.()}>{t("editor.saveCopy")}</button>
        </div>
      </div>
    {/if}
  </div>
  {#if vault && !codeHidden}
    <!-- An Ansible Vault file (ADR 0076): hex is not something to edit here. -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge bg-warn/10 px-2 py-1 text-xs" data-testid="editor-vault">
      <Icon name="lock" size={13} class="shrink-0 text-warn" />
      <span class="text-text">{t("editor.vault.title")}</span>
      <span class="text-muted">{t("editor.vault.hint")}</span>
      {#if terminalHere && onTerminal}
        <span class="flex-1"></span>
        <button
          class="rounded border border-edge px-2 py-0.5 text-caption text-text hover:bg-edge"
          onclick={() => onTerminal?.(vaultArgv(doc.path, false, vault.label))}
        >{t("editor.vault.view")}</button>
        <button
          class="rounded border border-edge px-2 py-0.5 text-caption text-text hover:bg-edge"
          onclick={() => onTerminal?.(vaultArgv(doc.path, true, vault.label))}
        >{t("editor.vault.edit")}</button>
      {/if}
    </div>
  {/if}
  {#if crumbs.length > 0}
    <!-- Where the cursor is in the document (ADR 0076); a click goes there. -->
    <div class="flex h-6 shrink-0 items-center gap-1 overflow-hidden border-b border-edge px-2 text-meta text-muted" data-testid="editor-crumbs">
      {#each crumbs as c, i (c.line + ":" + i)}
        {#if i > 0}<Icon name="chevronRight" size={10} class="shrink-0" />{/if}
        <button type="button" class="max-w-[16rem] shrink truncate hover:text-text {i === crumbs.length - 1 ? 'text-text' : ''}" onclick={() => jumpToLine(c.line)}>{c.name}</button>
      {/each}
      <span class="flex-1"></span>
      <button
        type="button"
        class="shrink-0 hover:text-text"
        aria-label={t("editor.outline.title")}
        use:tooltip={t("editor.outline.hint")}
        onclick={() => (outlineOpen = true)}
      ><Icon name="hierarchy" size={12} /></button>
    </div>
  {/if}
  <!-- CodeMirror host (always mounted so edits keep flowing); hidden in the
       markdown preview and on a pipeline's schema, beside the schema otherwise. -->
  <div class="relative min-h-0 flex-1 {preview ? 'hidden' : 'flex'}">
    {#if outlineOpen}
      <OutlinePalette
        {syms}
        onpick={(line) => {
          outlineOpen = false;
          jumpToLine(line);
        }}
        onclose={() => {
          outlineOpen = false;
          view?.focus();
        }}
      />
    {/if}
    <div
      bind:this={host}
      class="min-h-0 min-w-0 flex-1 overflow-hidden text-sm [&_.cm-editor]:h-full {codeHidden ? 'hidden' : ''} {pipelineKind && pipeView === 'split'
        ? 'border-r border-edge'
        : ''}"
    ></div>
    {#if pipelineKind && pipeView !== "code"}
      <div class="min-h-0 min-w-0 {pipeView === 'split' ? 'w-1/2 shrink-0' : 'flex-1'}">
        <PipelineView
          path={doc.path}
          text={doc.content}
          kind={pipelineKind}
          reader={pipeReader}
          {sessionId}
          compact={pipeView === "split"}
          cursorLine={pipeView === "split" ? cursorLine : null}
          onjump={jumpFromSchema}
          onselectjob={lightJob}
          onedit={doc.readOnly ? undefined : editFromSchema}
        />
      </div>
    {/if}
  </div>
  {#if isMarkdown && preview}
    <!-- Preview of a file opened over SFTP/locally — untrusted; see markdown.ts. -->
    <div class="markdown-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-sm" use:mdLinks>
      {@html previewHtml}
      {#if mdHasRemote}
        <!-- Say why the badges are grey boxes; see mdimage.ts for the reasoning. -->
        <p class="mt-4 border-t border-edge pt-2 text-meta text-muted">
          {t("editor.mdRemoteImages")}
        </p>
      {/if}
    </div>
  {/if}
  {#if !codeHidden && !preview}
    <EditorStatusBar
      left={schemaRef || lspServer ? statusLeft : undefined}
      line={cursorLine ?? 1}
      col={cursorCol}
      {selections}
      indent={indentInfo}
      {indentSource}
      encoding={doc.encoding}
      eol={doc.eol}
      lang={doc.lang}
      {detected}
      overridden={override !== null}
      wrap={settings.editor.wrap}
      minimap={settings.editor.minimap}
      readOnly={doc.readOnly}
      onlang={pickLang}
      onindent={setIndent}
      onwrap={() => (settings.editor.wrap = !settings.editor.wrap)}
      onminimap={() => (settings.editor.minimap = !settings.editor.minimap)}
    />
  {/if}
  <ContextMenu menu={formatMenu} onclose={() => (formatMenu = null)} />
  <ContextMenu menu={lspMenu} onclose={() => (lspMenu = null)} />
  <ConfirmDialog
    open={lspAsk}
    title={t("lsp.prodTitle")}
    confirmLabel={t("lsp.startAnyway")}
    onconfirm={() => {
      lspAsk = false;
      void startLsp(true);
    }}
    oncancel={() => (lspAsk = false)}
  >
    <p>{t("lsp.prodBody", { server: lspServer?.program ?? "" })}</p>
  </ConfirmDialog>
  {#if lintMessages && lintMessages.length > 0}
    <!-- Server-side lint results (Phase 12.7): click to jump to the line. -->
    <div class="max-h-40 shrink-0 overflow-auto border-t border-edge text-xs">
      <div
        class="sticky top-0 flex items-center justify-between border-b border-edge bg-panel-alt px-2 py-1 text-meta text-muted"
      >
        <span>{t("editor.lintIssues", { n: lintMessages.length })}</span>
        <button
          class="hover:text-text"
          aria-label={t("common.dismiss")}
          onclick={() => (lintMessages = null)}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      {#each lintMessages as m, i (i)}
        <button
          class="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-edge"
          onclick={() => jumpToLine(m.line)}
        >
          <span
            class="shrink-0 tabular-nums {m.level === 'error'
              ? 'text-danger'
              : m.level === 'warning'
                ? 'text-warn'
                : 'text-muted'}"
          >
            {m.line}{#if m.col}:{m.col}{/if}
          </span>
          <span class="min-w-0 flex-1 break-words">{m.message}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

{#snippet statusLeft()}
  {#if lspServer}
    {@const dot = lspState === "running" ? "bg-ok" : lspState === "starting" ? "bg-warn" : lspState === "failed" ? "bg-bad" : "bg-edge"}
    <button
      type="button"
      class="flex items-center gap-1 hover:text-text"
      data-testid="editor-lsp"
      use:tooltip={lspHeld && lspSaid(lspEntryKey(lspHeld)) ? (lspSaid(lspEntryKey(lspHeld)) ?? "") : t(`lsp.state.${lspState ?? "off"}`)}
      onclick={openLspMenu}
    >
      <span class="size-1.5 rounded-full {dot}"></span>
      {lspServer.program}
      {#if lspState === "missing"}<span class="text-warn">· {t("lsp.state.missing")}</span>{/if}
    </button>
  {/if}
  {@render schemaChip()}
{/snippet}

{#snippet schemaChip()}
  {#if schemaRef}
    <span
      class="flex items-center gap-1 {schemaState && 'issues' in schemaState && schemaState.issues > 0 ? 'text-warn' : ''}"
      data-testid="editor-schema"
      use:tooltip={schemaState && "unavailable" in schemaState
        ? t(schemaState.unavailable === "url" ? "schema.urlNotFetched" : "schema.unread")
        : t("schema.hint")}
    >
      <Icon name={schemaState && "unavailable" in schemaState ? "circleOff" : "listCheck"} size={11} />
      {t("schema.chip", { label: schemaRef.label })}
      {#if schemaState && "issues" in schemaState}
        {#if schemaState.issues === 0}<Icon name="check" size={11} class="text-ok" />{:else}· {t("schema.issues", { n: schemaState.issues })}{/if}
      {/if}
    </span>
  {/if}
{/snippet}

<!--
  Styling for the {@html}-rendered markdown preview. Svelte's scoped styles don't
  reach injected HTML, so descendants are targeted with :global(...). Colors use
  the theme tokens so the preview follows the active UI theme (same as HelpPanel).
-->
<style>
  .markdown-preview :global(h1),
  .markdown-preview :global(h2),
  .markdown-preview :global(h3),
  .markdown-preview :global(h4) {
    font-weight: 600;
    color: var(--color-text);
    margin: 1.1em 0 0.5em;
    line-height: 1.3;
  }
  .markdown-preview :global(h1) {
    font-size: 1.35em;
  }
  .markdown-preview :global(h2) {
    font-size: 1.15em;
    border-bottom: 1px solid var(--color-edge);
    padding-bottom: 0.25em;
  }
  .markdown-preview :global(h3) {
    font-size: 1.05em;
  }
  .markdown-preview :global(h1:first-child) {
    margin-top: 0;
  }
  .markdown-preview :global(p) {
    margin: 0.6em 0;
  }
  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.2em;
  }
  .markdown-preview :global(ul) {
    list-style: disc;
  }
  .markdown-preview :global(ol) {
    list-style: decimal;
  }
  .markdown-preview :global(li) {
    margin: 0.2em 0;
  }
  .markdown-preview :global(a) {
    color: var(--color-accent);
    cursor: pointer;
  }
  .markdown-preview :global(a:hover) {
    text-decoration: underline;
  }
  .markdown-preview :global(strong) {
    color: var(--color-text);
    font-weight: 600;
  }
  /* Inline images (Phase 44.4). Capped so a full-window screenshot doesn't push
     the rest of the document off-screen; the aspect ratio is kept by `height`. */
  .markdown-preview :global(img) {
    display: inline-block;
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    vertical-align: middle;
  }
  /* An image that could not be inlined. Reads as a labelled slot rather than a
     broken picture: for a badge row that is the truth — nothing is damaged, the
     target is simply unreachable from an app that makes no network requests. */
  /* Locally-drawn shields.io badges (Phase 44.5): they sit in a row, so they need
     the same baseline as the surrounding text and a little breathing room. */
  .markdown-preview :global(svg.md-badge) {
    display: inline-block;
    vertical-align: middle;
    margin: 0.1em 0.15em;
  }
  .markdown-preview :global(.md-img) {
    display: inline-block;
    border: 1px dashed var(--color-edge);
    border-radius: 4px;
    padding: 0 0.4em;
    color: var(--color-muted);
    font-size: 0.85em;
    line-height: 1.6;
    vertical-align: middle;
  }
  .markdown-preview :global(code) {
    font-family: ui-monospace, monospace;
    background: var(--color-panel);
    border: 1px solid var(--color-edge);
    border-radius: 4px;
    padding: 0 0.3em;
    font-size: 0.92em;
  }
  .markdown-preview :global(pre) {
    background: var(--color-panel);
    border: 1px solid var(--color-edge);
    border-radius: 6px;
    padding: 0.75em;
    overflow-x: auto;
    margin: 0.7em 0;
  }
  .markdown-preview :global(pre code) {
    background: none;
    border: none;
    padding: 0;
  }
  .markdown-preview :global(blockquote) {
    border-left: 3px solid var(--color-edge);
    padding: 0.1em 0.8em;
    margin: 0.7em 0;
    color: var(--color-muted);
  }
  .markdown-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--color-edge);
    margin: 1em 0;
  }
  .markdown-preview :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.7em 0;
    display: block;
    overflow-x: auto;
  }
  .markdown-preview :global(th),
  .markdown-preview :global(td) {
    border: 1px solid var(--color-edge);
    padding: 0.3em 0.5em;
    text-align: left;
  }
  .markdown-preview :global(th) {
    background: var(--color-panel);
    color: var(--color-text);
  }
</style>
