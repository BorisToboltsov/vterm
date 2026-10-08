<script lang="ts">
  // The border between the two parts of a wide tool panel (v1.10.1): Git's
  // changes and history, a Docker or k8s list and what is opened beside it.
  // Dragging it gives one part room at the other's expense; so do the arrow keys
  // once it has focus (Home/End go to the limits, Enter and a double-click put
  // it back where the panel starts).
  //
  // The same shape as the divider between the centre's panes: a 1px line with a
  // wider invisible strip over it to grab. Unlike that one it stands in the
  // panel's own row — and inside the panel's query container, so it brings no
  // `fixed` element with it (`panelcontainer.guard`): the pointer is captured,
  // and the cursor stays with the strip.
  import { resizableHandle } from "./actions/drag";
  import { nudgedShare, shareAt, shareRange, type PanelSplit } from "./panelsplit";
  import { drawnShare, resetPanelShare, setPanelShare } from "./stores/panelsplit.svelte";
  import { t } from "./i18n";

  let {
    split,
    width,
  }: {
    split: PanelSplit;
    /** Width of the row the two parts share, px. */
    width: number;
  } = $props();

  /** One arrow press, px. */
  const STEP = 24;

  const share = $derived(drawnShare(split, width));
  const range = $derived(shareRange(width));
  const pct = (r: number): number => Math.round(r * 100);

  let resizing = $state(false);
  // Where the border stood when the drag began, px: the deltas are measured
  // from there, so a part at its minimum does not make the border drift from
  // the pointer.
  let origin = 0;

  function onKey(e: KeyboardEvent) {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = nudgedShare(share, width, -STEP);
    else if (e.key === "ArrowRight") next = nudgedShare(share, width, STEP);
    else if (e.key === "Home") next = range.min;
    else if (e.key === "End") next = range.max;
    else if (e.key === "Enter") {
      e.preventDefault();
      resetPanelShare(split);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setPanelShare(split, next);
  }
</script>

<!-- A focusable separator is a widget (ARIA: it has a value and takes the arrow
     keys); the linter only knows the static, non-interactive kind. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-orientation="vertical"
  aria-label={t("panel.resizeParts")}
  aria-valuenow={pct(share)}
  aria-valuemin={pct(range.min)}
  aria-valuemax={pct(range.max)}
  data-testid="panel-divider"
  data-split={split}
  class="relative z-10 w-px shrink-0 touch-none self-stretch bg-edge"
  onkeydown={onKey}
  ondblclick={() => resetPanelShare(split)}
  use:resizableHandle={{
    onStart: () => {
      resizing = true;
      origin = share * width;
    },
    onResize: (dx) => setPanelShare(split, shareAt(width, origin + dx)),
    onEnd: () => (resizing = false),
  }}
>
  <span
    class="absolute -inset-x-0.5 inset-y-0 cursor-col-resize hover:bg-accent {resizing
      ? 'bg-accent'
      : 'bg-transparent'}"
  ></span>
</div>
