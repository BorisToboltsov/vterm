<script lang="ts">
  // Renders a line-icon from the central registry (src/lib/ui/icons.ts).
  // Inherits colour via `currentColor`; size and extra classes are props. `size` is
  // px at 100 %: drawn in rem, so a glyph grows with the text next to it (ADR 0049).
  import { ICONS, type IconName } from "./icons";
  import { REM_PX } from "../appearance/uiscale";

  let {
    name,
    size = 16,
    class: cls = "",
    title,
    strokeWidth = 1.8,
  }: {
    name: IconName;
    size?: number;
    class?: string;
    title?: string;
    /** Line weight; the registry is drawn for the default. Raise it only where a
     *  glyph made of dots (the «⋯» overflow) would otherwise read as specks. */
    strokeWidth?: number;
  } = $props();
</script>

<svg
  width={size}
  height={size}
  style:width="{size / REM_PX}rem"
  style:height="{size / REM_PX}rem"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class="inline-block shrink-0 {cls}"
  role={title ? "img" : "presentation"}
  aria-label={title}
  aria-hidden={title ? undefined : "true"}
>
  {#if title}<title>{title}</title>{/if}
  <!-- eslint-disable-next-line vterm/md-links -- static markup from the ICONS registry, never user input -->
  {@html ICONS[name]}
</svg>
