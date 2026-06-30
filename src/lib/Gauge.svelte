<script lang="ts">
  // Radial gauge for a bounded metric (CPU/RAM/disk %, temperature). A donut
  // ring fills clockwise from the top; the ring colour follows the threshold
  // level (ok → accent, warn → amber, crit → danger). Pure presentational —
  // the parent maps a value to `fill` (0–100) and supplies the centred `text`.
  // Phase 13.1: KPI tiles. Richer chart primitives land in 13.2.
  import type { ThresholdLevel } from "./thresholds";

  let {
    fill,
    text = "",
    level = "ok",
    size = 56,
    testid,
  }: {
    /** Ring fill 0–100, or null when the value is unknown (no arc drawn). */
    fill: number | null;
    /** Centred label, e.g. "42%" or "55°". */
    text?: string;
    level?: ThresholdLevel;
    size?: number;
    testid?: string;
  } = $props();

  const R = 20;
  const C = 2 * Math.PI * R;
  const pct = $derived(fill == null ? 0 : Math.min(100, Math.max(0, fill)));
  const arc = $derived((pct / 100) * C);
  const stroke = $derived(
    level === "crit"
      ? "var(--color-danger)"
      : level === "warn"
        ? "var(--color-warn)"
        : "var(--color-accent)",
  );
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 48 48"
  role="img"
  aria-label={text}
  data-testid={testid}
  class="shrink-0"
>
  <circle cx="24" cy="24" r={R} fill="none" stroke="var(--color-edge)" stroke-width="5" />
  {#if fill != null}
    <circle
      cx="24"
      cy="24"
      r={R}
      fill="none"
      stroke={stroke}
      stroke-width="5"
      stroke-linecap="round"
      stroke-dasharray="{arc} {C - arc}"
      transform="rotate(-90 24 24)"
    />
  {/if}
  <text
    x="24"
    y="24"
    text-anchor="middle"
    dominant-baseline="central"
    fill="var(--color-text)"
    font-size="11"
    class="tabular-nums">{text}</text
  >
</svg>
