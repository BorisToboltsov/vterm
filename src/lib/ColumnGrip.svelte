<script lang="ts">
  // The draggable border of a table column (v1.1): a strip on the column's right
  // edge that resizes it. It lives in the header cell but reaches down over the
  // rows — `--list-h`, set by the list to its visible height — so a column can be
  // resized from anywhere along its border, not only next to its title. The
  // header is sticky, so the strip stays with the viewport while the rows scroll.
  //
  // The hit zone is wider than the line it shows: 8px to grab, 2px to see.
  // Mouse-only, so it is hidden from the a11y tree (kept out of the column
  // header's name).
  import { resizableHandle } from "./actions/drag";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  let {
    onstart,
    onresize,
    onreset,
    testid,
  }: {
    /** The drag begins — capture the column's width here. */
    onstart: () => void;
    /** Signed distance (px) the border has been dragged from where it started. */
    onresize: (dx: number) => void;
    /** Double click: back to the column's default width. */
    onreset?: () => void;
    testid?: string;
  } = $props();

  let resizing = $state(false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  aria-hidden="true"
  data-testid={testid}
  use:tooltip={t("jsonlog.resizeColumn")}
  class="group/grip absolute -right-1 top-0 z-10 flex h-[var(--list-h,100%)] w-2 cursor-col-resize justify-center"
  ondblclick={() => onreset?.()}
  use:resizableHandle={{
    onStart: () => {
      resizing = true;
      onstart();
    },
    onResize: (dx) => onresize(dx),
    onEnd: () => (resizing = false),
  }}
>
  <span class="h-full w-0.5 group-hover/grip:bg-accent {resizing ? 'bg-accent' : ''}"></span>
</div>
