<script lang="ts">
  // A container's details (Phase 36, point 1): Overview (the facts that used to
  // sit inline on the row), Logs (live-polled) and Inspect (raw JSON, fetched
  // once), with the lifecycle actions (start/stop/restart/remove) and "open
  // shell" in its header — one entry point for a container instead of five hover
  // icons. Presentational — the orchestrator's `run`/`runQuery` execute; arg
  // building stays pure (docker.ts).
  //
  // The content only (v1.7): `DockerDetailModal` shows it as a dialog, a wide
  // panel puts it into a `SidePane` beside the list. It owns no dialog itself —
  // it stands inside the panel's query container (`panelcontainer.guard`).
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import Chart from "../monitoring/Chart.svelte";
  import { series, latest, type History } from "../monitoring/monhistory";
  import { SERIES } from "../monitoring/monpalette";
  import { fmtBytes, fmtRate } from "../monitoring/format";
  import { shortStamp, type LogTailSize } from "../ui/loglines";
  import { tooltip } from "../actions/tooltip";
  import { REDACTED } from "../ai/redact";
  import {
    startArgs,
    stopArgs,
    restartArgs,
    removeArgs,
    logsArgs,
    inspectArgs,
    containerInfoRows,
    containerAddress,
    dockerDate,
    isRunning,
    stateSummary,
    stateTone,
    parseContainerDetail,
    eventWord,
    eventTone,
    resourceKey,
    EVENTS_WINDOW_MIN,
    type ContainerEvent,
    type ResourceSeries,
    type ContainerDetail,
    type DockerContainer,
    type DockerFacts,
    type DockerStat,
    type DockerInfoKey,
    type DockerDetailTab,
  } from "./docker";
  import type { ContainerOutput } from "../api";
  import { t, currentLocale, type MessageKey } from "../i18n";

  let {
    active = false,
    container = null,
    stat,
    facts = undefined,
    events = [],
    history = {},
    seq = -1,
    containers = [],
    busy = false,
    refreshSec = 3,
    fill = false,
    closeOnAsk = false,
    tab = $bindable("logs"),
    run,
    runQuery,
    onShell,
    onFollowLogs = undefined,
    onAsk,
    onclose,
  }: {
    /** On screen right now: fetches and re-polls only then. */
    active?: boolean;
    container?: DockerContainer | null;
    stat?: DockerStat;
    /** What `inspect` told of it (v1.33): restarts, addresses, times; absent — not asked yet. */
    facts?: DockerFacts;
    /** Its events in the last minutes, newest first (stage 3) — from the panel's snapshot. */
    events?: readonly ContainerEvent[];
    /** The panel's resources history (`<id>.<series>`) and its newest sample number. */
    history?: History;
    seq?: number;
    /** Every container — whose network a `container:` one shares is named from it. */
    containers?: readonly DockerContainer[];
    busy?: boolean;
    refreshSec?: number;
    /** Take the height of the place it stands in (a pane beside a list); without
     *  it the text is bounded by the window, as a dialog needs. */
    fill?: boolean;
    /** Asking the assistant closes this — set by a dialog, which covers the chat. */
    closeOnAsk?: boolean;
    /**
     * The view on screen: Logs (where details open, v1.33), Overview or Inspect. Bound by the panel (v1.17):
     * the same details are shown by a dialog in a narrow dock and by the pane
     * beside the list in a wide one — two instances — and a panel that crosses
     * the width threshold must not throw the user from Logs back to Overview.
     * Left unbound, the component keeps it itself.
     */
    tab?: DockerDetailTab;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    runQuery: (args: string[], timeout?: number) => Promise<ContainerOutput>;
    onShell: (c: DockerContainer) => void;
    /** Follow the log live in a terminal tab, from the last `tail` lines. */
    onFollowLogs?: (c: DockerContainer, tail: number) => void;
    /** Hand this container's state + logs to the assistant (Phase 41). */
    onAsk?: (context: string) => void;
    onclose: () => void;
  } = $props();

  /**
   * What the assistant is told about this container: the facts already on screen
   * plus whatever logs have been fetched. Deliberately not `inspect` — it is large
   * and mostly noise, and the logs are what explain a crash loop.
   */
  function askContext(c: DockerContainer): string {
    const facts = [
      `Container: ${c.name}`,
      `Image: ${c.image}`,
      `State: ${c.state}`,
      `Status: ${c.status}`,
      c.ports ? `Ports: ${c.ports}` : "",
      // The health check's own words, from its latest failing run — what explains
      // `unhealthy`. The environment is never part of it.
      healthLine(),
    ]
      .filter(Boolean)
      .join("\n");
    return logsText.trim() ? `${facts}\n\n--- docker logs ---\n${logsText}` : facts;
  }

  function healthLine(): string {
    const h = detail?.health;
    const failed = h?.probes.find((p) => p.exitCode !== 0);
    return h && failed ? `Health check: ${h.status || "unknown"}, latest failing run said: ${failed.last || "(no output)"}` : "";
  }

  type Tab = DockerDetailTab;

  let logsText = $state("");
  let inspectText = $state("");
  // How the log is read: followed (re-asked on every poll) or held still, and how
  // many last lines are asked for. Kept across containers: picking the next row
  // in the list is reading the next log the same way.
  let following = $state(true);
  let tail = $state<LogTailSize>(200);
  // The Overview's own reading of `docker inspect` (stage 1): undefined — not
  // asked yet, null — the answer could not be read.
  let detail = $state<ContainerDetail | null | undefined>(undefined);
  // Secrets in the environment stay masked until asked for, per container.
  let showSecrets = $state(false);
  let labelsOpen = $state(false);

  const TONE: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    idle: "bg-muted",
  };
  const INFO_LABEL: Record<DockerInfoKey, MessageKey> = {
    status: "docker.status",
    ports: "docker.ports",
    portsConfigured: "docker.portsConfigured",
    cpu: "docker.cpu",
    mem: "docker.mem",
    net: "docker.net",
    created: "docker.created",
  };

  const rows = $derived(container ? containerInfoRows(container, stat, facts) : []);

  // The panel hands us a *fresh* container object on every poll (a new snapshot
  // every `refreshSec`), so the container prop changes identity constantly while
  // describing the same container. Effects must therefore key off the id, and
  // compare it themselves: an effect that merely reads the prop re-runs on every
  // poll, which snapped the user back to Overview a second after they picked
  // Logs and wiped the fetched text. `shownId` is deliberately *not* reactive —
  // it is the guard, not state. `activeId` is what the tab effects below depend
  // on, so they see only real container changes.
  let shownId: string | null = null;
  let activeId = $state<string | null>(null);

  // Forget what was fetched whenever a different container opens (or this closes).
  // The view stays (v1.33): with details beside the list, picking the next row
  // is reading the next container's log — a jump back to Overview on every pick
  // made the list useless for that.
  $effect(() => {
    const id = active ? (container?.id ?? null) : null;
    if (id === shownId) return;
    shownId = id;
    activeId = id;
    logsText = "";
    inspectText = "";
    detail = undefined;
    showSecrets = false;
  });

  async function fetchLogs(id: string, lines: number) {
    const res = await runQuery(logsArgs(id, lines), 30);
    logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchInspect(id: string) {
    const res = await runQuery(inspectArgs(id), 30);
    inspectText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  // Logs tab: fetched on open and on a new tail size, re-polled while followed
  // (like the panel's live view); a held log stands still. Inspect once.
  $effect(() => {
    const cid = activeId;
    const lines = tail;
    if (!active || tab !== "logs" || !cid) return;
    void fetchLogs(cid, lines);
    if (!following) return;
    const timer = setInterval(() => void fetchLogs(cid, lines), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const cid = activeId;
    if (!active || tab !== "inspect" || !cid) return;
    void fetchInspect(cid);
  });

  // Overview: what `inspect` says, asked on open and again on every poll — a
  // health check runs on its own clock, and its last runs are the point.
  async function fetchDetail(id: string) {
    try {
      const res = await runQuery(inspectArgs(id), 30);
      if (activeId === id) detail = parseContainerDetail(res.stdout);
    } catch {
      if (activeId === id) detail = null;
    }
  }
  $effect(() => {
    const cid = activeId;
    if (!active || tab !== "overview" || !cid) return;
    void fetchDetail(cid);
    const timer = setInterval(() => void fetchDetail(cid), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });

  const probeTime = (ms: number | null): string => (ms == null ? "—" : shortStamp(new Date(ms).toISOString()));
  const HEALTH_TEXT: Record<string, string> = { healthy: "text-ok", unhealthy: "text-warn", starting: "text-muted" };
  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";

  async function act(args: string[], opts?: { destructive?: boolean; successKey?: string }) {
    const ok = await run(args, opts);
    // A successful remove leaves nothing to show — close the modal.
    if (ok && opts?.destructive && args[1] === "rm") onclose();
  }

  const TABS: { id: Tab; label: MessageKey }[] = [
    { id: "logs", label: "docker.viewLogs" },
    { id: "overview", label: "docker.overview" },
    { id: "resources", label: "docker.resources" },
    { id: "inspect", label: "docker.inspect" },
  ];

  const sample = (series_: ResourceSeries) => (container ? series(history, resourceKey(container.id, series_)) : []);
  const now = (series_: ResourceSeries) => (container ? latest(history, resourceKey(container.id, series_)) : null);
  const EVENT_TEXT: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-muted" };

  const summary = $derived(container ? stateSummary(container, facts) : null);
  const address = $derived(container ? containerAddress(container, facts, containers) : null);
</script>

{#if container}
  {@const c = container}
  <!-- Header: state + image + actions -->
  <div class="mb-2 flex items-center gap-2">
    <span class="h-[0.5rem] w-[0.5rem] shrink-0 rounded-full {TONE[stateTone(c.state)]}" use:tooltip={c.state}></span>
    <div class="min-w-0 flex-1 truncate text-meta text-muted">{c.image}</div>
    <div class="flex shrink-0 items-center gap-0.5 text-muted">
      {#if isRunning(c)}
        <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.stop")} aria-label={t("docker.stop")} onclick={() => act(stopArgs([c.id]), { successKey: "docker.stopped" })}>
          <Icon name="stop" size={14} />
        </button>
      {:else}
        <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.start")} aria-label={t("docker.start")} onclick={() => act(startArgs([c.id]), { successKey: "docker.started" })}>
          <Icon name="play" size={14} />
        </button>
      {/if}
      <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.restart")} aria-label={t("docker.restart")} onclick={() => act(restartArgs([c.id]), { successKey: "docker.restarted" })}>
        <Icon name="refresh" size={13} />
      </button>
      <button class="rounded p-1 hover:bg-edge hover:text-text" use:tooltip={t("docker.openShell")} aria-label={t("docker.openShell")} onclick={() => onShell(c)}>
        <Icon name="terminal" size={14} />
      </button>
      {#if onAsk}
        <!-- "Ask AI" (Phase 41): the state and logs are already fetched here, so
             the question carries them instead of asking the user to copy-paste.
             A dialog closes (`closeOnAsk`) — the question is typed in the chat,
             which it covers; a pane beside the list covers nothing and stays. -->
        <button
          data-testid="docker-ask-ai"
          class="rounded p-1 hover:bg-edge hover:text-text"
          use:tooltip={t("ai.ask.button")}
          aria-label={t("ai.ask.button")}
          onclick={() => {
            onAsk?.(askContext(c));
            if (closeOnAsk) onclose();
          }}
        >
          <Icon name="aiMark" size={14} />
        </button>
      {/if}
      <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("docker.remove")} aria-label={t("docker.remove")} onclick={() => act(removeArgs([c.id], isRunning(c)), { destructive: true, successKey: "docker.removed" })}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="mb-2 flex border-b border-edge text-meta">
    {#each TABS as tb (tb.id)}
      <button
        data-testid={`docker-detail-tab-${tb.id}`}
        class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
        aria-current={tab === tb.id ? "true" : undefined}
        onclick={() => (tab = tb.id)}
      >
        {t(tb.label)}
      </button>
    {/each}
  </div>

  {#if tab === "overview"}
    <div class="text-meta {fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-[60vh] overflow-auto'}" data-testid="docker-detail-overview">
    <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
      <dt class="text-muted">{t("docker.name")}</dt>
      <dd class="break-all text-text/85">{c.name}</dd>
      <dt class="text-muted">{t("docker.image")}</dt>
      <dd class="break-all text-text/85">{c.image}</dd>
      {#if c.project}
        <dt class="text-muted">{t("docker.project")}</dt>
        <dd class="break-all text-text/85">{c.project}{#if c.service}<span class="text-muted">{` · ${c.service}`}</span>{/if}</dd>
      {/if}
      {#if summary}
        <dt class="text-muted">{t("docker.state")}</dt>
        <dd class="break-all text-text/85" data-testid="docker-detail-state">
          {summary.word}{#if summary.age}<span class="text-muted">{` · ${summary.age}`}</span>{/if}{#if facts?.restarts}<span class="text-warn">{` · ↻${facts.restarts}`}</span>{/if}
        </dd>
      {/if}
      {#each rows as row (row.key)}
        <dt class="text-muted">{t(INFO_LABEL[row.key])}</dt>
        <dd class="break-all text-text/85">{row.key === "created" ? dockerDate(row.value, currentLocale()) : row.value}</dd>
      {/each}
      {#if address}
        <dt class="text-muted">{t("docker.address")}</dt>
        <dd class="text-text/85" data-testid="docker-detail-address">
          {#if address.kind === "ip"}
            {#each address.all as a (a.network)}
              <div class="break-all"><span class="font-mono">{[a.ipv4, a.ipv6].filter(Boolean).join(" · ")}</span><span class="text-muted">{` · ${a.network}`}</span></div>
            {/each}
            <div class="text-caption text-muted">{t("docker.addressInside")}</div>
          {:else if address.kind === "host"}
            {t("docker.addressHost")}
          {:else if address.kind === "none"}
            {t("docker.addressNone")}
          {:else if address.kind === "shared"}
            {t("docker.addressShared", { name: address.with })}
          {:else if address.kind === "down"}
            <span class="text-muted">{t("docker.addressDown")}</span>
          {:else}
            <span class="text-muted">—</span>
          {/if}
        </dd>
      {/if}
      {#if detail}
        <dt class="text-muted">{t("docker.command")}</dt>
        <dd class="break-all font-mono text-text/85" data-testid="docker-detail-command">{detail.command || "—"}</dd>
        <dt class="text-muted">{t("docker.restartPolicy")}</dt>
        <dd class="text-text/85">{detail.restartPolicy}</dd>
      {/if}
    </dl>

    {#if events.length > 0}
      <!-- What happened to it lately: a crash the restart policy hid is here. -->
      <section data-testid="docker-detail-events">
        <h4 class={SECTION}>{t("docker.events", { min: EVENTS_WINDOW_MIN })} <span class="tabular-nums">{events.length}</span></h4>
        <ul class="max-h-36 space-y-0.5 overflow-auto">
          {#each events.slice(0, 50) as e, i (i)}
            <li class="flex items-baseline gap-2 px-1">
              <span class="shrink-0 font-mono text-caption text-muted">{probeTime(e.at)}</span>
              <span class="font-mono {EVENT_TEXT[eventTone(e)]}">{eventWord(e)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if detail === null}
      <p class="mt-3 text-muted" data-testid="docker-detail-unread">{t("docker.detailUnread")}</p>
    {:else if detail}
      {#if detail.health}
        {@const h = detail.health}
        <!-- What a failing check says is in its output, not in the word «unhealthy». -->
        <section data-testid="docker-detail-health">
          <h4 class={SECTION}>{t("docker.healthCheck")}</h4>
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span class={HEALTH_TEXT[h.status] ?? "text-text/85"}>{h.status || "—"}</span>
            {#if h.failingStreak > 0}<span class="text-warn">{t("docker.healthStreak", { n: h.failingStreak })}</span>{/if}
            <span class="text-caption text-muted">
              {[h.interval ? t("docker.healthInterval", { v: h.interval }) : "", h.timeout ? t("docker.healthTimeout", { v: h.timeout }) : "", h.retries ? t("docker.healthRetries", { n: h.retries }) : ""].filter(Boolean).join(" · ")}
            </span>
          </div>
          {#if h.test}<div class="mt-0.5 break-all font-mono text-caption text-muted">{h.test}</div>{/if}
          {#if h.probes.length === 0}
            <p class="mt-1 text-muted">{t("docker.healthNoRuns")}</p>
          {:else}
            <ul class="mt-1 space-y-0.5" data-testid="docker-detail-probes">
              {#each h.probes as p, i (i)}
                <li>
                  <details class="group/probe">
                    <summary class="flex cursor-default list-none items-baseline gap-2 rounded px-1 hover:bg-edge/30">
                      <span class="shrink-0 font-mono text-caption text-muted">{probeTime(p.start)}</span>
                      <span class="w-6 shrink-0 text-right tabular-nums {p.exitCode === 0 ? 'text-ok' : 'text-bad'}">{p.exitCode ?? "—"}</span>
                      <span class="min-w-0 flex-1 truncate font-mono text-text/85">{p.last || "—"}</span>
                    </summary>
                    {#if p.output.trim()}
                      <pre class="my-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-1.5 font-mono text-caption text-text/85 select-text">{p.output}</pre>
                    {/if}
                  </details>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      {#if detail.mounts.length > 0}
        <section data-testid="docker-detail-mounts">
          <h4 class={SECTION}>{t("docker.mounts")} <span class="tabular-nums">{detail.mounts.length}</span></h4>
          {#each detail.mounts as m, i (i)}
            <div class="flex min-w-0 items-baseline gap-1.5 break-all">
              <span class="shrink-0 text-caption text-muted">{m.type}</span>
              <span class="font-mono text-text/85">{m.source}</span>
              <span class="shrink-0 text-muted">→</span>
              <span class="font-mono text-text/85">{m.destination}</span>
              {#if m.readOnly}<span class="shrink-0 text-caption text-muted">{t("docker.mountRo")}</span>{/if}
            </div>
          {/each}
        </section>
      {/if}

      {#if detail.env.length > 0}
        {@const masked = detail.env.filter((e) => e.sensitive).length}
        <section data-testid="docker-detail-env">
          <h4 class={SECTION}>
            {t("docker.env")} <span class="tabular-nums">{detail.env.length}</span>
            {#if masked > 0}
              <button
                type="button"
                class="ml-auto rounded px-1 normal-case tracking-normal hover:bg-edge hover:text-text"
                aria-pressed={showSecrets}
                data-testid="docker-detail-env-reveal"
                onclick={() => (showSecrets = !showSecrets)}
              >{t(showSecrets ? "docker.envHide" : "docker.envShow")}</button>
            {/if}
          </h4>
          <dl class="grid grid-cols-[minmax(0,auto)_1fr] gap-x-2 gap-y-0.5 font-mono">
            {#each detail.env as e (e.key)}
              <dt class="truncate text-muted" use:tooltip={e.key}>{e.key}</dt>
              <dd class="break-all {e.sensitive && !showSecrets ? 'text-muted' : 'text-text/85'}">{e.sensitive && !showSecrets ? REDACTED : e.value}</dd>
            {/each}
          </dl>
          {#if masked > 0 && !showSecrets}<p class="mt-0.5 text-caption text-muted">{t("docker.envMaskedHint")}</p>{/if}
        </section>
      {/if}

      {#if detail.labels.length > 0}
        <section data-testid="docker-detail-labels">
          <button type="button" class="{SECTION} w-full hover:text-text" aria-expanded={labelsOpen} onclick={() => (labelsOpen = !labelsOpen)}>
            <Icon name={labelsOpen ? "chevronDown" : "chevronRight"} size={10} />
            {t("docker.labels")} <span class="tabular-nums">{detail.labels.length}</span>
          </button>
          {#if labelsOpen}
            <dl class="grid grid-cols-[minmax(0,auto)_1fr] gap-x-2 gap-y-0.5 font-mono">
              {#each detail.labels as l (l.key)}
                <dt class="truncate text-muted" use:tooltip={l.key}>{l.key}</dt>
                <dd class="break-all text-text/85">{l.value}</dd>
              {/each}
            </dl>
          {/if}
        </section>
      {/if}
    {/if}
    </div>
  {:else if tab === "logs"}
    <LogTail
      text={logsText}
      bind:live={following}
      bind:tail
      {fill}
      empty={t("docker.noLogs")}
      testid="docker"
      onterminal={onFollowLogs ? () => onFollowLogs?.(c, tail) : undefined}
    />
  {:else if tab === "resources"}
    <!-- Every container's history is kept by the panel from its own poll — the
         view opens with what was polled while it was closed. A share is drawn
         only against a known ceiling (`--cpus`, `--memory`). -->
    {@const cores = facts?.cpuCores ?? null}
    {@const memLimit = facts?.memBytes ?? null}
    <div class="space-y-3 text-meta {fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-[60vh] overflow-auto'}" data-testid="docker-detail-resources">
      <p class="text-caption text-muted">{t("docker.resHint", { sec: refreshSec })}</p>
      {#if !isRunning(c)}
        <p class="text-muted" data-testid="docker-res-down">{t("docker.resDown")}</p>
      {/if}
      <section>
        <div class="mb-1 flex items-baseline gap-2">
          <span class="text-muted">{t("docker.cpu")}</span>
          <span class="tabular-nums text-text/90">{now("cpu") != null ? `${now("cpu")!.toFixed(1)}%` : "—"}</span>
          <span class="text-caption text-muted">{cores != null ? t("docker.resCpuLimit", { n: cores }) : t("docker.resNoLimit")}</span>
        </div>
        <Chart lines={[{ samples: sample("cpu"), color: SERIES.cpu, fill: true }]} {seq} max={cores != null ? cores * 100 : undefined} floor={10} height={72} ticks scaleLabel={cores == null} format={(v) => `${Math.round(v)}%`} interval={refreshSec} testid="docker-res-cpu" />
      </section>
      <section>
        <div class="mb-1 flex items-baseline gap-2">
          <span class="text-muted">{t("docker.mem")}</span>
          <span class="tabular-nums text-text/90">{fmtBytes(now("mem"))}</span>
          <span class="text-caption text-muted">{memLimit != null ? t("docker.resMemLimit", { size: fmtBytes(memLimit) }) : t("docker.resNoLimit")}</span>
        </div>
        <!-- Against its limit — a share, on the same scale as the monitoring page's
             memory; without one, the bytes on an automatic scale named in the corner
             (a byte figure does not fit the tick gutter). -->
        {#if memLimit != null}
          <Chart lines={[{ samples: sample("mem").map((x) => ({ s: x.s, v: x.v == null ? null : (x.v / memLimit) * 100 })), color: SERIES.ram, fill: true }]} {seq} max={100} height={72} ticks format={(v) => `${Math.round(v)}%`} interval={refreshSec} testid="docker-res-mem" />
        {:else}
          <Chart lines={[{ samples: sample("mem"), color: SERIES.ram, fill: true }]} {seq} floor={64 * 1024 ** 2} height={72} scaleLabel format={(v) => fmtBytes(v)} interval={refreshSec} testid="docker-res-mem" />
        {/if}
      </section>
      <section>
        <div class="mb-1 flex items-baseline gap-2">
          <span class="text-muted">{t("docker.net")}</span>
          <span class="tabular-nums text-text/90">↓ {fmtRate(now("rx"))} · ↑ {fmtRate(now("tx"))}</span>
        </div>
        <Chart lines={[{ samples: sample("rx"), color: SERIES.rx }, { samples: sample("tx"), color: SERIES.tx }]} {seq} mirror floor={1024} height={64} scaleLabel format={(v) => fmtRate(v)} interval={refreshSec} testid="docker-res-net" />
      </section>
      <section>
        <div class="mb-1 flex items-baseline gap-2">
          <span class="text-muted">{t("docker.resDisk")}</span>
          <span class="tabular-nums text-text/90">{t("docker.resRead")} {fmtRate(now("read"))} · {t("docker.resWrite")} {fmtRate(now("write"))}</span>
        </div>
        <Chart lines={[{ samples: sample("read"), color: SERIES.read }, { samples: sample("write"), color: SERIES.write }]} {seq} mirror floor={1024} height={64} scaleLabel format={(v) => fmtRate(v)} interval={refreshSec} testid="docker-res-disk" />
      </section>
    </div>
  {:else}
    <div class="mb-1 flex justify-end">
      <CopyButton text={inspectText} label={t("util.copy")} testid="docker-copy-text" />
    </div>
    <pre
      data-testid="docker-text"
      class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
    >{inspectText || t("docker.noLogs")}</pre>
  {/if}
{/if}
