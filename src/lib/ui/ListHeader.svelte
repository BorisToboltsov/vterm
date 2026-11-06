<script lang="ts" generics="T">
  // The header row of a list (v1.29, ADR 0050), as the Git history's filter row
  // has it: the filter field; the facets — in a wide panel buttons that say their
  // value, in a narrow one a funnel with how many are picked; the reset; the
  // «View» menu (eye) with the grouping, the order and the list's own switches.
  // What the list is narrowed to and how it lies are the caller's; the model is
  // `listview.ts`.
  //
  // The menus are not drawn here: the Docker, k8s and file panels are query
  // containers, and a `fixed` menu inside one is placed against the container,
  // not the window (`panelcontainer.guard`). The header hands the open menu to
  // its panel, which shows it where it shows its rows' menus.
  import type { Snippet } from "svelte";
  import FilterField from "./FilterField.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { listMenuText, type ListLabels } from "./listtext";
  import {
    activeFacets,
    clearFacets,
    facetLabel,
    facetMenu,
    facetValueMenu,
    isFiltered,
    viewMenu,
    type ListFilter,
    type ListOrder,
    type ListSchema,
  } from "./listview";

  let {
    items,
    schema,
    filter,
    onfilter,
    order = null,
    onorder = () => {},
    shown,
    total,
    labels = {},
    placeholder,
    wide,
    onmenu,
    fold = undefined,
    extra = [],
    testid = "list-header",
    children,
  }: {
    /** Every item, unfiltered — the facets count their values over it. */
    items: readonly T[];
    schema: ListSchema<T>;
    filter: ListFilter;
    onfilter: (next: ListFilter) => void;
    /** How the list lies; null — it has no order or grouping to pick. */
    order?: ListOrder | null;
    onorder?: (next: ListOrder) => void;
    shown: number;
    total: number;
    labels?: ListLabels;
    placeholder: string;
    /** The panel's one width threshold (`wideWhen`). */
    wide: boolean;
    onmenu: (menu: OpenMenu) => void;
    /** Fold (true) or unfold every group — offered while the list is grouped. */
    fold?: (collapsed: boolean) => void;
    /** The list's own rows of the «View» menu (tags, hidden files, columns). */
    extra?: MenuItem[];
    testid?: string;
    /** Before the eye: the list's own buttons (the log view's «Clear»). */
    children?: Snippet;
  } = $props();

  const text = $derived(listMenuText(labels));
  const facets = $derived(schema.facets ?? []);
  const picked = $derived(activeFacets(filter).length);
  const narrowed = $derived(isFiltered(filter));
  const view = $derived(order ? viewMenu(schema, order, text, { order: onorder, fold }, extra) : extra);

  function open(e: MouseEvent, menu: MenuItem[]) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onmenu({ x: box.left, y: box.bottom + 2, items: menu });
  }
</script>

<div
  class="flex min-w-0 shrink-0 items-center gap-1 border-b border-edge px-2 py-1 text-meta text-muted"
  data-testid={testid}
  data-morph
>
  <FilterField
    value={filter.text}
    oninput={(value) => onfilter({ ...filter, text: value })}
    {placeholder}
    shown={narrowed ? shown : null}
    total={narrowed ? total : null}
    class="flex-1 {wide ? 'max-w-72' : ''}"
    testid="{testid}-field"
  />
  {#if wide}
    {#each facets as f (f.id)}
      <button
        type="button"
        class="flex min-w-0 max-w-40 shrink items-center gap-0.5 rounded px-1 py-0.5 hover:bg-edge hover:text-text {(
          filter.facets[f.id] ?? []
        ).length > 0
          ? 'text-accent'
          : ''}"
        aria-haspopup="menu"
        data-testid="{testid}-facet-{f.id}"
        onclick={(e) => open(e, facetValueMenu(items, schema, filter, f.id, text, onfilter))}
      >
        <span class="min-w-0 truncate">{facetLabel(schema, filter, f.id, text)}</span>
        <Icon name="chevronDown" size={10} class="shrink-0" />
      </button>
    {/each}
    {#if picked > 0}
      <button
        type="button"
        class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text"
        aria-label={t("list.reset")}
        use:tooltip={t("list.reset")}
        data-testid="{testid}-reset"
        onclick={() => onfilter(clearFacets(filter))}
      >
        <Icon name="close" size={12} />
      </button>
    {/if}
    <span class="flex-1"></span>
  {:else if facets.length > 0}
    <button
      type="button"
      class="flex shrink-0 items-center gap-0.5 rounded p-1 hover:bg-edge hover:text-text {picked > 0
        ? 'text-accent'
        : ''}"
      aria-label={t("list.filters")}
      aria-haspopup="menu"
      use:tooltip={t("list.filters")}
      data-testid="{testid}-funnel"
      onclick={(e) => open(e, facetMenu(items, schema, filter, text, onfilter))}
    >
      <Icon name="filter" size={13} />
      {#if picked > 0}<span class="text-caption tabular-nums">{picked}</span>{/if}
    </button>
  {/if}
  {@render children?.()}
  {#if view.length > 0}
    <button
      type="button"
      class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text"
      aria-label={t("list.view")}
      aria-haspopup="menu"
      use:tooltip={t("list.view")}
      data-testid="{testid}-view"
      onclick={(e) => open(e, view)}
    >
      <Icon name="eye" size={13} />
    </button>
  {/if}
</div>
