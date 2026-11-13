<script lang="ts">
  // The schema of one pipeline file (ADR 0068): the event bar, the graph, what
  // the event does to each job and why, and the job picked. The pipeline is read
  // from the text the editor holds — live as it is edited — and the files it
  // names through the reader of the same connection. Played, it starts jobs wave
  // by wave: order, not time.
  import { onDestroy, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { diag, swallow } from "../api/diag";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import { notifySuccess } from "../stores/toasts.svelte";
  import Icon from "../ui/Icon.svelte";
  import { reducedMotion } from "../ui/motion";
  import PipelineGraph from "./PipelineGraph.svelte";
  import { pipelineReasonText, pipelineProblemText, pipelineEventText } from "./pipetext";
  import { jobAtLine, jobOf, type PipelineKind, type Pipeline, type SourceSpan } from "./pipeline";
  import { cachedReader, loadPipeline, type PipeReader } from "./pipeload";
  import type { GraphMode } from "./pipelayout";
  import { toMermaid } from "./pipemermaid";
  import { finishJobs, nextWave, openGate, planStates, playbackPhase, startPlayback, type Playback, type RunState } from "./pipeplay";
  import { eventPresets, planFor, type PipeEvent } from "./pipesim";
  import { loadYaml, type Yaml } from "./yamldoc";

  let {
    path,
    text,
    kind,
    reader,
    sessionId = null,
    compact = false,
    cursorLine = null,
    readyPipeline = null,
    onjump,
    onselectjob,
  }: {
    /** The file the pipeline starts in. */
    path: string;
    /** Its text — the editor's buffer, so edits show at once. */
    text: string;
    kind?: PipelineKind;
    reader: PipeReader;
    sessionId?: string | null;
    /** Beside the code: the parts stack instead of standing side by side. */
    compact?: boolean;
    /** The editor's cursor line: the job it is in is picked. */
    cursorLine?: number | null;
    /** A pipeline already read (the map of a group hands one over). */
    readyPipeline?: Pipeline | null;
    /** Show a place of a file in the editor. */
    onjump?: (file: string, line: number) => void;
    /** The job picked, for the editor to light its lines. */
    onselectjob?: (span: SourceSpan | null) => void;
  } = $props();

  /** One wave of the playback. */
  const STEP_MS = 900;
  const GAP_MS = 260;

  // The files the pipeline includes are read once while the schema is open.
  const files = $derived(cachedReader(reader));
  let Y = $state.raw<Yaml | null>(null);
  let pipeline = $state.raw<Pipeline | null>(null);
  let failed = $state<string | null>(null);
  let seq = 0;
  loadYaml()
    .then((y) => (Y = y))
    .catch((e: unknown) => {
      failed = String(e);
      swallow("editor", "the YAML parser did not load: the pipeline schema is not drawn", "warn")(e);
    });

  // Read again as the text changes — a beat after the last keystroke, not on
  // every one (`untrack`: the effect must not run on what it writes itself).
  $effect(() => {
    const y = Y;
    const src = text;
    const file = path;
    const given = readyPipeline;
    const via = files;
    if (given) {
      untrack(() => (pipeline = given));
      return;
    }
    if (!y) return;
    const mine = ++seq;
    const first = untrack(() => pipeline === null);
    const id = setTimeout(
      () => {
        void loadPipeline(y, via, file, src, kind).then((next) => {
          if (mine !== seq) return;
          pipeline = next;
          for (const f of next.files.filter((x) => x.state === "failed")) {
            diag.warn("editor", "a file of the pipeline could not be read: the schema is drawn without it", { path: f.path });
          }
        });
      },
      first ? 0 : 350,
    );
    return () => clearTimeout(id);
  });

  let mode = $state<GraphMode>("stages");
  const MODES = [
    { value: "stages", key: "pipeline.modeStages" },
    { value: "links", key: "pipeline.modeLinks" },
  ] as const;
  let open = $state.raw<ReadonlySet<string>>(new Set());
  let selected = $state<string | null>(null);
  let showFiles = $state(false);

  // ── The event ─────────────────────────────────────────────────────────────
  let defaultBranch = $state("main");
  let eventAt = $state(0);
  let refText = $state<string | null>(null);
  const presets = $derived(pipeline ? eventPresets(pipeline, defaultBranch.trim() || "main") : []);
  const preset = $derived(presets[Math.min(eventAt, Math.max(0, presets.length - 1))] ?? null);
  const event = $derived<PipeEvent | null>(preset ? { ...preset, ref: refText?.trim() || preset.ref } : null);
  const plan = $derived(pipeline && event ? planFor(pipeline, event) : null);

  function pickEvent(i: number) {
    eventAt = i;
    refText = null;
    stop();
    // Picked by hand: show what it does.
    after(() => play(), 450);
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  let pb = $state.raw<Playback | null>(null);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stepMs = () => (reducedMotion() ? 150 : STEP_MS);
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
    pb = null;
  }
  function play() {
    const p = pipeline;
    const pl = plan;
    if (!p || !pl || pl.created === false) return;
    stop();
    pb = startPlayback(pl);
    after(wave, 250);
  }
  function wave() {
    const p = pipeline;
    const pl = plan;
    if (!p || !pl || !pb) return;
    const next = nextWave(p, pl, pb);
    pb = next.pb;
    if (!next.started.length) return;
    after(() => {
      if (pb) pb = finishJobs(pl, pb, next.started);
      after(wave, GAP_MS);
    }, stepMs());
  }
  function letGo(id: string) {
    const pl = plan;
    if (!pb || !pl) return;
    pb = openGate(pb, id);
    after(() => {
      if (pb) pb = finishJobs(pl, pb, [id]);
      after(wave, GAP_MS);
    }, stepMs());
  }
  // A new plan — another event, an edit — ends the playback of the old one.
  $effect(() => {
    void plan;
    untrack(() => {
      if (pb) stop();
    });
  });
  onDestroy(stop);

  const states = $derived<Record<string, RunState>>(pb ? pb.states : plan ? planStates(plan) : {});
  const phase = $derived(pb ? playbackPhase(pb) : null);
  const willStart = $derived(plan ? [...plan.jobs.values()].filter((v) => v.run === true).length : 0);

  // ── Picking a job ─────────────────────────────────────────────────────────
  $effect(() => {
    const line = cursorLine;
    const p = pipeline;
    if (!p || line === null) return;
    const job = jobAtLine(p, path, line);
    untrack(() => {
      if (job && job.id !== selected) selected = job.id;
    });
  });
  $effect(() => {
    const p = pipeline;
    const id = selected;
    const job = p && id ? jobOf(p, id) : undefined;
    untrack(() => onselectjob?.(job ? job.span : null));
  });
  const job = $derived(pipeline && selected ? (jobOf(pipeline, selected) ?? null) : null);
  const verdict = $derived(plan && job ? (plan.jobs.get(job.id) ?? null) : null);

  function toggle(id: string) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    open = next;
  }

  async function copyMermaid() {
    if (!pipeline) return;
    await writeClipboard(toMermaid(pipeline, mode));
    notifySuccess(t("pipeline.mermaidCopied"), { source: "editor", sessionId });
  }

  const readCount = $derived(pipeline ? pipeline.files.filter((f) => f.state === "read").length : 0);
  const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const LEGEND: { state: RunState; icon: "circle" | "loader" | "circleCheck" | "play" | "shield" | "alert" | "help" | "circleOff"; tone: string; key: "pipeline.legend.idle" | "pipeline.legend.run" | "pipeline.legend.ok" | "pipeline.legend.manual" | "pipeline.legend.approval" | "pipeline.legend.warn" | "pipeline.legend.unknown" | "pipeline.legend.skip" }[] = [
    { state: "idle", icon: "circle", tone: "text-muted", key: "pipeline.legend.idle" },
    { state: "run", icon: "loader", tone: "text-accent", key: "pipeline.legend.run" },
    { state: "ok", icon: "circleCheck", tone: "text-ok", key: "pipeline.legend.ok" },
    { state: "gate", icon: "play", tone: "text-warn", key: "pipeline.legend.manual" },
    { state: "gate", icon: "shield", tone: "text-warn", key: "pipeline.legend.approval" },
    { state: "warn", icon: "alert", tone: "text-warn", key: "pipeline.legend.warn" },
    { state: "unknown", icon: "help", tone: "text-warn", key: "pipeline.legend.unknown" },
    { state: "skip", icon: "circleOff", tone: "text-muted", key: "pipeline.legend.skip" },
  ];
</script>

<div class="flex h-full min-h-0 flex-col @container" data-testid="pipeline-view">
  {#if !pipeline}
    <div class="flex flex-1 items-center justify-center p-4 text-xs text-muted">
      {failed ?? t("pipeline.loading")}
    </div>
  {:else}
    <!-- The event bar: what happens, on which branch; the columns; playback. -->
    <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-edge bg-panel-alt px-2 py-1 text-meta">
      {#if event && event.kind !== "call"}
        <span class="text-muted">{t("pipeline.ref")}</span>
        <input
          class="w-28 rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-text"
          aria-label={t("pipeline.ref")}
          use:tooltip={t("pipeline.ref")}
          value={refText ?? event.ref}
          oninput={(e) => {
            refText = (e.currentTarget as HTMLInputElement).value;
            stop();
          }}
        />
      {/if}
      {#if pipeline.kind === "gitlab" && /CI_DEFAULT_BRANCH/.test(text)}
        <span class="flex items-center gap-1 text-muted" use:tooltip={t("pipeline.defaultBranch")}>
          <Icon name="gitBranch" size={12} />
          <input
            class="w-20 rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-text"
            aria-label={t("pipeline.defaultBranch")}
            bind:value={defaultBranch}
          />
        </span>
      {/if}
      {#if pipeline.kind === "gitlab"}
        <!-- Columns: GitLab's stages, or how far down its needs a job is. -->
        <div class="flex overflow-hidden rounded border border-edge" role="radiogroup" aria-label={t("pipeline.mode")}>
          {#each MODES as m, i (m.value)}
            <button
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              class="px-2 py-0.5 {i ? 'border-l border-edge' : ''} {mode === m.value
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:bg-edge hover:text-text'}"
              onclick={() => (mode = m.value)}
            >
              {t(m.key)}
            </button>
          {/each}
        </div>
      {/if}
      <span class="ml-auto flex items-center gap-1 whitespace-nowrap text-muted" data-testid="pipeline-status">
        {#if plan && plan.created === false}
          <Icon name="circleOff" size={12} /> {t("pipeline.statusNotCreated")}
        {:else if phase === "running"}
          <Icon name="loader" size={12} class="animate-spin text-accent" /> {t("pipeline.statusWave", { n: Math.max(1, pb?.wave ?? 1) })}
        {:else if phase === "waiting"}
          <span class="flex items-center gap-1 text-warn"><Icon name="play" size={12} /> {t("pipeline.statusGate")}</span>
        {:else if phase === "done"}
          <span class="flex items-center gap-1 text-ok"><Icon name="circleCheck" size={12} /> {t("pipeline.statusDone", { n: pb?.wave ?? 0 })}</span>
        {:else}
          {t("pipeline.statusPlanned", { n: willStart, total: pipeline.jobs.length })}
        {/if}
      </span>
      <button
        type="button"
        class="flex items-center gap-1 rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt disabled:opacity-40"
        disabled={!plan || plan.created === false}
        use:tooltip={t("pipeline.playHint")}
        data-testid="pipeline-play"
        onclick={() => (pb && phase !== "done" ? stop() : play())}
      >
        <Icon name={pb && phase !== "done" ? "stop" : "play"} size={12} />
        {pb && phase !== "done" ? t("pipeline.stop") : t("pipeline.play")}
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-edge hover:text-text"
        aria-label={t("pipeline.mermaid")}
        use:tooltip={t("pipeline.mermaid")}
        onclick={copyMermaid}
      >
        <Icon name="copy" size={13} />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if pipeline.jobs.length}
        <div class="bg-panel-alt/40">
          <PipelineGraph
            {pipeline}
            {mode}
            {open}
            {states}
            {plan}
            {selected}
            stepMs={stepMs()}
            events={presets.map((e, i) => ({ id: String(i), label: pipelineEventText(pipeline!.kind, e) }))}
            event={String(Math.min(eventAt, Math.max(0, presets.length - 1)))}
            onevent={(id) => pickEvent(Number(id))}
            onselect={(id) => (selected = selected === id ? null : id)}
            ontoggle={toggle}
            ongate={letGo}
          />
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 border-y border-edge px-2.5 py-1 text-meta text-muted">
          {#each LEGEND as l (l.key)}
            <span class="flex items-center gap-1"><Icon name={l.icon} size={11} class={l.tone} />{t(l.key)}</span>
          {/each}
        </div>
      {:else}
        <div class="p-4 text-xs text-muted">{t("pipeline.empty")}</div>
      {/if}

      <div class="grid grid-cols-1 bg-panel text-xs {compact ? '' : '@wide:grid-cols-2'}">
        <!-- What the event does, and what the file gets wrong. -->
        <div class="min-w-0 space-y-1 p-2.5">
          {#if event && plan}
            <div class="text-caption uppercase tracking-wider text-muted">{t("pipeline.whatHappens", { event: pipelineEventText(pipeline.kind, event) })}</div>
            {#if plan.invalid}
              <div class="rounded bg-bad/10 px-2 py-1 text-bad"><Icon name="octagon" size={12} /> {t("pipeline.invalid")}</div>
            {:else if plan.created === false}
              <div class="rounded bg-warn/10 px-2 py-1 text-warn">
                <Icon name="circleOff" size={12} /> {t("pipeline.notCreated")}{#if plan.reason}: {pipelineReasonText(plan.reason)}{/if}
              </div>
            {:else if plan.created === "?"}
              <div class="rounded bg-warn/10 px-2 py-1 text-warn">
                <Icon name="help" size={12} /> {t("pipeline.unsure")}{#if plan.reason}: {pipelineReasonText(plan.reason)}{/if}
              </div>
            {:else}
              <div class="text-ok"><Icon name="circleCheck" size={12} /> {t("pipeline.willStart", { n: willStart, total: pipeline.jobs.length })}</div>
            {/if}
            {#if plan.created !== false || plan.invalid}
              {#each pipeline.jobs as j (j.id)}
                {@const v = plan.jobs.get(j.id)}
                {#if v && v.run !== true}
                  <button
                    type="button"
                    class="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-muted hover:bg-edge"
                    onclick={() => (selected = j.id)}
                  >
                    <Icon
                      name={v.error ? "octagon" : v.run === "?" ? "help" : "circleOff"}
                      size={12}
                      class="mt-0.5 {v.error ? 'text-bad' : v.run === '?' ? 'text-warn' : 'text-muted'}"
                    />
                    <span class="min-w-0"><b class="font-medium text-text">{j.name}</b> — {pipelineReasonText(v.reason)}</span>
                  </button>
                {/if}
              {/each}
            {/if}
          {/if}
          {#if pipeline.problems.length}
            <div class="pt-1.5 text-caption uppercase tracking-wider text-muted">{t("pipeline.problems")}</div>
            {#each pipeline.problems as p, i (i)}
              <button
                type="button"
                class="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-edge {p.level === 'error' ? 'text-bad' : 'text-warn'}"
                disabled={!p.file || !p.line || !onjump}
                onclick={() => p.file && p.line && onjump?.(p.file, p.line)}
              >
                <Icon name={p.level === "error" ? "octagon" : "alert"} size={12} class="mt-0.5" />
                <span class="min-w-0 break-words">
                  {pipelineProblemText(p)}
                  {#if p.file && p.line}<span class="text-muted"> · {fileName(p.file)}:{p.line}</span>{/if}
                </span>
              </button>
            {/each}
          {/if}
          <button
            type="button"
            class="flex items-center gap-1 pt-1 text-meta text-muted hover:text-text"
            aria-expanded={showFiles}
            onclick={() => (showFiles = !showFiles)}
          >
            <Icon name={showFiles ? "chevronDown" : "chevronRight"} size={11} />
            {t("pipeline.files", { read: readCount, total: pipeline.files.length })}
          </button>
          {#if showFiles}
            {#each pipeline.files as f, i (i)}
              <div class="flex items-center gap-1.5 pl-3 text-meta {f.state === 'read' ? 'text-text' : 'text-warn'}">
                <Icon name={f.state === "read" ? "file" : "alert"} size={11} />
                <span class="min-w-0 truncate" use:tooltip={f.path}>{f.state === "external" ? f.path : fileName(f.path)}</span>
                {#if f.state === "external"}<span class="text-muted">— {t("pipeline.fileExternal")}</span>{/if}
                {#if f.state === "failed"}<span class="text-muted">— {t("pipeline.fileFailed")}</span>{/if}
                {#if f.detail === "rules"}<span class="text-muted">— {t("pipeline.fileConditional")}</span>{/if}
              </div>
            {/each}
          {/if}
        </div>

        <!-- The job picked. -->
        <div class="min-w-0 space-y-1 border-t border-edge p-2.5 {compact ? '' : '@wide:border-l @wide:border-t-0'}">
          <div class="text-caption uppercase tracking-wider text-muted">{t("pipeline.job")}</div>
          {#if !job}
            <p class="text-muted">{t("pipeline.selectJob")}</p>
          {:else}
            <div class="flex items-baseline gap-1.5">
              <b class="font-medium text-text">{job.name}</b>
              <span class="truncate text-meta text-muted">{fileName(job.span.file)}:{job.span.line}</span>
            </div>
            {#if job.stage}
              <div><span class="text-muted">{t("pipeline.stage")}</span> {job.stage}</div>
            {/if}
            {#if job.needs}
              <div><span class="text-muted">{t("pipeline.needs")}</span> {job.needs.map((n) => n.job).join(", ") || "[]"}</div>
            {:else if pipeline.kind === "gitlab"}
              {@const at = pipeline.stages.indexOf(job.stage ?? "")}
              <div>
                <span class="text-muted">{t("pipeline.waits")}</span>
                {at > 0 ? t("pipeline.waitsStages", { stage: job.stage ?? "" }) : t("pipeline.waitsNothing")}
              </div>
            {/if}
            {#if job.environment}
              <div><span class="text-muted">{t("pipeline.environment")}</span> <span class="text-warn">{job.environment}</span></div>
            {/if}
            {#if job.matrix}
              <div>
                <span class="text-muted">{t("pipeline.matrix")}</span>
                {job.matrix.axes}{#if job.matrix.items} — {job.matrix.items.length}{:else} — {t("pipeline.matrixUnknown")}{/if}
              </div>
            {/if}
            {#if job.call}
              <div><span class="text-muted">{t("pipeline.calls")}</span> {job.call.file}</div>
            {/if}
            {#if job.condition}
              <pre class="whitespace-pre-wrap break-words rounded border border-edge bg-panel-alt px-1.5 py-1 font-mono text-meta">if: {job.condition}</pre>
            {/if}
            {#if verdict}
              {@const tone = verdict.error ? "text-bad" : verdict.run === true ? "text-ok" : verdict.run === "?" ? "text-warn" : "text-muted"}
              <div class={tone}>
                <Icon name={verdict.error ? "octagon" : verdict.run === true ? "circleCheck" : verdict.run === "?" ? "help" : "circleOff"} size={12} />
                {verdict.error
                  ? t("pipeline.verdict.error")
                  : verdict.run === "?"
                    ? t("pipeline.verdict.unknown")
                    : !verdict.run
                      ? t("pipeline.verdict.skip")
                      : verdict.gate === "manual"
                        ? t("pipeline.verdict.manual")
                        : verdict.gate === "approval"
                          ? t("pipeline.verdict.approval")
                          : t("pipeline.verdict.run")} — {pipelineReasonText(verdict.reason)}
              </div>
              {#if verdict.delayed}
                <div class="text-muted"><Icon name="clock" size={12} /> {t("pipeline.delayed", { time: verdict.delayed })}</div>
              {/if}
            {/if}
            {#if job.steps.length}
              <div class="pt-1 text-caption uppercase tracking-wider text-muted">{t("pipeline.steps")}</div>
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-edge bg-panel-alt px-1.5 py-1 font-mono text-meta text-muted">{job.steps.join("\n")}</pre>
            {/if}
            {#if onjump}
              <button
                type="button"
                class="flex items-center gap-1 pt-1 text-accent hover:text-accent-hover"
                onclick={() => job && onjump?.(job.span.file, job.span.line)}
              >
                <Icon name="arrowRight" size={12} />
                {t("pipeline.openInCode")}
              </button>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
