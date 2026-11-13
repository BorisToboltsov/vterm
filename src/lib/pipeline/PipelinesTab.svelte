<script lang="ts">
  // The pipelines of a group of files (ADR 0068): every workflow of a folder or
  // a repository on one map — the events on the left, the pipelines they start,
  // the ones only called on the right, calls dashed. An event is played across
  // the map: the lines from it light up, each pipeline it starts runs its jobs
  // wave by wave, a call lights the pipeline it calls. A pipeline clicked shows
  // its own graph; the file opens in the editor.
  import { onDestroy } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { connectionFiles } from "../api";
  import { diag, swallow } from "../api/diag";
  import { t } from "../i18n";
  import { settings, uiPx } from "../settings/settings.svelte";
  import type { EditorDoc } from "../stores/workspaces.svelte";
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import { reducedMotion } from "../ui/motion";
  import PipelineView from "./PipelineView.svelte";
  import { cardLines, layoutMap } from "./pipelayout";
  import { loadGroup, type PipelineGroup } from "./pipeload";
  import { buildMap, eventKey, mapPlans, startedBy, type MapCard } from "./pipemap";
  import { finishJobs, nextWave, playbackPhase, startPlayback, type Playback, type RunState } from "./pipeplay";
  import { planFor, type Plan } from "./pipesim";
  import { pipelineEventText } from "./pipetext";
  import { loadYaml } from "./yamldoc";

  let {
    sessionId,
    doc,
    onOpenFile,
  }: {
    sessionId: string;
    doc: EditorDoc;
    /** Open a pipeline's file in the editor, on a line. */
    onOpenFile?: (path: string, line?: number) => void;
  } = $props();

  const STEP_MS = 520;
  const reader = $derived(connectionFiles(doc.source === "sftp" ? sessionId : null, settings.sftp.maxOpenMb * 1024 * 1024));

  let group = $state.raw<PipelineGroup | null>(null);
  let failed = $state<string | null>(null);
  let drill = $state<string | null>(null);

  async function read() {
    group = null;
    failed = null;
    try {
      const Y = await loadYaml();
      const next = await loadGroup(Y, reader, doc.pipelines?.targets ?? []);
      for (const f of next.failed) diag.warn("editor", "a pipeline of the group could not be read: the map is drawn without it", { path: f.path });
      group = next;
    } catch (e) {
      failed = String(e);
      swallow("editor", "the pipelines were not read: the map is not drawn", "warn")(e);
    }
  }
  void read();

  const map = $derived(group ? buildMap(group.pipelines) : null);
  let eventAt = $state(0);
  const event = $derived(map?.events[Math.min(eventAt, Math.max(0, map.events.length - 1))] ?? null);
  const plans = $derived(map && event ? mapPlans(map, event) : new Map<string, Plan>());
  const starts = $derived(map && event ? startedBy(map, event) : []);
  const kind = $derived(group?.pipelines.every((p) => p.kind === "gitlab") ? "gitlab" : "github");

  let width = $state(600);
  const layout = $derived(
    map && event
      ? layoutMap({
          cards: map.cards.map((c) => ({ id: c.id, called: c.called, lines: cardLines(c.pipeline.jobs.map((j) => j.name + (j.call ? " ↗" : "")), c.called) })),
          events: map.events.map((e) => ({ id: eventKey(e), to: map.cards.filter((c) => !c.called && planCreated(c, e)).map((c) => c.id) })),
          calls: map.calls,
          width,
          scale: uiPx(1),
        })
      : null,
  );
  function planCreated(card: MapCard, e: typeof event): boolean {
    if (!map || !e) return false;
    return mapPlans({ ...map, cards: [card] }, e).get(card.id)?.created !== false;
  }

  // ── Playing an event across the map ───────────────────────────────────────
  let runs = $state.raw<Record<string, Playback>>({});
  let lit = $state.raw<ReadonlySet<string>>(new Set());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function after(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }
  function stop() {
    timers.forEach(clearTimeout);
    timers.clear();
    runs = {};
    lit = new Set();
  }
  onDestroy(stop);
  const step = () => (reducedMotion() ? 120 : STEP_MS);
  const light = (key: string) => (lit = new Set([...lit, key]));

  /** Play one card; `called` — started by another pipeline (a call, `workflow_run`), not by the event. */
  function runCard(id: string, called = false) {
    const card = map?.cards.find((c) => c.id === id);
    const plan = called && card && event ? planFor(card.pipeline, event, true) : plans.get(id);
    if (!card || !plan || plan.created === false || runs[id]) return;
    runs = { ...runs, [id]: startPlayback(plan) };
    const wave = () => {
      const pb = runs[id];
      if (!pb) return;
      const next = nextWave(card.pipeline, plan, pb);
      runs = { ...runs, [id]: next.pb };
      for (const jobId of next.started) {
        const callee = card.pipeline.jobs.find((j) => j.id === jobId)?.call?.pipeline?.file;
        if (callee && map?.cards.some((c) => c.id === callee)) {
          light(`${id}|${callee}`);
          after(() => runCard(callee, true), 300);
        }
      }
      if (!next.started.length) {
        if (playbackPhase(next.pb) === "done") {
          for (const call of map?.calls.filter((c) => c.after && c.from === id) ?? []) {
            light(`${call.from}|${call.to}`);
            after(() => runCard(call.to, true), 300);
          }
        }
        return;
      }
      after(() => {
        const cur = runs[id];
        if (cur) runs = { ...runs, [id]: finishJobs(plan, cur, next.started) };
        after(wave, 120);
      }, step());
    };
    after(wave, 200);
  }

  function play() {
    if (!event) return;
    stop();
    starts.forEach((id, i) => {
      after(() => {
        light(`ev:${eventKey(event)}|${id}`);
        after(() => runCard(id), 450);
      }, 200 + i * 120);
    });
  }
  function pickEvent(i: number) {
    eventAt = i;
    drill = null;
    play();
  }

  const CARD_ICON: Record<"idle" | "run" | "ok" | "wait" | "skip" | "unknown", [IconName, string]> = {
    idle: ["circle", "text-muted"],
    run: ["loader", "text-accent animate-spin"],
    ok: ["circleCheck", "text-ok"],
    wait: ["play", "text-warn"],
    skip: ["circleOff", "text-muted"],
    unknown: ["help", "text-warn"],
  };
  function cardState(id: string): keyof typeof CARD_ICON {
    const pb = runs[id];
    if (pb) {
      const phase = playbackPhase(pb);
      return phase === "done" ? "ok" : phase === "waiting" ? "wait" : "run";
    }
    const plan = plans.get(id);
    if (!plan) return "idle";
    // A called pipeline, or one that starts after another, waits for it: the event does not leave it out.
    if (map?.cards.find((c) => c.id === id)?.called || afterOf(id)) return "idle";
    return plan.created === false ? "skip" : plan.created === "?" ? "unknown" : "idle";
  }
  const JOB_ICON: Record<RunState, [IconName, string]> = {
    idle: ["circle", "text-muted"],
    wait: ["circleDashed", "text-muted"],
    run: ["loader", "text-accent animate-spin"],
    ok: ["circleCheck", "text-ok"],
    warn: ["alert", "text-warn"],
    gate: ["play", "text-warn"],
    skip: ["circleOff", "text-muted"],
    unknown: ["help", "text-warn"],
    error: ["octagon", "text-bad"],
  };
  function jobState(cardId: string, jobId: string): RunState {
    const pb = runs[cardId];
    if (pb) return pb.states[jobId] ?? "idle";
    const v = plans.get(cardId)?.jobs.get(jobId);
    if (!v) return "idle";
    return v.error ? "error" : v.run === true ? "idle" : v.run === "?" ? "unknown" : "skip";
  }
  /** The pipeline whose end starts this one (`workflow_run`), if any. */
  const afterOf = (id: string): string | null => {
    const call = map?.calls.find((c) => c.after && c.to === id);
    return call ? (map?.cards.find((c) => c.id === call.from)?.pipeline.name ?? null) : null;
  };
  const names = (ids: string[]) => ids.map((id) => map?.cards.find((c) => c.id === id)?.pipeline.name ?? id).join(", ");
  const unsure = $derived(map && event ? map.cards.filter((c) => !c.called && plans.get(c.id)?.created === "?").map((c) => c.id) : []);
  const sure = $derived(starts.filter((id) => !unsure.includes(id)));
  const drilled = $derived(drill && map ? (map.cards.find((c) => c.id === drill) ?? null) : null);
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="pipelines-tab">
  <div class="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1 text-xs">
    <Icon name="hierarchy" size={13} class="text-muted" />
    {#if drilled}
      <button type="button" class="text-accent hover:text-accent-hover" onclick={() => (drill = null)}>{t("pipeline.group.back")}</button>
      <span class="text-muted">›</span>
      <span class="truncate">{drilled.pipeline.name}</span>
      <button
        type="button"
        class="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-muted hover:bg-edge hover:text-text"
        onclick={() => drilled && onOpenFile?.(drilled.id)}
      >
        <Icon name="file" size={13} />
        {t("pipeline.group.open")}
      </button>
    {:else}
      <span>{t("pipeline.group.title")}</span>
      <span class="min-w-0 truncate text-muted" use:tooltip={doc.path}>· {doc.path}</span>
      {#if group}<span class="shrink-0 text-muted">· {t("pipeline.group.count", { n: group.pipelines.length })}</span>{/if}
      <button
        type="button"
        class="ml-auto rounded p-1 text-muted hover:bg-edge hover:text-text"
        aria-label={t("pipeline.group.reload")}
        use:tooltip={t("pipeline.group.reload")}
        onclick={() => {
          stop();
          void read();
        }}
      >
        <Icon name="refresh" size={13} />
      </button>
    {/if}
  </div>

  {#if drilled}
    <div class="min-h-0 flex-1">
      <PipelineView
        path={drilled.id}
        text=""
        readyPipeline={drilled.pipeline}
        reader={reader}
        {sessionId}
        onjump={(file, line) => onOpenFile?.(file, line)}
      />
    </div>
  {:else if !group || !map}
    <div class="flex flex-1 items-center justify-center p-4 text-xs text-muted">{failed ?? t("pipeline.loading")}</div>
  {:else if map.cards.length === 0}
    <div class="flex flex-1 items-center justify-center p-4 text-xs text-muted">{t("pipeline.group.none")}</div>
  {:else}
    <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-edge bg-panel-alt px-2 py-1 text-meta">
      <span class="text-muted">{t("pipeline.if")}</span>
      {#each map.events as e, i (eventKey(e))}
        <button
          type="button"
          class="rounded-full border px-2 py-0.5 transition-colors {i === eventAt
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-edge text-muted hover:border-accent/60 hover:text-text'}"
          aria-pressed={i === eventAt}
          onclick={() => pickEvent(i)}
        >
          {pipelineEventText(kind, e)}
        </button>
      {/each}
      <button
        type="button"
        class="ml-auto flex items-center gap-1 rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
        use:tooltip={t("pipeline.playHint")}
        onclick={play}
      >
        <Icon name="play" size={12} />
        {t("pipeline.play")}
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto bg-panel-alt/40" bind:clientWidth={width}>
      {#if layout && event}
        <div class="relative" style="width: {layout.width}px; height: {layout.height}px">
          <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="pipe-map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M1 1L8 5L1 9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" />
              </marker>
            </defs>
            {#each layout.links as l (l.key)}
              <path
                d={l.d}
                class="map-link"
                class:call={l.call}
                class:dim={!l.call && !l.key.startsWith(`ev:${eventKey(event)}|`)}
                marker-end={l.call ? "url(#pipe-map-arrow)" : undefined}
              />
            {/each}
            {#each layout.links as l (l.key)}
              <path d={l.d} pathLength="1" class="map-flow" class:on={lit.has(l.key)} />
            {/each}
          </svg>
          {#each map.events as e, i (eventKey(e))}
            {@const box = layout.events.get(eventKey(e))}
            {#if box}
              <button
                type="button"
                class="absolute truncate rounded-full border px-2 text-center text-meta transition-colors {i === eventAt
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-edge bg-panel text-muted opacity-60 hover:opacity-100'}"
                style="left: {box.x}px; top: {box.y}px; width: {box.w}px; height: {box.h}px"
                use:tooltip={pipelineEventText(kind, e)}
                onclick={() => pickEvent(i)}
              >
                {pipelineEventText(kind, e)}
              </button>
            {/if}
          {/each}
          {#each map.cards as card (card.id)}
            {@const box = layout.cards.get(card.id)}
            {@const cs = cardState(card.id)}
            {#if box}
              <button
                type="button"
                class="absolute overflow-hidden rounded-md border px-2.5 py-1.5 text-left transition-[border-color,opacity,background-color] {cs === 'run'
                  ? 'border-accent bg-accent/10'
                  : cs === 'ok'
                    ? 'border-ok/50 bg-panel'
                    : cs === 'wait'
                      ? 'border-warn bg-panel'
                      : cs === 'skip'
                        ? 'border-dashed border-edge opacity-40'
                        : cs === 'unknown'
                          ? 'border-dashed border-warn/50'
                          : 'border-edge bg-panel'} {card.called ? 'border-dashed' : ''}"
                style="left: {box.x}px; top: {box.y}px; width: {box.w}px; height: {box.h}px"
                data-testid="pipeline-card"
                onclick={() => (drill = card.id)}
              >
                <span class="flex items-center gap-1.5 text-xs leading-4 font-medium text-text">
                  <Icon name={CARD_ICON[cs][0]} size={12} class={CARD_ICON[cs][1]} />
                  <span class="truncate">{card.pipeline.name}</span>
                  {#if card.called}<span class="text-meta font-normal text-muted">{t("pipeline.group.called")}</span>{/if}
                  {#if afterOf(card.id)}<span class="truncate text-meta font-normal text-muted">{t("pipeline.group.after")} {afterOf(card.id)}</span>{/if}
                  <span class="ml-auto truncate font-mono text-caption font-normal text-muted">{base(card.id)}</span>
                </span>
                <span class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-caption leading-4 text-muted">
                  {#each card.pipeline.jobs as job (job.id)}
                    {@const js = jobState(card.id, job.id)}
                    <span class="flex min-w-0 max-w-full items-center gap-0.5 {js === 'skip' ? 'opacity-50' : js === 'idle' || js === 'wait' ? '' : 'text-text'}">
                      <Icon name={JOB_ICON[js][0]} size={10} class={JOB_ICON[js][1]} />
                      <span class="truncate">{job.name}{job.call ? " ↗" : ""}</span>
                    </span>
                  {/each}
                </span>
              </button>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    <div class="shrink-0 space-y-0.5 border-t border-edge bg-panel px-2.5 py-1.5 text-meta">
      {#if event}
        <div class="text-muted">{t("pipeline.whatHappens", { event: pipelineEventText(kind, event) })}</div>
        {#if sure.length}<div class="text-ok"><Icon name="circleCheck" size={11} /> {t("pipeline.group.started", { names: names(sure) })}</div>{/if}
        {#if unsure.length}<div class="text-warn"><Icon name="help" size={11} /> {t("pipeline.group.unsure", { names: names(unsure) })}</div>{/if}
        {#if !starts.length}<div class="text-muted"><Icon name="circleOff" size={11} /> {t("pipeline.group.nothing")}</div>{/if}
      {/if}
      {#each group.failed as f (f.path)}
        <div class="text-warn"><Icon name="alert" size={11} /> {t("pipeline.group.failed", { path: f.path })}</div>
      {/each}
      <div class="text-muted"><Icon name="info" size={11} /> {t("pipeline.group.hint")}</div>
    </div>
  {/if}
</div>

<style>
  .map-link {
    fill: none;
    stroke: color-mix(in srgb, var(--color-muted) 45%, var(--color-edge));
    stroke-width: 1.6;
    transition: opacity 0.35s;
  }
  .map-link.call {
    stroke-dasharray: 5 4;
  }
  .map-link.dim {
    opacity: 0.3;
  }
  .map-flow {
    fill: none;
    stroke: var(--color-ok);
    stroke-width: 1.9;
    stroke-dasharray: 1 1;
    stroke-dashoffset: 1;
    transition: stroke-dashoffset 0.6s ease-out;
  }
  .map-flow.on {
    stroke-dashoffset: 0;
  }
</style>
