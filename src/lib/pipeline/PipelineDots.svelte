<script lang="ts">
  // A pipeline as a handful of dots (ADR 0070): its jobs in the columns of its
  // schema, coloured by a run when one is known — grey when not. For the rows of
  // the CI panel's lists, where the schema itself does not fit; where it stands
  // is pipedots.ts's.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import { uiPx } from "../settings/settings.svelte";
  import { dotsOf, DOTS } from "./pipedots";
  import type { Pipeline } from "./pipeline";
  import type { RunState } from "./pipeplay";

  let {
    pipeline,
    states = null,
  }: {
    pipeline: Pipeline;
    /** A run's states by job; null — no run known, the shape alone. */
    states?: Record<string, RunState> | null;
  } = $props();

  const FILL: Record<RunState, string> = {
    idle: "fill-muted/40",
    wait: "fill-muted/40",
    run: "fill-accent animate-pulse",
    ok: "fill-ok",
    warn: "fill-warn",
    gate: "fill-warn",
    skip: "fill-edge",
    unknown: "fill-warn/60",
    error: "fill-bad",
    fail: "fill-bad",
  };

  const layout = $derived(dotsOf(pipeline));
  const k = $derived(uiPx(1));
  const label = $derived(
    layout.hidden
      ? t("ci.pipes.dotsHidden", { n: pipeline.jobs.length, hidden: layout.hidden })
      : t("ci.pipes.dots", { n: pipeline.jobs.length }),
  );
</script>

{#if layout.dots.length}
  <span class="inline-flex shrink-0" use:tooltip={label} data-testid="pipe-dots">
    <svg width={layout.width * k} height={layout.height * k} viewBox="0 0 {layout.width} {layout.height}" aria-hidden="true">
      {#each layout.links as l (`${l.from}>${l.to}`)}
        <path d={l.d} class="fill-none stroke-muted/40" stroke-width="0.8" />
      {/each}
      {#each layout.dots as d (d.id)}
        <circle cx={d.x} cy={d.y} r={DOTS.r} class={FILL[states?.[d.id] ?? "idle"]} data-state={states?.[d.id] ?? "idle"} />
      {/each}
    </svg>
  </span>
{/if}
