<script lang="ts">
  // The CI panel's pipelines (ADR 0070): the repository's pipeline files, each
  // with its dots — the jobs in the columns of its schema, coloured by its
  // latest run — and that run's number, length and age. Beside the list in a
  // wide panel, in its place in a narrow one: the pipeline picked — what starts
  // it, its schema in small with that run's states, its recent runs, and the
  // ways into the schema itself (the file on its schema, the event played, the
  // latest run on it, the form to start it). The schema opens in the centre;
  // here it is a preview.
  //
  // The rows come from the files, not from the forge: they stand without gh.
  // Names come from files on a server — text, never markup.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import { listOrder, setListOrder } from "../stores/listview.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import Icon from "../ui/Icon.svelte";
  import ListHeader from "../ui/ListHeader.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import { compactAge } from "../ui/age";
  import type { OpenMenu } from "../ui/ctxmenu";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import { applyView, filterSummary, NO_FILTER, type ListFilter, type ListOrder } from "../ui/listview";
  import PipelineDots from "../pipeline/PipelineDots.svelte";
  import PipelineGraph from "../pipeline/PipelineGraph.svelte";
  import type { PipeFile } from "../pipeline/pipeline";
  import type { RunState } from "../pipeline/pipeplay";
  import { pipelineEventText } from "../pipeline/pipetext";
  import { isActive, type CiRun } from "./ciparse";
  import { PIPE_SCHEMA, type PipeRow } from "./cipipes";
  import { clock } from "./cirun";
  import { runName, STATE_FILL, STATE_ICON, STATE_TONE, stateText } from "./citext";

  let {
    rows,
    failed = [],
    error = null,
    wide,
    now,
    runsKnown,
    selected,
    filter,
    statesOf,
    notesOf,
    onfilter,
    onmenu,
    onselect,
    onschema,
    onplay,
    onlast,
    onstart,
    onruns,
  }: {
    /** null — being read. */
    rows: PipeRow[] | null;
    /** Files found but not read. */
    failed?: PipeFile[];
    /** Why nothing could be read (the YAML parser did not load). */
    error?: string | null;
    wide: boolean;
    now: number;
    /** The runs can be read here: the forge's buttons stand. */
    runsKnown: boolean;
    selected: string | null;
    filter: ListFilter;
    /** The states of a pipeline's latest run, once its jobs were read; null — not known. */
    statesOf: (row: PipeRow) => Record<string, RunState> | null;
    /** That run's lengths by job. */
    notesOf: (row: PipeRow) => Record<string, string>;
    onfilter: (next: ListFilter) => void;
    onmenu: (menu: OpenMenu) => void;
    /** null — back to the list (a narrow panel). */
    onselect: (id: string | null) => void;
    /** The file on its schema. */
    onschema: (row: PipeRow) => void;
    /** The schema with the event that starts it played. */
    onplay: (row: PipeRow) => void;
    /** Its latest run on the schema. */
    onlast: (row: PipeRow, run: CiRun) => void;
    /** The form to start it by hand. */
    onstart: (row: PipeRow) => void;
    /** Its runs, in the runs' list. */
    onruns: (row: PipeRow) => void;
  } = $props();

  const FALLBACK: ListOrder = { sort: { key: "time", dir: "desc" }, group: "none" };
  const LABELS: ListLabels = {
    sort: (id) => (id === "name" ? t("ci.pipes.sortName") : t("ci.sortTime")),
    facet: () => t("ci.facet.state"),
    value: (_facet, v) => stateText(v as CiRun["state"]),
  };
  const order = $derived(listOrder("ci.pipes", PIPE_SCHEMA, FALLBACK));
  const view = $derived(rows ? applyView(rows, PIPE_SCHEMA, filter, order) : null);
  const row = $derived(rows?.find((r) => r.id === selected) ?? null);
  /** Jobs whose matrix copies the preview shows. */
  let open = $state.raw<ReadonlySet<string>>(new Set());

  const length = (r: CiRun) => (r.started !== null ? (r.finished ?? now) - r.started : null);
  /** What starts it, in a line: its events, or who calls it. */
  function startsBy(r: PipeRow): string {
    if (r.called) return r.callers.length ? t("ci.pipes.calledBy", { names: r.callers.join(", ") }) : t("ci.pipes.calledOnly");
    return r.events.map((e) => pipelineEventText(r.kind, e)).join(" · ");
  }
</script>

{#snippet pipeRow(r: PipeRow)}
  {@const last = r.runs[0]}
  <button
    type="button"
    class="flex w-full items-center gap-2 border-b border-edge/50 px-2.5 py-1.5 text-left hover:bg-edge/40 {selected === r.id && wide ? 'bg-accent/10' : ''}"
    data-testid="ci-pipe"
    onclick={() => onselect(r.id)}
  >
    {#if last}
      <span use:tooltip={stateText(last.state)}><Icon name={STATE_ICON[last.state]} size={13} class="{STATE_TONE[last.state]} {last.state === 'running' ? 'animate-spin' : ''}" /></span>
    {:else}
      <Icon name="hierarchy" size={13} class="text-muted" />
    {/if}
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs text-text">
        <span class="font-medium">{r.name}</span>
        <span class="font-mono text-meta text-muted">{r.rel.split("/").pop()}</span>
      </span>
      <span class="block truncate text-meta text-muted">{startsBy(r)}</span>
    </span>
    <PipelineDots pipeline={r.pipeline} states={statesOf(r)} />
    <span class="w-[4.75rem] shrink-0 text-right">
      {#if last}
        <span class="block truncate tabular-nums text-meta {isActive(last.state) ? 'text-accent' : 'text-text'}">#{last.number ?? last.id}</span>
        <span class="block truncate text-caption text-muted">{length(last) !== null ? clock(length(last) ?? 0) : "—"} · {compactAge(last.created, now)}</span>
      {:else}
        <span class="block text-meta text-muted">—</span>
      {/if}
    </span>
  </button>
{/snippet}

{#snippet detail(r: PipeRow)}
  {@const last = r.runs[0]}
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="ci-pipe-detail">
    <div class="shrink-0 border-b border-edge px-3 py-2">
      <div class="flex min-w-0 items-center gap-1.5">
        {#if !wide}
          <button type="button" class="rounded p-0.5 text-muted hover:bg-edge hover:text-text" aria-label={t("ci.pipes.back")} use:tooltip={t("ci.pipes.back")} data-testid="ci-pipe-back" onclick={() => onselect(null)}>
            <Icon name="arrowLeft" size={13} />
          </button>
        {/if}
        <span class="shrink-0 text-xs font-medium text-text">{r.name}</span>
        <span class="min-w-0 truncate font-mono text-meta text-muted" use:tooltip={r.rel}>{r.rel}</span>
        {#if !wide}<span class="ml-auto"><PipelineDots pipeline={r.pipeline} states={statesOf(r)} /></span>{/if}
      </div>
      <div class="mt-0.5 truncate text-meta text-muted">{startsBy(r)}</div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <button type="button" class="flex items-center gap-1 rounded border border-accent/60 px-2 py-0.5 text-meta text-accent hover:border-accent" data-testid="ci-pipe-schema" onclick={() => onschema(r)}>
          <Icon name="hierarchy" size={12} />{t("ci.pipes.schema")}
        </button>
        <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" use:tooltip={t("ci.pipes.playHint")} data-testid="ci-pipe-play" onclick={() => onplay(r)}>
          <Icon name="play" size={12} />{t("ci.pipes.play")}
        </button>
        {#if last && runsKnown}
          <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" use:tooltip={runName(last)} data-testid="ci-pipe-last" onclick={() => onlast(r, last)}>
            <Icon name="history" size={12} />{t("ci.pipes.lastRun")}
          </button>
        {/if}
        {#if r.canStart && runsKnown}
          <button type="button" class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-meta text-text hover:border-accent" use:tooltip={t("ci.pipes.startHint")} data-testid="ci-pipe-start" onclick={() => onstart(r)}>
            <Icon name="rocket" size={12} />{t("ci.pipes.start")}
          </button>
        {/if}
      </div>
    </div>
    {#if wide}
      <!-- The schema in small: the latest run's states when its jobs were read. -->
      <div class="shrink-0 px-1.5 py-1" data-testid="ci-pipe-preview">
        <PipelineGraph
          pipeline={r.pipeline}
          mode={r.kind === "gitlab" ? "stages" : "links"}
          {open}
          states={statesOf(r) ?? {}}
          plan={null}
          live
          notes={notesOf(r)}
          selected={null}
          stepMs={0}
          compact
          onselect={() => onschema(r)}
          ontoggle={(id) => {
            const next = new Set(open);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            open = next;
          }}
          ongate={() => {}}
        />
      </div>
    {/if}
    <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-3 pb-2 text-meta text-muted" data-testid="ci-pipe-runs">
      {#if !runsKnown}
        <span>{t("ci.pipes.runsElsewhere")}</span>
      {:else if r.runs.length}
        <span>{t("ci.pipes.recent")}</span>
        <span class="flex gap-0.5" aria-hidden="true">
          {#each r.runs.slice(0, 8) as x (x.id)}
            <span class="h-2 w-2 rounded-sm {STATE_FILL[x.state]}" use:tooltip={`${runName(x)} · ${stateText(x.state)}`}></span>
          {/each}
        </span>
        {#if last}<span class="truncate">· {runName(last)} · {last.branch ?? last.sha.slice(0, 7)}</span>{/if}
        <button type="button" class="text-accent hover:underline" data-testid="ci-pipe-allruns" onclick={() => onruns(r)}>{t("ci.pipes.allRuns")}</button>
      {:else if r.called && r.callers.length}
        <span>{t("ci.pipes.runsInCaller", { names: r.callers.join(", ") })}</span>
      {:else}
        <span>{t("ci.pipes.noRuns")}</span>
      {/if}
    </div>
  </div>
{/snippet}

{#if error}
  <EmptyState icon="alert" title={t("ci.pipes.unreadable")} hint={error} />
{:else if !wide && row}
  {@render detail(row)}
{:else}
  <div class="flex min-h-0 flex-1">
    <div class="flex min-h-0 min-w-0 flex-col {wide ? 'w-[46%] border-r border-edge' : 'flex-1'}">
      {#if rows?.length}
        <ListHeader
          items={rows}
          schema={PIPE_SCHEMA}
          {filter}
          {onfilter}
          {order}
          onorder={(o) => setListOrder("ci.pipes", o)}
          shown={view?.shown ?? 0}
          total={rows.length}
          labels={LABELS}
          placeholder={t("ci.pipes.filter")}
          {wide}
          {onmenu}
          testid="ci-pipes-header"
        />
      {/if}
      <div class="min-h-0 flex-1 overflow-y-auto">
        {#if !view}
          <div class="space-y-2 p-3"><Skeleton /><Skeleton width="80%" /><Skeleton width="60%" /></div>
        {:else if !rows?.length}
          <EmptyState icon="hierarchy" title={t("ci.pipes.none")} hint={t("ci.pipes.noneHint")} />
        {:else if !view.shown}
          <FilteredEmpty summary={filterSummary(PIPE_SCHEMA, filter, listMenuText(LABELS))} onreset={() => onfilter(NO_FILTER)} testid="ci-pipes-filtered-empty" />
        {:else}
          {#each view.groups[0]?.items ?? [] as r (r.id)}{@render pipeRow(r)}{/each}
        {/if}
        {#if failed.length}
          <p class="px-2.5 py-1.5 text-meta text-warn" data-testid="ci-pipes-failed">
            <Icon name="alert" size={12} />
            {t("ci.pipes.unread", { files: failed.map((f) => f.path.split("/").pop()).join(", ") })}
          </p>
        {/if}
      </div>
    </div>
    {#if wide}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        {#if row}
          {@render detail(row)}
        {:else}
          <EmptyState icon="hierarchy" title={t("ci.pipes.pick")} />
        {/if}
      </div>
    {/if}
  </div>
{/if}
