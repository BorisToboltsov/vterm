<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { EditorState, Compartment, type Extension } from "@codemirror/state";
  import { unifiedMergeView } from "@codemirror/merge";
  import { ICONS } from "./icons";
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
  } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
  import {
    StreamLanguage,
    bracketMatching,
    indentOnInput,
    syntaxTree,
  } from "@codemirror/language";
  import { lintGutter, linter, type Diagnostic } from "@codemirror/lint";
  import { yaml } from "@codemirror/lang-yaml";
  import { json, jsonParseLinter } from "@codemirror/lang-json";
  import { markdown } from "@codemirror/lang-markdown";
  import { python } from "@codemirror/lang-python";
  import { javascript } from "@codemirror/lang-javascript";
  import { java } from "@codemirror/lang-java";
  // Official Lezer packages for the "green group": these parse to a syntax tree,
  // so the generic error-node linter below gives them syntax linting for free.
  import { html } from "@codemirror/lang-html";
  import { css } from "@codemirror/lang-css";
  import { sass } from "@codemirror/lang-sass";
  import { less } from "@codemirror/lang-less";
  import { xml } from "@codemirror/lang-xml";
  import { cpp } from "@codemirror/lang-cpp";
  import { rust } from "@codemirror/lang-rust";
  import { go } from "@codemirror/lang-go";
  import { sql } from "@codemirror/lang-sql";
  import { shell } from "@codemirror/legacy-modes/mode/shell";
  import { toml } from "@codemirror/legacy-modes/mode/toml";
  import { properties } from "@codemirror/legacy-modes/mode/properties";
  import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
  import { ruby } from "@codemirror/legacy-modes/mode/ruby";
  import { csharp, scala, kotlin, dart } from "@codemirror/legacy-modes/mode/clike";
  import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { perl } from "@codemirror/legacy-modes/mode/perl";
  import { nginx } from "./nginxmode";
  import { cmake } from "@codemirror/legacy-modes/mode/cmake";
  import { diff } from "@codemirror/legacy-modes/mode/diff";
  import { http } from "@codemirror/legacy-modes/mode/http";
  import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
  import { puppet } from "@codemirror/legacy-modes/mode/puppet";
  import { groovy } from "@codemirror/legacy-modes/mode/groovy";
  import { swift } from "@codemirror/legacy-modes/mode/swift";
  import { clojure } from "@codemirror/legacy-modes/mode/clojure";
  import { haskell } from "@codemirror/legacy-modes/mode/haskell";
  import { erlang } from "@codemirror/legacy-modes/mode/erlang";
  import { elm } from "@codemirror/legacy-modes/mode/elm";
  import { crystal } from "@codemirror/legacy-modes/mode/crystal";
  import { r } from "@codemirror/legacy-modes/mode/r";
  import { julia } from "@codemirror/legacy-modes/mode/julia";
  import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
  import { vb } from "@codemirror/legacy-modes/mode/vb";
  import { scheme } from "@codemirror/legacy-modes/mode/scheme";
  import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
  import { oCaml, fSharp } from "@codemirror/legacy-modes/mode/mllike";
  import { tcl } from "@codemirror/legacy-modes/mode/tcl";
  import { d } from "@codemirror/legacy-modes/mode/d";
  import { verilog } from "@codemirror/legacy-modes/mode/verilog";
  import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
  import { pascal } from "@codemirror/legacy-modes/mode/pascal";
  import { fortran } from "@codemirror/legacy-modes/mode/fortran";
  import { cobol } from "@codemirror/legacy-modes/mode/cobol";
  import { editorTheme } from "./cmtheme";
  import { cspNonceExtension } from "./cspnonce";
  import { readClipboard, writeClipboard } from "./clipboard";
  import { activeTerminalTheme, settings } from "./settings.svelte";
  import type { EditorLangKind } from "./editorlang";
  import { setEditorContent, type EditorDoc } from "./stores/workspaces.svelte";
  import { renderMarkdown } from "./markdown";
  import { snippetsForLang } from "./snippets";
  import { lintRemote } from "./api";
  import { hasRemoteLinter, parseLint, type LintMsg } from "./remotelint";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    sessionId,
    doc,
    saving = false,
    onsave,
    onLintMissing,
  }: {
    sessionId: string;
    doc: EditorDoc;
    /** True while a save is in flight (disables the button). */
    saving?: boolean;
    /** Invoked by the Save button / Ctrl+S. */
    onsave?: () => void;
    /** Server linter isn't installed — let the page offer to install it. */
    onLintMissing?: (tool: string) => void;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;
  const themeC = new Compartment();
  const lintC = new Compartment();

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
    ".cm-chunkButtons .cm-gitMergeBtn": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "22px",
      height: "22px",
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
  // Live-rendered HTML (CodeMirror stays mounted, so doc.content tracks edits).
  const previewHtml = $derived(isMarkdown && preview ? renderMarkdown(doc.content) : "");

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
        // sshd -t needs root to read host keys — reuse the same sudo password the
        // file was opened-as-root with (never a fresh prompt just to lint).
        sudoPassword: doc.sudo ? doc.sudoPassword : undefined,
      });
      if (!res.found) {
        lintMessages = null;
        notifyError(t("editor.lintMissing", { tool: res.tool || doc.lang.label }));
        if (res.tool) onLintMissing?.(res.tool);
        return;
      }
      const msgs = parseLint(res.output, res.format);
      lintMessages = msgs;
      if (msgs.length === 0) notifySuccess(t("editor.lintClean", { tool: res.tool }));
    } catch (e) {
      notifyError(String(e));
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

  /** Resolve a language kind to a CodeMirror language extension. */
  function langExt(kind: EditorLangKind): Extension {
    switch (kind) {
      case "yaml":
        return yaml();
      case "json":
        return json();
      case "markdown":
        return markdown();
      case "shell":
        return StreamLanguage.define(shell);
      case "toml":
        return StreamLanguage.define(toml);
      case "ini":
        return StreamLanguage.define(properties);
      case "python":
        return python();
      case "javascript":
        return javascript({ jsx: true });
      case "typescript":
        return javascript({ typescript: true, jsx: true });
      case "java":
        return java();
      case "dockerfile":
        return StreamLanguage.define(dockerFile);
      case "go":
        return go();
      case "rust":
        return rust();
      case "ruby":
        return StreamLanguage.define(ruby);
      case "c":
      case "cpp":
        return cpp();
      case "csharp":
        return StreamLanguage.define(csharp);
      case "sql":
        return sql();
      case "powershell":
        return StreamLanguage.define(powerShell);
      case "lua":
        return StreamLanguage.define(lua);
      case "perl":
        return StreamLanguage.define(perl);
      case "html":
        return html();
      case "css":
        return css();
      case "scss":
        return sass({ indented: false });
      case "less":
        return less();
      case "xml":
        return xml();
      case "nginx":
        return StreamLanguage.define(nginx);
      // Daemon configs (Phase A): approximate highlighting — systemd units and the
      // key/value daemon configs are INI-shaped; BIND's braces/semicolons fit nginx.
      case "systemd":
      case "sshdconfig":
      case "sudoers":
      case "haproxy":
        return StreamLanguage.define(properties);
      case "bind":
        return StreamLanguage.define(nginx);
      // YAML-family dialects (Phase B) are highlighted as YAML; only their server
      // validator differs (docker compose config / actionlint / kubeconform / …).
      case "compose":
      case "ghactions":
      case "prometheus":
      case "ansible":
      case "k8s":
        return yaml();
      case "cmake":
        return StreamLanguage.define(cmake);
      case "diff":
        return StreamLanguage.define(diff);
      case "http":
        return StreamLanguage.define(http);
      case "protobuf":
        return StreamLanguage.define(protobuf);
      case "puppet":
        return StreamLanguage.define(puppet);
      case "groovy":
        return StreamLanguage.define(groovy);
      case "scala":
        return StreamLanguage.define(scala);
      case "kotlin":
        return StreamLanguage.define(kotlin);
      case "dart":
        return StreamLanguage.define(dart);
      case "swift":
        return StreamLanguage.define(swift);
      case "clojure":
        return StreamLanguage.define(clojure);
      case "haskell":
        return StreamLanguage.define(haskell);
      case "erlang":
        return StreamLanguage.define(erlang);
      case "elm":
        return StreamLanguage.define(elm);
      case "crystal":
        return StreamLanguage.define(crystal);
      case "r":
        return StreamLanguage.define(r);
      case "julia":
        return StreamLanguage.define(julia);
      case "coffeescript":
        return StreamLanguage.define(coffeeScript);
      case "vb":
        return StreamLanguage.define(vb);
      case "scheme":
        return StreamLanguage.define(scheme);
      case "commonlisp":
        return StreamLanguage.define(commonLisp);
      case "ocaml":
        return StreamLanguage.define(oCaml);
      case "fsharp":
        return StreamLanguage.define(fSharp);
      case "tcl":
        return StreamLanguage.define(tcl);
      case "d":
        return StreamLanguage.define(d);
      case "verilog":
        return StreamLanguage.define(verilog);
      case "vhdl":
        return StreamLanguage.define(vhdl);
      case "pascal":
        return StreamLanguage.define(pascal);
      case "fortran":
        return StreamLanguage.define(fortran);
      case "cobol":
        return StreamLanguage.define(cobol);
      default:
        return [];
    }
  }

  function triggerSave(): boolean {
    if (!doc.readOnly) onsave?.();
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
  // a silent, total paste failure that only reproduces off macOS. See
  // clipboardpaste.guard.test.ts.
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
        EditorView.lineWrapping,
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
        langExt(doc.lang.kind),
        lintC.of(lintExt()),
        themeC.of(editorTheme(activeTerminalTheme())),
        // Mod+S saves; Mod+C/X/V use the backend clipboard. These sit before the
        // default keymap so they win.
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: triggerSave },
          { key: "Mod-c", run: cmCopy },
          { key: "Mod-x", run: cmCut },
          { key: "Mod-v", run: cmPaste },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setEditorContent(sessionId, doc.id, u.state.doc.toString());
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    // Jump to a requested line (e.g. from a content-search hit).
    if (doc.gotoLine && doc.gotoLine > 1) {
      const n = Math.min(doc.gotoLine, view.state.doc.lines);
      const line = view.state.doc.line(n);
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    }
  });

  // Re-theme live when the user switches themes (settings.theme is a rune).
  $effect(() => {
    // Touch the dependency so the effect re-runs on theme change.
    void settings.theme;
    void settings.customTheme;
    view?.dispatch({ effects: themeC.reconfigure(editorTheme(activeTerminalTheme())) });
  });

  onDestroy(() => view?.destroy());
</script>

<div class="flex h-full flex-col">
  <!-- Editor toolbar: path, language, read-only / dirty state, Save. -->
  <div class="flex items-center gap-2 border-b border-edge px-2 py-1 text-xs">
    <Icon name="file" size={13} class="shrink-0 text-muted" />
    <span class="truncate text-muted" title={doc.path}>{doc.path}</span>
    <span class="shrink-0 rounded bg-panel px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">
      {doc.lang.label}
    </span>
    {#if doc.readOnly}
      <span class="shrink-0 text-[10px] uppercase tracking-wider text-warn">
        {t("editor.readOnly")}
      </span>
    {/if}
    <div class="ml-auto flex shrink-0 items-center gap-2">
      {#if doc.content !== doc.baseContent && !doc.readOnly}
        <span class="text-[10px] text-muted">{t("editor.unsaved")}</span>
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
      {#if canRemoteLint && !preview}
        <button
          class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-white disabled:opacity-40"
          use:tooltip={t("editor.lintServer")}
          aria-label={t("editor.lintServer")}
          disabled={linting}
          onclick={runRemoteLint}
        >
          <Icon name="check" size={13} />
          {linting ? t("editor.linting") : t("editor.lintServer")}
        </button>
      {/if}
      {#if snippets.length > 0 && !doc.readOnly && !preview}
        <div class="relative">
          <button
            class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-white"
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
                  class="block w-full truncate px-3 py-1.5 text-left text-xs text-muted hover:bg-edge hover:text-white"
                  onclick={() => insertSnippet(s.body)}
                >
                  {s.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <button
        class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-white disabled:opacity-40"
        use:tooltip={t("editor.save")}
        aria-label={t("editor.save")}
        disabled={doc.readOnly || saving || doc.content === doc.baseContent}
        onclick={() => onsave?.()}
      >
        <Icon name="save" size={13} />
        {t("editor.save")}
      </button>
    </div>
  </div>
  <!-- CodeMirror host (always mounted so edits keep flowing); hidden in preview. -->
  <div
    bind:this={host}
    class="min-h-0 flex-1 overflow-hidden text-sm [&_.cm-editor]:h-full {preview ? 'hidden' : ''}"
  ></div>
  {#if isMarkdown && preview}
    <div class="markdown-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-sm">
      {@html previewHtml}
    </div>
  {/if}
  {#if lintMessages && lintMessages.length > 0}
    <!-- Server-side lint results (Phase 12.7): click to jump to the line. -->
    <div class="max-h-40 shrink-0 overflow-auto border-t border-edge text-xs">
      <div
        class="sticky top-0 flex items-center justify-between border-b border-edge bg-panel-alt px-2 py-1 text-[11px] text-muted"
      >
        <span>{t("editor.lintIssues", { n: lintMessages.length })}</span>
        <button
          class="hover:text-white"
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
