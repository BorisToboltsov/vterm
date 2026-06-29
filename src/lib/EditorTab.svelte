<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorState, Compartment, type Extension } from "@codemirror/state";
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
  import { nginx } from "@codemirror/legacy-modes/mode/nginx";
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
  import { readClipboard, writeClipboard } from "./clipboard";
  import { activeTerminalTheme, settings } from "./settings.svelte";
  import type { EditorLangKind } from "./editorlang";
  import { setEditorContent, type EditorDoc } from "./stores/workspaces.svelte";
  import { renderMarkdown } from "./markdown";
  import { snippetsForLang } from "./snippets";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    sessionId,
    doc,
    saving = false,
    onsave,
  }: {
    sessionId: string;
    doc: EditorDoc;
    /** True while a save is in flight (disables the button). */
    saving?: boolean;
    /** Invoked by the Save button / Ctrl+S. */
    onsave?: () => void;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;
  const themeC = new Compartment();
  const lintC = new Compartment();

  // Markdown files get a Code ⇄ Preview toggle; they open in preview by default
  // (set once in onMount). `lang.kind` never changes for a mounted editor.
  const isMarkdown = $derived(doc.lang.kind === "markdown");
  let preview = $state(false);
  // Live-rendered HTML (CodeMirror stays mounted, so doc.content tracks edits).
  const previewHtml = $derived(isMarkdown && preview ? renderMarkdown(doc.content) : "");

  // Config snippets/templates relevant to this file's language.
  const snippets = $derived(snippetsForLang(doc.lang.kind));
  let showSnippets = $state(false);

  /** Insert a snippet body at the cursor (replacing any selection). */
  function insertSnippet(body: string) {
    showSnippets = false;
    if (doc.readOnly || !view) return;
    view.dispatch(view.state.replaceSelection(body));
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

  /** Lint extensions for the current doc, gated by the setting. JSON gets precise
   *  parse messages; everything else uses the generic syntax-error linter. */
  function lintExt() {
    if (!settings.editor.lint) return [];
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
  function cmPaste(v: EditorView): boolean {
    if (doc.readOnly) return true;
    void readClipboard().then((text) => {
      if (!text) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    });
    return true;
  }

  onMount(() => {
    preview = isMarkdown; // markdown opens in preview by default
    const state = EditorState.create({
      doc: doc.content,
      extensions: [
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

  // Toggle linting live when the setting changes.
  $effect(() => {
    void settings.editor.lint;
    view?.dispatch({ effects: lintC.reconfigure(lintExt()) });
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
            title={t("editor.viewCode")}
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
            title={t("editor.viewPreview")}
            onclick={() => (preview = true)}
          >
            <Icon name="eye" size={13} />
            {t("editor.viewPreview")}
          </button>
        </div>
      {/if}
      {#if snippets.length > 0 && !doc.readOnly && !preview}
        <div class="relative">
          <button
            class="flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-white"
            title={t("editor.snippets")}
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
        title={t("editor.save")}
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
