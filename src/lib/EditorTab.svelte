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
  } from "@codemirror/language";
  import { yaml } from "@codemirror/lang-yaml";
  import { json } from "@codemirror/lang-json";
  import { markdown } from "@codemirror/lang-markdown";
  import { python } from "@codemirror/lang-python";
  import { javascript } from "@codemirror/lang-javascript";
  import { java } from "@codemirror/lang-java";
  import { shell } from "@codemirror/legacy-modes/mode/shell";
  import { toml } from "@codemirror/legacy-modes/mode/toml";
  import { properties } from "@codemirror/legacy-modes/mode/properties";
  import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
  import { go } from "@codemirror/legacy-modes/mode/go";
  import { rust } from "@codemirror/legacy-modes/mode/rust";
  import { ruby } from "@codemirror/legacy-modes/mode/ruby";
  import { c, cpp, csharp, scala, kotlin, dart } from "@codemirror/legacy-modes/mode/clike";
  import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
  import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { perl } from "@codemirror/legacy-modes/mode/perl";
  import { css, sCSS, less } from "@codemirror/legacy-modes/mode/css";
  import { xml, html } from "@codemirror/legacy-modes/mode/xml";
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
        return StreamLanguage.define(go);
      case "rust":
        return StreamLanguage.define(rust);
      case "ruby":
        return StreamLanguage.define(ruby);
      case "c":
        return StreamLanguage.define(c);
      case "cpp":
        return StreamLanguage.define(cpp);
      case "csharp":
        return StreamLanguage.define(csharp);
      case "sql":
        return StreamLanguage.define(standardSQL);
      case "powershell":
        return StreamLanguage.define(powerShell);
      case "lua":
        return StreamLanguage.define(lua);
      case "perl":
        return StreamLanguage.define(perl);
      case "html":
        return StreamLanguage.define(html);
      case "css":
        return StreamLanguage.define(css);
      case "scss":
        return StreamLanguage.define(sCSS);
      case "less":
        return StreamLanguage.define(less);
      case "xml":
        return StreamLanguage.define(xml);
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
  <!-- CodeMirror host; the editor owns its own scrolling. -->
  <div bind:this={host} class="min-h-0 flex-1 overflow-hidden text-sm [&_.cm-editor]:h-full"></div>
</div>
