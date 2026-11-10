<script lang="ts">
  // The filter field of a list (v1.29, ADR 0050) — the one born in the Git
  // history's filter row: a search glass, the text, «N of M» while the list is
  // narrowed, a cross that clears it; Esc clears it too. Two sizes: a dock's
  // row (22px, `text-meta`) and a window's (28px, `text-sm` — settings,
  // utilities, known hosts). Presentational — the caller owns the text.
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";

  let {
    value = $bindable(""),
    placeholder,
    label = undefined,
    size = "dock",
    shown = null,
    total = null,
    testid = undefined,
    class: cls = "",
    oninput,
    onkeydown,
    children,
  }: {
    value?: string;
    placeholder: string;
    /** The field's accessible name, when it is not the placeholder. */
    label?: string;
    size?: "dock" | "window";
    /** How many items the narrowed list shows, of how many; null — no figure. */
    shown?: number | null;
    total?: number | null;
    testid?: string;
    class?: string;
    oninput?: (value: string) => void;
    /** Keys other than Esc (the Git history commits its query on Enter). */
    onkeydown?: (e: KeyboardEvent) => void;
    /** Switches inside the field, after the figure (the history's `.*` and `Aa`). */
    children?: Snippet;
  } = $props();

  const win = $derived(size === "window");
  let inputEl: HTMLInputElement | undefined;

  export function focus() {
    inputEl?.focus();
  }

  function set(next: string) {
    value = next;
    oninput?.(next);
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape" && value) {
      e.stopPropagation();
      set("");
    }
    onkeydown?.(e);
  }
</script>

<label
  class="flex min-w-0 items-center gap-1 rounded border border-edge bg-panel text-muted focus-within:border-accent {win
    ? 'h-7 px-2 text-sm'
    : 'h-[1.375rem] px-1.5 text-meta'} {cls}"
>
  <Icon name="search" size={win ? 14 : 12} class="shrink-0" />
  <input
    bind:this={inputEl}
    {value}
    oninput={(e) => set(e.currentTarget.value)}
    onkeydown={keydown}
    {placeholder}
    aria-label={label ?? placeholder}
    spellcheck="false"
    class="min-w-0 flex-1 bg-transparent text-text placeholder:text-muted focus:outline-none"
    data-testid={testid}
  />
  {#if shown !== null && total !== null}
    <span class="shrink-0 tabular-nums" data-testid={testid ? `${testid}-count` : undefined}
      >{t("list.shownOf", { shown, total })}</span
    >
  {/if}
  {#if value}
    <button
      type="button"
      class="flex shrink-0 rounded hover:text-text"
      aria-label={t("list.clear")}
      use:tooltip={t("list.clear")}
      onclick={() => set("")}
    >
      <Icon name="close" size={win ? 13 : 11} />
    </button>
  {/if}
  {@render children?.()}
</label>
