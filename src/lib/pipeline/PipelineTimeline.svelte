<script lang="ts">
  // A real run in time (ADR 0069): one row per job — the file's jobs in the
  // order written, a called workflow's jobs under its caller — a bar from start
  // to end, the wait for a runner before it dashed, and the path that decided
  // the run's length lit. Played, the run goes by again, its own times sped up;
  // under "less motion" the play shows the end at once.
  import { onDestroy, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { clock, type Timeline, type TimeRow } from "../ci/cirun";
  import { durationText, STATE_ICON, STATE_TONE, stateText } from "../ci/citext";
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import { reducedMotion } from "../ui/motion";
  import { uiPx } from "../settings/settings.svelte";

  let {
    tl,
    now,
    replay = 0,
    selected = null,
    onpick,
  }: {
    tl: Timeline;
    now: number;
    /** Bumped to play the run again. */
    replay?: number;
    /** The row whose job is picked. */
    selected?: string | null;
    onpick?: (row: TimeRow) => void;
  } = $props();

  /** How long a replay takes, whatever the run's length. */
  const REPLAY_MS = 14_000;
  const LABEL_REM = 13;

  let width = $state(0);
  /** The moment shown: null — now (everything as it is). */
  let at = $state<number | null>(null);
  let raf = 0;

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function play() {
    stop();
    if (reducedMotion()) {
      at = null;
      return;
    }
    const t0 = performance.now();
    const span = tl.end - tl.start;
    const step = (ts: number) => {
      const k = Math.min(1, (ts - t0) / REPLAY_MS);
      at = tl.start + span * k;
      if (k < 1) raf = requestAnimationFrame(step);
      else {
        at = null;
        raf = 0;
      }
    };
    raf = requestAnimationFrame(step);
  }
  $effect(() => {
    if (replay > 0) untrack(play);
  });
  onDestroy(stop);

  const moment = $derived(at ?? now);
  const labelPx = $derived(uiPx(LABEL_REM * 16));
  const barsPx = $derived(Math.max(40, width - labelPx - uiPx(56)));
  const span = $derived(Math.max(1000, tl.end - tl.start));
  const x = (ms: number) => ((ms - tl.start) / span) * barsPx;

  /** Ticks every round step: 10 s … 1 h, about seven of them. */
  const ticks = $derived.by(() => {
    const steps = [10, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
    const step = steps.find((s) => span / s <= 8) ?? 3_600_000;
    const out: number[] = [];
    for (let v = 0; v <= span; v += step) out.push(v);
    return { step, out };
  });
  const tickText = (ms: number) => (ticks.step >= 60_000 ? String(Math.round(ms / 60_000)) : clock(ms));

  /** What a row shows at the moment shown. */
  function seen(r: TimeRow) {
    const started = r.started !== null && r.started <= moment;
    const end = r.finished !== null && r.finished <= moment ? r.finished : null;
    const state = !started ? (r.created !== null && r.created <= moment ? "queued" : null) : end === null ? "running" : r.state;
    return { started, end, state };
  }

  const BAR: Record<string, string> = {
    ok: "bg-ok/45",
    failed: "bg-bad/70",
    running: "bg-accent",
    cancelled: "bg-muted/30",
    skipped: "bg-muted/30",
    neutral: "bg-muted/40",
    waiting: "bg-warn/50",
    manual: "bg-warn/50",
    queued: "bg-muted/30",
  };
</script>

<div class="py-1.5" bind:clientWidth={width} data-testid="pipeline-timeline">
  <div class="relative flex h-4 items-end text-caption tabular-nums text-muted">
    <div style:width={`${labelPx}px`} class="shrink-0"></div>
    <div class="relative flex-1">
      {#each ticks.out as v (v)}
        <span class="absolute -translate-x-1/2" style:left={`${x(tl.start + v)}px`}>{tickText(v)}</span>
      {/each}
      {#if ticks.step >= 60_000}<span class="absolute" style:left={`${barsPx + uiPx(14)}px`}>{t("pipeline.run.min")}</span>{/if}
    </div>
  </div>
  <div class="relative">
    {#each tl.rows as r (r.key)}
      {@const s = seen(r)}
      <button
        type="button"
        class="flex h-[1.375rem] w-full items-center text-left text-xs hover:bg-edge/30 {selected === r.key ? 'bg-edge/40' : ''}"
        data-testid="timeline-row"
        data-critical={r.critical}
        onclick={() => onpick?.(r)}
      >
        <span class="flex shrink-0 items-center gap-1.5 truncate pr-2" style:width={`${labelPx}px`} style:padding-left={r.depth ? "1.75rem" : "0.75rem"}>
          {#if s.state}
            <span use:tooltip={stateText(s.state)}><Icon name={STATE_ICON[s.state]} size={12} class="shrink-0 {STATE_TONE[s.state]} {s.state === 'running' ? 'animate-spin' : ''}" /></span>
          {:else}
            <Icon name="circleDashed" size={12} class="shrink-0 text-muted" />
          {/if}
          <span class="min-w-0 truncate {r.job ? 'text-text' : 'font-medium text-text'}" use:tooltip={r.label}>{r.label}</span>
        </span>
        <span class="relative h-full flex-1">
          {#each ticks.out.slice(1) as v (v)}
            <span class="absolute inset-y-0 border-l border-edge/40" style:left={`${x(tl.start + v)}px`}></span>
          {/each}
          {#if r.job && r.created !== null && moment > r.created}
            {@const qEnd = Math.min(r.started ?? moment, moment)}
            {#if qEnd > r.created}
              <span class="absolute top-1/2 border-t border-dashed border-muted/60" style:left={`${x(r.created)}px`} style:width={`${Math.max(0, x(qEnd) - x(r.created))}px`}></span>
            {/if}
          {/if}
          {#if s.started && r.started !== null}
            {@const until = s.end ?? moment}
            <span
              class="absolute rounded-sm {r.critical && s.end !== null && r.state === 'ok' ? 'bg-ok ring-1 ring-ok/70' : (BAR[s.state ?? 'neutral'] ?? 'bg-muted/40')} {r.job ? 'top-[0.3rem] h-3' : 'top-[0.55rem] h-1'}"
              style:left={`${x(r.started)}px`}
              style:width={`${Math.max(2, x(until) - x(r.started))}px`}
              use:tooltip={`${r.label} — ${durationText(until - r.started)}${r.created !== null && r.started > r.created ? ` · ${t("pipeline.run.queued", { time: durationText(r.started - r.created) })}` : ""}`}
            ></span>
            <span class="absolute top-[0.2rem] whitespace-nowrap text-meta tabular-nums text-muted" style:left={`${x(until) + 6}px`}>
              {s.end === null ? t("pipeline.run.going", { time: durationText(until - r.started) }) : durationText(until - r.started)}
            </span>
          {/if}
        </span>
      </button>
    {/each}
    {#if at !== null}
      <span class="pointer-events-none absolute inset-y-0 border-l border-accent" style:left={`${labelPx + x(at)}px`}></span>
    {/if}
  </div>
  <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge px-3 pt-1.5 text-meta">
    <span><span class="text-muted">{t("pipeline.run.total")}</span> {durationText(tl.end - tl.start)}</span>
    <span><span class="text-muted">{t("pipeline.run.busy")}</span> {durationText(tl.busy)}</span>
    {#if tl.done && tl.path.length}
      <span class="flex min-w-0 items-center gap-1.5" data-testid="timeline-path">
        <span class="inline-block h-2 w-3.5 rounded-sm bg-ok ring-1 ring-ok/70"></span>
        <span class="whitespace-nowrap text-muted">{t("pipeline.run.path")}</span>
        <span class="min-w-0 truncate" use:tooltip={tl.path.map((r) => r.label).join(" → ")}>
          {tl.path.map((r) => (r.finished !== null && r.started !== null && r.finished - r.started >= 60_000 ? `${r.label} ${durationText(r.finished - r.started)}` : r.label)).join(" → ")}
        </span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block w-3.5 border-t border-dashed border-muted/60"></span>
        <span class="whitespace-nowrap text-muted">{t("pipeline.run.waited")}</span> {durationText(tl.waited)}
      </span>
    {:else if !tl.done}
      <span class="text-muted">{t("pipeline.run.pathLater")}</span>
    {/if}
  </div>
</div>
