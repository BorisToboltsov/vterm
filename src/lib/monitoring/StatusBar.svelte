<script lang="ts">
  // The status bar (v1.34): how the host is, then its resources, then the rest —
  // the decisions are in barmodel.ts, the readings in the session's one feed
  // (stores/metricsfeed). The bar reads the feed of the active tab: switching
  // tabs shows that session's last reading at once, never "loading" again.
  //
  // Motion is the monitoring page's, shorter (STATUS_MS): the bar is in view all
  // day, at the edge of sight. A number counts to its reading, the CPU line slides
  // in, a threshold colour changes over 300 ms, and nothing flashes.
  //
  // What is short of room leaves for «⋯» by pixels (fitBar) instead of going out
  // of view; the problems chip, the transfers and the toggle are pinned outside
  // the row. A group opens its section of the monitoring page; hovering one with a
  // history raises its tile — the overview's tile, over the bar.
  import { untrack } from "svelte";
  import { tooltip } from "../actions/tooltip";
  import { createRowGlide } from "../actions/fluidglide";
  import { sftpCancel, type Metrics } from "../api";
  import { fmtBytes, fmtPct, fmtRate, fmtUptime, memPct, osIconFor, rateParts } from "./format";
  import { settings, uiPx } from "../settings/settings.svelte";
  import { thresholdLevel, levelTextClass, type ThresholdLevel } from "./thresholds";
  import { loadHealth } from "./monhealth";
  import { levelDot } from "./monpalette";
  import { HISTORY, SPARK } from "./chartgeom";
  import { series } from "./monhistory";
  import type { SectionId } from "./monproblems";
  import {
    BAR_ROOMY_REM,
    BAR_SECTION,
    BAR_TILES,
    barProblems,
    barVerdict,
    chipText,
    fitBar,
    shownGroups,
    tileLeft,
    usersOf,
    type BarGroup,
  } from "./barmodel";
  import Icon from "../ui/Icon.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import Chart from "./Chart.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import { STATUS_MS } from "../ui/tween";
  import { feedOf, pollEveryMs, watchMetrics } from "../stores/metricsfeed.svelte";
  import { revealPanel } from "../stores/layout.svelte";
  import { aggregateTransfers, transfersState } from "../stores/transfers.svelte";
  import { isCancellableTransfer } from "../files/transfer";
  import { t, type MessageKey } from "../i18n";

  let {
    sessionId,
    onopen = undefined,
  }: {
    sessionId: string;
    /** Open the monitoring page on a section. */
    onopen?: (section: SectionId) => void;
  } = $props();

  // Watch the session's feed while the bar shows it.
  $effect(() => {
    const id = sessionId;
    return untrack(() => watchMetrics(id));
  });

  const feed = $derived(feedOf(sessionId));
  const m = $derived(feed.metrics);
  const expanded = $derived(settings.statusBarExpanded);
  const th = $derived(settings.statusBarThresholds);
  const groups = $derived(m ? shownGroups(m, settings.statusBarItems) : []);

  // A reading the host did not renew: the values stay, dimmed, with their age.
  const stale = $derived(m != null && feed.failedAt != null);
  const staleSecs = $derived(stale && feed.at != null ? Math.max(0, Math.round((feed.failedAt! - feed.at) / 1000)) : 0);
  const staleAge = $derived(
    staleSecs < 60 ? t("bar.staleSec", { n: staleSecs }) : t("bar.staleMin", { n: Math.round(staleSecs / 60) }),
  );

  const ramPct = $derived(m ? memPct(m.memUsed, m.memTotal) : null);
  const diskPct = $derived(m ? memPct(m.diskUsed, m.diskTotal) : null);
  const swapPct = $derived(m?.swapTotal ? memPct(m.swapUsed, m.swapTotal) : null);
  const diskFree = $derived(m?.diskUsed != null && m.diskTotal != null ? m.diskTotal - m.diskUsed : null);
  const users = $derived(m ? usersOf(m) : []);
  const topProcs = $derived((m?.topProc ?? "").split(", ").filter(Boolean));

  // Levels, by the same rules the monitoring page and the screensaver use.
  const level = $derived<Partial<Record<BarGroup, ThresholdLevel>>>({
    cpu: thresholdLevel(m?.cpuPct ?? null, th.cpu),
    ram: thresholdLevel(ramPct, th.ram),
    swap: thresholdLevel(swapPct, th.swap),
    disk: thresholdLevel(diskPct, th.disk),
    load: loadHealth(m?.load1 ?? null, m?.load1 != null && m.cpuCount ? m.load1 / m.cpuCount : null, th.load),
    cpuTemp: thresholdLevel(m?.cpuTemp ?? null, th.cpuTemp),
  });
  const tone = (l: ThresholdLevel | undefined) =>
    `transition-colors duration-300 ${l && l !== "ok" ? levelTextClass(l) : "text-text"}`;

  const probs = $derived(barProblems(m, th));
  const verdict = $derived(barVerdict(probs));
  const chip = $derived(chipText(probs));
  const verdictText = $derived(
    (verdict === "crit" ? t("mon.healthCrit") : verdict === "warn" ? t("mon.healthWarn") : t("mon.healthOk")) +
      "\n" +
      t("bar.openMonitoring"),
  );
  const chipLabel = $derived.by(() => {
    if (!chip) return "";
    if (chip.kind === "one") return t(chip.problem.key, chip.problem.params);
    const parts = [];
    if (chip.crit) parts.push(t("mon.critCount", { n: chip.crit }));
    if (chip.warn) parts.push(t("mon.warnCount", { n: chip.warn }));
    return parts.join(" · ");
  });
  const chipTip = $derived(
    [...probs.map((p) => t(p.key, p.params)), "", t("bar.problemsNote")].join("\n"),
  );

  // Is the bar wide enough for words — the chip's and the transfer's — or only numbers?
  let rootW = $state(0);
  const roomy = $derived(rootW >= uiPx(BAR_ROOMY_REM * 16));

  // ── Fitting: what leaves for «⋯» ─────────────────────────────────────────────
  let groupsEl = $state<HTMLElement | null>(null);
  let hidden = $state.raw<Set<BarGroup>>(new Set());

  function refit() {
    const el = groupsEl;
    if (!el) return;
    const items = groups.map((id) => ({
      id,
      w: (el.querySelector(`[data-group="${id}"]`) as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
    }));
    const sep = parseFloat(getComputedStyle(el).columnGap) || 0;
    const more = (el.querySelector("[data-more]") as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    const next = fitBar(items, el.clientWidth, sep, more);
    if (next.size !== hidden.size || [...next].some((g) => !hidden.has(g))) hidden = next;
  }

  // What leaves for «⋯» flies into it and what comes back flies out of it; the
  // rest glide to their places — at the bar's own pace (STATUS_MS), no flash.
  const rowGlide = createRowGlide(() => groupsEl, { more: "more", base: STATUS_MS });
  $effect.pre(() => {
    void hidden;
    untrack(() => rowGlide.snapshot());
  });
  $effect(() => {
    void hidden;
    untrack(() => rowGlide.play());
  });

  // Measure again whenever the row, a group or the set of groups changes size.
  $effect(() => {
    void groups;
    void expanded;
    const el = groupsEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => refit());
    ro.observe(el);
    for (const g of el.querySelectorAll("[data-group], [data-more]")) ro.observe(g);
    untrack(refit);
    return () => ro.disconnect();
  });

  // ── What a group says, for its label and for «⋯» ─────────────────────────────
  const LABEL: Record<BarGroup, MessageKey> = {
    os: "settings.metric.os",
    host: "settings.metric.host",
    cpu: "settings.metric.cpu",
    load: "settings.metric.load",
    ram: "settings.metric.ram",
    swap: "settings.metric.swap",
    disk: "settings.metric.disk",
    diskio: "settings.metric.diskio",
    net: "settings.metric.net",
    netConns: "settings.metric.netConns",
    uptime: "settings.metric.uptime",
    users: "settings.metric.users",
    ip: "settings.metric.ip",
    topProc: "settings.metric.topProc",
    cpuTemp: "settings.metric.cpuTemp",
    kernel: "settings.metric.kernel",
    serverTime: "settings.metric.serverTime",
  };

  function valueText(g: BarGroup, x: Metrics): string {
    switch (g) {
      case "os":
        return x.prettyName || x.os || t("bar.osUnknown");
      case "host":
        return `${x.user || "—"}@${x.hostname || "—"}`;
      case "cpu":
        return fmtPct(x.cpuPct);
      case "load":
        return [x.load1, x.load5, x.load15].map((v) => (v == null ? "—" : v.toFixed(2))).join(" ");
      case "ram":
        return `${fmtPct(ramPct)} · ${fmtBytes(x.memUsed)} / ${fmtBytes(x.memTotal)}`;
      case "swap":
        return `${fmtPct(swapPct)} · ${fmtBytes(x.swapUsed)} / ${fmtBytes(x.swapTotal)}`;
      case "disk":
        return `${fmtPct(diskPct)} · ${t("bar.diskFree", { size: fmtBytes(diskFree) })}`;
      case "diskio":
        return `${fmtRate(x.diskReadRate)} / ${fmtRate(x.diskWriteRate)}`;
      case "net":
        return `↓ ${fmtRate(x.netRxRate)} · ↑ ${fmtRate(x.netTxRate)}`;
      case "netConns":
        return String(x.netConns ?? "—");
      case "uptime":
        return fmtUptime(x.uptimeSecs);
      case "users":
        return users.join(", ");
      case "ip":
        return x.ip;
      case "topProc":
        return topProcs[0] ?? "—";
      case "cpuTemp":
        return x.cpuTemp == null ? "—" : `${Math.round(x.cpuTemp)} °C`;
      case "kernel":
        return x.kernel;
      case "serverTime":
        return x.serverTime;
    }
  }
  const lineOf = (g: BarGroup, x: Metrics) => `${t(LABEL[g])}: ${valueText(g, x)}`;

  /** The tooltip of a group without a tile; one with a tile shows the tile. */
  function tipOf(g: BarGroup, x: Metrics): string | undefined {
    if (BAR_TILES[g]) return undefined;
    switch (g) {
      case "os":
        return t("bar.titleOs", { os: x.prettyName || x.os || t("bar.osUnknown") });
      case "host":
        return t("bar.titleHost");
      case "ip":
        return t("bar.titleIp", { ip: x.ip });
      case "uptime":
        return t("bar.titleUptime");
      case "kernel":
        return t("bar.titleKernel", { kernel: x.kernel });
      case "serverTime":
        return t("bar.titleServerTime");
      case "topProc":
        return t("bar.titleTopProc") + "\n" + topProcs.join("\n");
      case "netConns":
        return t("bar.titleNetConns");
      case "users":
        return t("bar.titleUsers") + "\n" + users.join("\n");
      default:
        return undefined;
    }
  }
  const moreTip = $derived(
    m ? [...groups.filter((g) => hidden.has(g)).map((g) => lineOf(g, m)), "", t("bar.openMonitoring")].join("\n") : "",
  );

  // ── The tile over a group ─────────────────────────────────────────────────────
  let root = $state<HTMLElement | null>(null);
  let tileFor = $state<BarGroup | null>(null);
  let tileX = $state(0);
  const TILE_W = 240;

  function showTile(g: BarGroup, el: HTMLElement) {
    if (!BAR_TILES[g] || !root) return;
    const left = el.getBoundingClientRect().left - root.getBoundingClientRect().left;
    tileX = tileLeft(left, uiPx(TILE_W), rootW);
    tileFor = g;
  }
  const hideTile = () => (tileFor = null);

  const spec = $derived(tileFor ? BAR_TILES[tileFor] : undefined);
  const everySec = $derived(pollEveryMs(false) / 1000);
  type TileView = { value: number | null; format: (v: number) => string; unit?: (v: number) => string; sub: string };
  const pctTile = (v: number | null, sub: string): TileView => ({
    value: v,
    format: (n) => String(Math.round(n)),
    unit: () => "%",
    sub,
  });
  const rateTile = (v: number | null, sub: string): TileView => ({
    value: v,
    format: (n) => rateParts(n)?.num ?? "—",
    unit: (n) => rateParts(n)?.unit ?? "",
    sub,
  });
  const tile = $derived.by((): TileView | null => {
    if (!tileFor || !m) return null;
    switch (tileFor) {
      case "cpu":
        return pctTile(
          m.cpuPct,
          [
            m.load1 != null && m.cpuCount ? t("mon.loadOnThreads", { load: m.load1.toFixed(2), n: m.cpuCount }) : "",
            m.cpuTemp != null ? `${Math.round(m.cpuTemp)} °C` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      case "ram":
        return pctTile(ramPct, `${fmtBytes(m.memUsed)} / ${fmtBytes(m.memTotal)}`);
      case "swap":
        return pctTile(swapPct, `${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}`);
      case "disk":
        return pctTile(diskPct, `${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)} · ${t("bar.diskFree", { size: fmtBytes(diskFree) })}`);
      case "load":
        return {
          value: m.load1,
          format: (n) => n.toFixed(2),
          sub: t("bar.tileLoad", { l5: m.load5?.toFixed(2) ?? "—", l15: m.load15?.toFixed(2) ?? "—", n: m.cpuCount ?? "—" }),
        };
      case "cpuTemp":
        return { value: m.cpuTemp, format: (n) => String(Math.round(n)), unit: () => "°C", sub: "" };
      case "net":
        return rateTile(
          m.netRxRate,
          [`↑ ${fmtRate(m.netTxRate)}`, m.netConns != null ? t("mon.connections", { n: m.netConns }) : ""].filter(Boolean).join(" · "),
        );
      case "diskio":
        return rateTile(m.diskReadRate, `${t("mon.write")} ${fmtRate(m.diskWriteRate)}`);
      default:
        return null;
    }
  });

  // ── Transfers (the shared store) ──────────────────────────────────────────────
  const summary = $derived(aggregateTransfers(Object.values(transfersState.map)));
  // What "cancel all" stops: in-flight transfers the user started. Sync-run files
  // are stopped by the sync window's own Stop, not per file.
  const cancellable = $derived(Object.values(transfersState.map).filter(isCancellableTransfer));
  const pinned = $derived(!!chip || !!summary.direction);

  const pct = (n: number) => String(Math.round(n));
  const rateNum = (n: number) => rateParts(n)?.num ?? "—";
  const rateUnit = (n: number) => rateParts(n)?.unit ?? "";
</script>

{#snippet divider()}
  <span class="h-3 w-px shrink-0 bg-current" aria-hidden="true"></span>
{/snippet}

{#snippet percent(value: number | null, l: ThresholdLevel | undefined)}
  <TweenNumber {value} format={pct} unit={() => "%"} duration={STATUS_MS} class={tone(l)} numClass="min-w-[3ch]" />
{/snippet}

{#snippet rate(value: number | null)}
  <TweenNumber
    {value}
    format={rateNum}
    unit={rateUnit}
    duration={STATUS_MS}
    class="text-text"
    numClass="min-w-[4ch]"
    unitClass="inline-block w-[1.75rem]"
  />
{/snippet}

{#snippet body(g: BarGroup, x: Metrics)}
  {#if g === "os"}
    <Icon name={osIconFor(x)} size={14} />
    {#if expanded}<span>{x.prettyName || x.os || "—"}</span>{/if}
  {:else if g === "host"}
    <span class="text-text">{x.user || "—"}@{x.hostname || "—"}</span>
  {:else if g === "cpu"}
    <Icon name="cpu" size={14} />
    {#if expanded}
      <Chart
        class="w-10 rounded-sm bg-edge/40"
        lines={[{ samples: series(feed.hist, "cpu"), color: "var(--color-rail-1)", fill: true }]}
        seq={feed.seq}
        max={100}
        slots={SPARK}
        height={14}
        bar
        testid="cpu-chart"
      />
    {/if}
    {@render percent(x.cpuPct, level.cpu)}
  {:else if g === "ram"}
    <Icon name="memory" size={14} />
    {#if expanded}<span class="text-meta tabular-nums">{fmtBytes(x.memUsed)} / {fmtBytes(x.memTotal)}</span>{/if}
    {@render percent(ramPct, level.ram)}
  {:else if g === "disk"}
    <Icon name="disk" size={14} />
    {#if expanded}<span class="text-meta tabular-nums">{t("bar.diskFree", { size: fmtBytes(diskFree) })}</span>{/if}
    {@render percent(diskPct, level.disk)}
  {:else if g === "net"}
    <Icon name="download" size={13} />
    {@render rate(x.netRxRate)}
    <Icon name="upload" size={13} />
    {@render rate(x.netTxRate)}
  {:else if g === "load"}
    <Icon name="gauge" size={14} />
    <TweenNumber value={x.load1} format={(n) => n.toFixed(2)} duration={STATUS_MS} class={tone(level.load)} />
    {#if expanded}<span class="text-meta tabular-nums">{x.load5?.toFixed(2) ?? "—"} {x.load15?.toFixed(2) ?? "—"}</span>{/if}
  {:else if g === "cpuTemp"}
    <Icon name="thermometer" size={14} />
    <TweenNumber value={x.cpuTemp} format={pct} unit={() => "°C"} duration={STATUS_MS} class={tone(level.cpuTemp)} numClass="min-w-[2ch]" />
  {:else if g === "swap"}
    <Icon name="swap" size={14} />
    {#if expanded}<span class="text-meta tabular-nums">{fmtBytes(x.swapUsed)} / {fmtBytes(x.swapTotal)}</span>{/if}
    {@render percent(swapPct, level.swap)}
  {:else if g === "diskio"}
    <Icon name="diskIo" size={14} />
    {@render rate(x.diskReadRate)}
    <span class="opacity-70">/</span>
    {@render rate(x.diskWriteRate)}
  {:else if g === "topProc"}
    <Icon name="activity" size={14} />
    <span class="max-w-28 truncate text-text">{topProcs[0] ?? "—"}</span>
  {:else if g === "netConns"}
    <Icon name="plug" size={14} />
    <TweenNumber value={x.netConns} duration={STATUS_MS} class="text-text" />
  {:else if g === "users"}
    <Icon name="users" size={14} />
    <span class="tabular-nums text-text">{users.length}</span>
  {:else if g === "uptime"}
    <Icon name="power" size={14} />
    <span class="tabular-nums text-text">{fmtUptime(x.uptimeSecs)}</span>
  {:else if g === "ip"}
    <Icon name="globe" size={14} />
    <span class="tabular-nums text-text">{x.ip}</span>
  {:else if g === "kernel"}
    <Icon name="terminal" size={14} />
    <span class="max-w-28 truncate text-text">{x.kernel}</span>
  {:else if g === "serverTime"}
    <Icon name="clock" size={14} />
    <span class="tabular-nums text-text">{x.serverTime}</span>
  {/if}
{/snippet}

<div
  bind:this={root}
  bind:clientWidth={rootW}
  class="relative flex items-stretch border-t border-edge bg-panel-alt text-xs text-muted"
  data-testid="statusbar"
>
  <div class="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap py-1 pl-2 pr-2">
    {#if m}
      <button
        type="button"
        class="flex shrink-0 items-center rounded p-1 hover:bg-edge"
        data-testid="bar-verdict"
        data-level={verdict}
        aria-label={verdictText}
        use:tooltip={verdictText}
        onclick={() => onopen?.("overview")}
      >
        <span class="h-2 w-2 rounded-full transition-colors duration-300" style="background-color: {levelDot(verdict)}"></span>
      </button>
      {#key sessionId}
        <div
          bind:this={groupsEl}
          class="relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden transition-opacity duration-300 {stale ? 'opacity-50' : ''}"
        >
          {#each groups as g (g)}
            {@const off = hidden.has(g)}
            <span
              data-group={g}
              data-row-key={g}
              class="flex shrink-0 items-center gap-2 {off ? 'pointer-events-none invisible absolute' : ''}"
              aria-hidden={off || undefined}
            >
              <!-- Every group brings its own separator: the dot stands before the first. -->
              {@render divider()}
              <button
                type="button"
                class="-mx-1 flex items-center gap-2 rounded px-1 hover:bg-edge"
                data-testid="bar-{g}"
                tabindex={off ? -1 : undefined}
                aria-label={lineOf(g, m)}
                use:tooltip={tipOf(g, m)}
                onclick={() => onopen?.(BAR_SECTION[g])}
                onpointerenter={(e) => showTile(g, e.currentTarget)}
                onpointerleave={hideTile}
                onfocus={(e) => showTile(g, e.currentTarget)}
                onblur={hideTile}
              >
                {@render body(g, m)}
              </button>
            </span>
          {/each}
          <button
            type="button"
            data-more
            data-row-key="more"
            data-testid="bar-more"
            class="flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-edge hover:text-text {hidden.size
              ? ''
              : 'pointer-events-none invisible absolute'}"
            aria-hidden={hidden.size ? undefined : true}
            tabindex={hidden.size ? undefined : -1}
            aria-label={t("bar.more", { n: hidden.size })}
            use:tooltip={hidden.size ? moreTip : undefined}
            onclick={() => onopen?.("overview")}
          >
            <Icon name="dots" size={13} strokeWidth={2.4} />
            <span class="tabular-nums">+{hidden.size}</span>
          </button>
        </div>
      {/key}
      {#if stale}
        <span class="flex shrink-0 items-center gap-1 text-warn" data-testid="bar-stale" use:tooltip={t("bar.staleTip", { age: staleAge })}>
          <Icon name="clock" size={12} />
          <span class="tabular-nums">{staleAge}</span>
        </span>
      {/if}
    {:else if feed.failedAt != null}
      <span>{t("bar.metricsUnavailable")}</span>
    {:else}
      <div class="flex items-center gap-2" role="status" aria-label={t("bar.loadingMetrics")} data-testid="bar-loading">
        {#each [2.5, 3.5, 3.5, 6] as w, i (i)}
          {#if i > 0}{@render divider()}{/if}
          <Skeleton width="{w}rem" height="0.625rem" class="rounded" />
        {/each}
      </div>
    {/if}
  </div>

  <!-- Pinned outside the row: what must not go out of view. -->
  {#if m && pinned}
    <div class="flex shrink-0 items-center gap-2 border-l border-edge px-2">
      {#if chip}
        <button
          type="button"
          data-testid="bar-problems"
          data-level={verdict}
          class="flex max-w-64 items-center gap-1 rounded border px-1.5 py-px text-meta {verdict === 'crit'
            ? 'border-bad/50 bg-bad/10 text-bad'
            : 'border-warn/50 bg-warn/10 text-warn'}"
          aria-label={chipLabel}
          use:tooltip={chipTip}
          onclick={() => onopen?.("overview")}
        >
          <Icon name="alert" size={12} />
          <span class="truncate {roomy ? '' : 'tabular-nums'}">{roomy ? chipLabel : probs.length}</span>
        </button>
      {/if}
      {#if summary.direction}
        <button
          type="button"
          data-testid="transfer-indicator"
          class="flex items-center gap-1.5 rounded px-1 text-muted hover:text-text"
          use:tooltip={t("bar.transfers")}
          onclick={() => revealPanel("files")}
        >
          <Icon name={summary.direction === "copy" ? "arrowRight" : summary.direction} size={13} />
          {#if expanded && roomy}
            <span class="tabular-nums">{summary.active} {summary.active === 1 ? t("bar.file") : t("bar.files")}</span>
            <span class="relative h-1.5 w-12 overflow-hidden rounded-full bg-edge">
              <span
                class="absolute inset-0 origin-left rounded-full bg-accent transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style="transform: scaleX({summary.pct / 100})"
              ></span>
            </span>
          {/if}
          <span class="tabular-nums text-text">{summary.pct}%</span>
        </button>
        {#if cancellable.length > 0}
          <button
            type="button"
            data-testid="transfer-cancel-all"
            class="flex items-center rounded p-0.5 text-muted hover:text-danger"
            use:tooltip={t("bar.cancelTransfers")}
            aria-label={t("bar.cancelTransfers")}
            onclick={() => cancellable.forEach((tr) => void sftpCancel(tr.id))}
          >
            <Icon name="close" size={12} />
          </button>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Compact/expanded toggle — outside the row, so nothing shows through behind
       it. Fixed 36px (w-9) matches the collapsed right dock's rail so their left
       borders line up into one continuous vertical divider. -->
  {#if m}
    <button
      type="button"
      data-testid="statusbar-toggle"
      class="flex w-9 shrink-0 items-center justify-center self-stretch border-l border-edge text-muted hover:text-text"
      use:tooltip={expanded ? t("bar.compactView") : t("bar.expandedView")}
      aria-label={expanded ? t("bar.compactAria") : t("bar.expandedAria")}
      aria-pressed={expanded}
      onclick={() => (settings.statusBarExpanded = !settings.statusBarExpanded)}
    >
      <Icon name={expanded ? "chevronLeft" : "chevronRight"} size={14} />
    </button>
  {/if}

  <!-- The tile of the group under the pointer: the overview's tile, over the bar. -->
  {#if spec && tile}
    {#key tileFor}
    <div
      class="pointer-events-none absolute bottom-full z-30 mb-1 w-60 overflow-hidden rounded-lg border border-edge bg-panel pt-2 shadow-lg"
      style="left: {tileX}px"
      role="tooltip"
      data-testid="bar-tile"
      data-group={tileFor}
    >
      <div class="px-2.5">
        <div class="truncate text-caption uppercase tracking-wider text-muted">{t(spec.label, spec.params)}</div>
        <TweenNumber
          value={tile.value}
          format={tile.format}
          unit={tile.unit}
          duration={STATUS_MS}
          class="text-xl font-semibold {tone(tileFor ? level[tileFor] : undefined)}"
        />
        <div class="truncate text-meta text-muted">{tile.sub || " "}</div>
      </div>
      <Chart
        lines={spec.lines.map((l) => ({ samples: series(feed.hist, l.key), color: l.color, fill: true }))}
        seq={feed.seq}
        max={spec.max}
        floor={spec.floor ?? 1}
        mirror={spec.mirror ?? false}
        slots={HISTORY}
        height={48}
        marks
        interval={everySec}
        class="mt-1"
      />
    </div>
    {/key}
  {/if}
</div>
