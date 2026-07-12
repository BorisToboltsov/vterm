<script lang="ts">
  // Signature-theme depth. A subtle, full-window layer painted ON TOP of the whole
  // app (sidebar + terminal + chrome) — pointer-events:none, so clicks/selection
  // pass straight through. Because it sits above the opaque, WebGL-rendered
  // terminal *and* the chrome, both share the same dimensional tint: no seam
  // between the connected terminal and the panels, full readability, and no
  // renderer/perf cost (the terminal stays opaque on WebGL). Classic themes have
  // no `overlay` and render nothing. z-index 30 keeps it below modals/tooltips
  // (z-40+) so those stay crisp and untinted.
  import { settings } from "./settings.svelte";
  import { getTheme } from "./themes";

  const overlay = $derived(
    settings.theme !== "custom" ? getTheme(settings.theme).overlay : undefined,
  );
</script>

{#if overlay}
  <div
    aria-hidden="true"
    data-testid="theme-overlay"
    style="position:fixed;inset:0;pointer-events:none;z-index:30;background:{overlay}"
  ></div>
{/if}
