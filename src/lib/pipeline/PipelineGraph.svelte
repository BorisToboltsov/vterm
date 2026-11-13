<script lang="ts">
  // The graph of a pipeline's jobs (ADR 0068): jobs as rows in columns, links as
  // lines that turn with one radius in the gutters — the look of the Git
  // history's lanes. Where things stand is pipelayout.ts's; this draws it, lights
  // the path of the selected job, and shows the playback: a running job spins
  // and fills its bar, a finished one sends a line of `ok` along its links.
  //
  // Jobs move to their new places when the columns change (stages ⇄ needs, a
  // matrix opened); the lines fade out meanwhile and come back where the jobs
  // stand — a path cannot glide in every WebView. Job names come from a file on
  // a server: they are text, never markup.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import { uiPx } from "../settings/settings.svelte";
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import { motionMs, reducedMotion } from "../ui/motion";
  import { downstreamOf, upstreamOf, type Pipeline } from "./pipeline";
  import { layoutPipeline, METRICS, subLines, type GraphMode, type LayoutMetrics } from "./pipelayout";
  import type { RunState } from "./pipeplay";
  import type { Plan } from "./pipesim";

  let {
    pipeline,
    mode,
    open,
    states,
    plan,
    selected,
    stepMs,
    events = [],
    event = null,
    onselect,
    ontoggle,
    ongate,
    onevent,
  }: {
    pipeline: Pipeline;
    mode: GraphMode;
    /** Jobs whose matrix copies are shown. */
    open: ReadonlySet<string>;
    states: Record<string, RunState>;
    plan: Plan | null;
    selected: string | null;
    /** How long a running job's bar takes to fill. */
    stepMs: number;
    /** The events that start the pipeline, drawn on the left and linked to the jobs it starts with. */
    events?: { id: string; label: string }[];
    /** The event played. */
    event?: string | null;
    onevent?: (id: string) => void;
    onselect: (id: string) => void;
    ontoggle: (id: string) => void;
    ongate: (id: string) => void;
  } = $props();

  const ICON: Record<RunState, IconName> = {
    idle: "circle",
    wait: "circleDashed",
    run: "loader",
    ok: "circleCheck",
    warn: "alert",
    gate: "play",
    skip: "circleOff",
    unknown: "help",
    error: "octagon",
  };
  const TONE: Record<RunState, string> = {
    idle: "text-muted",
    wait: "text-muted",
    run: "text-accent",
    ok: "text-ok",
    warn: "text-warn",
    gate: "text-warn",
    skip: "text-muted",
    unknown: "text-warn",
    error: "text-bad",
  };
  const FRAME: Record<RunState, string> = {
    idle: "border-edge bg-panel",
    wait: "border-edge bg-panel",
    run: "border-accent bg-accent/10",
    ok: "border-edge bg-panel",
    warn: "border-warn/50 bg-panel",
    gate: "border-warn bg-panel",
    skip: "border-dashed border-edge bg-transparent opacity-40",
    unknown: "border-dashed border-warn/50 bg-transparent",
    error: "border-bad bg-panel",
  };
  /** How long jobs take to reach their new places. */
  const MOVE_MS = 320;

  let width = $state(0);
  const metrics = $derived.by((): LayoutMetrics => {
    const k = uiPx(1);
    return Object.fromEntries(Object.entries(METRICS).map(([key, v]) => [key, v * k])) as unknown as LayoutMetrics;
  });
  const layout = $derived(
    layoutPipeline(pipeline, { mode, width: Math.max(1, width), open, metrics, events: events.map((e) => e.id) }),
  );
  const up = $derived(selected ? upstreamOf(pipeline, selected) : new Set<string>());
  const down = $derived(selected ? downstreamOf(pipeline, selected) : new Set<string>());

  // Jobs glide only when the columns change, not while the window is resized:
  // the lines would lag behind them.
  let moving = $state(false);
  let edgesShown = $state(true);
  let lastShape = "";
  $effect(() => {
    const shape = `${mode}|${[...open].sort().join(",")}|${pipeline.file}`;
    if (lastShape === "" || lastShape === shape) {
      lastShape = shape;
      return;
    }
    lastShape = shape;
    moving = true;
    edgesShown = false;
    const id = setTimeout(() => {
      moving = false;
      edgesShown = true;
    }, motionMs(MOVE_MS, reducedMotion()));
    return () => clearTimeout(id);
  });

  const done = (s: RunState | undefined) => s === "ok" || s === "warn";
  const started = (s: RunState | undefined) => s === "run" || s === "gate" || done(s);
  const left = (s: RunState | undefined) => s === "skip" || s === "error" || s === "unknown";
  const lit = (from: string, to: string) =>
    !!selected && (((to === selected || up.has(to)) && up.has(from)) || ((from === selected || down.has(from)) && down.has(to)));
  const subState = (s: RunState): RunState => (s === "wait" || s === "gate" ? "idle" : left(s) ? "skip" : s);
</script>

<div bind:clientWidth={width} class="relative min-w-0 overflow-x-auto overflow-y-hidden" style="height: {layout.height}px">
  <div class="relative" style="width: {layout.width}px; height: {layout.height}px">
    {#each layout.columns as col, i (i)}
      {#if col.title}
        <div
          class="absolute truncate text-caption uppercase tracking-wider text-muted"
          style="left: {col.x + 2}px; top: {metrics.top / 4}px; width: {col.w}px"
        >
          {col.title}
        </div>
      {/if}
    {/each}
    <svg
      class="pipe-edges pointer-events-none absolute left-0 top-0 overflow-visible"
      class:hidden-edges={!edgesShown}
      width={layout.width}
      height={layout.height}
      aria-hidden="true"
    >
      {#each layout.edges as e (`${e.from}>${e.to}`)}
        <path
          d={e.d}
          class="pipe-edge"
          class:implicit={e.implicit}
          class:hl={lit(e.from, e.to)}
          class:faint={left(states[e.to]) || left(states[e.from])}
        />
      {/each}
      {#each layout.triggers as tr (`${tr.event}>${tr.to}`)}
        <path d={tr.d} class="pipe-edge trigger" class:hl={tr.event === event} class:faint={tr.event !== event} />
      {/each}
      {#each layout.triggers.filter((tr) => tr.event === event) as tr (`${tr.event}>${tr.to}`)}
        <path d={tr.d} pathLength="1" class="pipe-flow" class:on={started(states[tr.to])} />
      {/each}
      {#each layout.edges as e (`${e.from}>${e.to}`)}
        <path
          d={e.d}
          pathLength="1"
          class="pipe-flow"
          class:on={done(states[e.from]) && started(states[e.to]) && states[e.to] !== "run"}
          class:live={done(states[e.from]) && states[e.to] === "run"}
          class:ready={done(states[e.from]) && states[e.to] === "wait"}
        />
      {/each}
    </svg>
    {#each events as e (e.id)}
      {@const box = layout.events.get(e.id)}
      {#if box}
        <button
          type="button"
          class="absolute truncate rounded-full border px-2 text-meta transition-[border-color,color,background-color,opacity] {e.id === event
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-edge bg-panel text-muted opacity-70 hover:border-accent/60 hover:text-text hover:opacity-100'}"
          style="left: {box.x}px; top: {box.y}px; width: {box.w}px; height: {box.h}px"
          aria-pressed={e.id === event}
          data-testid="pipeline-event"
          use:tooltip={e.label}
          onclick={() => onevent?.(e.id)}
        >
          {e.label}
        </button>
      {/if}
    {/each}
    {#each pipeline.jobs as job (job.id)}
      {@const box = layout.nodes.get(job.id)!}
      {@const s = states[job.id] ?? "idle"}
      {@const v = plan?.jobs.get(job.id)}
      {@const lines = subLines(job, open.has(job.id))}
      <div
        class="absolute left-0 top-0 overflow-hidden rounded-md border {FRAME[s]} {selected === job.id
          ? 'outline outline-1 outline-offset-1 outline-accent'
          : ''} {moving ? 'pipe-moving' : ''} pipe-node"
        style="transform: translate({box.x}px, {box.y}px); width: {box.w}px; height: {box.h}px"
        data-job={job.id}
        data-state={s}
      >
        <div class="relative flex items-center gap-1 pr-1.5" style="height: {metrics.node - 2}px">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2 text-left text-xs text-text"
            aria-pressed={selected === job.id}
            onclick={() => onselect(job.id)}
          >
            <Icon
              name={s === "gate" && v?.gate === "approval" ? "shield" : ICON[s]}
              size={13}
              class="{TONE[s]} {s === 'run' ? 'animate-spin' : ''}"
            />
            <span class="min-w-0 truncate" use:tooltip={job.name}>{job.name}</span>
            {#if job.call && !job.call.pipeline}
              <span class="min-w-0 truncate text-caption text-muted">↳ {job.call.file.split("/").pop()}</span>
            {/if}
          </button>
          <span class="flex shrink-0 items-center gap-1 text-meta text-muted">
            {#if job.matrix?.items && !open.has(job.id) && job.matrix.items.length <= 8 && box.w >= metrics.minColumn * 1.3}
              <span class="flex gap-0.5" aria-hidden="true">
                {#each job.matrix.items as _, i (i)}
                  <span
                    class="h-1.5 w-1.5 rounded-full {s === 'run'
                      ? 'animate-pulse bg-accent'
                      : done(s)
                        ? 'bg-ok'
                        : 'bg-edge'}"
                  ></span>
                {/each}
              </span>
            {/if}
            {#if job.matrix}
              <span>×{job.matrix.items?.length ?? "?"}</span>
            {/if}
            {#if v?.delayed}
              <span use:tooltip={t("pipeline.delayed", { time: v.delayed })}><Icon name="clock" size={12} /></span>
            {/if}
            {#if job.environment && s !== "gate"}
              <span use:tooltip={job.environment}><Icon name="shield" size={12} class="text-warn" /></span>
            {/if}
            {#if v?.allowFailure && s !== "warn"}
              <span use:tooltip={t("pipeline.legend.warn")}><Icon name="alert" size={12} /></span>
            {/if}
          </span>
          {#if job.matrix?.items}
            <button
              type="button"
              class="shrink-0 rounded p-0.5 text-muted hover:text-accent"
              aria-label={open.has(job.id) ? t("pipeline.collapse") : t("pipeline.expand")}
              aria-expanded={open.has(job.id)}
              use:tooltip={open.has(job.id) ? t("pipeline.collapse") : t("pipeline.expand")}
              onclick={() => ontoggle(job.id)}
            >
              <Icon name={open.has(job.id) ? "chevronUp" : "chevronDown"} size={12} />
            </button>
          {/if}
          {#if s === "gate"}
            <button
              type="button"
              class="flex shrink-0 animate-pulse items-center rounded-full bg-warn/15 px-1.5 py-0.5 text-warn hover:bg-warn/25"
              aria-label={v?.gate === "approval" ? t("pipeline.approve") : t("pipeline.runGate")}
              use:tooltip={v?.gate === "approval" ? t("pipeline.approve") : t("pipeline.runGate")}
              onclick={() => ongate(job.id)}
            >
              <Icon name={v?.gate === "approval" ? "check" : "play"} size={11} />
            </button>
          {/if}
          {#if s === "run"}
            <span class="pipe-progress absolute bottom-0 left-0 h-0.5 w-full bg-accent" style="animation-duration: {stepMs}ms"></span>
          {/if}
        </div>
        {#if lines.length}
          <div class="pipe-subs relative pb-1">
            {#each lines as line, i (i)}
              {@const ss = subState(s)}
              <div class="pipe-sub relative flex items-center gap-1.5 truncate pl-6 pr-2 text-meta text-text" style="height: {metrics.sub}px">
                <Icon name={ICON[ss]} size={11} class="{TONE[ss]} {ss === 'run' ? 'animate-spin' : ''}" />
                <span class="min-w-0 truncate" use:tooltip={line}>{line}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  /* The lines: a quiet mix of the theme's muted text and edges; the selected
     job's path in the accent; a playback's finished links in `ok`. */
  .pipe-edges {
    transition: opacity 0.18s;
  }
  .pipe-edges.hidden-edges {
    opacity: 0;
  }
  .pipe-edge {
    fill: none;
    stroke: color-mix(in srgb, var(--color-muted) 45%, var(--color-edge));
    stroke-width: 1.6;
    transition: stroke 0.3s, opacity 0.3s;
  }
  .pipe-edge.implicit,
  .pipe-edge.faint:not(.trigger) {
    stroke-dasharray: 3 4;
  }
  .pipe-edge.faint {
    opacity: 0.35;
  }
  .pipe-edge.hl {
    stroke: var(--color-accent);
  }
  .pipe-flow {
    fill: none;
    stroke: var(--color-ok);
    stroke-width: 1.9;
    stroke-dasharray: 1 1;
    stroke-dashoffset: 1;
    transition: stroke-dashoffset 0.55s ease-out;
  }
  .pipe-flow.on,
  .pipe-flow.ready {
    stroke-dashoffset: 0;
  }
  .pipe-flow.live {
    stroke-dashoffset: 0;
    stroke-dasharray: 0.03 0.025;
    animation: pipe-flow 0.7s linear infinite;
  }
  @keyframes pipe-flow {
    to {
      stroke-dashoffset: -0.055;
    }
  }
  .pipe-node {
    transition: border-color 0.3s, background-color 0.3s, opacity 0.35s;
  }
  .pipe-node.pipe-moving {
    transition: transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1), height 0.32s cubic-bezier(0.2, 0.8, 0.2, 1), width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.3s, background-color 0.3s, opacity 0.35s;
  }
  .pipe-progress {
    transform-origin: left;
    animation-name: pipe-progress;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
  @keyframes pipe-progress {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
  /* The rail of the lines under a job: one line down, a tick to each. */
  .pipe-subs::before {
    content: "";
    position: absolute;
    left: 0.75rem;
    top: -0.375rem;
    bottom: 0.9rem;
    width: 1.5px;
    background: color-mix(in srgb, var(--color-muted) 45%, var(--color-edge));
  }
  .pipe-sub::before {
    content: "";
    position: absolute;
    left: 0.75rem;
    top: 50%;
    width: 0.4rem;
    height: 1.5px;
    background: color-mix(in srgb, var(--color-muted) 45%, var(--color-edge));
  }
</style>
