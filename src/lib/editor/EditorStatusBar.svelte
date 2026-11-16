<script lang="ts">
  // The editor's status bar (ADR 0076): where the cursor is, how the file
  // indents and where that came from, its encoding and line ends (kept on save),
  // wrapping and the minimap, and the language — detected, or set by hand and
  // remembered for the file. What a language server or a schema says about the
  // file sits at its left (`left`).
  import type { Snippet } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import FilterField from "../ui/FilterField.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import type { OpenMenu } from "../ui/ctxmenu";
  import { LANG_CHOICES, type EditorLang, type EditorLangKind } from "./editorlang";
  import type { IndentInfo, IndentSource } from "./indent";

  let {
    line,
    col,
    selections,
    indent,
    indentSource,
    encoding,
    eol,
    lang,
    detected,
    overridden,
    wrap,
    minimap,
    readOnly = false,
    onlang,
    onindent,
    onwrap,
    onminimap,
    left,
  }: {
    line: number;
    col: number;
    selections: number;
    indent: IndentInfo;
    indentSource: IndentSource;
    encoding: string;
    eol: "lf" | "crlf";
    lang: EditorLang;
    /** What the file was detected as — shown in the picker. */
    detected: EditorLang;
    /** The language was set by hand for this file. */
    overridden: boolean;
    wrap: boolean;
    minimap: boolean;
    readOnly?: boolean;
    onlang: (kind: EditorLangKind | null) => void;
    /** A new unit; `convert` — rewrite the file's indentation to it too. */
    onindent: (info: IndentInfo, convert: boolean) => void;
    onwrap: () => void;
    onminimap: () => void;
    left?: Snippet;
  } = $props();

  let menu = $state<OpenMenu | null>(null);
  let picking = $state(false);
  let query = $state("");
  let picker = $state<HTMLDivElement | undefined>();

  // The picker takes the keyboard when it opens and closes on a click outside it.
  $effect(() => {
    if (!picking || !picker) return;
    picker.querySelector("input")?.focus();
    const away = (e: PointerEvent) => {
      const el = e.target as Node;
      if (picker && !picker.contains(el) && !(el as Element).closest?.('[data-testid="editor-status-lang"]')) picking = false;
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });

  const SOURCE_KEY = {
    editorconfig: "editor.status.indentFromEditorconfig",
    file: "editor.status.indentFromFile",
    language: "editor.status.indentFromLanguage",
  } as const;

  const indentLabel = $derived(
    indent.tabs ? t("editor.status.tabs", { n: indent.width }) : t("editor.status.spaces", { n: indent.width }),
  );

  const choices = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? LANG_CHOICES.filter((l) => l.label.toLowerCase().includes(q) || l.kind.includes(q)) : LANG_CHOICES;
  });

  function openIndent(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const use = (info: IndentInfo, convert: boolean) => () => onindent(info, convert);
    const units: IndentInfo[] = [
      { tabs: false, width: 2 },
      { tabs: false, width: 4 },
      { tabs: false, width: 8 },
      { tabs: true, width: 4 },
      { tabs: true, width: 8 },
    ];
    const name = (u: IndentInfo) => (u.tabs ? t("editor.status.tabs", { n: u.width }) : t("editor.status.spaces", { n: u.width }));
    menu = {
      x: r.left,
      y: r.top - 8,
      items: [
        ...units.map((u) => ({
          label: name(u),
          checked: u.tabs === indent.tabs && u.width === indent.width,
          onSelect: use(u, false),
        })),
        { kind: "separator" as const },
        {
          kind: "submenu" as const,
          key: "convert",
          icon: "wrap" as const,
          label: t("editor.status.convertIndent"),
          items: units.map((u) => ({ label: name(u), disabled: readOnly, onSelect: use(u, true) })),
        },
      ],
    };
  }

  function pick(kind: EditorLangKind | null) {
    picking = false;
    query = "";
    onlang(kind);
  }
</script>

<div
  class="relative flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-panel-alt px-2 text-meta text-muted"
  data-testid="editor-status"
>
  {@render left?.()}
  <span class="flex-1"></span>
  <span class="tabular-nums" data-testid="editor-status-pos">
    {t("editor.status.position", { line, col })}{#if selections > 1}&nbsp;· {t("editor.status.selections", { n: selections })}{/if}
  </span>
  <button
    type="button"
    class="hover:text-text"
    data-testid="editor-status-indent"
    use:tooltip={t(SOURCE_KEY[indentSource])}
    onclick={openIndent}
  >{indentLabel}</button>
  <span use:tooltip={t("editor.status.encodingHint")}>{encoding.toUpperCase()}</span>
  <span use:tooltip={t("editor.status.eolHint")}>{eol.toUpperCase()}</span>
  <button
    type="button"
    class="flex items-center hover:text-text {wrap ? 'text-accent' : ''}"
    aria-pressed={wrap}
    aria-label={t("editor.status.wrap")}
    use:tooltip={t("editor.status.wrap")}
    onclick={onwrap}
  ><Icon name="wrap" size={12} /></button>
  <button
    type="button"
    class="flex items-center hover:text-text {minimap ? 'text-accent' : ''}"
    aria-pressed={minimap}
    aria-label={t("editor.status.minimap")}
    use:tooltip={t("editor.status.minimap")}
    data-testid="editor-status-minimap"
    onclick={onminimap}
  ><Icon name="minimap" size={12} /></button>
  <button
    type="button"
    class="flex items-center gap-1 hover:text-text {overridden ? 'text-accent' : ''}"
    data-testid="editor-status-lang"
    use:tooltip={overridden ? t("editor.status.langSet") : t("editor.status.langDetected")}
    onclick={() => (picking = !picking)}
  >{lang.label}{#if lang.jinja}&nbsp;+ Jinja{/if}<Icon name="chevronUp" size={11} /></button>
  {#if picking}
    <div
      bind:this={picker}
      class="absolute bottom-full right-1 z-20 mb-1 flex max-h-80 w-64 flex-col overflow-hidden rounded border border-edge bg-panel-alt shadow-lg"
      data-testid="editor-lang-picker"
    >
      <div class="p-1.5">
        <FilterField
          bind:value={query}
          placeholder={t("editor.status.langSearch")}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === "Escape") picking = false;
            if (e.key === "Enter" && choices[0]) pick(choices[0].kind);
          }}
        />
      </div>
      <div class="min-h-0 flex-1 overflow-auto pb-1">
        {#if overridden}
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-accent hover:bg-edge"
            onclick={() => pick(null)}
          ><Icon name="refresh" size={12} />{t("editor.status.langAuto", { lang: detected.label })}</button>
        {/if}
        {#each choices as l (l.kind)}
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-edge {l.kind === lang.kind ? 'text-text' : 'text-muted'}"
            onclick={() => pick(l.kind)}
          >
            <span class="w-3 shrink-0">{#if l.kind === lang.kind}<Icon name="check" size={11} />{/if}</span>
            <span class="flex-1 truncate">{l.label}</span>
            {#if l.kind === detected.kind}<span class="text-caption text-muted">{t("editor.status.detected")}</span>{/if}
          </button>
        {/each}
      </div>
      <div class="border-t border-edge px-3 py-1 text-caption text-muted">{t("editor.status.langRemembered")}</div>
    </div>
  {/if}
  <ContextMenu {menu} onclose={() => (menu = null)} />
</div>
