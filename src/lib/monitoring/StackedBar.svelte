<script lang="ts">
  // A whole split into parts (v1.33): memory composition, CPU time, TCP states.
  // Every segment stays in the DOM, keyed by its label, and moves by `transform`
  // — a part that drops to zero shrinks away instead of vanishing and shoving its
  // neighbours, and none of it costs layout per frame (the reduced-motion guard
  // in app.css collapses the transition). Pure presentational.
  import { tooltip } from "../actions/tooltip";

  type Segment = { label: string; value: number; color: string; text?: string };

  let {
    segments,
    legend = true,
    class: cls = "",
    height = "h-2.5",
    testid = undefined,
  }: {
    segments: Segment[];
    legend?: boolean;
    class?: string;
    height?: string;
    testid?: string;
  } = $props();

  const total = $derived(Math.max(1e-9, segments.reduce((s, x) => s + Math.max(0, x.value), 0)));
  const placed = $derived.by(() => {
    let at = 0;
    return segments.map((s) => {
      const share = Math.max(0, s.value) / total;
      const out = { ...s, left: at, share };
      at += share;
      return out;
    });
  });
</script>

<div data-testid={testid} class={cls}>
  <div class="relative w-full overflow-hidden rounded-full bg-edge {height}">
    {#each placed as s (s.label)}
      <span
        class="absolute inset-0 origin-left transition-transform duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style="transform: translateX({s.left * 100}%) scaleX({s.share}); background-color: {s.color}"
        data-share={Math.round(s.share * 100)}
        use:tooltip={`${s.label}: ${Math.round(s.share * 100)}%`}
      ></span>
    {/each}
  </div>
  {#if legend}
    <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted">
      {#each segments as s (s.label)}
        <span class="flex items-center gap-1">
          <span class="inline-block h-2 w-2 shrink-0 rounded-[2px]" style="background-color: {s.color}"></span>
          {s.label}
          {#if s.text}<span class="tabular-nums text-text">{s.text}</span>{/if}
        </span>
      {/each}
    </div>
  {/if}
</div>
