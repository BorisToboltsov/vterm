<script lang="ts">
  // The schema of one pipeline file (ADR 0068): the event bar, the graph, what
  // the event does to each job and why, and the job picked. The pipeline is read
  // from the text the editor holds — live as it is edited — and the files it
  // names through the reader of the same connection. Played, it starts jobs wave
  // by wave: order, not time.
  //
  // "Run" (ADR 0069) lays a real run of the file over it, read through the
  // user's own gh/glab: the schema from the file at the run's commit, the jobs'
  // states from the forge, and in time — real lengths, the wait for a runner,
  // the path that decided how long it took. Below the problems: what in a
  // GitHub workflow lets someone else's code run with its token, from the file
  // alone; and on `workflow_dispatch`, the form to start it by hand.
  import { onDestroy, untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { diag, swallow } from "../api/diag";
  import { writeClipboard } from "../app/clipboard";
  import { t } from "../i18n";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
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
  import { loadYaml, parseYaml, type Yaml, type YamlFile } from "./yamldoc";
  import PipelineTimeline from "./PipelineTimeline.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import { baseName } from "../files/fspath";
  import { auditWorkflow, pinText, type Finding } from "../ci/ciaudit";
  import { dispatchFields, formProblems, formValues, pipelineFields, prodFields, type FormField } from "../ci/cidispatch";
  import { isActive, type CiFailure, type CiJob, type CiRun } from "../ci/ciparse";
  import { clock, jobNotes, runOnSchema, timeline } from "../ci/cirun";
  import { durationText, problemTitle, runName, STATE_ICON, STATE_TONE, stateText } from "../ci/citext";
  import { CLI, type Repo } from "../ci/forge";
  import { fileAtCommit, pinCommit, readJobs, readRuns, repoOfFile, schemaAskOf, startRun } from "../stores/ci.svelte";
  import { clickLink } from "../stores/linkopen.svelte";
  import { compactAge } from "../ui/age";

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
    onedit,
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
    /** Change the editor's text (pin by SHA); absent — the file is read-only here. */
    onedit?: (next: string) => void;
  } = $props();

  /** One wave of the playback. */
  const STEP_MS = 900;
  const GAP_MS = 260;

  // The files the pipeline includes are read once while the schema is open.
  const files = $derived(cachedReader(reader));
  let Y = $state.raw<Yaml | null>(null);
  let pipeline = $state.raw<Pipeline | null>(null);
  /** The main file as YAML: what the security checks and the start form read. */
  let doc = $state.raw<YamlFile | null>(null);
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
          doc = parseYaml(y, src);
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

  // ── A real run (ADR 0069) ─────────────────────────────────────────────────
  let source = $state<"sim" | "run">("sim");
  let runView = $state<"time" | "order">("time");
  let repo = $state.raw<Repo | null>(null);
  let repoRoot: string | null = null;
  let runs = $state.raw<CiRun[] | null>(null);
  let runsFailure = $state<CiFailure | null>(null);
  let runId = $state<string | null>(null);
  const theRun = $derived(runs?.find((r) => r.id === runId) ?? null);
  let runJobs = $state.raw<CiJob[] | null>(null);
  /** The file as it was at the run's commit; null — not read (yet, or not here). */
  let runPipeline = $state.raw<Pipeline | null>(null);
  let fromCommit = $state<boolean | null>(null);
  let replay = $state(0);
  let now = $state(Date.now());
  let host = $state<HTMLElement | null>(null);

  /** The repository of the file and its forge, found once. */
  async function findRepo(): Promise<Repo | null> {
    if (repo && repoRoot) return repo;
    if (!sessionId) return null;
    const found = await repoOfFile(sessionId, path);
    repoRoot = found?.root ?? null;
    repo = repo ?? found?.repo ?? null;
    return repo;
  }

  async function enterRun(pick: string | null = null) {
    stop();
    source = "run";
    runsFailure = null;
    const sid = sessionId;
    const r = await findRepo();
    if (!sid || !r) {
      runsFailure = { kind: "failed", text: t("pipeline.run.noForge") };
      return;
    }
    const answer = await readRuns(sid, r, { workflow: r.forge === "github" ? baseName(path) : null });
    now = Date.now();
    if (!answer.ok) {
      runsFailure = answer.failure;
      return;
    }
    runs = answer.value;
    const next = pick ?? runId ?? answer.value[0]?.id ?? null;
    if (next !== runId || !runJobs) {
      runId = next;
      await loadRun();
    }
  }

  async function loadRun() {
    const run = theRun;
    const r = repo;
    const sid = sessionId;
    if (!run || !r || !sid) return;
    runJobs = null;
    runPipeline = null;
    fromCommit = null;
    const [jobs, atCommit] = await Promise.all([
      readJobs(sid, r, run.id),
      repoRoot ? fileAtCommit(sid, repoRoot, run.sha, path) : Promise.resolve(null),
    ]);
    // The file at the commit is read before anything is drawn: the jobs are
    // placed on it, not on the current file first and then on another.
    const atFile = atCommit !== null && Y ? await loadPipeline(Y, files, path, atCommit, kind) : null;
    if (runId !== run.id) return;
    if (!atFile) diag.debug("editor", "the workflow at the run's commit is not here: the schema is the current file", { sha: run.sha.slice(0, 12) });
    runPipeline = atFile;
    fromCommit = atFile !== null;
    runJobs = jobs.ok ? jobs.value : [];
    if (!jobs.ok) runsFailure = jobs.failure;
  }

  /** A run still going is read again while the schema is on screen. */
  async function refreshRun() {
    const r = repo;
    const sid = sessionId;
    const run = theRun;
    if (!r || !sid || !run) return;
    const answer = await readRuns(sid, r, { workflow: r.forge === "github" ? baseName(path) : null });
    if (answer.ok) runs = answer.value;
    const jobs = await readJobs(sid, r, run.id);
    if (jobs.ok && runId === run.id) runJobs = jobs.value;
    now = Date.now();
  }

  $effect(() => {
    if (source !== "run" || !theRun || !isActive(theRun.state)) return;
    const id = setInterval(() => {
      now = Date.now();
      // Only while it is seen: a schema in a zone behind another, or a window away, is not.
      if (document.hidden || !host || host.getClientRects().length === 0) return;
      void refreshRun();
    }, 10_000);
    return () => clearInterval(id);
  });

  // The CI panel's asks: "On the schema" — this file, that run (ADR 0069);
  // "Simulation" — the event that starts it, played; "Start" — the form to
  // start it by hand (ADR 0070). The last two wait for the pipeline to be read.
  let askedSeq = 0;
  let pending = $state<"play" | "start" | null>(null);
  $effect(() => {
    const asked = schemaAskOf(sessionId, path);
    if (!asked || asked.seq === askedSeq) return;
    askedSeq = asked.seq;
    untrack(() => {
      if (asked.kind === "run") {
        pending = null;
        repo = asked.repo;
        void enterRun(asked.runId);
      } else pending = asked.kind;
    });
  });
  $effect(() => {
    const want = pending;
    const list = presets;
    if (!want || !pipeline || !list.length) return;
    untrack(() => {
      pending = null;
      source = "sim";
      if (want === "play") {
        pickEvent(Math.max(0, list.findIndex((e) => e.kind !== "call")));
        return;
      }
      const manual = list.findIndex((e) => e.kind === "manual");
      if (manual < 0) return;
      stop();
      eventAt = manual;
      refText = null;
      after(showStartForm, 60);
    });
  });
  /** The start form in view, its first field in focus. */
  function showStartForm() {
    const form = host?.querySelector<HTMLElement>('[data-testid="pipeline-start-form"]');
    if (!form) return;
    form.scrollIntoView({ block: "nearest" });
    form.querySelector<HTMLElement>("input, select")?.focus();
  }

  const shownPipeline = $derived(source === "run" ? (runPipeline ?? pipeline) : pipeline);
  const onSchema = $derived(source === "run" && shownPipeline && runJobs ? runOnSchema(shownPipeline, runJobs) : null);
  const tl = $derived(source === "run" && theRun && runJobs ? timeline(theRun, runJobs, shownPipeline, now) : null);
  /** A job's real length on its card: the longest of its copies and called jobs. */
  const notes = $derived(onSchema ? jobNotes(onSchema, now) : {});

  // ── What in the file lets someone else's code run (GitHub) ────────────────
  const findings = $derived<Finding[]>(doc && pipeline?.kind === "github" ? auditWorkflow(doc, text) : []);
  let openFinding = $state<string | null>(null);
  let pinning = $state(false);
  async function pinAll(f: Finding) {
    const sid = sessionId;
    if (!sid || !onedit || pinning) return;
    pinning = true;
    try {
      const shas = new Map<string, string>();
      for (const p of f.pins) {
        const key = `${p.repo}@${p.ref}`;
        if (shas.has(key)) continue;
        const answer = await pinCommit(sid, p.repo, p.ref);
        if (!answer.ok) {
          notifyError(t("pipeline.audit.pinFailed", { action: key, why: problemTitle(answer.failure, "gh", "github.com") }), { source: "editor", sessionId: sid });
          return;
        }
        shas.set(key, answer.value);
      }
      onedit(pinText(text, f.pins.map((p) => ({ ...p, sha: shas.get(`${p.repo}@${p.ref}`) ?? "" }))));
      notifySuccess(t("pipeline.audit.pinned", { n: shas.size }), { source: "editor", sessionId: sid });
    } finally {
      pinning = false;
    }
  }

  // ── Starting it by hand ───────────────────────────────────────────────────
  const fields = $derived<FormField[] | null>(
    !doc || !pipeline ? null : pipeline.kind === "github" ? dispatchFields(doc) : pipelineFields(doc),
  );
  let values = $state<Record<string, string>>({});
  let formTried = $state(false);
  const problemsOfForm = $derived(fields ? formProblems(fields, values) : []);
  let startAsk = $state<{ repo: Repo; ref: string; values: Record<string, string>; prod: string[] } | null>(null);
  async function askStart() {
    formTried = true;
    if (!fields || problemsOfForm.length || !event) return;
    const r = await findRepo();
    if (!r) {
      notifyError(t("pipeline.run.noForge"), { source: "editor", sessionId });
      return;
    }
    startAsk = { repo: r, ref: event.ref, values: formValues(fields, values), prod: prodFields(fields, values) };
  }
  async function confirmStart() {
    const a = startAsk;
    startAsk = null;
    if (!a || !sessionId) return;
    const failed = await startRun(sessionId, a.repo, a.repo.forge === "github" ? baseName(path) : null, a.ref, a.values);
    if (!failed) {
      formTried = false;
      // The new run, on the schema, as soon as the forge lists it.
      after(() => {
        runId = null;
        runJobs = null;
        void enterRun(null);
      }, 3000);
    }
  }

  const states = $derived<Record<string, RunState>>(
    onSchema ? onSchema.states : pb ? pb.states : plan ? planStates(plan) : {},
  );
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
  const verdict = $derived(source === "sim" && plan && job ? (plan.jobs.get(job.id) ?? null) : null);

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
  /** What the states of a real run look like on the schema. */
  const RUN_LEGEND = [
    { icon: "circleCheck", tone: "text-ok", key: "pipeline.run.legend.ok" },
    { icon: "circleX", tone: "text-bad", key: "pipeline.run.legend.fail" },
    { icon: "loader", tone: "text-accent", key: "pipeline.run.legend.run" },
    { icon: "circleDashed", tone: "text-muted", key: "pipeline.run.legend.wait" },
    { icon: "play", tone: "text-warn", key: "pipeline.run.legend.gate" },
    { icon: "circleOff", tone: "text-muted", key: "pipeline.run.legend.skip" },
  ] as const;
</script>

<div class="flex h-full min-h-0 flex-col @container" data-testid="pipeline-view" bind:this={host}>
  {#if !pipeline}
    <div class="flex flex-1 items-center justify-center p-4 text-xs text-muted">
      {failed ?? t("pipeline.loading")}
    </div>
  {:else}
    <!-- The event bar: what happens, on which branch; the columns; playback. -->
    <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-edge bg-panel-alt px-2 py-1 text-meta">
      {#if sessionId}
        <!-- What the schema shows: what an event would do, or what a real run did (ADR 0069). -->
        <div class="flex overflow-hidden rounded border border-edge" role="radiogroup" aria-label={t("pipeline.run.source")}>
          <button
            type="button"
            role="radio"
            aria-checked={source === "sim"}
            class="px-2 py-0.5 {source === 'sim' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
            onclick={() => (source = "sim")}
          >
            {t("pipeline.run.sim")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={source === "run"}
            class="border-l border-edge px-2 py-0.5 {source === 'run' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
            data-testid="pipeline-source-run"
            onclick={() => void enterRun()}
          >
            {t("pipeline.run.run")}
          </button>
        </div>
      {/if}
      {#if source === "run"}
        {#if runs?.length}
          <select
            class="min-w-0 max-w-[50%] truncate rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-text"
            aria-label={t("pipeline.run.pick")}
            value={runId ?? ""}
            onchange={(e) => {
              runId = (e.currentTarget as HTMLSelectElement).value;
              void loadRun();
            }}
          >
            {#each runs as r (r.id)}
              <option value={r.id}>{runName(r)} · {r.branch ?? r.sha.slice(0, 7)} · {stateText(r.state)} · {compactAge(r.created, now)}</option>
            {/each}
          </select>
        {/if}
        <div class="flex overflow-hidden rounded border border-edge" role="radiogroup" aria-label={t("pipeline.run.view")}>
          {#each [{ v: "order", k: "pipeline.run.order" }, { v: "time", k: "pipeline.run.time" }] as const as m, i (m.v)}
            <button
              type="button"
              role="radio"
              aria-checked={runView === m.v}
              class="px-2 py-0.5 {i ? 'border-l border-edge' : ''} {runView === m.v ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
              onclick={() => (runView = m.v)}
            >
              {t(m.k)}
            </button>
          {/each}
        </div>
        <span class="ml-auto flex items-center gap-1 whitespace-nowrap text-muted" data-testid="pipeline-run-status">
          {#if theRun}
            <Icon name={STATE_ICON[theRun.state]} size={12} class="{STATE_TONE[theRun.state]} {theRun.state === 'running' ? 'animate-spin' : ''}" />
            {stateText(theRun.state)}{#if theRun.started !== null} · {durationText((theRun.finished ?? now) - theRun.started)}{/if}
          {/if}
        </span>
        {#if runView === "time" && tl}
          <button
            type="button"
            class="flex items-center gap-1 rounded bg-edge px-2 py-0.5 text-text hover:bg-accent hover:text-panel-alt"
            use:tooltip={t("pipeline.run.replayHint")}
            data-testid="pipeline-replay"
            onclick={() => replay++}
          >
            <Icon name="play" size={12} />{t("pipeline.play")}
          </button>
        {/if}
        {#if theRun?.url}
          {@const url = theRun.url}
          <button type="button" class="rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("pipeline.run.web")} use:tooltip={t("pipeline.run.web")} onclick={() => clickLink(url)}>
            <Icon name="globe" size={13} />
          </button>
        {/if}
      {:else}
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
      {/if}
    </div>

    {#if source === "run"}
      <!-- Where the schema comes from, and what of the run it does not explain. -->
      <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-edge px-2.5 py-1 text-meta text-muted" data-testid="pipeline-run-note">
        {#if runsFailure}
          <span class="text-warn"><Icon name="alert" size={12} /> {repo ? problemTitle(runsFailure, CLI[repo.forge], repo.host) : runsFailure.text}</span>
        {:else if !runs}
          <span>{t("pipeline.run.reading")}</span>
        {:else if !runs.length}
          <span>{t("pipeline.run.none")}</span>
        {:else if theRun && fromCommit !== null}
          <span class="flex items-center gap-1">
            <Icon name="gitCommit" size={12} />
            {fromCommit ? t("pipeline.run.atCommit", { sha: theRun.sha.slice(0, 7) }) : t("pipeline.run.currentFile", { sha: theRun.sha.slice(0, 7) })}
          </span>
          {#if onSchema && runJobs}
            <span>· {t("pipeline.run.matched", { n: runJobs.length - onSchema.unmatched.length, total: runJobs.length })}</span>
            {#if onSchema.unmatched.length}
              <span class="min-w-0 truncate text-warn" use:tooltip={onSchema.unmatched.map((j) => j.name).join("\n")}>
                · {t("pipeline.run.unmatched", { names: onSchema.unmatched.map((j) => j.name).join(", ") })}
              </span>
            {/if}
          {/if}
        {/if}
      </div>
    {/if}

    {#if source === "sim" && event?.kind === "manual" && fields && sessionId}
      <!-- Start it by hand: the form the file describes (ADR 0069). -->
      <div class="shrink-0 border-b border-edge bg-panel px-2.5 py-2 text-xs" data-testid="pipeline-start-form">
        <div class="mb-1.5 text-caption uppercase tracking-wider text-muted">
          {t(pipeline.kind === "github" ? "pipeline.start.titleGithub" : "pipeline.start.titleGitlab", { ref: event.ref })}
        </div>
        {#if fields.length}
          <div class="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5">
            {#each fields as f (f.name)}
              {@const bad = formTried ? problemsOfForm.find((p) => p.name === f.name) : undefined}
              <label class="truncate text-muted" for={`pf-${f.name}`} use:tooltip={f.description ?? f.name}>{f.name}{f.required ? " *" : ""}</label>
              <div class="min-w-0">
                {#if f.kind === "boolean"}
                  <input
                    id={`pf-${f.name}`}
                    type="checkbox"
                    checked={(values[f.name] ?? f.value) === "true"}
                    onchange={(e) => (values = { ...values, [f.name]: (e.currentTarget as HTMLInputElement).checked ? "true" : "false" })}
                  />
                {:else if f.kind === "choice" && f.options.length}
                  <select
                    id={`pf-${f.name}`}
                    class="w-full rounded border border-edge bg-panel-alt px-1.5 py-0.5 text-meta text-text"
                    value={values[f.name] ?? f.value}
                    onchange={(e) => (values = { ...values, [f.name]: (e.currentTarget as HTMLSelectElement).value })}
                  >
                    {#each f.options as o (o)}<option value={o}>{o}</option>{/each}
                  </select>
                {:else}
                  <input
                    id={`pf-${f.name}`}
                    class="w-full rounded border bg-panel-alt px-1.5 py-0.5 text-meta text-text {bad ? 'border-bad' : 'border-edge'}"
                    inputmode={f.kind === "number" ? "decimal" : undefined}
                    placeholder={f.description ?? ""}
                    value={values[f.name] ?? f.value}
                    oninput={(e) => (values = { ...values, [f.name]: (e.currentTarget as HTMLInputElement).value })}
                  />
                {/if}
                {#if bad}<p class="mt-0.5 text-meta text-bad">{t(`pipeline.start.bad.${bad.kind}` as const)}</p>{/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-muted">{t("pipeline.start.noInputs")}</p>
        {/if}
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={() => play()}>
            <Icon name="play" size={12} />{t("pipeline.start.playHere")}
          </button>
          <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" data-testid="pipeline-start" onclick={() => void askStart()}>
            <Icon name="rocket" size={12} />{t(pipeline.kind === "github" ? "pipeline.start.onGithub" : "pipeline.start.onGitlab")}
          </button>
          {#if prodFields(fields, values).length}
            <span class="text-meta text-bad">{t("pipeline.start.prodNote", { names: prodFields(fields, values).join(", ") })}</span>
          {/if}
        </div>
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if source === "run" && runView === "time" && tl}
        <div class="bg-panel-alt/40">
          <PipelineTimeline
            {tl}
            {now}
            {replay}
            selected={selected ? (tl.rows.find((r) => r.key === `call:${selected}` || (r.job && onSchema?.jobsOf[selected ?? ""]?.includes(r.job)))?.key ?? null) : null}
            onpick={(row) => {
              const id = row.key.startsWith("call:") ? row.key.slice(5) : Object.entries(onSchema?.jobsOf ?? {}).find(([, list]) => row.job && list.includes(row.job))?.[0];
              if (id) selected = id;
            }}
          />
        </div>
      {:else if shownPipeline && shownPipeline.jobs.length}
        <div class="bg-panel-alt/40">
          <PipelineGraph
            pipeline={shownPipeline}
            {mode}
            {open}
            {states}
            plan={source === "sim" ? plan : null}
            {selected}
            live={source === "run"}
            notes={source === "run" ? notes : {}}
            stepMs={stepMs()}
            events={source === "sim" ? presets.map((e, i) => ({ id: String(i), label: pipelineEventText(pipeline!.kind, e) })) : []}
            event={String(Math.min(eventAt, Math.max(0, presets.length - 1)))}
            onevent={(id) => pickEvent(Number(id))}
            onselect={(id) => (selected = selected === id ? null : id)}
            ontoggle={toggle}
            ongate={letGo}
          />
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 border-y border-edge px-2.5 py-1 text-meta text-muted">
          {#if source === "run"}
            {#each RUN_LEGEND as l (l.key)}
              <span class="flex items-center gap-1"><Icon name={l.icon} size={11} class={l.tone} />{t(l.key)}</span>
            {/each}
          {:else}
            {#each LEGEND as l (l.key)}
              <span class="flex items-center gap-1"><Icon name={l.icon} size={11} class={l.tone} />{t(l.key)}</span>
            {/each}
          {/if}
        </div>
      {:else}
        <div class="p-4 text-xs text-muted">{t("pipeline.empty")}</div>
      {/if}

      <div class="grid grid-cols-1 bg-panel text-xs {compact ? '' : '@wide:grid-cols-2'}">
        <!-- What the event does, and what the file gets wrong. -->
        <div class="min-w-0 space-y-1 p-2.5">
          {#if source === "sim" && event && plan}
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
          {#if findings.length}
            <!-- What lets someone else's code run with the workflow's token (ADR 0069). -->
            <div class="pt-1.5 text-caption uppercase tracking-wider text-muted" data-testid="pipeline-security">{t("pipeline.audit.title")}</div>
            {#each findings as f (f.code)}
              {@const tone = f.level === "error" ? "text-bad" : f.level === "warn" ? "text-warn" : "text-muted"}
              <div class="rounded px-1 py-0.5 {openFinding === f.code ? 'bg-edge/50' : 'hover:bg-edge'}" data-testid="pipeline-finding">
                <button type="button" class="flex w-full items-start gap-1.5 text-left" aria-expanded={openFinding === f.code} onclick={() => (openFinding = openFinding === f.code ? null : f.code)}>
                  <Icon name={f.level === "error" ? "octagon" : f.level === "warn" ? "alert" : "info"} size={12} class="mt-0.5 {tone}" />
                  <span class="min-w-0 break-words {f.level === 'info' ? 'text-text/80' : tone}">
                    {t(`pipeline.audit.${f.code}` as const, { detail: f.detail })}
                    <span class="text-muted"> · {t("pipeline.audit.lines", { lines: f.lines.join(", ") })}</span>
                  </span>
                </button>
                {#if openFinding === f.code}
                  <p class="ml-5 mt-0.5 text-muted">{t(`pipeline.audit.${f.code}Fix` as const)}</p>
                  <div class="ml-5 mt-1 flex flex-wrap gap-1.5">
                    {#if onjump && f.lines[0]}
                      {@const line = f.lines[0]}
                      <button type="button" class="flex items-center gap-1 text-meta text-accent hover:text-accent-hover" onclick={() => onjump?.(path, line)}>
                        <Icon name="arrowRight" size={11} />{t("pipeline.openInCode")}
                      </button>
                    {/if}
                    {#if f.pins.length && onedit && sessionId}
                      <button
                        type="button"
                        class="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-meta text-text hover:border-accent disabled:opacity-40"
                        disabled={pinning}
                        use:tooltip={t("pipeline.audit.pinHint")}
                        data-testid="pipeline-pin"
                        onclick={() => void pinAll(f)}
                      >
                        <Icon name={pinning ? "loader" : "pin"} size={11} class={pinning ? "animate-spin" : ""} />{t("pipeline.audit.pin")}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
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
            {#if source === "run" && onSchema}
              {@const ran = onSchema.jobsOf[job.id] ?? []}
              <div class="pt-1 text-caption uppercase tracking-wider text-muted">{t("pipeline.run.inRun")}</div>
              {#if !ran.length}
                <p class="text-muted">{t("pipeline.run.notInRun")}</p>
              {/if}
              {#each ran as j (j.id)}
                <div class="flex items-center gap-1.5">
                  <Icon name={STATE_ICON[j.state]} size={12} class="{STATE_TONE[j.state]} {j.state === 'running' ? 'animate-spin' : ''}" />
                  <span class="min-w-0 flex-1 truncate" use:tooltip={j.name}>{j.name}</span>
                  {#if j.started !== null}<span class="tabular-nums text-meta text-muted">{clock((j.finished ?? now) - j.started)}</span>{/if}
                </div>
                {#each j.steps.filter((st) => st.state === "failed") as st (st.number)}
                  <div class="ml-4 flex items-center gap-1 text-meta text-bad"><Icon name="circleX" size={11} />{st.name}</div>
                {/each}
              {/each}
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

<ConfirmDialog
  open={startAsk !== null}
  title={startAsk ? t("pipeline.start.confirm", { file: baseName(path), ref: startAsk.ref }) : ""}
  confirmLabel={t("pipeline.start.go")}
  danger={(startAsk?.prod.length ?? 0) > 0}
  onconfirm={() => void confirmStart()}
  oncancel={() => (startAsk = null)}
>
  {#if startAsk}
    <span class="block">{t("pipeline.start.confirmBody", { cli: CLI[startAsk.repo.forge], host: startAsk.repo.host })}</span>
    {#if Object.keys(startAsk.values).length}
      <code class="mt-1 block break-all rounded bg-panel px-1 py-0.5 text-text/80">{Object.entries(startAsk.values).map(([k, v]) => `${k}=${v}`).join("  ")}</code>
    {/if}
    {#if startAsk.prod.length}
      <span class="mt-1 block text-meta text-danger">{t("pipeline.start.prod", { names: startAsk.prod.join(", ") })}</span>
    {/if}
  {/if}
</ConfirmDialog>
