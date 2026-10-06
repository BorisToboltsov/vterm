<script lang="ts">
  // The line between the two halves of a split in the centre (v1.2). Dragging it
  // resizes them; so do the arrow keys once it has focus (Home/End go to the
  // limits, Enter and a double-click set the halves equal).
  //
  // The line itself is 1px — the gap the layout model leaves between panes — with
  // a wider invisible strip over it to grab, the same shape as a dock's resize
  // handle. What a drag or a key may set comes from the model (`Divider.min/max`),
  // so neither half goes under the pane minimum.
  import { resizableHandle } from "./actions/drag";
  import { rectStyle } from "./centerview";
  import { nudgedRatio, ratioAt, type Divider } from "./splitlayout";
  import { t } from "./i18n";

  let {
    divider,
    bounds,
    onratio,
  }: {
    divider: Divider;
    /** The area the divider's rectangle was computed for. */
    bounds: { width: number; height: number };
    onratio: (ratio: number) => void;
  } = $props();

  /** One arrow press, px. */
  const STEP = 24;

  const row = $derived(divider.dir === "row");
  const pct = (r: number): number => Math.round(r * 100);

  let resizing = $state(false);
  // The divider as it stood when the drag began: the deltas are measured from
  // there, so a pane hitting its minimum does not make the handle drift from
  // the pointer.
  let origin: Divider | null = null;

  function onResize(dx: number, dy: number) {
    if (!origin) return;
    const at = origin.start + origin.ratio * origin.avail + (origin.dir === "row" ? dx : dy);
    onratio(ratioAt(origin, at));
  }

  function onKey(e: KeyboardEvent) {
    let next: number | null = null;
    if (e.key === (row ? "ArrowLeft" : "ArrowUp")) next = nudgedRatio(divider, -STEP);
    else if (e.key === (row ? "ArrowRight" : "ArrowDown")) next = nudgedRatio(divider, STEP);
    else if (e.key === "Home") next = divider.min;
    else if (e.key === "End") next = divider.max;
    else if (e.key === "Enter") next = ratioAt(divider, divider.start + divider.avail / 2);
    if (next === null) return;
    e.preventDefault();
    onratio(next);
  }
</script>

<!-- A focusable separator is a widget (ARIA: it has a value and takes the arrow
     keys); the linter only knows the static, non-interactive kind. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-orientation={row ? "vertical" : "horizontal"}
  aria-label={t("split.resize")}
  aria-valuenow={pct(divider.ratio)}
  aria-valuemin={pct(divider.min)}
  aria-valuemax={pct(divider.max)}
  data-testid="split-divider"
  data-split={divider.split}
  class="absolute z-10 touch-none bg-edge"
  style={rectStyle(divider.rect, bounds)}
  onkeydown={onKey}
  ondblclick={() => onratio(ratioAt(divider, divider.start + divider.avail / 2))}
  use:resizableHandle={{
    onStart: () => {
      resizing = true;
      origin = divider;
    },
    onResize,
    onEnd: () => {
      resizing = false;
      origin = null;
    },
  }}
>
  <span
    class="absolute hover:bg-accent {resizing ? 'bg-accent' : 'bg-transparent'} {row
      ? '-inset-x-0.5 inset-y-0 cursor-col-resize'
      : 'inset-x-0 -inset-y-0.5 cursor-row-resize'}"
  ></span>
</div>

<!-- While resizing: keep the resize cursor and suppress text selection. -->
{#if resizing}
  <div class="fixed inset-0 z-50 select-none {row ? 'cursor-col-resize' : 'cursor-row-resize'}"></div>
{/if}
