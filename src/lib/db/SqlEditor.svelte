<script lang="ts">
  // The console's SQL editor (ADR 0080): CodeMirror with the dialect's grammar
  // (loaded on first use), completion from the database's catalog, ⌘/Ctrl+Enter
  // to run the statement under the caret (or the selection), ⌘/Ctrl+Shift+Enter
  // to run them all, and the place the database said was wrong underlined.
  // The clipboard goes through the backend, as in the file editor. `single` —
  // a one-line field of a table document (ADR 0081): its WHERE or ORDER BY,
  // the table's columns completed bare, Enter applies it.
  import { onDestroy, onMount, untrack } from "svelte";
  import { Compartment, EditorState, StateEffect, StateField, RangeSet } from "@codemirror/state";
  import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, placeholder as placeholderText } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
  import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
  import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
  import { swallow } from "../api/diag";
  import { readClipboard, writeClipboard } from "../app/clipboard";
  import { editorTheme } from "../editor/cmtheme";
  import { cspNonceExtension } from "../editor/cspnonce";
  import { activeTerminalTheme, settings } from "../settings/settings.svelte";
  import type { DbKind } from "../types";

  let {
    value,
    kind,
    names = {},
    defaultSchema = null,
    errorAt = null,
    onchange,
    onrun,
    onrunAll,
    onready,
    single = false,
    defaultTable = null,
    placeholder = "",
    onsubmit,
  }: {
    value: string;
    kind: DbKind;
    /** `schema → table → columns`, for completion. */
    names?: Record<string, Record<string, string[]>>;
    defaultSchema?: string | null;
    /** A range of the text the database said was wrong. */
    errorAt?: { from: number; to: number } | null;
    onchange: (text: string) => void;
    /** Run what the caret stands in (or the selection): its text and where it starts. */
    onrun: (text: string, offset: number, selection: boolean) => void;
    onrunAll: () => void;
    /** The view, for whoever reads the caret (the toolbar's buttons). */
    onready?: (api: { caret: () => { from: number; to: number }; insert: (text: string) => void; focus: () => void }) => void;
    /** One line: no gutter, no line breaks, Enter submits. */
    single?: boolean;
    /** The table whose columns complete bare. */
    defaultTable?: string | null;
    placeholder?: string;
    onsubmit?: () => void;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  const langC = new Compartment();
  const themeC = new Compartment();

  // The place the database said was wrong, underlined in red.
  const setError = StateEffect.define<{ from: number; to: number } | null>();
  const errorMark = Decoration.mark({ class: "cm-db-error" });
  const errorField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(setError)) continue;
        const r = e.value;
        deco = r && r.to > r.from && r.to <= tr.state.doc.length ? RangeSet.of([errorMark.range(r.from, r.to)]) : Decoration.none;
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  function runHere(v: EditorView): boolean {
    const { from, to } = v.state.selection.main;
    if (to > from) onrun(v.state.sliceDoc(from, to), from, true);
    else onrun("", from, false);
    return true;
  }

  async function language() {
    const m = await import("@codemirror/lang-sql");
    return m.sql({
      dialect: kind === "postgres" ? m.PostgreSQL : m.MySQL,
      schema: names,
      defaultSchema: defaultSchema ?? undefined,
      defaultTable: defaultTable ?? undefined,
      upperCaseKeywords: true,
    });
  }

  /**
   * What one line needs: Enter submits, a line break never gets in. Its text and
   * its hint are the row's own — the mono `text-meta` of the field's box (below),
   * not the console's size or CodeMirror's own font; the line fills the box inside
   * its border.
   */
  const oneLine = () => [
    placeholderText(placeholder),
    EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
    EditorView.theme({
      ".cm-content": { padding: "0" },
      ".cm-line": { padding: "0 6px" },
      ".cm-scroller": { overflow: "hidden", fontFamily: "inherit", lineHeight: "calc(1.375rem - 2px)" },
      ".cm-placeholder": { color: "var(--color-muted)" },
    }),
    keymap.of([
      ...completionKeymap,
      {
        key: "Enter",
        preventDefault: true,
        run: () => {
          onsubmit?.();
          return true;
        },
      },
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: () => {
          onsubmit?.();
          return true;
        },
      },
    ]),
  ];

  onMount(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        cspNonceExtension(),
        ...(single ? oneLine() : [lineNumbers(), highlightActiveLine()]),
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        autocompletion({ activateOnTyping: settings.editor.autocomplete }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        errorField,
        langC.of([]),
        themeC.of(editorTheme(activeTerminalTheme())),
        EditorView.theme({
          ".cm-db-error": { textDecoration: "underline wavy var(--color-bad)", textUnderlineOffset: "3px" },
        }),
        keymap.of([
          { key: "Mod-Enter", preventDefault: true, run: runHere },
          {
            key: "Mod-Shift-Enter",
            preventDefault: true,
            run: () => {
              onrunAll();
              return true;
            },
          },
          {
            key: "Mod-c",
            run: (v) => {
              const { from, to } = v.state.selection.main;
              if (to > from) void writeClipboard(v.state.sliceDoc(from, to));
              return true;
            },
          },
          {
            key: "Mod-x",
            run: (v) => {
              const { from, to } = v.state.selection.main;
              if (to > from) {
                void writeClipboard(v.state.sliceDoc(from, to));
                v.dispatch({ changes: { from, to, insert: "" } });
              }
              return true;
            },
          },
          {
            key: "Mod-v",
            run: (v) => {
              void readClipboard()
                .then((text) => {
                  if (text) v.dispatch(v.state.replaceSelection(single ? text.replace(/\s*[\r\n]+\s*/g, " ") : text));
                })
                .catch(swallow("db", "the clipboard was not read: nothing was pasted"));
              return true;
            },
          },
        ]),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            onchange(u.state.doc.toString());
            if (errorAt) u.view.dispatch({ effects: setError.of(null) });
          }
        }),
      ],
    });
    view = new EditorView({ state, parent: host });
    const created = view;
    void language()
      .then((ext) => {
        if (view === created) view.dispatch({ effects: langC.reconfigure(ext) });
      })
      .catch(swallow("db", "the SQL grammar did not load: the console has no highlighting or completion"));
    onready?.({
      caret: () => {
        const sel = created.state.selection.main;
        return { from: sel.from, to: sel.to };
      },
      insert: (text: string) => {
        const end = created.state.doc.length;
        const lead = end > 0 && !created.state.sliceDoc(end - 1, end).endsWith("\n") ? "\n\n" : "";
        // At the end, then as a paste: the caret lands after what CodeMirror stored.
        created.dispatch({ selection: { anchor: end } });
        created.dispatch(created.state.replaceSelection(lead + text));
        created.focus();
      },
      focus: () => created.focus(),
    });
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });

  // The catalog arrives after the console opens; the completion follows it.
  $effect(() => {
    void names;
    void defaultSchema;
    const v = untrack(() => view);
    if (!v) return;
    void language()
      .then((ext) => {
        if (view === v) v.dispatch({ effects: langC.reconfigure(ext) });
      })
      .catch(swallow("db", "the SQL grammar did not load: the console has no highlighting or completion"));
  });

  $effect(() => {
    const r = errorAt;
    untrack(() => view)?.dispatch({ effects: setError.of(r) });
  });

  $effect(() => {
    void settings.theme;
    untrack(() => view)?.dispatch({ effects: themeC.reconfigure(editorTheme(activeTerminalTheme())) });
  });

  // Text set from outside (a history entry, "first rows" of a table).
  $effect(() => {
    const next = value;
    const v = untrack(() => view);
    if (v && v.state.doc.toString() !== next) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
  });
</script>

<!-- The file editor's size and box: a size inherited from the page left the gutter measured for another one.
     One line is a field of its row: the height of a list's filter field, the size of the row's text. -->
<div
  class="min-h-0 overflow-hidden [&_.cm-editor]:h-full {single
    ? 'h-[1.375rem] rounded border border-edge bg-panel-alt font-mono text-meta focus-within:border-accent'
    : 'h-full text-sm'}"
  bind:this={host}
  data-testid={single ? "sql-field" : "sql-editor"}
></div>
