<script lang="ts">
  // The CI panel (ADR 0069, 0070): the repository the terminal is in, as two
  // tabs. «Pipelines» — its pipeline files, read as the schema reads them, each
  // with its jobs as dots coloured by its latest run, and the way into the
  // schema; they stand without the forge. «Runs» — its runs, GitHub Actions
  // through `gh`, GitLab CI through `glab`, the user's own, on the host the
  // session runs on. Each a list (filter, groups, order — ADR 0050), the item
  // picked beside it in a wide panel and in its place in a narrow one.
  // Read while the panel is on screen: every 10 s while something runs, every
  // minute otherwise. Every write asks first, on production in red.
  import { untrack } from "svelte";
  import { wideWhen } from "../actions/panelwide.svelte";
  import { tooltip } from "../actions/tooltip";
  import { gitRun } from "../api";
  import { diag } from "../api/diag";
  import { repoRootArgs } from "../git/git";
  import { t } from "../i18n";
  import { gitCwd } from "../pathsync/followcwd";
  import { aboutSession } from "../stores/diag.svelte";
  import { dockCwd } from "../stores/dockstate.svelte";
  import { clickLink } from "../stores/linkopen.svelte";
  import { listOrder, setListOrder } from "../stores/listview.svelte";
  import { settings } from "../settings/settings.svelte";
  import type { PipelineGroup } from "../pipeline/pipeload";
  import type { Pipeline } from "../pipeline/pipeline";
  import { buildMap } from "../pipeline/pipemap";
  import type { RunState } from "../pipeline/pipeplay";
  import PipelineDots from "../pipeline/PipelineDots.svelte";
  import {
    cancelRun,
    checkAuth,
    isWatched,
    readJobs,
    readLog,
    readPipelines,
    readRuns,
    repoRemotes,
    rerunRun,
    setHostForge,
    unwatchRun,
    watchRun,
  } from "../stores/ci.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import Icon from "../ui/Icon.svelte";
  import ListHeader from "../ui/ListHeader.svelte";
  import PollFailStrip from "../ui/PollFailStrip.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { compactAge } from "../ui/age";
  import type { OpenMenu } from "../ui/ctxmenu";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import { applyView, filterSummary, NO_FILTER, type ListFilter, type ListOrder, type ListSchema } from "../ui/listview";
  import { pollFailed, singleFlight, type PollFailure } from "../ui/poll";
  import { isActive, logPlaces, logTail, type CiFailure, type CiJob, type CiRun } from "./ciparse";
  import { jobsToRead, ownerOf, pipeRows, type HeldJobs, type PipeRow } from "./cipipes";
  import { clock, jobNotes, runOnSchema } from "./cirun";
  import CiPipelines from "./CiPipelines.svelte";
  import { problemHint, problemTitle, runName, STATE_ICON, STATE_TONE, stateText } from "./citext";
  import CiRunDetail, { type OpenLog } from "./CiRunDetail.svelte";
  import { CLI, FORGES, isKnown, pickRepo, repoWebUrl, type Repo, type RepoRemote } from "./forge";

  let {
    sessionId,
    visible = true,
    sessionReady = true,
    prod = false,
    terminalCwd = null,
    followTerminal = false,
    onAsk,
    onOpenFile,
    onOpenSchema,
    onOpenLog,
    onTypeInTerminal,
    local = false,
    onOpenPipeline,
    onPipelines,
  }: {
    sessionId: string;
    /** On screen: the panel reads only then (`dockpanels.guard`). */
    visible?: boolean;
    sessionReady?: boolean;
    prod?: boolean;
    terminalCwd?: string | null;
    followTerminal?: boolean;
    /** A failed job, its log tail and what it is, to the assistant. */
    onAsk?: (context: string) => void;
    /** A file of the repository, at a line. */
    onOpenFile?: (path: string, line: number) => void;
    /** The run on its workflow file's schema. */
    onOpenSchema?: (path: string, repo: Repo, run: CiRun) => void;
    /** A whole log, as a document to read. */
    onOpenLog?: (name: string, text: string) => void;
    /** "Sign in": the CLI's own login, typed into this tab's terminal. */
    onTypeInTerminal?: (argv: string[]) => void;
    /** A local tab: the repository's files are this computer's, not a server's. */
    local?: boolean;
    /** A pipeline file on its schema: as it is, its event played, or on the form to start it (ADR 0070). */
    onOpenPipeline?: (path: string, ask: "play" | "start" | null) => void;
    /** The map of the repository's pipelines. */
    onPipelines?: (targets: { path: string; isDir: boolean }[]) => void;
  } = $props();

  /** How often the list is read: while a run goes on, and otherwise. */
  const FAST_MS = 10_000;
  const SLOW_MS = 60_000;

  const cwd = $derived(gitCwd(followTerminal, dockCwd(sessionId), terminalCwd));
  let root = $state<string | null>(null);
  let repos = $state.raw<RepoRemote[]>([]);
  let picked = $state<string | null>(null);
  const shown = $derived(pickRepo(repos, picked));
  const repo = $derived<Repo | null>(isKnown(shown) ? shown : null);

  type Phase = "idle" | "checking" | "noRepo" | "noRemote" | "unknown" | "problem" | "ready";
  let phase = $state<Phase>("idle");
  let problem = $state<CiFailure | null>(null);
  let runs = $state.raw<CiRun[] | null>(null);
  let readAt = 0;
  let failure = $state<PollFailure | null>(null);
  let now = $state(Date.now());

  let wide = $state(false);
  let selected = $state<string | null>(null);
  const run = $derived(runs?.find((r) => r.id === selected) ?? null);
  let jobs = $state.raw<CiJob[] | null>(null);
  let jobsFailure = $state<CiFailure | null>(null);
  let openJob = $state<string | null>(null);
  let log = $state.raw<OpenLog | null>(null);
  let busy = $state(false);

  // ── Two tabs: the pipelines and their runs (ADR 0070) ─────────────────────
  type CiTab = "pipelines" | "runs";
  /** Picked here since the repository was found; null — the stored choice decides. */
  let tabPick = $state<CiTab | null>(null);
  /** The runs cannot be read here: no remote, a host nobody named, the CLI missing or signed out. */
  const blocked = $derived(phase === "noRemote" || phase === "unknown" || phase === "problem");
  const tab = $derived<CiTab>(tabPick ?? (blocked ? "pipelines" : settings.ciTab));
  function pickTab(next: CiTab) {
    tabPick = next;
    settings.ciTab = next;
  }

  let group = $state.raw<PipelineGroup | null>(null);
  let pipesError = $state<string | null>(null);
  let pipesAt = 0;
  let failedSaid = "";
  let pipeSelected = $state<string | null>(null);
  let pipeFilter = $state<ListFilter>(NO_FILTER);
  const pipes = $derived(group && root ? pipeRows(buildMap(group.pipelines), root, runs) : null);
  /** Runs' jobs read for the dots and the preview: each pipeline's latest run, and the run opened. */
  let held = $state.raw<ReadonlyMap<string, HeldJobs>>(new Map());
  /** The pipeline each run of the list belongs to, when the panel can tell. */
  const pipeOfRun = $derived.by(() => {
    const out = new Map<string, Pipeline>();
    if (!pipes || !runs) return out;
    for (const r of runs) {
      const owner = ownerOf(r, pipes);
      const row = owner ? pipes.find((p) => p.id === owner) : undefined;
      if (row) out.set(r.id, row.pipeline);
    }
    return out;
  });
  function onPipeline(run: CiRun | undefined, pipeline: Pipeline) {
    const h = run ? held.get(run.id) : undefined;
    return h ? runOnSchema(pipeline, h.jobs) : null;
  }
  const runStates = (run: CiRun | undefined, pipeline: Pipeline): Record<string, RunState> | null => onPipeline(run, pipeline)?.states ?? null;
  function hold(run: CiRun, list: CiJob[]) {
    const next = new Map(held);
    next.set(run.id, { state: run.state, attempt: run.attempt, jobs: list });
    held = next;
  }

  /** The repository's pipelines, from its files — whatever the forge says. */
  const readPipes = singleFlight(async () => {
    const top = root;
    if (!top) return;
    try {
      const next = await readPipelines(sessionId, local, top);
      if (top !== root) return;
      pipesAt = Date.now();
      pipesError = null;
      group = next;
      const said = next.failed.map((f) => f.path).join("\n");
      if (said && said !== failedSaid) {
        const first = next.failed[0];
        diag.warn("ci", "pipeline files of the repository were not read: the CI panel lists the rest", { count: next.failed.length, path: first.path, said: first.detail }, aboutSession(sessionId));
      }
      failedSaid = said;
    } catch (e) {
      if (top !== root) return;
      pipesError = String(e);
      diag.warn("ci", "the pipelines of the repository were not read: the YAML parser did not load", { said: String(e) }, aboutSession(sessionId));
    }
  });

  /** The jobs of each pipeline's latest run, for its dots: a run that ended once, a running one with every read. */
  const readLatestJobs = singleFlight(async () => {
    const r = repo;
    const list = pipes;
    if (!r || !list) return;
    for (const run of jobsToRead(list, held)) {
      const answer = await readJobs(sessionId, r, run.id);
      if (r !== repo) return;
      if (!answer.ok) {
        // The forge said no: the dots stay grey, the rest wait for the next read of the list.
        diag.debug("ci", "the jobs of a pipeline's latest run were not read: its dots stay grey", { run: run.id, kind: answer.failure.kind }, aboutSession(sessionId));
        return;
      }
      hold(run, answer.value);
    }
  });
  // With every new list (and back on screen): what the dots still lack.
  $effect(() => {
    void pipes;
    if (!visible || !sessionReady || phase !== "ready") return;
    untrack(() => void readLatestJobs());
  });

  function runsOf(row: PipeRow) {
    filter = { text: "", facets: { workflow: [row.runs[0]?.workflow || "—"] } };
    selected = null;
    pickTab("runs");
  }

  // ── Where the runs are ────────────────────────────────────────────────────
  let located: string | null = null;
  async function locate(force = false) {
    const at = cwd;
    if (!at || (!force && at === located)) return;
    located = at;
    phase = "checking";
    problem = null;
    const top = await gitRun(sessionId, at, repoRootArgs());
    if (at !== cwd) return;
    if (top.exitCode !== 0) {
      root = null;
      group = null;
      repos = [];
      phase = "noRepo";
      return;
    }
    const found = top.stdout.trim();
    if (found !== root) {
      // Another repository: nothing of the last one stands.
      root = found;
      group = null;
      pipesError = null;
      failedSaid = "";
      held = new Map();
      pipeSelected = null;
      pipeFilter = NO_FILTER;
      tabPick = null;
    }
    void readPipes();
    repos = (await repoRemotes(sessionId, found)) ?? [];
    await settle();
  }

  /** With the repository known: is the CLI there and signed in, then the list. */
  async function settle() {
    runs = null;
    selected = null;
    if (!shown) return void (phase = "noRemote");
    if (!repo) return void (phase = "unknown");
    phase = "checking";
    const said = await checkAuth(sessionId, repo);
    if (said) {
      problem = said;
      phase = "problem";
      diag.info("ci", "the CI panel cannot read runs here", { cli: CLI[repo.forge], kind: said.kind }, aboutSession(sessionId));
      return;
    }
    phase = "ready";
    void refresh();
  }

  function pickRemote(name: string) {
    picked = name;
    void settle();
  }

  function sayForge(forge: "github" | "gitlab") {
    if (!shown) return;
    setHostForge(shown.host, forge);
    repos = repos.map((r) => (r.host === shown.host ? { ...r, forge } : r));
    void settle();
  }

  // Found again when the directory changes — read only while on screen.
  $effect(() => {
    void cwd;
    if (!(visible && sessionReady)) return;
    untrack(() => void locate());
  });

  // ── Reading ───────────────────────────────────────────────────────────────
  const refresh = singleFlight(async () => {
    const r = repo;
    if (!r || phase !== "ready") return;
    const answer = await readRuns(sessionId, r);
    now = Date.now();
    readAt = now;
    if (r !== repo) return;
    if (!answer.ok) {
      const next = pollFailed(failure, answer.failure.text || answer.failure.kind, now);
      if (next.news) diag.warn("ci", `the runs were not read: ${answer.failure.kind}`, { said: answer.failure.text }, aboutSession(sessionId));
      failure = next.failure;
      if (answer.failure.kind === "signedOut" || answer.failure.kind === "missing") {
        problem = answer.failure;
        phase = "problem";
      }
      return;
    }
    failure = null;
    runs = answer.value;
    if (selected) await loadJobs(false);
  });

  const busyList = $derived(runs?.some((r) => isActive(r.state)) ?? false);

  // Asked again while on screen: fast while a run goes on, slowly otherwise.
  $effect(() => {
    if (!visible || !sessionReady || phase !== "ready") return;
    const id = setInterval(() => {
      now = Date.now();
      if (now - readAt >= (busyList ? FAST_MS : SLOW_MS)) void refresh();
    }, 2_000);
    return () => clearInterval(id);
  });

  // Back on screen: one read at once, not whatever was there when it was left.
  let wasVisible = untrack(() => visible);
  $effect(() => {
    const back = visible && !wasVisible;
    wasVisible = visible;
    if (!back) return;
    untrack(() => {
      if (phase === "ready") void refresh();
      // The files change seldom: read again only when the last read is a while old.
      if (root && Date.now() - pipesAt > SLOW_MS) void readPipes();
    });
  });

  async function loadJobs(fresh: boolean) {
    const r = repo;
    const picked = run;
    if (!r || !picked) return;
    if (fresh) {
      jobs = null;
      jobsFailure = null;
    }
    // A run that ended has its jobs for good: read once.
    if (!fresh && jobs && !isActive(picked.state)) return;
    const answer = await readJobs(sessionId, r, picked.id);
    if (selected !== picked.id) return;
    if (!answer.ok) {
      jobsFailure = answer.failure;
      return;
    }
    jobsFailure = null;
    jobs = answer.value;
    hold(picked, answer.value);
    if (fresh && openJob === null) {
      const bad = answer.value.find((j) => j.state === "failed" && !j.allowFailure);
      if (bad) void toggleJob(bad.id);
    }
  }

  function select(id: string) {
    if (selected === id) return;
    selected = id;
    openJob = null;
    log = null;
    void loadJobs(true);
  }

  async function toggleJob(id: string) {
    if (openJob === id) {
      openJob = null;
      return;
    }
    openJob = id;
    const job = jobs?.find((j) => j.id === id);
    const r = repo;
    if (!job || !r) return;
    // GitHub has a job's log once it is over; GitLab's trace grows as it runs.
    if (r.forge === "github" && isActive(job.state)) return;
    log = { jobId: id, tail: null, failure: null, place: null };
    const answer = await readLog(sessionId, r, id);
    if (openJob !== id) return;
    if (!answer.ok) {
      log = { jobId: id, tail: null, failure: answer.failure, place: null };
      return;
    }
    const tail = logTail(answer.value, 14);
    log = { jobId: id, tail, failure: null, place: null };
    fullLogs.set(id, answer.value);
    // A place the log names — only if it is a file of the repository.
    const top = root;
    if (!top) return;
    for (const place of logPlaces(tail.lines).slice(0, 4)) {
      const known = await gitRun(sessionId, top, ["rev-parse", "--verify", "-q", `HEAD:${place.path}`]);
      if (known.exitCode === 0) {
        if (openJob === id && log?.jobId === id) log = { ...log, place };
        return;
      }
    }
  }
  const fullLogs = new Map<string, string>();

  // ── Writes — each after a question ────────────────────────────────────────
  type Ask = { kind: "rerunFailed" | "rerun" | "cancel"; run: CiRun };
  let asking = $state<Ask | null>(null);

  async function confirmed() {
    const a = asking;
    const r = repo;
    asking = null;
    if (!a || !r) return;
    busy = true;
    try {
      if (a.kind === "cancel") await cancelRun(sessionId, r, a.run);
      else await rerunRun(sessionId, r, a.run, a.kind === "rerunFailed");
      readAt = 0;
      void refresh();
    } finally {
      busy = false;
    }
  }

  function toggleWatch(r: CiRun) {
    if (!repo) return;
    if (isWatched(sessionId, r.id)) unwatchRun(sessionId, r.id);
    else watchRun(sessionId, repo, r);
  }

  function askAi(job: CiJob) {
    const r = run;
    if (!r || !onAsk) return;
    const failedStep = job.steps.find((s) => s.state === "failed");
    const tail = log?.jobId === job.id && log.tail ? log.tail.lines.map((l) => l.text).join("\n") : "";
    onAsk(
      [
        `Run: ${runName(r)} (${r.forge === "github" ? "GitHub Actions" : "GitLab CI"})`,
        r.file ? `Workflow file: ${r.file}` : null,
        `Branch: ${r.branch ?? "—"} · event: ${r.event} · commit: ${r.sha.slice(0, 12)}`,
        `Job: ${job.name} — ${job.state}`,
        failedStep ? `Failed step: ${failedStep.name}` : null,
        tail ? `Log (last lines):\n${tail}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  function openFullLog(job: CiJob) {
    const text = fullLogs.get(job.id);
    if (text === undefined || !run) return;
    onOpenLog?.(`${runName(run)} · ${job.name}.log`, text);
  }

  function schemaOf(r: CiRun): (() => void) | undefined {
    const top = root;
    const rp = repo;
    if (!top || !rp || !onOpenSchema) return undefined;
    const file = r.file ?? (r.forge === "gitlab" ? ".gitlab-ci.yml" : null);
    if (!file) return undefined;
    const sep = top.endsWith("/") ? "" : "/";
    return () => onOpenSchema?.(`${top}${sep}${file}`, rp, r);
  }

  function placeOf(place: { path: string; line: number }) {
    const top = root;
    if (!top) return;
    const sep = top.endsWith("/") ? "" : "/";
    onOpenFile?.(`${top}${sep}${place.path}`, place.line);
  }

  // ── The list ──────────────────────────────────────────────────────────────
  const SCHEMA: ListSchema<CiRun> = {
    text: (r) => `${r.workflow} #${r.number ?? r.id} ${r.title ?? ""} ${r.branch ?? ""} ${r.event} ${r.sha.slice(0, 7)}`,
    sorts: [{ id: "time", firstDir: "desc", compare: (a, b) => a.created - b.created }],
    groups: [
      { id: "workflow", of: (r) => ({ key: r.workflow || "—", label: r.workflow || "—" }) },
      { id: "branch", of: (r) => ({ key: r.branch ?? "—", label: r.branch ?? "—" }) },
    ],
    facets: [
      { id: "workflow", value: (r) => r.workflow || "—" },
      { id: "branch", value: (r) => r.branch ?? "—" },
      { id: "state", value: (r) => r.state, order: ["failed", "running", "queued", "waiting", "manual", "ok", "cancelled", "skipped", "neutral"] },
      { id: "event", value: (r) => r.event || "—" },
    ],
    tie: (a, b) => b.created - a.created,
  };
  const FALLBACK: ListOrder = { sort: { key: "time", dir: "desc" }, group: "none" };
  const LABELS: ListLabels = {
    group: (id) => t(`ci.facet.${id}` as "ci.facet.workflow"),
    sort: () => t("ci.sortTime"),
    facet: (id) => t(`ci.facet.${id}` as "ci.facet.workflow"),
    value: (facet, v) => (facet === "state" ? stateText(v as CiRun["state"]) : v),
  };
  let filter = $state<ListFilter>(NO_FILTER);
  const order = $derived(listOrder("ci.runs", SCHEMA, FALLBACK));
  const view = $derived(runs ? applyView(runs, SCHEMA, filter, order) : null);
  let collapsed = $state.raw<ReadonlySet<string>>(new Set());
  let menu = $state<OpenMenu | null>(null);

  const cli = $derived(repo ? CLI[repo.forge] : "gh");
  const length = (r: CiRun) => (r.started !== null ? (r.finished ?? now) - r.started : null);
</script>

{#snippet runRow(r: CiRun)}
  {@const shape = pipeOfRun.get(r.id)}
  <button
    type="button"
    class="flex w-full items-start gap-2 border-b border-edge/50 px-2.5 py-1.5 text-left hover:bg-edge/40 {selected === r.id && wide ? 'bg-accent/10' : ''}"
    data-testid="ci-run"
    onclick={() => select(r.id)}
  >
    <span class="pt-0.5" use:tooltip={stateText(r.state)}><Icon name={STATE_ICON[r.state]} size={13} class="{STATE_TONE[r.state]} {r.state === 'running' ? 'animate-spin' : ''}" /></span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs text-text">
        <span class="font-medium">{r.workflow || t("ci.pipeline")}</span>
        <span class="text-muted">#{r.number ?? r.id}</span>
        {#if r.title}<span>{r.title}</span>{/if}
      </span>
      <span class="flex min-w-0 items-center gap-1 truncate text-meta text-muted">
        <Icon name="gitBranch" size={10} /><span class="truncate">{r.branch ?? r.sha.slice(0, 7)}</span><span>· {r.event}</span>
      </span>
    </span>
    {#if shape}<span class="self-center"><PipelineDots pipeline={shape} states={runStates(r, shape)} /></span>{/if}
    <span class="shrink-0 text-right">
      <span class="block tabular-nums text-meta {isActive(r.state) ? 'text-accent' : 'text-text'}">{length(r) !== null ? clock(length(r) ?? 0) : "—"}</span>
      <span class="block text-caption text-muted">{compactAge(r.created, now)}</span>
    </span>
  </button>
{/snippet}

{#snippet runsNote()}
  <!-- Why there are no runs here — over the pipelines, which stand without them. -->
  <div class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-edge bg-warn/10 px-2.5 py-1 text-meta text-warn" data-testid="ci-runs-note">
    <Icon name={phase === "problem" && problem?.kind === "missing" ? "wrench" : phase === "problem" && problem?.kind === "signedOut" ? "key" : "alert"} size={12} />
    <span class="min-w-0 flex-1 truncate">
      {#if phase === "noRemote"}{t("ci.noRemote")}{:else if phase === "unknown" && shown}{t("ci.unknownForge", { host: shown.host })}{:else if problem && repo}{problemTitle(problem, cli, repo.host)}{/if}
      · {t("ci.pipes.runsOff")}
    </span>
    {#if phase === "unknown" && shown}
      {#each FORGES as f (f)}
        <button type="button" class="rounded border border-edge px-2 py-0.5 text-text hover:border-accent" onclick={() => sayForge(f)}>{f === "github" ? "GitHub" : "GitLab"}</button>
      {/each}
    {:else if phase === "problem"}
      {#if problem?.kind === "signedOut" && onTypeInTerminal && repo}
        {@const r = repo}
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-text hover:border-accent" onclick={() => onTypeInTerminal?.([cli, "auth", "login", "--hostname", r.host])}>
          <Icon name="terminal" size={12} />{t("ci.signInTerminal")}
        </button>
      {/if}
      <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-text hover:border-accent" onclick={() => void settle()}>
        <Icon name="refresh" size={12} />{t("ci.retry")}
      </button>
    {/if}
  </div>
{/snippet}

<div class="flex h-full min-h-0 flex-col @container" use:wideWhen={(w) => (wide = w)} data-testid="ci-panel">
  <div class="flex shrink-0 items-center gap-1.5 border-b border-edge px-2.5 py-1">
    {#if root && phase !== "noRepo"}
      <!-- What the panel shows: the repository's pipelines, or their runs (ADR 0070). -->
      <div class="flex shrink-0 overflow-hidden rounded border border-edge text-meta" role="radiogroup" aria-label={t("ci.tabs")}>
        <button
          type="button"
          role="radio"
          aria-checked={tab === "pipelines"}
          class="px-2 py-0.5 {tab === 'pipelines' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
          data-testid="ci-tab-pipelines"
          onclick={() => pickTab("pipelines")}
        >
          {t("ci.tab.pipelines")}{#if pipes}<span class="ml-1 tabular-nums text-muted">{pipes.length}</span>{/if}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={tab === "runs"}
          class="border-l border-edge px-2 py-0.5 {tab === 'runs' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-edge hover:text-text'}"
          data-testid="ci-tab-runs"
          onclick={() => pickTab("runs")}
        >
          {t("ci.tab.runs")}{#if runs && !blocked}<span class="ml-1 tabular-nums text-muted">{runs.length}</span>{/if}
        </button>
      </div>
    {/if}
    {#if repos.length}
      <!-- The remote whose runs are shown: origin first; each with its forge. -->
      <select
        class="min-w-0 max-w-[60%] truncate rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-text"
        aria-label={t("ci.remote")}
        value={shown?.remote ?? ""}
        onchange={(e) => pickRemote((e.currentTarget as HTMLSelectElement).value)}
      >
        {#each repos as r (r.remote)}
          <option value={r.remote}>{r.remote} · {r.forge === "github" ? "GitHub" : r.forge === "gitlab" ? "GitLab" : r.host}</option>
        {/each}
      </select>
    {/if}
    <span class="ml-auto truncate text-caption text-muted">
      {#if tab === "runs" && phase === "ready" && runs}{busyList ? t("ci.pollFast") : t("ci.pollSlow")}{/if}
    </span>
    {#if root && onPipelines && pipes?.length}
      {@const top = root}
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
        aria-label={t("ci.pipes.map")}
        use:tooltip={t("ci.pipes.mapHint")}
        data-testid="ci-pipes-map"
        onclick={() => onPipelines?.([{ path: top, isDir: true }])}
      >
        <Icon name="network" size={13} />{#if wide}<span>{t("ci.pipes.map")}</span>{/if}
      </button>
    {/if}
    <button
      type="button"
      class="rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
      aria-label={t("ci.refresh")}
      use:tooltip={t("ci.refresh")}
      disabled={!sessionReady}
      onclick={() => {
        if (root) void readPipes();
        if (phase === "ready") {
          readAt = 0;
          void refresh();
        } else void locate(true);
      }}
    >
      <Icon name="refresh" size={13} />
    </button>
  </div>

  {#if !root && (phase === "idle" || phase === "checking")}
    <div class="space-y-2 p-3"><Skeleton /><Skeleton width="85%" /><Skeleton width="70%" /></div>
  {:else if phase === "noRepo"}
    <EmptyState icon="gitBranch" title={t("ci.noRepo")} hint={t("ci.noRepoHint")} />
  {:else if tab === "pipelines"}
    {#if blocked}{@render runsNote()}{/if}
    <CiPipelines
      rows={pipes}
      failed={group?.failed ?? []}
      error={pipesError}
      {wide}
      {now}
      runsKnown={phase === "ready"}
      selected={pipeSelected}
      filter={pipeFilter}
      statesOf={(row) => runStates(row.runs[0], row.pipeline)}
      notesOf={(row) => {
        const on = onPipeline(row.runs[0], row.pipeline);
        return on ? jobNotes(on, now) : {};
      }}
      onfilter={(next) => (pipeFilter = next)}
      onmenu={(m) => (menu = m)}
      onselect={(id) => (pipeSelected = id)}
      onschema={(row) => onOpenPipeline?.(row.id, null)}
      onplay={(row) => onOpenPipeline?.(row.id, "play")}
      onlast={(row, last) => repo && onOpenSchema?.(row.id, repo, last)}
      onstart={(row) => onOpenPipeline?.(row.id, "start")}
      onruns={runsOf}
    />
  {:else if phase === "checking" && !runs}
    <div class="space-y-2 p-3"><Skeleton /><Skeleton width="85%" /><Skeleton width="70%" /></div>
  {:else if phase === "noRemote"}
    <EmptyState icon="gitBranch" title={t("ci.noRemote")} hint={t("ci.noRemoteHint")} />
  {:else if phase === "unknown" && shown}
    <EmptyState icon="help" title={t("ci.unknownForge", { host: shown.host })} hint={t("ci.unknownForgeHint")}>
      <div class="flex gap-1.5">
        {#each FORGES as f (f)}
          <button type="button" class="rounded border border-edge px-2 py-0.5 text-xs text-text hover:border-accent" onclick={() => sayForge(f)}>
            {f === "github" ? "GitHub" : "GitLab"}
          </button>
        {/each}
      </div>
    </EmptyState>
  {:else if phase === "problem" && problem && repo}
    <EmptyState icon={problem.kind === "missing" ? "wrench" : problem.kind === "signedOut" ? "key" : "alert"} title={problemTitle(problem, cli, repo.host)} hint={problemHint(problem, cli, repo.host)}>
      <div class="flex flex-wrap justify-center gap-1.5">
        {#if problem.kind === "signedOut" && onTypeInTerminal}
          <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-xs text-text hover:border-accent" onclick={() => repo && onTypeInTerminal?.([cli, "auth", "login", "--hostname", repo.host])}>
            <Icon name="terminal" size={12} />{t("ci.signInTerminal")}
          </button>
        {/if}
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-xs text-text hover:border-accent" onclick={() => void settle()}>
          <Icon name="refresh" size={12} />{t("ci.retry")}
        </button>
      </div>
    </EmptyState>
  {:else}
    <PollFailStrip {failure} onretry={() => ((readAt = 0), void refresh())} testid="ci-poll-fail" />
    {#if !wide && run}
      <CiRunDetail
        {run}
        {jobs}
        {jobsFailure}
        open={openJob}
        {log}
        {now}
        {busy}
        watched={isWatched(sessionId, run.id)}
        onback={() => (selected = null)}
        ontoggle={(id) => void toggleJob(id)}
        onrerun={(failed) => run && (asking = { kind: failed ? "rerunFailed" : "rerun", run })}
        oncancel={() => run && (asking = { kind: "cancel", run })}
        onwatch={() => run && toggleWatch(run)}
        onschema={schemaOf(run)}
        onweb={run.url ? () => run?.url && clickLink(run.url) : undefined}
        onfulllog={openFullLog}
        onask={onAsk ? askAi : undefined}
        onplace={placeOf}
      />
    {:else}
      <div class="flex min-h-0 flex-1">
        <div class="flex min-h-0 min-w-0 flex-col {wide ? 'w-[46%] border-r border-edge' : 'flex-1'}">
          {#if runs}
            <ListHeader
              items={runs}
              schema={SCHEMA}
              {filter}
              onfilter={(next) => (filter = next)}
              {order}
              onorder={(o) => setListOrder("ci.runs", o)}
              shown={view?.shown ?? 0}
              total={runs.length}
              labels={LABELS}
              placeholder={t("ci.filter")}
              {wide}
              onmenu={(m) => (menu = m)}
              fold={(c) => (collapsed = c ? new Set(view?.groups.map((g) => g.key)) : new Set())}
              testid="ci-header"
            />
          {/if}
          <div class="min-h-0 flex-1 overflow-y-auto">
            {#if !view}
              <div class="space-y-2 p-3"><Skeleton /><Skeleton width="80%" /></div>
            {:else if !runs?.length}
              <EmptyState icon="rocket" title={t("ci.noRuns")} hint={repo ? repoWebUrl(repo) : undefined} />
            {:else if !view.shown}
              <FilteredEmpty summary={filterSummary(SCHEMA, filter, listMenuText(LABELS))} onreset={() => (filter = NO_FILTER)} testid="ci-filtered-empty" />
            {:else if view.grouped}
              {#each view.groups as g (g.key)}
                <GroupHeader
                  label={g.label}
                  count={g.items.length}
                  collapsed={collapsed.has(g.key)}
                  rest={g.rest}
                  ontoggle={() => {
                    const next = new Set(collapsed);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    collapsed = next;
                  }}
                />
                {#if !collapsed.has(g.key)}
                  {#each g.items as r (r.id)}{@render runRow(r)}{/each}
                {/if}
              {/each}
            {:else}
              {#each view.groups[0]?.items ?? [] as r (r.id)}{@render runRow(r)}{/each}
            {/if}
          </div>
        </div>
        {#if wide}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            {#if run}
              <CiRunDetail
                {run}
                {jobs}
                {jobsFailure}
                open={openJob}
                {log}
                {now}
                {busy}
                watched={isWatched(sessionId, run.id)}
                ontoggle={(id) => void toggleJob(id)}
                onrerun={(failed) => run && (asking = { kind: failed ? "rerunFailed" : "rerun", run })}
                oncancel={() => run && (asking = { kind: "cancel", run })}
                onwatch={() => run && toggleWatch(run)}
                onschema={schemaOf(run)}
                onweb={run.url ? () => run?.url && clickLink(run.url) : undefined}
                onfulllog={openFullLog}
                onask={onAsk ? askAi : undefined}
                onplace={placeOf}
              />
            {:else}
              <EmptyState icon="rocket" title={t("ci.pickRun")} />
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<ContextMenu {menu} onclose={() => (menu = null)} />

<ConfirmDialog
  open={asking !== null}
  title={asking ? t(`ci.confirm.${asking.kind}` as const, { run: runName(asking.run) }) : ""}
  confirmLabel={asking?.kind === "cancel" ? t("ci.cancel") : asking?.kind === "rerunFailed" ? t("ci.rerunFailed") : t("ci.rerunAll")}
  danger={asking?.kind === "cancel" || prod}
  onconfirm={() => void confirmed()}
  oncancel={() => (asking = null)}
>
  {#if asking}
    <span class="block">{t("ci.confirmBody", { cli, host: repo?.host ?? "" })}</span>
    {#if asking.run.branch}<span class="mt-1 block text-meta text-muted">{t("ci.confirmWhere", { branch: asking.run.branch })}</span>{/if}
    {#if prod}
      <span class="mt-1 block text-meta text-danger">{t("ci.confirmProd")}</span>
    {/if}
  {/if}
</ConfirmDialog>
