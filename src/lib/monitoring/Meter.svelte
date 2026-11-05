<script lang="ts">
  // A share against a known ceiling (v1.33): a track and a fill. The fill moves by
  // `transform`, not width — no layout per frame, and the reduced-motion guard in
  // app.css collapses the transition. Unknown draws an empty track, not a zero bar
  // that would read as a measurement.
  import type { ThresholdLevel } from "./thresholds";
  import { levelFill } from "./monpalette";

  let {
    pct,
    level = "ok",
    color = undefined,
    class: cls = "h-1.5",
    testid = undefined,
  }: {
    pct: number | null;
    level?: ThresholdLevel;
    /** A series colour instead of the level's. */
    color?: string;
    class?: string;
    testid?: string;
  } = $props();

  const k = $derived(pct == null || !Number.isFinite(pct) ? 0 : Math.min(1, Math.max(0, pct / 100)));
</script>

<div class="relative w-full overflow-hidden rounded-full bg-edge {cls}" data-testid={testid} data-pct={pct == null ? "" : Math.round(pct)}>
  <span
    class="absolute inset-0 origin-left transition-transform duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
    style="transform: scaleX({k}); background-color: {color ?? levelFill(level)}"
  ></span>
</div>
