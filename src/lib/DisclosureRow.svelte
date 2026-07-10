<script lang="ts">
  // Unified collapsible-section header (Phase 15). Two looks:
  //  • default/`inline` — compact leading-chevron row (used by the server-form icon
  //    picker and the AI rows that carry a trailing ⓘ);
  //  • `variant="list"` — the Settings-panel list style (Phase 22.x): hairline
  //    dividers, a brighter medium-weight label and a right-aligned chevron, so the
  //    collapsible sections read clearly as a list.
  import Icon from "./Icon.svelte";
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    label = "",
    labelSnippet = undefined,
    count = null,
    testid = undefined,
    preview = undefined,
    variant = "plain",
    trailing = undefined,
  }: {
    open?: boolean;
    /** Plain-text label. Use `labelSnippet` instead when the label needs markup. */
    label?: string;
    /** Rich label (e.g. coloured inline spans); takes precedence over `label`. */
    labelSnippet?: Snippet;
    count?: number | null;
    testid?: string;
    preview?: Snippet;
    /** "list" = Settings list style (dividers, right chevron); "plain" = compact. */
    variant?: "plain" | "list";
    /** list only: content rendered after the chevron, inside the row's dividers but
     *  outside the toggle button (e.g. an ⓘ hint — a button can't nest a button). */
    trailing?: Snippet;
  } = $props();
</script>

{#if variant === "list"}
  <div class="flex items-center gap-2 border-y border-edge text-xs font-medium text-text">
    <button
      type="button"
      data-testid={testid}
      aria-expanded={open}
      onclick={() => (open = !open)}
      class="group flex min-w-0 flex-1 items-center gap-2 py-2 text-left hover:text-white"
    >
      <span class="truncate">{#if labelSnippet}{@render labelSnippet()}{:else}{label}{/if}</span>
      <span class="ml-auto flex min-w-0 items-center gap-2 font-normal">
        {#if count != null}
          <span class="shrink-0 text-muted">{count}</span>
        {/if}
        {#if preview}
          <span class="flex min-w-0 items-center gap-2 text-white">{@render preview()}</span>
        {/if}
      </span>
      <Icon
        name={open ? "chevronDown" : "chevronRight"}
        size={14}
        class="shrink-0 text-muted group-hover:text-white"
      />
    </button>
    {#if trailing}{@render trailing()}{/if}
  </div>
{:else}
  <button
    type="button"
    data-testid={testid}
    aria-expanded={open}
    onclick={() => (open = !open)}
    class="flex w-full items-center gap-2 rounded text-xs text-muted hover:text-white"
  >
    <Icon name={open ? "chevronDown" : "chevronRight"} size={14} class="shrink-0" />
    <span class="text-left">{#if labelSnippet}{@render labelSnippet()}{:else}{label}{/if}</span>
    {#if count != null}
      <span class="shrink-0 text-muted">{count}</span>
    {/if}
    {#if preview}
      <span class="ml-auto flex min-w-0 items-center gap-2 text-white">{@render preview()}</span>
    {/if}
  </button>
{/if}
