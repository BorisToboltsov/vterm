<script lang="ts">
  // The Processes section (v1.33): every process of the host, while this section
  // is on screen (`fetch_metrics_detail` with `processes`). CPU is % of one core
  // over the last poll — the growth of each process's ticks, counted in Rust —
  // not `ps`'s lifetime average. So 512 % is five cores' worth (v1.35): the column
  // says "% of a core", its bar is drawn against all the cores (`machineShare`),
  // and the picked process's chart runs up to every core busy (`cpuCeiling`). The list narrows and orders through the lists'
  // model (ADR 0050, `proclist.ts`), can be drawn as a tree by parent, and is a
  // window over the rows (`windowRange`), so thousands of processes cost a
  // screenful of DOM. A click reads that process's details once
  // (`fetch_process_detail`) — never in the poll loop.
  import Chart from "./Chart.svelte";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import Meter from "./Meter.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import Icon from "../ui/Icon.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import ListHeader from "../ui/ListHeader.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import SortTitle from "../ui/SortTitle.svelte";
  import { fetchProcessDetail, type ProcessDetail, type ProcRow } from "../api";
  import { SPARK } from "./chartgeom";
  import { fmtBytes, fmtCount, fmtUptime } from "./format";
  import { series } from "./monhistory";
  import type { MonActions, MonView } from "./monsections";
  import { SERIES } from "./monpalette";
  import { coresBusy, cpuCeiling, machineShare, PROC_ORDER, PROC_SCHEMA, procTree, type TreeRow } from "./proclist";
  import { applyView, filterSummary, nextSort, NO_FILTER, type ListFilter } from "../ui/listview";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { windowRange } from "../ui/virtuallist";
  import { listOrder, setListOrder } from "../stores/listview.svelte";
  import { listFilter, setListFilter } from "../stores/dockstate.svelte";
  import { uiPx } from "../settings/settings.svelte";
  import { t } from "../i18n";
  import type { MessageKey } from "../i18n/messages";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const LIST = "mon.processes";
  const d = $derived(v.detail);
  const rows = $derived(d?.processes ?? []);
  const order = $derived(listOrder(LIST, PROC_SCHEMA, PROC_ORDER));
  const filter = $derived(listFilter(v.sessionId, LIST));
  const setFilter = (next: ListFilter) => setListFilter(v.sessionId, LIST, next);
  const view = $derived(applyView(rows, PROC_SCHEMA, filter, order));
  const kept = $derived(view.groups.flatMap((g) => g.items));

  let tree = $state(false);
  const shown = $derived<TreeRow[]>(
    tree ? procTree(rows, kept) : kept.map((row) => ({ row, depth: 0, context: false, kids: 0 })),
  );

  const STATE: Record<string, MessageKey> = {
    running: "mon.state.running",
    sleeping: "mon.state.sleeping",
    disk: "mon.state.disk",
    stopped: "mon.state.stopped",
    zombie: "mon.state.zombie",
    idle: "mon.state.idle",
    other: "mon.state.other",
  };
  const SORT_LABEL: Record<string, MessageKey> = {
    cpu: "mon.col.cpu",
    mem: "mon.col.mem",
    rss: "mon.col.rss",
    threads: "mon.col.threads",
    age: "mon.col.age",
    pid: "mon.col.pid",
    name: "mon.col.name",
    user: "mon.col.user",
  };
  const labels: ListLabels = {
    sort: (id) => (SORT_LABEL[id] ? t(SORT_LABEL[id]) : id),
    facet: (id) => (id === "user" ? t("mon.col.user") : t("mon.procState")),
    value: (facet, value) => (facet === "state" && STATE[value] ? t(STATE[value]) : value),
  };
  let listHeader = $state<{ contextItems(): MenuItem[] }>();
  function openListMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    menu = { x: e.clientX, y: e.clientY, items: listHeader?.contextItems() ?? [] };
  }
  let menu = $state<OpenMenu | null>(null);
  const sortedBy = (key: string) => (order.sort.key === key ? order.sort.dir : null);
  const orderBy = (key: string) => () =>
    setListOrder(LIST, { ...order, sort: nextSort(PROC_SCHEMA, order.sort, key) });

  // The window over the rows.
  const ROW_H = $derived(uiPx(26));
  let scrollTop = $state(0);
  let viewportH = $state(420);
  let scrolling = $state(false);
  let scrollIdle: ReturnType<typeof setTimeout> | undefined;
  function onscroll(e: Event) {
    scrollTop = (e.currentTarget as HTMLElement).scrollTop;
    scrolling = true;
    clearTimeout(scrollIdle);
    scrollIdle = setTimeout(() => (scrolling = false), 150);
  }
  const win = $derived(windowRange(scrollTop, viewportH, ROW_H, shown.length));
  const visible = $derived(shown.slice(win.start, win.end));

  const noCpuYet = $derived(rows.length > 0 && rows.every((r) => r.cpu == null));
  const capped = $derived(d?.processTotal != null && d.processTotal > rows.length);

  // The process picked for details, read once per pick.
  let picked = $state<ProcRow | null>(null);
  let detail = $state<ProcessDetail | null | undefined>(undefined);
  let failed = $state(false);
  let reqSeq = 0;
  async function pick(p: ProcRow) {
    if (picked?.pid === p.pid) {
      picked = null;
      return;
    }
    picked = p;
    detail = undefined;
    failed = false;
    const mine = ++reqSeq;
    try {
      const got = await fetchProcessDetail(v.sessionId, p.pid);
      if (mine === reqSeq) detail = got;
    } catch {
      if (mine === reqSeq) failed = true;
    }
  }
  // The pick follows the list: the newest reading of the same pid.
  const current = $derived(picked ? (rows.find((r) => r.pid === picked!.pid) ?? picked) : null);
  const linux = $derived(/linux/i.test(v.metrics.os));
  const cores = $derived(v.metrics.cpuCount);
  const pct = (n: number) => `${Math.round(n)}%`;
  const memPct = (n: number) => `${n.toFixed(1)}%`;
  const COLS = "grid-cols-[3.75rem_minmax(0,1fr)_6rem_7rem_4.5rem_4.5rem_3.5rem_4.5rem_5.5rem]";
</script>

<MonHeader
  section="processes"
  {v}
  {a}
  title={t("mon.processes")}
  sub={[
    d?.processTotal != null ? t("mon.procsTotal", { n: fmtCount(d.processTotal) }) : "",
    d?.procsRunning != null ? t("mon.procsSub", { r: d.procsRunning, b: d.procsBlocked ?? 0 }) : "",
  ]
    .filter(Boolean)
    .join(" · ")}
  onask={a.ask ? () => a.ask?.({ kind: "section", section: "processes" }) : undefined}
/>

<MonCard pad={false} testid="proc-table">
  <div role="presentation" oncontextmenu={openListMenu}>
  <ListHeader
    bind:this={listHeader}
    items={rows}
    schema={PROC_SCHEMA}
    {filter}
    onfilter={setFilter}
    {order}
    onorder={(o) => setListOrder(LIST, o)}
    shown={view.shown}
    total={view.total}
    {labels}
    placeholder={t("mon.procsFilter")}
    wide
    onmenu={(m) => (menu = m)}
    extra={[{ label: t("mon.procsTree"), checked: tree, onSelect: () => (tree = !tree) }]}
    testid="proc-list-header"
  />
  {#if noCpuYet || capped}
    <p class="border-b border-edge px-3 py-1 text-meta text-muted" data-testid="proc-note">
      {[noCpuYet ? t("mon.cpuNextReading") : "", capped ? t("mon.procsCapped", { n: fmtCount(rows.length), total: fmtCount(d!.processTotal) }) : ""]
        .filter(Boolean)
        .join(" · ")}
    </p>
  {/if}
  <div class="grid {COLS} items-center gap-x-2 border-b border-edge px-3 py-1 text-meta text-muted">
    <SortTitle label={t("mon.col.pid")} sorted={sortedBy("pid")} onsort={orderBy("pid")} />
    <SortTitle label={t("mon.col.name")} sorted={sortedBy("name")} onsort={orderBy("name")} />
    <SortTitle label={t("mon.col.user")} sorted={sortedBy("user")} onsort={orderBy("user")} />
    <SortTitle label={t("mon.cpuOfCore")} sorted={sortedBy("cpu")} onsort={orderBy("cpu")} align="right" />
    <SortTitle label={t("mon.col.mem")} sorted={sortedBy("mem")} onsort={orderBy("mem")} align="right" />
    <SortTitle label={t("mon.col.rss")} sorted={sortedBy("rss")} onsort={orderBy("rss")} align="right" />
    <SortTitle label={t("mon.col.threads")} sorted={sortedBy("threads")} onsort={orderBy("threads")} align="right" />
    <SortTitle label={t("mon.col.age")} sorted={sortedBy("age")} onsort={orderBy("age")} align="right" />
    <span class="truncate">{t("mon.sinceOpen")}</span>
  </div>
  {#if rows.length === 0}
    <div class="p-3"><Skeleton height="120px" /></div>
  {:else if view.shown === 0}
    <FilteredEmpty
      summary={filterSummary(PROC_SCHEMA, filter, listMenuText(labels))}
      onreset={() => setFilter(NO_FILTER)}
    />
  {:else}
    <div
      class="h-[min(44vh,420px)] overflow-y-auto [overflow-anchor:none]"
      bind:clientHeight={viewportH}
      {onscroll}
      data-testid="proc-scroller"
    >
      <div style="height: {win.totalHeight}px; position: relative;">
        <div style="transform: translateY({win.padTop}px);" class={scrolling ? "pointer-events-none" : ""}>
          {#each visible as tr (tr.row.pid)}
            {@const p = tr.row}
            <button
              type="button"
              class="grid w-full {COLS} items-center gap-x-2 px-3 text-left text-meta hover:bg-edge/50 {picked?.pid === p.pid
                ? 'bg-edge'
                : ''} {tr.context ? 'opacity-60' : ''}"
              style="height: {ROW_H}px"
              aria-pressed={picked?.pid === p.pid}
              data-testid="proc-row"
              onclick={() => pick(p)}
            >
              <span class="tabular-nums text-muted">{p.pid}</span>
              <span class="flex min-w-0 items-center font-mono text-text" style="padding-left: {tr.depth * 0.75}rem">
                {#if tree && tr.depth > 0}<span class="mr-1 shrink-0 text-muted">└</span>{/if}
                <span class="truncate">{p.comm}</span>
                {#if tree && tr.kids > 0}<span class="ml-1 shrink-0 text-caption text-muted">{tr.kids}</span>{/if}
              </span>
              <span class="truncate text-muted">{p.user}</span>
              <span class="flex items-center gap-1.5">
                <Meter pct={machineShare(p.cpu, cores)} color={SERIES.cpu} class="h-1" />
                <span class="w-10 shrink-0 text-right tabular-nums">{p.cpu == null ? "—" : p.cpu.toFixed(1)}</span>
              </span>
              <span class="text-right tabular-nums">{p.mem.toFixed(1)}</span>
              <span class="text-right tabular-nums text-muted">{p.rss == null ? "—" : fmtBytes(p.rss)}</span>
              <span class="text-right tabular-nums text-muted">{p.threads ?? "—"}</span>
              <span class="truncate text-right tabular-nums text-muted">{p.elapsedSecs == null ? "—" : fmtUptime(p.elapsedSecs)}</span>
              <Chart
                lines={[{ samples: series(v.hist, `proc.${p.pid}.cpu`), color: SERIES.cpu, width: 1.2 }]}
                seq={v.seq}
                floor={1}
                slots={SPARK}
                height={14}
                dot={false}
              />
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
  <p class="border-t border-edge px-3 py-1 text-meta text-muted">{t("mon.procsNote")}</p>
  </div>
</MonCard>

{#if current}
  {@const hasHistory = series(v.hist, `proc.${current.pid}.cpu`).some((x) => x.v != null)}
  <MonCard class="mt-2" testid="proc-detail">
    <div class="mb-2 flex items-center gap-2">
      <span class="min-w-0 truncate font-mono text-xs text-text">{current.comm}</span>
      <span class="text-meta tabular-nums text-muted">PID {current.pid}</span>
      <button
        type="button"
        class="ml-auto text-muted hover:text-text"
        aria-label={t("common.close")}
        onclick={() => (picked = null)}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
    {#if !hasHistory}
      <p class="text-meta text-muted">{t("mon.procNoHistory")}</p>
    {:else}
    <!-- The value now above each chart, the scale on its left (3Б, v1.35): the
         numbers never sit where the line runs. CPU runs up to every core busy. -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <div class="mb-0.5 flex flex-wrap items-baseline gap-x-2">
          <span class="text-caption uppercase tracking-wider text-muted">{t("mon.cpuSinceOpen")}</span>
          <TweenNumber value={current.cpu} format={pct} class="text-xs font-semibold text-text" testid="proc-cpu-now" />
          {#if current.cpu != null && cores != null}
            <span class="text-caption tabular-nums text-muted" data-testid="proc-cores-busy"
              >{t("mon.coresBusy", { n: coresBusy(current.cpu).toFixed(1), total: cores })}</span
            >
          {/if}
        </div>
        <Chart
          lines={[{ samples: series(v.hist, `proc.${current.pid}.cpu`), color: SERIES.cpu, fill: true }]}
          seq={v.seq}
          max={cpuCeiling(cores) ?? undefined}
          floor={1}
          ticks
          scaleLabel={cpuCeiling(cores) == null}
          format={pct}
          height={64}
          testid="proc-cpu-chart"
        />
      </div>
      <div>
        <div class="mb-0.5 flex flex-wrap items-baseline gap-x-2">
          <span class="text-caption uppercase tracking-wider text-muted">{t("mon.memSinceOpen")}</span>
          <TweenNumber value={current.mem} format={memPct} class="text-xs font-semibold text-text" testid="proc-mem-now" />
        </div>
        <Chart
          lines={[{ samples: series(v.hist, `proc.${current.pid}.mem`), color: SERIES.ram, fill: true }]}
          seq={v.seq}
          floor={1}
          ticks
          format={memPct}
          height={64}
          testid="proc-mem-chart"
        />
      </div>
    </div>
    {/if}
    {#if failed}
      <p class="mt-2 text-xs text-danger">{t("mon.procReadFailed")}</p>
    {:else if detail === undefined}
      <div class="mt-2"><Skeleton height="36px" /></div>
    {:else if detail === null}
      <p class="mt-2 text-xs text-muted">{t("mon.procGone")}</p>
    {:else}
      <dl class="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta">
        <dt class="text-muted">{t("mon.procState")}</dt>
        <dd class="text-text">{detail.state ? t(STATE[detail.state] ?? "mon.state.other") : "—"}</dd>
        <dt class="text-muted">{t("mon.procAge")}</dt>
        <dd class="tabular-nums text-text">{detail.elapsedSecs != null ? fmtUptime(detail.elapsedSecs) : "—"}</dd>
        <dt class="text-muted">{t("mon.procThreads")}</dt>
        <dd class="tabular-nums text-text">{fmtCount(detail.threads)}</dd>
        <dt class="text-muted">{t("mon.procRss")}</dt>
        <dd class="tabular-nums text-text">{fmtBytes(detail.rss)}</dd>
        <dt class="text-muted">{t("mon.procFds")}</dt>
        <dd class="tabular-nums {detail.fds == null ? 'text-muted' : 'text-text'}">{detail.fds == null ? t("mon.procFdsHidden") : fmtCount(detail.fds)}</dd>
        <dt class="text-muted">{t("mon.col.user")}</dt>
        <dd class="truncate text-text">{detail.user || "—"}</dd>
      </dl>
      {#if detail.cmdline}
        <pre class="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel-alt p-1.5 font-mono text-meta text-text select-text">{detail.cmdline}</pre>
      {/if}
    {/if}
    <div class="mt-2 flex flex-wrap gap-1.5 text-meta">
      {#if a.ask}
        <button
          type="button"
          class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 hover:bg-edge"
          onclick={() => a.ask?.({ kind: "process", pid: current!.pid, comm: current!.comm, detail: detail ?? null })}
        >
          <Icon name="aiMark" size={12} />{t("mon.askProcess")}
        </button>
      {/if}
      {#if a.run && linux}
        <button
          type="button"
          class="flex items-center gap-1 rounded border border-edge px-2 py-0.5 hover:bg-edge"
          onclick={() => a.run?.(["top", "-p", String(current!.pid)])}
        >
          <Icon name="terminal" size={12} />{t("mon.inTerminal", { cmd: `top -p ${current.pid}` })}
        </button>
      {/if}
    </div>
  </MonCard>
{/if}

<ContextMenu {menu} onclose={() => (menu = null)} />
