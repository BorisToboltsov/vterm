<script lang="ts">
  // The pipelines of a group of files (ADR 0068). The map shows how they are
  // built: the events on the left, the pipelines they start, the ones only
  // called on the right, calls dashed. Playing an event shows the order they
  // run in: each card it reaches glides into a lane across the window and its
  // jobs fly out into columns by wave; a pipeline called mid-run is a lane right
  // under its caller, the line goes into it and comes back. The lanes stay after
  // the run; «Map» takes the cards back. A pipeline clicked shows its own graph.
  //
  // Where things stand is pipelayout.ts's, the order is pipelanes.ts's — one
  // list of what each job waits for draws its column and plays its turn. Job
  // names come from files on a server: they are text, never markup.
  import { onDestroy } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { connectionFiles } from "../api";
  import { diag, swallow } from "../api/diag";
  import { t } from "../i18n";
  import { settings, uiPx } from "../settings/settings.svelte";
  import type { EditorDoc } from "../stores/workspaces.svelte";
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import { motionMs, reducedMotion } from "../ui/motion";
  import PipelineView from "./PipelineView.svelte";
  import { cardLines, layoutLanes, layoutMap, type Box } from "./pipelayout";
  import {
    EVENT,
    groupFinish,
    groupOpenGate,
    groupRun,
    groupStep,
    laneProgress,
    laneState,
    currentWave,
    startGroup,
    type GroupPlayback,
    type GroupRun,
    type Lane,
    type LaneNode,
  } from "./pipelanes";
  import { loadGroup, type PipelineGroup } from "./pipeload";
  import { buildMap, eventKey, mapPlans, startedBy, type MapCard } from "./pipemap";
  import { playbackPhase, type RunState } from "./pipeplay";
  import type { Plan } from "./pipesim";
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

  /** One wave: about as long as a job of the pipeline's own graph takes. */
  const STEP_MS = 760;
  const GAP_MS = 160;
  /** Cards into lanes and back. */
  const MOVE_MS = 520;
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

  // ── The run, as lanes ─────────────────────────────────────────────────────
  const run = $derived<GroupRun | null>(map && event ? groupRun(map, event, starts) : null);
  const laneLayout = $derived(
    run ? layoutLanes({ lanes: run.lanes, nodes: run.nodes, links: run.links, waves: run.waves, event: EVENT, idle: run.idle, width, scale: uiPx(1) }) : null,
  );
  /** Each card's own lane — the first it has; a pipeline called again gets lanes of its own. */
  const primary = $derived.by(() => {
    const out = new Map<string, string>();
    for (const l of run?.lanes ?? []) if (!out.has(l.card)) out.set(l.card, l.key);
    return out;
  });
  const extraLanes = $derived(run ? run.lanes.filter((l) => primary.get(l.card) !== l.key) : []);

  let view = $state<"map" | "lanes">("map");
  /** The jobs stand at their lane's start for a moment, then fly out to their columns. */
  let entering = $state(false);
  /** Boxes glide only between the map and the lanes, not while the window is resized. */
  let moving = $state(false);
  let linksShown = $state(true);
  let pb = $state.raw<GroupPlayback | null>(null);
  let played: GroupRun | null = null;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  function after(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }
  function stopTimers() {
    timers.forEach(clearTimeout);
    timers.clear();
  }
  onDestroy(stopTimers);
  const step = () => (reducedMotion() ? 150 : STEP_MS);
  const move = () => motionMs(MOVE_MS, reducedMotion());

  /** Boxes glide to their new places; the lines, which cannot glide, come back where they land. */
  function glide() {
    moving = true;
    linksShown = false;
    after(() => {
      moving = false;
      linksShown = true;
    }, move());
  }

  function play() {
    const r = run;
    if (!r) return;
    stopTimers();
    const fresh = view === "map" || r !== played;
    view = "lanes";
    played = r;
    pb = startGroup(r);
    glide();
    if (fresh) {
      entering = true;
      after(() => (entering = false), 40);
    }
    after(tick, move() + 200);
  }
  function tick() {
    const r = played;
    if (!r || !pb || r !== run) return;
    const next = groupStep(r, pb);
    pb = next.pb;
    if (!next.started.length) return;
    after(() => {
      if (pb) pb = groupFinish(r, pb, next.started);
      after(tick, GAP_MS);
    }, step());
  }
  function letGo(key: string) {
    const r = played;
    if (!r || !pb) return;
    pb = groupOpenGate(pb, key);
    after(() => {
      if (pb) pb = groupFinish(r, pb, [key]);
      after(tick, GAP_MS);
    }, step());
  }
  function stopPlaying() {
    stopTimers();
    pb = null;
    // Stopped mid-glide: the boxes are where they were going — show the lines and the jobs.
    moving = false;
    linksShown = true;
    entering = false;
  }
  function toMap() {
    stopPlaying();
    view = "map";
    entering = false;
    glide();
  }
  function reload() {
    stopPlaying();
    view = "map";
    void read();
  }
  function pickEvent(i: number) {
    eventAt = i;
    drill = null;
    play();
  }

  const phase = $derived(pb ? playbackPhase(pb) : null);
  /** The column being run, while the run goes on. */
  const nowWave = $derived(run && pb && phase === "running" ? currentWave(run, pb) : null);
  const nodeState = (n: LaneNode): RunState => pb?.states[n.key] ?? laneState(n);
  /** Jobs the file cannot decide: the lines into them are faint. */
  const unsureKeys = $derived(new Set(run?.nodes.filter((n) => n.unsure).map((n) => n.key)));

  // ── States and words ──────────────────────────────────────────────────────
  type CardState = "idle" | "run" | "ok" | "wait" | "skip" | "unknown";
  const CARD_ICON: Record<CardState, [IconName, string]> = {
    idle: ["circle", "text-muted"],
    run: ["loader", "text-accent animate-spin"],
    ok: ["circleCheck", "text-ok"],
    wait: ["play", "text-warn"],
    skip: ["circleOff", "text-muted"],
    unknown: ["help", "text-warn"],
  };
  const CARD_FRAME: Record<CardState, string> = {
    idle: "border-edge bg-panel",
    run: "border-accent bg-panel",
    ok: "border-ok/50 bg-panel",
    wait: "border-warn bg-panel",
    skip: "border-dashed border-edge opacity-40",
    unknown: "border-dashed border-warn/50",
  };
  /** What the event does to a card on the map: its plan, before anything plays. */
  function cardState(id: string): CardState {
    const plan = plans.get(id);
    if (!plan) return "idle";
    // A called pipeline, or one that starts after another, waits for it: the event does not leave it out.
    if (map?.cards.find((c) => c.id === id)?.called || afterOf(id)) return "idle";
    return plan.created === false ? "skip" : plan.created === "?" ? "unknown" : "idle";
  }
  const laneCardState = (key: string): CardState => (run ? laneProgress(run, pb, key) : "idle");

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
  const JOB_FRAME: Record<RunState, string> = {
    idle: "border-edge bg-panel",
    wait: "border-edge bg-panel",
    run: "border-accent bg-accent/10",
    ok: "border-edge bg-panel",
    warn: "border-warn/50 bg-panel",
    gate: "border-warn bg-panel",
    skip: "border-dashed border-edge bg-panel opacity-40",
    unknown: "border-dashed border-warn/50 bg-panel",
    error: "border-bad bg-panel",
  };
  /** A card's job list on the map, as the plan has it. */
  function jobState(cardId: string, jobId: string): RunState {
    const v = plans.get(cardId)?.jobs.get(jobId);
    if (!v) return "idle";
    return v.error ? "error" : v.run === true ? "idle" : v.run === "?" ? "unknown" : "skip";
  }
  /** The pipeline whose end starts this one (`workflow_run`), if any. */
  const afterOf = (id: string): string | null => {
    const call = map?.calls.find((c) => c.after && c.to === id);
    return call ? (map?.cards.find((c) => c.id === call.from)?.pipeline.name ?? null) : null;
  };
  /** How a lane came to run, in words: called from a job, started by one, after another. */
  function laneVia(lane: Lane): string | null {
    const s = lane.start;
    if (s.kind === "event") return null;
    const from = run?.lanes.find((l) => l.key === s.lane);
    if (!from) return null;
    if (s.kind === "after") return `${t("pipeline.group.after")} ${from.pipeline.name}`;
    const job = from.pipeline.jobs.find((j) => j.id === s.job)?.name ?? s.job;
    return t(s.waits ? "pipeline.group.calledFrom" : "pipeline.group.startedFrom", { pipeline: from.pipeline.name, job });
  }
  const names = (ids: string[]) => ids.map((id) => map?.cards.find((c) => c.id === id)?.pipeline.name ?? id).join(", ");
  const unsure = $derived(map && event ? map.cards.filter((c) => !c.called && plans.get(c.id)?.created === "?").map((c) => c.id) : []);
  const sure = $derived(starts.filter((id) => !unsure.includes(id)));
  const drilled = $derived(drill && map ? (map.cards.find((c) => c.id === drill) ?? null) : null);
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

  /** Where a card stands: on the map, as its lane's frame, or on the shelf of the ones not started. */
  function cardBox(id: string): Box | undefined {
    if (view === "map") return layout?.cards.get(id);
    const lane = primary.get(id);
    return lane ? laneLayout?.lanes.get(lane) : laneLayout?.idle.get(id);
  }
  const isFrame = (id: string) => view === "lanes" && primary.has(id);
  const shelved = (id: string) => view === "lanes" && !primary.has(id);
  /** A job's box: at its lane's start while entering, then in its column. */
  function nodeBox(n: LaneNode): Box | undefined {
    const box = laneLayout?.nodes.get(n.key);
    const lane = laneLayout?.lanes.get(n.lane);
    if (!box || !lane) return undefined;
    return entering ? { x: lane.x + 10, y: lane.y + 4, w: box.w, h: box.h } : box;
  }
  const done = (s: RunState | undefined) => s === "ok" || s === "warn";
  const started = (s: RunState | undefined) => s === "run" || s === "gate" || done(s);
  const sourceDone = (from: string) => (from === EVENT ? pb !== null : done(pb?.states[from]));
  const stage = $derived(view === "lanes" ? laneLayout : layout);
  const status = $derived(
    view !== "lanes" || !pb || !run
      ? null
      : phase === "running"
        ? t("pipeline.statusWave", { n: nowWave ?? 1 })
        : phase === "waiting"
          ? t("pipeline.statusGate")
          : t("pipeline.statusDone", { n: run.waves }),
  );
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
        onclick={reload}
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
      <span class="ml-auto flex items-center gap-1.5">
        {#if status}
          <span class="flex items-center gap-1 {phase === 'done' ? 'text-ok' : phase === 'waiting' ? 'text-warn' : 'text-muted'}" data-testid="pipelines-status">
            <Icon
              name={phase === "done" ? "circleCheck" : phase === "waiting" ? "play" : "loader"}
              size={12}
              class={phase === "running" ? "animate-spin text-accent" : ""}
            />
            {status}
          </span>
        {/if}
        {#if view === "lanes"}
          <button
            type="button"
            class="flex items-center gap-1 rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
            use:tooltip={t("pipeline.group.mapHint")}
            onclick={toMap}
          >
            <Icon name="layoutGrid" size={12} />
            {t("pipeline.group.map")}
          </button>
        {/if}
        <button
          type="button"
          class="flex items-center gap-1 rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
          use:tooltip={t("pipeline.playHint")}
          data-testid="pipelines-play"
          onclick={() => (phase === "running" ? stopPlaying() : play())}
        >
          <Icon name={phase === "running" ? "stop" : "play"} size={12} />
          {phase === "running" ? t("pipeline.stop") : t("pipeline.play")}
        </button>
      </span>
    </div>
    <div class="min-h-0 flex-1 overflow-auto bg-panel-alt/40" bind:clientWidth={width}>
      {#if stage && event && run}
        <div class="relative" style="width: {stage.width}px; height: {stage.height}px" data-view={view}>
          <!-- The cards: on the map, or each as its lane's frame, or on the shelf. -->
          {#each map.cards as card (card.id)}
            {@const box = cardBox(card.id)}
            {@const frame = isFrame(card.id)}
            {@const cs = frame ? laneCardState(primary.get(card.id) ?? "") : view === "lanes" ? "idle" : cardState(card.id)}
            {#if box}
              <button
                type="button"
                class="pipe-box absolute left-0 top-0 overflow-hidden rounded-md border text-left {CARD_FRAME[cs]} {card.called
                  ? 'border-dashed'
                  : ''} {shelved(card.id) ? 'px-2 py-0.5 opacity-60 hover:opacity-100' : 'px-2.5 py-1.5'} {frame ? 'pointer-events-none' : ''}"
                class:moving
                style="transform: translate({box.x}px, {box.y}px); width: {box.w}px; height: {box.h}px"
                tabindex={frame ? -1 : 0}
                aria-hidden={frame || undefined}
                data-testid="pipeline-card"
                data-shelved={shelved(card.id) || undefined}
                onclick={() => (drill = card.id)}
              >
                <span class="pipe-face flex flex-col" class:hidden-face={frame}>
                  <span class="flex items-center gap-1.5 text-xs leading-4 font-medium text-text">
                    <Icon name={CARD_ICON[cs][0]} size={12} class={CARD_ICON[cs][1]} />
                    <span class="truncate" use:tooltip={card.pipeline.name}>{card.pipeline.name}</span>
                    {#if !shelved(card.id)}
                      <!-- On the shelf the name has the room: the file and how it starts are on the map. -->
                      {#if card.called}<span class="text-meta font-normal text-muted">{t("pipeline.group.called")}</span>{/if}
                      {#if afterOf(card.id)}<span class="truncate text-meta font-normal text-muted">{t("pipeline.group.after")} {afterOf(card.id)}</span>{/if}
                      <span class="ml-auto truncate font-mono text-caption font-normal text-muted">{base(card.id)}</span>
                    {/if}
                  </span>
                  <span class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-caption leading-4 text-muted">
                    {#each card.pipeline.jobs as job (job.id)}
                      {@const js = jobState(card.id, job.id)}
                      <span class="flex min-w-0 max-w-full items-center gap-0.5 {js === 'skip' ? 'opacity-50' : js === 'idle' ? '' : 'text-text'}">
                        <Icon name={JOB_ICON[js][0]} size={10} class={JOB_ICON[js][1]} />
                        <span class="truncate">{job.name}{job.call ? " ↗" : ""}</span>
                      </span>
                    {/each}
                  </span>
                </span>
              </button>
            {/if}
          {/each}

          {#if view === "lanes" && laneLayout}
            <!-- A pipeline run a second time (called from another job) has a lane of its own. -->
            {#each extraLanes as lane (lane.key)}
              {@const box = laneLayout.lanes.get(lane.key)}
              {#if box}
                <div
                  class="pipe-box pipe-appear pointer-events-none absolute left-0 top-0 rounded-md border border-dashed {CARD_FRAME[laneCardState(lane.key)]}"
                  class:moving
                  style="transform: translate({box.x}px, {box.y}px); width: {box.w}px; height: {box.h}px"
                ></div>
              {/if}
            {/each}
            {#each laneLayout.columns as col, i (i)}
              <div
                class="pipe-appear absolute truncate text-center text-caption uppercase tracking-wider transition-colors {nowWave === i + 1 ? 'text-accent' : 'text-muted'}"
                style="left: {col.x}px; top: {col.h / 4}px; width: {col.w}px"
              >
                {t("pipeline.group.wave", { n: i + 1 })}
              </div>
            {/each}
            {#if nowWave !== null}
              {@const col = laneLayout.columns[nowWave - 1]}
              <div
                class="pipe-sweep pointer-events-none absolute left-0 top-0 w-0.5 rounded bg-accent/50"
                style="transform: translate({col.x}px, {col.h - 2}px); height: {(laneLayout.idleTitle?.y ?? stage.height) - col.h}px"
              ></div>
            {/if}
            {#if laneLayout.idleTitle}
              <div
                class="pipe-appear absolute truncate text-meta text-muted"
                style="left: {laneLayout.idleTitle.x}px; top: {laneLayout.idleTitle.y}px; width: {laneLayout.idleTitle.w}px"
              >
                {t("pipeline.group.notStarted")}
              </div>
            {/if}
          {/if}

          <svg
            class="pipe-links pointer-events-none absolute left-0 top-0 overflow-visible"
            class:hidden-links={!linksShown}
            width={stage.width}
            height={stage.height}
            aria-hidden="true"
          >
            <defs>
              <marker id="pipe-map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M1 1L8 5L1 9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" />
              </marker>
            </defs>
            {#if view === "lanes" && laneLayout}
              {#each laneLayout.links as l (l.key)}
                <path d={l.d} class="map-link" class:call={l.kind !== "need" && l.kind !== "event"} class:dim={unsureKeys.has(l.to)} data-link={l.key} />
              {/each}
              {#each laneLayout.links as l (l.key)}
                {@const to = pb?.states[l.to]}
                <path
                  d={l.d}
                  pathLength="1"
                  class="map-flow"
                  class:on={sourceDone(l.from) && started(to) && to !== "run"}
                  class:live={sourceDone(l.from) && to === "run"}
                />
              {/each}
            {:else if layout}
              {#each layout.links as l (l.key)}
                <path
                  d={l.d}
                  class="map-link"
                  class:call={l.call}
                  class:dim={!l.call && !l.key.startsWith(`ev:${eventKey(event)}|`)}
                  marker-end={l.call ? "url(#pipe-map-arrow)" : undefined}
                />
              {/each}
            {/if}
          </svg>

          {#each map.events as e, i (eventKey(e))}
            {@const gone = view === "lanes" && i !== eventAt}
            {@const box = view === "lanes" && laneLayout && i === eventAt ? laneLayout.event : layout?.events.get(eventKey(e))}
            {#if box}
              <button
                type="button"
                class="pipe-box absolute left-0 top-0 truncate rounded-full border px-2 text-center text-meta {i === eventAt
                  ? 'border-accent bg-accent/15 text-accent'
                  : gone
                    ? 'pointer-events-none border-edge bg-panel text-muted opacity-0'
                    : 'border-edge bg-panel text-muted opacity-60 hover:opacity-100'}"
                class:moving
                style="transform: translate({box.x}px, {box.y}px); width: {box.w}px; height: {box.h}px"
                tabindex={gone ? -1 : 0}
                aria-hidden={gone || undefined}
                use:tooltip={pipelineEventText(kind, e)}
                onclick={() => pickEvent(i)}
              >
                {pipelineEventText(kind, e)}
              </button>
            {/if}
          {/each}

          {#if view === "lanes" && laneLayout}
            <!-- Each lane's title, above the lines that cross it. -->
            {#each run.lanes as lane (lane.key)}
              {@const box = laneLayout.lanes.get(lane.key)}
              {@const ls = laneCardState(lane.key)}
              {@const via = laneVia(lane)}
              {#if box}
                <button
                  type="button"
                  class="pipe-box pipe-appear late absolute left-0 top-0 flex items-center gap-1.5 overflow-hidden rounded bg-panel px-1.5 text-left text-xs leading-4"
                  class:moving
                  style="transform: translate({box.x + 6}px, {box.y + 3}px); max-width: {box.w - 12}px; height: {uiPx(18)}px"
                  data-testid="pipeline-lane"
                  data-lane={lane.key}
                  data-state={ls}
                  onclick={() => (drill = lane.card)}
                >
                  <Icon name={CARD_ICON[ls][0]} size={12} class={CARD_ICON[ls][1]} />
                  <span class="shrink-0 font-medium text-text">{lane.pipeline.name}</span>
                  {#if via}<span class="min-w-0 truncate text-meta text-muted">{via}</span>{/if}
                  {#if lane.plan.created === false}
                    <span class="shrink-0 text-meta text-muted">· {t("pipeline.statusNotCreated")}</span>
                  {:else if lane.leftOut.length}
                    <span class="shrink-0 text-meta text-muted" use:tooltip={lane.leftOut.join(", ")}>· {t("pipeline.group.leftOut", { n: lane.leftOut.length })}</span>
                  {/if}
                  <span class="shrink-0 font-mono text-caption text-muted">{base(lane.card)}</span>
                </button>
              {/if}
            {/each}

            {#each run.nodes as n (n.key)}
              {@const box = nodeBox(n)}
              {@const s = nodeState(n)}
              {#if box}
                <div
                  class="pipe-box lane-node absolute left-0 top-0 flex items-center gap-1.5 overflow-hidden rounded-md border pl-2 pr-1.5 text-xs text-text {JOB_FRAME[s]}"
                  class:moving
                  class:entering
                  style="transform: translate({box.x}px, {box.y}px); width: {box.w}px; height: {box.h}px"
                  data-testid="pipeline-lane-job"
                  data-job={n.key}
                  data-state={s}
                >
                  <Icon
                    name={s === "gate" && n.verdict.gate === "approval" ? "shield" : JOB_ICON[s][0]}
                    size={13}
                    class="{JOB_ICON[s][1]} {s === 'run' ? 'animate-spin' : ''}"
                  />
                  <span class="min-w-0 flex-1 truncate" use:tooltip={n.job.name}>{n.job.name}{n.job.call ? " ↗" : ""}</span>
                  {#if n.job.matrix}<span class="shrink-0 text-meta text-muted">×{n.job.matrix.items?.length ?? "?"}</span>{/if}
                  {#if n.job.environment && s !== "gate"}
                    <span class="shrink-0" use:tooltip={n.job.environment}><Icon name="shield" size={12} class="text-warn" /></span>
                  {/if}
                  {#if s === "gate"}
                    <button
                      type="button"
                      class="flex shrink-0 animate-pulse items-center rounded-full bg-warn/15 px-1.5 py-0.5 text-warn hover:bg-warn/25"
                      aria-label={n.verdict.gate === "approval" ? t("pipeline.approve") : t("pipeline.runGate")}
                      use:tooltip={n.verdict.gate === "approval" ? t("pipeline.approve") : t("pipeline.runGate")}
                      onclick={() => letGo(n.key)}
                    >
                      <Icon name={n.verdict.gate === "approval" ? "check" : "play"} size={11} />
                    </button>
                  {/if}
                  {#if s === "run"}
                    <span class="pipe-progress absolute bottom-0 left-0 h-0.5 w-full bg-accent" style="animation-duration: {step()}ms"></span>
                  {/if}
                </div>
              {/if}
            {/each}
          {/if}
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
  /* Boxes glide between the map and the lanes; while the window is resized they follow at once. */
  .pipe-box {
    transition:
      border-color 0.3s,
      background-color 0.3s,
      opacity 0.35s;
  }
  .pipe-box.moving {
    transition:
      transform 0.52s cubic-bezier(0.2, 0.8, 0.2, 1),
      width 0.52s cubic-bezier(0.2, 0.8, 0.2, 1),
      height 0.52s cubic-bezier(0.2, 0.8, 0.2, 1),
      border-color 0.3s,
      background-color 0.3s,
      opacity 0.35s;
  }
  .pipe-face {
    transition: opacity 0.25s;
  }
  .pipe-face.hidden-face {
    opacity: 0;
  }
  .lane-node.entering {
    opacity: 0;
  }
  .pipe-appear {
    animation: pipe-appear 0.4s ease-out both;
  }
  /* A lane's title comes once its frame has arrived. */
  .pipe-appear.late {
    animation-delay: 0.32s;
  }
  @keyframes pipe-appear {
    from {
      opacity: 0;
    }
  }
  .pipe-sweep {
    transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .pipe-links {
    transition: opacity 0.18s;
  }
  /* Gone at once — the new view's lines would flash over the boxes still on their way — and back with a fade. */
  .pipe-links.hidden-links {
    opacity: 0;
    transition: none;
  }
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
  .map-flow.live {
    stroke-dashoffset: 0;
    stroke-dasharray: 0.03 0.025;
    animation: pipe-flow 0.7s linear infinite;
  }
  @keyframes pipe-flow {
    to {
      stroke-dashoffset: -0.055;
    }
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
</style>
