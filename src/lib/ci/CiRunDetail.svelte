<script module lang="ts">
  import type { CiFailure, LogTail } from "./ciparse";

  /** The log of the job opened: its tail, or why there is none. */
  export interface OpenLog {
    jobId: string;
    tail: LogTail | null;
    failure: CiFailure | null;
    /** A file and line of the repository the log names. */
    place: { path: string; line: number } | null;
  }
</script>

<script lang="ts">
  // One run of the CI panel (ADR 0069): what it is, what can be done with it,
  // its jobs — GitHub's with their steps — and the tail of the log of the job
  // opened, error lines marked. Content, not a dialog: it stands beside the list
  // in a wide panel and in place of it in a narrow one; the questions before a
  // write are the panel's.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { compactAge } from "../ui/age";
  import { isActive, type CiJob, type CiRun } from "./ciparse";
  import { clock } from "./cirun";
  import { durationText, runName, STATE_ICON, STATE_TONE, stateText } from "./citext";

  let {
    run,
    jobs,
    jobsFailure = null,
    open = null,
    log = null,
    watched = false,
    busy = false,
    now,
    onback,
    ontoggle,
    onrerun,
    oncancel,
    onwatch,
    onschema,
    onweb,
    onfulllog,
    onask,
    onplace,
  }: {
    run: CiRun;
    /** null — being read. */
    jobs: CiJob[] | null;
    jobsFailure?: CiFailure | null;
    /** The job opened. */
    open?: string | null;
    log?: OpenLog | null;
    watched?: boolean;
    /** A write is on its way: the buttons wait for it. */
    busy?: boolean;
    now: number;
    /** A narrow panel: back to the list. */
    onback?: () => void;
    ontoggle: (jobId: string) => void;
    onrerun: (failed: boolean) => void;
    oncancel: () => void;
    onwatch: () => void;
    /** The run on its file's schema; absent — the file is not known. */
    onschema?: () => void;
    onweb?: () => void;
    onfulllog: (job: CiJob) => void;
    onask?: (job: CiJob) => void;
    onplace: (place: { path: string; line: number }) => void;
  } = $props();

  const active = $derived(isActive(run.state));
  const failedJobs = $derived(jobs?.some((j) => j.state === "failed" && !j.allowFailure) ?? run.state === "failed");
  const length = $derived(run.started !== null ? (run.finished ?? now) - run.started : null);
  const took = (j: CiJob) => (j.started === null ? null : (j.finished ?? now) - j.started);
  // GitLab's jobs by stage, in the order the pipeline met them.
  const stages = $derived.by(() => {
    if (!jobs || run.forge !== "gitlab") return null;
    const out: { stage: string; jobs: CiJob[] }[] = [];
    for (const j of [...jobs].reverse()) {
      const at = out.find((s) => s.stage === (j.stage ?? ""));
      if (at) at.jobs.push(j);
      else out.push({ stage: j.stage ?? "", jobs: [j] });
    }
    return out;
  });
</script>

{#snippet jobRow(j: CiJob)}
  {@const opened = open === j.id}
  <button
    type="button"
    class="flex h-6 w-full items-center gap-1.5 px-3 text-left text-xs hover:bg-edge/50 {opened ? 'bg-edge/40' : ''}"
    aria-expanded={opened}
    data-testid="ci-job"
    onclick={() => ontoggle(j.id)}
  >
    <Icon name={opened ? "chevronDown" : "chevronRight"} size={11} class="shrink-0 text-muted" />
    <span use:tooltip={stateText(j.state)} class="shrink-0"><Icon name={STATE_ICON[j.state]} size={13} class="{STATE_TONE[j.state]} {j.state === 'running' ? 'animate-spin' : ''}" /></span>
    <span class="min-w-0 flex-1 truncate text-text" use:tooltip={j.name}>{j.name}</span>
    {#if j.allowFailure && j.state === "failed"}<span class="shrink-0 text-meta text-warn">{t("ci.allowedToFail")}</span>{/if}
    {#if took(j) !== null}<span class="shrink-0 tabular-nums text-meta text-muted">{clock(took(j) ?? 0)}</span>{/if}
  </button>
  {#if opened}
    {#each j.steps as st (st.number)}
      <div class="flex h-5 items-center gap-1.5 pl-9 pr-3 text-meta {st.state === 'failed' ? 'bg-bad/10' : ''}" data-testid="ci-step">
        <Icon name={STATE_ICON[st.state]} size={11} class="shrink-0 {STATE_TONE[st.state]} {st.state === 'running' ? 'animate-spin' : ''}" />
        <span class="min-w-0 flex-1 truncate {st.state === 'skipped' ? 'text-muted' : 'text-text'}" use:tooltip={st.name}>{st.name}</span>
        <span class="shrink-0 tabular-nums text-muted">{st.started !== null && st.finished !== null ? clock(st.finished - st.started) : "—"}</span>
      </div>
    {/each}
    {#if log && log.jobId === j.id}
      <div class="mx-3 mb-1.5 ml-9 mt-1" data-testid="ci-log">
        {#if log.failure}
          <p class="text-meta text-warn">{t("ci.logUnread")} — {log.failure.text}</p>
        {:else if !log.tail}
          <Skeleton height="3rem" />
        {:else}
          <div class="mb-1 text-caption text-muted">{t("ci.logTail", { n: log.tail.lines.length, total: log.tail.total })}</div>
          <pre class="max-h-56 overflow-auto rounded border bg-panel-alt px-2 py-1 font-mono text-meta leading-relaxed {j.state === 'failed' ? 'border-bad/40' : 'border-edge'}">{#each log.tail.lines as l, i (i)}<span class={l.error ? "text-bad" : "text-text/90"}>{l.text}</span>{"\n"}{/each}</pre>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={() => onfulllog(j)}>
              <Icon name="file" size={12} />{t("ci.fullLog")}
            </button>
            {#if onask}
              <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" onclick={() => onask?.(j)}>
                <Icon name="aiMark" size={12} />{t("ai.ask.button")}
              </button>
            {/if}
            {#if log.place}
              {@const place = log.place}
              <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" use:tooltip={`${place.path}:${place.line}`} onclick={() => onplace(place)}>
                <Icon name="code" size={12} />{t("ci.toLine", { line: place.line })}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {:else if j.state === "running" || j.state === "queued"}
      <p class="mb-1 ml-9 px-3 text-meta text-muted">{t(run.forge === "github" ? "ci.logAfter" : "ci.logLoading")}</p>
    {/if}
  {/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="ci-run-detail">
  <div class="shrink-0 border-b border-edge px-3 py-2">
    <div class="flex min-w-0 items-center gap-1.5">
      {#if onback}
        <button type="button" class="rounded p-0.5 text-muted hover:bg-edge hover:text-text" aria-label={t("ci.back")} use:tooltip={t("ci.back")} onclick={onback}>
          <Icon name="arrowLeft" size={13} />
        </button>
      {/if}
      <span use:tooltip={stateText(run.state)}><Icon name={STATE_ICON[run.state]} size={14} class="{STATE_TONE[run.state]} {run.state === 'running' ? 'animate-spin' : ''}" /></span>
      <span class="shrink-0 text-xs font-medium text-text">{runName(run)}</span>
      {#if run.title}<span class="min-w-0 truncate text-xs text-muted" use:tooltip={run.title}>{run.title}</span>{/if}
    </div>
    <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-muted">
      {#if run.branch}<span class="flex min-w-0 items-center gap-0.5"><Icon name="gitBranch" size={11} /><span class="truncate">{run.branch}</span></span>{/if}
      <span>· {run.event}</span>
      {#if run.sha}<span class="font-mono">· {run.sha.slice(0, 7)}</span>{/if}
      {#if length !== null}<span>· {durationText(length)}</span>{/if}
      <span>· {compactAge(run.created, now)}</span>
      {#if run.attempt > 1}<span>· {t("ci.attempt", { n: run.attempt })}</span>{/if}
    </div>
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#if active}
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-danger hover:text-danger disabled:opacity-40" disabled={busy} data-testid="ci-cancel" onclick={oncancel}>
          <Icon name="stop" size={12} />{t("ci.cancel")}
        </button>
        <button type="button" class="flex items-center gap-1 rounded border px-2 py-0.5 text-meta {watched ? 'border-accent text-accent' : 'border-edge text-text hover:border-accent'}" aria-pressed={watched} use:tooltip={t("ci.watchHint")} data-testid="ci-watch" onclick={onwatch}>
          <Icon name="eye" size={12} />{watched ? t("ci.watching") : t("ci.watch")}
        </button>
      {:else}
        {#if failedJobs}
          <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent disabled:opacity-40" disabled={busy} data-testid="ci-rerun-failed" onclick={() => onrerun(true)}>
            <Icon name="refresh" size={12} />{t("ci.rerunFailed")}
          </button>
        {/if}
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent disabled:opacity-40" disabled={busy} data-testid="ci-rerun" onclick={() => onrerun(false)}>
          <Icon name="refresh" size={12} />{t("ci.rerunAll")}
        </button>
      {/if}
      {#if onschema}
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" data-testid="ci-schema" onclick={onschema}>
          <Icon name="hierarchy" size={12} />{t("ci.schema")}
        </button>
      {/if}
      {#if onweb}
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-muted hover:border-accent hover:text-text" onclick={onweb}>
          <Icon name="globe" size={12} />{t(run.forge === "github" ? "ci.onGithub" : "ci.onGitlab")}
        </button>
      {/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto py-1">
    {#if jobsFailure}
      <p class="px-3 py-2 text-xs text-warn">{t("ci.jobsUnread")} — {jobsFailure.text}</p>
    {:else if !jobs}
      <div class="space-y-1.5 px-3 py-2"><Skeleton /><Skeleton width="80%" /><Skeleton width="60%" /></div>
    {:else if !jobs.length}
      <p class="px-3 py-2 text-xs text-muted">{t("ci.noJobs")}</p>
    {:else if stages}
      {#each stages as s (s.stage)}
        <div class="px-3 pb-0.5 pt-1.5 text-caption uppercase tracking-wider text-muted">{s.stage}</div>
        {#each s.jobs as j (j.id)}{@render jobRow(j)}{/each}
      {/each}
    {:else}
      {#each jobs as j (j.id)}{@render jobRow(j)}{/each}
    {/if}
  </div>
</div>
