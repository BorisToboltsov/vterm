<script lang="ts">
  // Loading-placeholder primitive: a pulsing rounded block. Reused wherever a
  // list/area is loading (e.g. SFTP listing) to avoid layout jank. Decorative,
  // so it's hidden from assistive tech.
  let {
    width = "100%",
    height = "0.75rem",
    class: cls = "",
  }: { width?: string; height?: string; class?: string } = $props();
</script>

<span
  class="block animate-pulse rounded bg-edge {cls}"
  style="width: {width}; height: {height}"
  aria-hidden="true"
></span>
