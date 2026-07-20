<script lang="ts">
  // Renders a line-icon from the central registry (src/lib/icons.ts).
  // Inherits colour via `currentColor`; size and extra classes are props.
  import { ICONS, type IconName } from "./icons";

  let {
    name,
    size = 16,
    class: cls = "",
    title,
  }: { name: IconName; size?: number; class?: string; title?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="inline-block shrink-0 {cls}"
  role={title ? "img" : "presentation"}
  aria-label={title}
  aria-hidden={title ? undefined : "true"}
>
  {#if title}<title>{title}</title>{/if}
  <!-- Static, trusted markup from the ICONS registry — never user input, so this
       is the one {@html} sink that needs no link interception (mdlink.guard). -->
  {@html ICONS[name]}
</svg>
