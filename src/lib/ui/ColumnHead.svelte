<script lang="ts">
  // Header cell of a resizable list column (v1.1): the column's title and, on its
  // right edge, the border that is dragged to resize it (ColumnGrip). The width
  // itself is a CSS variable the list sets from the store, read by this cell and
  // by every row alike — so the cell only reports the drag, it does not size
  // anything.
  //
  // A column the list can be ordered by has a title that is a button (v1.17,
  // `SortTitle`): the click orders, the border still resizes.
  import ColumnGrip from "./ColumnGrip.svelte";
  import SortTitle from "./SortTitle.svelte";
  import { resizedWidth, type ListColumn } from "./colwidths";
  import { columnWidth, resetColumnWidth, setColumnWidth } from "../stores/colwidths.svelte";

  let {
    col,
    label,
    class: cls = "",
    sorted = null,
    onsort,
  }: {
    col: ListColumn;
    label: string;
    /** The list is ordered by this column, this way; null — by another one. */
    sorted?: "asc" | "desc" | null;
    /** Order the list by this column. Without it the title is plain text. */
    onsort?: () => void;
    /** Width and horizontal padding — the same classes the column's row cells use,
     *  so the header and the rows shrink identically when the list is tight. */
    class?: string;
  } = $props();

  let startWidth = 0;
</script>

<!-- Not clipped itself — the grip overflows it downwards, over the rows; the
     title is what truncates. -->
<div
  data-testid={`column-${col}`}
  class="relative min-w-0 border-r border-edge py-1 {cls}"
>
  {#if onsort}
    <SortTitle {label} {sorted} {onsort} testid={`column-sort-${col}`} />
  {:else}
    <span class="block truncate">{label}</span>
  {/if}
  <ColumnGrip
    testid={`column-grip-${col}`}
    onstart={() => (startWidth = columnWidth(col))}
    onresize={(dx) => setColumnWidth(col, resizedWidth(startWidth, dx))}
    onreset={() => resetColumnWidth(col)}
  />
</div>
