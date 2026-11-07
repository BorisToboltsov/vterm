<script lang="ts">
  // A pod's details (Phase 37): Overview (identity + status + live metrics), Logs
  // (live-polled, with a container picker for multi-container pods), Describe and
  // YAML (read-only, fetched once). Header carries the two pod-level actions —
  // open shell, delete. Presentational — the orchestrator's `run`/`runQuery`
  // execute; arg building stays pure (k8s.ts). Mirrors DockerDetail.
  //
  // The content only (v1.7): `K8sDetailModal` shows it as a dialog, a wide panel
  // puts it into a `SidePane` beside the list. It owns no dialog itself — it
  // stands inside the panel's query container (`panelcontainer.guard`).
  import Icon from "../ui/Icon.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import LogTail from "../ui/LogTail.svelte";
  import type { LogTailSize } from "../ui/loglines";
  import { tooltip } from "../actions/tooltip";
  import { REDACTED } from "../ai/redact";
  import { compactAge } from "../ui/age";
  import Chart from "../monitoring/Chart.svelte";
  import { SERIES } from "../monitoring/monpalette";
  import { series, latest, type History } from "../monitoring/monhistory";
  import {
    logsArgs,
    describeArgs,
    getYamlArgs,
    deleteArgs,
    podPhaseTone,
    podDetailFacts,
    podEventsArgs,
    podResourceKey,
    metricsKey,
    topContainersArgs,
    parseTopContainers,
    metricsGap,
    limitRatio,
    limitTone,
    parseCpuMillis,
    parseMemMiB,
    type ContainerUsage,
    type MetricsGap,
    parseEvents,
    listFailure,
    eventTone,
    type K8sEvent,
    type K8sPod,
    type K8sPodMetrics,
    type K8sDetailTab,
    type PodContainer,
    type PodContainerRole,
    type PodDetail,
    type PodProbe,
    type PodProbeKind,
  } from "./k8s";
  import type { KubeOutput } from "../api";
  import { currentLocale, t, type MessageKey } from "../i18n";

  let {
    active = false,
    pod = null,
    detail = null,
    metrics,
    history = {},
    seq = -1,
    metricsDown = null,
    busy = false,
    refreshSec = 5,
    fill = false,
    closeOnAsk = false,
    tab = $bindable("logs"),
    container = $bindable(null),
    run,
    runQuery,
    openShell,
    onFollowLogs = undefined,
    onAsk,
    onclose,
  }: {
    /** On screen right now: fetches and re-polls only then. */
    active?: boolean;
    pod?: K8sPod | null;
    /** What «Overview» explains (stage 1) — read by the panel from the list it polls. */
    detail?: PodDetail | null;
    metrics?: K8sPodMetrics;
    /** The panel's resources history (`<metricsKey>.cpu|mem`, stage 3) and its newest sample number. */
    history?: History;
    seq?: number;
    /** Why the panel's `top pods` gave no readings; null — it did. */
    metricsDown?: MetricsGap | null;
    busy?: boolean;
    refreshSec?: number;
    /** Take the height of the place it stands in (a pane beside a list); without
     *  it the text is bounded by the window, as a dialog needs. */
    fill?: boolean;
    /** Asking the assistant closes this — set by a dialog, which covers the chat. */
    closeOnAsk?: boolean;
    /**
     * The view on screen, and — in a pod of several containers — the one whose
     * logs are shown. Bound by the panel (v1.17): a dialog in a narrow dock and
     * the pane beside the list in a wide one are two instances, and crossing the
     * width threshold must not throw the user from the logs of the second
     * container back to Overview. Left unbound, the component keeps them itself.
     */
    tab?: K8sDetailTab;
    container?: string | null;
    run: (
      bareArgs: string[],
      namespace: string,
      opts?: { successKey?: string },
    ) => Promise<boolean>;
    runQuery: (bareArgs: string[], namespace: string, timeout?: number) => Promise<KubeOutput>;
    openShell: (pod: K8sPod, container: string | null) => void;
    /** Follow the log live in a terminal tab, from the last `tail` lines. */
    onFollowLogs?: (pod: K8sPod, container: string | null, tail: number) => void;
    /** Hand this pod's state + logs to the assistant (Phase 41). */
    onAsk?: (context: string) => void;
    onclose: () => void;
  } = $props();

  /**
   * What the assistant is told about this pod: the facts on screen plus whatever
   * logs are loaded. `describe` is skipped — it is long, and the interesting part
   * of it (recent events) is usually echoed by the status and the logs.
   */
  function askContext(p: K8sPod): string {
    const facts = [
      `Pod: ${p.name}`,
      `Namespace: ${p.namespace}`,
      `Status: ${p.status}`,
      `Ready: ${p.ready}`,
      `Restarts: ${p.restarts}`,
      p.node ? `Node: ${p.node}` : "",
      // What does not hold and how each container ended — never its environment.
      ...(detail ? podDetailFacts(detail) : []),
      usageLine(p),
      // What the cluster said about it lately, warnings only — the cause is there.
      ...(events ?? [])
        .filter((e) => e.type === "Warning")
        .slice(0, EVENTS_TO_ASSISTANT)
        .map((e) => `Event ${e.reason}${e.count > 1 ? ` ×${e.count}` : ""}${e.container ? ` (${e.container})` : ""}, ${e.age} ago: ${e.message}`),
    ]
      .filter(Boolean)
      .join("\n");
    return logsText.trim() ? `${facts}\n\n--- kubectl logs ---\n${logsText}` : facts;
  }

  type Tab = K8sDetailTab;

  /** Millicores as kubectl writes them. */
  const fmtCpu = (v: number | null): string => (v == null ? "—" : `${Math.round(v)}m`);
  /**
   * MiB as kubectl writes them: Ki for a figure given in Ki, Gi from a thousand. A
   * zero stays `0Mi` — `kubectl top` rounds to MiB, so it means «under half a MiB»,
   * not a count of KiB we do not have.
   */
  function fmtMi(v: number | null): string {
    if (v == null) return "—";
    if (v === 0) return "0Mi";
    if (v < 1) return `${Math.round(v * 1024)}Ki`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)}Gi`;
    return `${Math.round(v)}Mi`;
  }
  const BAR: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };

  /** What the assistant is told of its load: now, against the ceiling when there is one. */
  function usageLine(p: K8sPod): string {
    const key = metricsKey(p.namespace, p.name);
    const cpu = latest(history, podResourceKey(key, "cpu"));
    const mem = latest(history, podResourceKey(key, "mem"));
    if (cpu == null && mem == null) return "";
    const of = (v: number | null, limit: number | null, f: (x: number | null) => string) =>
      `${f(v)}${limit != null ? ` of limit ${f(limit)}` : " (no limit)"}`;
    return `Usage now: cpu ${of(cpu, p.cpuLimit, fmtCpu)}, memory ${of(mem, p.memLimit, fmtMi)}`;
  }

  let logsText = $state("");
  let describeText = $state("");
  let yamlText = $state("");
  // How the log is read — followed or held, how many lines — kept across pods:
  // picking the next row is reading the next log the same way.
  let following = $state(true);
  let tail = $state<LogTailSize>(200);
  // Secrets in the environment stay masked until asked for, per pod.
  let showSecrets = $state(false);
  // The open pod's events (stage 2), asked by its uid while «Overview» is on
  // screen: undefined — not answered yet; `eventsError` — could not be read,
  // which is not «no events».
  let events = $state<K8sEvent[] | undefined>(undefined);
  let eventsError = $state<string | null>(null);
  // A string, so the effect below re-runs on another pod, not on every poll.
  const uid = $derived(pod?.uid ?? "");
  const EVENTS_SHOWN = 50;
  // «Resources» (stage 3): the pod's containers now, asked while the view is on
  // screen; undefined — not answered yet.
  let usage = $state<ContainerUsage[] | undefined>(undefined);
  let usageGap = $state.raw<MetricsGap | null>(null);
  const EVENTS_TO_ASSISTANT = 8;
  let labelsOpen = $state(false);

  const SECTION = "mb-1 mt-3 flex items-center gap-1.5 text-caption uppercase tracking-wider text-muted";
  const ROLE: Record<Exclude<PodContainerRole, "app">, MessageKey> = { sidecar: "k8s.roleSidecar", init: "k8s.roleInit" };
  const PROBE: Record<PodProbeKind, MessageKey> = {
    startup: "k8s.probeStartup",
    readiness: "k8s.probeReadiness",
    liveness: "k8s.probeLiveness",
  };
  const TEXT_TONE: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-muted" };

  const ago = (ms: number): string => compactAge(ms, Date.now());
  const moment = (ms: number): string => new Date(ms).toLocaleString(currentLocale());
  const exitWord = (code: number | null, signal: number | null = null): string =>
    signal ? t("k8s.signal", { n: signal }) : code != null ? t("k8s.exitCode", { code }) : "";

  /** What a container is doing, as the pod's own word for it would be. */
  function containerWord(c: PodContainer): string {
    if (!c.state) return t("k8s.noStatus");
    if (c.state === "running") return "Running";
    if (c.state === "terminated") return [c.reason || "Terminated", exitWord(c.exitCode)].filter(Boolean).join(" · ");
    return c.reason || "Waiting";
  }
  function containerTone(c: PodContainer): string {
    if (c.state === "running") return c.ready === false && c.role !== "init" ? "warn" : "ok";
    if (c.state === "terminated") return c.exitCode === 0 ? "idle" : "bad";
    if (!c.state) return "idle";
    return podPhaseTone(c.reason) === "bad" ? "bad" : "warn";
  }
  function probeTiming(p: PodProbe): string {
    return [
      p.initialDelaySec ? t("k8s.probeDelay", { v: `${p.initialDelaySec}s` }) : "",
      p.periodSec ? t("k8s.probeEvery", { v: `${p.periodSec}s` }) : "",
      p.timeoutSec ? t("k8s.probeTimeout", { v: `${p.timeoutSec}s` }) : "",
      p.failureThreshold ? t("k8s.probeThreshold", { n: p.failureThreshold }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const amount = (r: { cpu: string; memory: string }): string =>
    [r.cpu && `cpu ${r.cpu}`, r.memory && `memory ${r.memory}`].filter(Boolean).join(" · ");

  const TONE: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    idle: "bg-muted",
  };

  // The panel hands us a *fresh* pod object on every poll, so the prop changes
  // identity while describing the same pod. An effect that merely reads it re-runs
  // on every poll and yanks the user off Logs back to Overview, so identity is
  // compared here explicitly. `shownKey` is the guard (deliberately non-reactive);
  // `target` is what the tab effects below depend on, so they see only real changes.
  // Mirrors DockerDetailModal.
  let shownKey: string | null = null;
  let target = $state<{ name: string; namespace: string } | null>(null);

  // Forget what was fetched whenever a different pod opens (or this closes). The
  // view stays (v1.33) — with details beside the list, picking the next row is
  // reading the next pod's log; the container goes back to the default (the
  // first — multi-container pods need `-c` for logs/exec). For the first pod
  // after a mount the container is kept as handed in: the content may have just
  // moved here from the other wrapper — only one the pod does not have is replaced.
  $effect(() => {
    const p = active ? pod : null;
    const key = p ? `${p.namespace}/${p.name}` : null;
    if (key === shownKey) return;
    const switched = shownKey !== null && key !== null;
    shownKey = key;
    target = p ? { name: p.name, namespace: p.namespace } : null;
    logsText = "";
    describeText = "";
    yamlText = "";
    events = undefined;
    eventsError = null;
    usage = undefined;
    usageGap = null;
    if (switched) {
      showSecrets = false;
      labelsOpen = false;
    }
    if (!p) return;
    const first = p.containers.length > 1 ? p.containers[0] : null;
    if (switched || container === null || !p.containers.includes(container)) container = first;
  });

  async function fetchLogs(name: string, ns: string, c: string | null, lines: number) {
    const res = await runQuery(logsArgs(name, c, lines), ns, 30);
    logsText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchDescribe(name: string, ns: string) {
    const res = await runQuery(describeArgs("pod", name), ns, 30);
    describeText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  async function fetchYaml(name: string, ns: string) {
    const res = await runQuery(getYamlArgs("pod", name), ns, 30);
    yamlText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  async function fetchEvents(id: string, ns: string) {
    const res = await runQuery(podEventsArgs(id), ns, 20);
    if (uid !== id) return; // another pod opened while this was on its way
    const failure = listFailure(res.stdout, res.stderr, res.exitCode);
    eventsError = failure;
    events = failure === null ? parseEvents(res.stdout) : undefined;
  }

  // Overview: the pod's events on open and with every poll while it is on screen.
  $effect(() => {
    const p = target;
    const id = uid;
    if (!active || tab !== "overview" || !p || !id) return;
    void fetchEvents(id, p.namespace);
    const timer = setInterval(() => void fetchEvents(id, p.namespace), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });

  async function fetchUsage(name: string, ns: string) {
    const res = await runQuery(topContainersArgs(name), ns, 20);
    if (target?.name !== name || target?.namespace !== ns) return; // another pod opened meanwhile
    usageGap = metricsGap(res);
    usage = parseTopContainers(res.stdout, name);
  }

  // Resources: the containers' usage on open and with every poll while on screen.
  $effect(() => {
    const p = target;
    if (!active || tab !== "resources" || !p) return;
    void fetchUsage(p.name, p.namespace);
    const timer = setInterval(() => void fetchUsage(p.name, p.namespace), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(timer);
  });

  // Logs tab: fetched on open, on another container and on a new tail size,
  // re-polled while followed (like the panel's live view); describe/yaml once.
  $effect(() => {
    const p = target;
    const c = container; // refetch when the container selection changes
    const lines = tail;
    if (!active || tab !== "logs" || !p) return;
    void fetchLogs(p.name, p.namespace, c, lines);
    if (!following) return;
    const id = setInterval(() => void fetchLogs(p.name, p.namespace, c, lines), Math.max(1, refreshSec) * 1000);
    return () => clearInterval(id);
  });
  $effect(() => {
    const p = target;
    if (!active || tab !== "describe" || !p) return;
    void fetchDescribe(p.name, p.namespace);
  });
  $effect(() => {
    const p = target;
    if (!active || tab !== "yaml" || !p) return;
    void fetchYaml(p.name, p.namespace);
  });

  async function remove() {
    if (!pod) return;
    const ok = await run(deleteArgs("pod", pod.name), pod.namespace, { successKey: "k8s.deleted" });
    if (ok) onclose();
  }

  const TABS: { id: Tab; label: MessageKey }[] = [
    { id: "logs", label: "k8s.viewLogs" },
    { id: "overview", label: "k8s.overview" },
    { id: "resources", label: "k8s.resources" },
    { id: "describe", label: "k8s.describe" },
    { id: "yaml", label: "k8s.yaml" },
  ];
</script>

{#if pod}
  {@const p = pod}
  <!-- Header: status + namespace + actions -->
  <div class="mb-2 flex items-center gap-2">
    <span class="h-[0.5rem] w-[0.5rem] shrink-0 rounded-full {TONE[podPhaseTone(p.status)]}" use:tooltip={p.status}></span>
    <div class="min-w-0 flex-1 truncate text-meta text-muted">{p.namespace} · {p.status}</div>
    <div class="flex shrink-0 items-center gap-0.5 text-muted">
      {#if onAsk}
        <!-- "Ask AI" (Phase 41): state, events and logs are already loaded here.
             A dialog closes (`closeOnAsk`) — the question is typed in the chat,
             which it covers; a pane beside the list covers nothing and stays. -->
        <button
          data-testid="k8s-ask-ai"
          class="rounded p-1 hover:bg-edge hover:text-text"
          use:tooltip={t("ai.ask.button")}
          aria-label={t("ai.ask.button")}
          onclick={() => {
            onAsk?.(askContext(p));
            if (closeOnAsk) onclose();
          }}
        >
          <Icon name="aiMark" size={14} />
        </button>
      {/if}
      <button class="rounded p-1 hover:bg-edge hover:text-text" use:tooltip={t("k8s.openShell")} aria-label={t("k8s.openShell")} onclick={() => openShell(p, container)}>
        <Icon name="terminal" size={14} />
      </button>
      <button class="rounded p-1 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} use:tooltip={t("k8s.delete")} aria-label={t("k8s.delete")} onclick={remove}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="mb-2 flex border-b border-edge text-meta">
    {#each TABS as tb (tb.id)}
      <button
        data-testid={`k8s-detail-tab-${tb.id}`}
        class="border-b-2 px-3 py-1.5 {tab === tb.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
        aria-current={tab === tb.id ? "true" : undefined}
        onclick={() => (tab = tb.id)}
      >
        {t(tb.label)}
      </button>
    {/each}
  </div>

  {#if tab === "overview"}
    <div class="text-meta {fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-[60vh] overflow-auto'}" data-testid="k8s-detail-overview">
    <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
      <dt class="text-muted">{t("k8s.name")}</dt>
      <dd class="break-all text-text/85">{p.name}</dd>
      <dt class="text-muted">{t("k8s.namespace")}</dt>
      <dd class="break-all text-text/85">{p.namespace}</dd>
      <dt class="text-muted">{t("k8s.status")}</dt>
      <dd class="break-all text-text/85">{p.status}</dd>
      <dt class="text-muted">{t("k8s.ready")}</dt>
      <dd class="text-text/85">{p.ready}</dd>
      <dt class="text-muted">{t("k8s.restarts")}</dt>
      <dd class="text-text/85">{p.restarts}</dd>
      <dt class="text-muted">{t("k8s.podIp")}</dt>
      <dd class="break-all text-text/85" data-testid="k8s-detail-ip">
        {#if (p.podIps ?? []).length > 0}
          <span class="font-mono">{(p.podIps ?? []).join(" · ")}</span>
          {#if p.hostNetwork}<span class="text-muted">{` · ${t("k8s.hostNetworkHint")}`}</span>{/if}
        {:else}
          <span class="text-muted">{t("k8s.noIp")}</span>
        {/if}
      </dd>
      {#if p.node}
        <dt class="text-muted">{t("k8s.node")}</dt>
        <dd class="break-all text-text/85">{p.node}{#if p.hostIp}<span class="font-mono text-muted">{` · ${p.hostIp}`}</span>{/if}</dd>
      {/if}
      <dt class="text-muted">{t("k8s.age")}</dt>
      <dd class="text-text/85">{p.age}</dd>
      {#if metrics}
        <dt class="text-muted">{t("k8s.cpu")}</dt>
        <dd class="text-text/85">{metrics.cpu}</dd>
        <dt class="text-muted">{t("k8s.mem")}</dt>
        <dd class="text-text/85">{metrics.mem}</dd>
      {/if}
      {#if p.qos}
        <dt class="text-muted">{t("k8s.qos")}</dt>
        <dd class="text-text/85">{p.qos}</dd>
      {/if}
      {#if detail?.serviceAccount}
        <dt class="text-muted">{t("k8s.serviceAccount")}</dt>
        <dd class="break-all font-mono text-text/85">{detail.serviceAccount}</dd>
      {/if}
      {#if detail?.priorityClass}
        <dt class="text-muted">{t("k8s.priorityClass")}</dt>
        <dd class="break-all font-mono text-text/85">{detail.priorityClass}</dd>
      {/if}
    </dl>

    {#if detail && detail.conditions.length > 0}
        <!-- Why it waits is said here: PodScheduled carries the scheduler's own words. -->
        <section data-testid="k8s-detail-conditions">
          <h4 class={SECTION}>{t("k8s.conditions")}</h4>
          <ul class="space-y-0.5">
            {#each detail.conditions as c (c.type)}
              <li class="px-1" data-testid="k8s-detail-condition">
                <div class="flex items-baseline gap-2">
                  <span class="h-[0.4rem] w-[0.4rem] shrink-0 rounded-full {c.ok === true ? 'bg-ok' : c.ok === false && !detail.finished ? 'bg-bad' : 'bg-muted'}"></span>
                  <span class="shrink-0 text-text/85">{c.type}</span>
                  {#if c.reason}<span class="min-w-0 truncate font-mono text-caption text-muted">{c.reason}</span>{/if}
                  {#if c.since != null}<span class="ml-auto shrink-0 font-mono text-caption text-muted" use:tooltip={moment(c.since)}>{ago(c.since)}</span>{/if}
                </div>
                {#if c.message}<p class="pl-3.5 break-words text-caption {c.ok === false && !detail.finished ? 'text-text/85' : 'text-muted'}">{c.message}</p>{/if}
              </li>
            {/each}
          </ul>
        </section>
    {/if}

      <!-- What the cluster said about the pod lately: why a probe fails, why no node
           takes it, what the pull answered. Asked by uid while this is on screen. -->
      {#if uid}
      <section data-testid="k8s-detail-events">
        <h4 class={SECTION}>{t("k8s.podEvents")} {#if events}<span class="tabular-nums">{events.length}</span>{/if}</h4>
        {#if eventsError !== null}
          <p class="text-muted" data-testid="k8s-detail-events-unread">{eventsError ? t("k8s.eventsUnreadWhy", { why: eventsError }) : t("k8s.eventsUnread")}</p>
        {:else if events === undefined}
          <p class="text-muted">…</p>
        {:else if events.length === 0}
          <p class="text-muted" data-testid="k8s-detail-events-none">{t("k8s.eventsNone")}</p>
        {:else}
          <ul class="max-h-48 space-y-0.5 overflow-auto">
            {#each events.slice(0, EVENTS_SHOWN) as e, i (i)}
              <li class="px-1" data-testid="k8s-detail-event">
                <div class="flex items-baseline gap-2">
                  <span class="shrink-0 font-mono {eventTone(e.type) === 'warn' ? 'text-warn' : 'text-text/85'}">{e.reason}</span>
                  {#if e.container}<span class="shrink-0 font-mono text-caption text-muted">{e.container}</span>{/if}
                  {#if e.count > 1}<span class="shrink-0 tabular-nums text-caption text-muted" use:tooltip={t("k8s.count")}>×{e.count}</span>{/if}
                  {#if e.ts}<span class="ml-auto shrink-0 font-mono text-caption text-muted" use:tooltip={moment(e.ts)}>{e.age}</span>{/if}
                </div>
                {#if e.message}<p class="break-words text-caption text-muted">{e.message}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if eventsError === null && events !== undefined}<p class="mt-0.5 text-caption text-muted">{t("k8s.eventsHint")}</p>{/if}
      </section>
      {/if}

    {#if detail}
      {#if detail.containers.length > 0}
        {@const masked = detail.containers.reduce((n, c) => n + c.env.filter((e) => e.sensitive).length, 0)}
        {@const refs = detail.containers.some((c) => c.env.some((e) => e.from) || c.envFrom.length > 0)}
        <section data-testid="k8s-detail-containers">
          <h4 class={SECTION}>
            {t("k8s.containers")} <span class="tabular-nums">{detail.containers.length}</span>
            {#if masked > 0}
              <button
                type="button"
                class="ml-auto rounded px-1 normal-case tracking-normal hover:bg-edge hover:text-text"
                aria-pressed={showSecrets}
                data-testid="k8s-detail-env-reveal"
                onclick={() => (showSecrets = !showSecrets)}
              >{t(showSecrets ? "k8s.envHide" : "k8s.envShow")}</button>
            {/if}
          </h4>
          {#each detail.containers as c (`${c.role}/${c.name}`)}
            <div class="mb-2.5 last:mb-0" data-testid="k8s-detail-container">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="font-mono text-text">{c.name}</span>
                {#if c.role !== "app"}<span class="text-caption text-muted">{t(ROLE[c.role])}</span>{/if}
                <span class={TEXT_TONE[containerTone(c)]} data-testid="k8s-detail-container-state">{containerWord(c)}</span>
                {#if c.state === "running" && c.ready === false && c.role !== "init"}<span class="text-warn">{t("k8s.notReadyWord")}</span>{/if}
                {#if c.restarts > 0}<span class="tabular-nums text-warn">↻{c.restarts}</span>{/if}
                {#if c.since != null}<span class="ml-auto font-mono text-caption text-muted" use:tooltip={moment(c.since)}>{ago(c.since)}</span>{/if}
              </div>
              {#if c.message}<p class="break-words font-mono text-caption text-muted">{c.message}</p>{/if}
              {#if c.last}
                <!-- How it ended the time before — what CrashLoopBackOff and a restart hide. -->
                <p class="text-caption" data-testid="k8s-detail-last">
                  <span class="text-muted">{t("k8s.lastTime")}:</span>
                  <span class={c.last.exitCode === 0 ? "text-muted" : "text-bad"}>{[c.last.reason, exitWord(c.last.exitCode, c.last.signal)].filter(Boolean).join(" · ")}</span>
                  {#if c.last.finishedAt != null}<span class="font-mono text-muted" use:tooltip={moment(c.last.finishedAt)}>{` · ${ago(c.last.finishedAt)}`}</span>{/if}
                </p>
                {#if c.last.message}
                  <pre class="my-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-1.5 font-mono text-caption text-text/85 select-text">{c.last.message}</pre>
                {/if}
              {/if}
              <dl class="mt-1 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
                <dt class="text-muted">{t("k8s.image")}</dt>
                <dd class="break-all font-mono text-text/85">{c.image || "—"}</dd>
                <dt class="text-muted">{t("k8s.command")}</dt>
                <dd class="break-all font-mono {c.command ? 'text-text/85' : 'text-muted'}" data-testid="k8s-detail-command">{c.command || t("k8s.commandFromImage")}</dd>
                <dt class="text-muted">{t("k8s.resources")}</dt>
                <dd class="text-text/85">
                  {#if amount(c.requests) || amount(c.limits)}
                    {#if amount(c.requests)}<div class="font-mono">{t("k8s.requested", { v: amount(c.requests) })}</div>{/if}
                    {#if amount(c.limits)}<div class="font-mono">{t("k8s.limited", { v: amount(c.limits) })}</div>{/if}
                  {:else}
                    <span class="text-muted">{t("k8s.noResources")}</span>
                  {/if}
                </dd>
                {#if c.ports.length > 0}
                  <dt class="text-muted">{t("k8s.ports")}</dt>
                  <dd class="break-all font-mono text-text/85">{c.ports.join(", ")}</dd>
                {/if}
                {#if c.probes.length > 0}
                  <dt class="text-muted">{t("k8s.probes")}</dt>
                  <dd data-testid="k8s-detail-probes">
                    {#each c.probes as pr (pr.kind)}
                      <div class="flex flex-wrap items-baseline gap-x-1.5">
                        <span class="text-muted">{t(PROBE[pr.kind])}</span>
                        <span class="break-all font-mono text-text/85">{pr.action || "—"}</span>
                        <span class="text-caption text-muted">{probeTiming(pr)}</span>
                      </div>
                    {/each}
                  </dd>
                {/if}
                {#if c.mounts.length > 0}
                  <dt class="text-muted">{t("k8s.mounts")}</dt>
                  <dd>
                    {#each c.mounts as m, i (i)}
                      <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 break-all">
                        <span class="font-mono text-text/85">{m.path}{#if m.subPath}<span class="text-muted">{` (${m.subPath})`}</span>{/if}</span>
                        <span class="shrink-0 text-muted">←</span>
                        <span class="font-mono text-muted" use:tooltip={m.volume}>{m.source || m.volume}</span>
                        {#if m.readOnly}<span class="shrink-0 text-caption text-muted">{t("k8s.mountRo")}</span>{/if}
                      </div>
                    {/each}
                  </dd>
                {/if}
                {#if c.env.length > 0 || c.envFrom.length > 0}
                  <dt class="text-muted">{t("k8s.env")}</dt>
                  <dd data-testid="k8s-detail-env">
                    <dl class="grid grid-cols-[minmax(0,auto)_1fr] gap-x-2 gap-y-0.5 font-mono">
                      {#each c.env as e (e.key)}
                        <dt class="truncate text-muted" use:tooltip={e.key}>{e.key}</dt>
                        {#if e.from}
                          <dd class="break-all text-muted">← {e.from}</dd>
                        {:else}
                          <dd class="break-all {e.sensitive && !showSecrets ? 'text-muted' : 'text-text/85'}">{e.sensitive && !showSecrets ? REDACTED : e.value}</dd>
                        {/if}
                      {/each}
                    </dl>
                    {#each c.envFrom as f (f)}
                      <div class="break-all font-mono text-muted">← {f}</div>
                    {/each}
                  </dd>
                {/if}
              </dl>
            </div>
          {/each}
          {#if masked > 0 && !showSecrets}<p class="text-caption text-muted">{t("k8s.envMaskedHint")}</p>{/if}
          {#if refs}<p class="text-caption text-muted">{t("k8s.envRefHint")}</p>{/if}
        </section>
      {/if}

      {#if detail.labels.length > 0}
        <section data-testid="k8s-detail-labels">
          <button type="button" class="{SECTION} w-full hover:text-text" aria-expanded={labelsOpen} onclick={() => (labelsOpen = !labelsOpen)}>
            <Icon name={labelsOpen ? "chevronDown" : "chevronRight"} size={10} />
            {t("k8s.labels")} <span class="tabular-nums">{detail.labels.length}</span>
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
  {:else if tab === "resources"}
    <!-- The pod's history is the panel's, from the `top pods` of every poll; its
         containers are asked while this is on screen. A share only against a known
         ceiling; the request is a mark, not a ceiling — and an automatic scale
         always holds it, or a pod far under its request would hide the mark. -->
    {@const key = metricsKey(p.namespace, p.name)}
    {@const cpuNow = latest(history, podResourceKey(key, "cpu"))}
    {@const memNow = latest(history, podResourceKey(key, "mem"))}
    {@const running = detail ? detail.containers.filter((c) => c.role !== "init") : []}
    <div class="space-y-3 text-meta {fill ? 'min-h-0 flex-1 overflow-auto' : 'max-h-[60vh] overflow-auto'}" data-testid="k8s-detail-resources">
      {#if metricsDown?.kind === "noServer"}
        <p class="text-muted" data-testid="k8s-res-noserver">{t("k8s.resNoServer")}</p>
      {:else}
        <p class="text-caption text-muted">{t("k8s.resHint", { sec: refreshSec })}</p>
        {#if metricsDown}
          <p class="text-muted" data-testid="k8s-res-gap">{metricsDown.kind === "notYet" ? t("k8s.resNotYet") : t("k8s.resUnread", { why: metricsDown.text })}</p>
        {/if}
        <section>
          <div class="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span class="text-muted">{t("k8s.cpu")}</span>
            <span class="tabular-nums text-text/90" data-testid="k8s-res-cpu-now">{fmtCpu(cpuNow)}</span>
            <span class="text-caption text-muted">{p.cpuLimit != null ? t("k8s.limited", { v: fmtCpu(p.cpuLimit) }) : t("k8s.noLimit")}</span>
            {#if p.cpuRequest != null}<span class="text-caption text-muted">{t("k8s.requested", { v: fmtCpu(p.cpuRequest) })}</span>{/if}
          </div>
          <Chart
            lines={[{ samples: series(history, podResourceKey(key, "cpu")), color: SERIES.cpu, fill: true }]}
            {seq}
            max={p.cpuLimit ?? undefined}
            floor={Math.max(10, p.cpuRequest ?? 0)}
            height={72}
            ticks
            scaleLabel={p.cpuLimit == null}
            threshold={p.cpuRequest ?? null}
            thresholdLabel={t("k8s.requestMark")}
            format={(v) => fmtCpu(v)}
            interval={refreshSec}
            testid="k8s-res-cpu"
          />
        </section>
        <section>
          <div class="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span class="text-muted">{t("k8s.mem")}</span>
            <span class="tabular-nums text-text/90" data-testid="k8s-res-mem-now">{fmtMi(memNow)}</span>
            <span class="text-caption text-muted">{p.memLimit != null ? t("k8s.limited", { v: fmtMi(p.memLimit) }) : t("k8s.noLimit")}</span>
            {#if p.memRequest != null}<span class="text-caption text-muted">{t("k8s.requested", { v: fmtMi(p.memRequest) })}</span>{/if}
          </div>
          <Chart
            lines={[{ samples: series(history, podResourceKey(key, "mem")), color: SERIES.ram, fill: true }]}
            {seq}
            max={p.memLimit ?? undefined}
            floor={Math.max(16, p.memRequest ?? 0)}
            height={72}
            ticks
            scaleLabel={p.memLimit == null}
            threshold={p.memRequest ?? null}
            thresholdLabel={t("k8s.requestMark")}
            format={(v) => fmtMi(v)}
            interval={refreshSec}
            testid="k8s-res-mem"
          />
        </section>
      {/if}

      {#if running.length > 0}
        <!-- Each container against its own ceiling: one near its memory limit is the
             one the OOM killer takes, whatever the pod's total says. -->
        <section data-testid="k8s-res-containers">
          <h4 class={SECTION}>{t("k8s.resByContainer")}</h4>
          {#each running as c (`${c.role}/${c.name}`)}
            {@const u = usage?.find((x) => x.container === c.name)}
            {@const cpuLimit = parseCpuMillis(c.limits.cpu)}
            {@const memLimit = parseMemMiB(c.limits.memory)}
            <div class="mb-1.5" data-testid="k8s-res-container">
              <div class="flex items-baseline gap-2">
                <span class="font-mono text-text">{c.name}</span>
                {#if c.role !== "app"}<span class="text-caption text-muted">{t(ROLE[c.role])}</span>{/if}
              </div>
              <div class="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5">
                {#each [{ label: t("k8s.cpu"), now: u?.cpu ?? null, limit: cpuLimit, request: parseCpuMillis(c.requests.cpu), f: fmtCpu }, { label: t("k8s.mem"), now: u?.mem ?? null, limit: memLimit, request: parseMemMiB(c.requests.memory), f: fmtMi }] as row (row.label)}
                  {@const ratio = limitRatio(row.now, row.limit)}
                  <span class="text-muted">{row.label}</span>
                  <div class="flex min-w-0 flex-wrap items-center gap-x-2">
                    <span class="tabular-nums text-text/90">{row.f(row.now)}</span>
                    {#if ratio != null}
                      <span class="h-1 w-16 overflow-hidden rounded-full bg-edge"><span class="block h-full {BAR[limitTone(ratio) ?? 'ok']}" style:width="{Math.min(100, ratio * 100)}%"></span></span>
                    {/if}
                    <span class="text-caption text-muted">{row.limit != null ? t("k8s.limited", { v: row.f(row.limit) }) : t("k8s.noLimit")}</span>
                    {#if row.request != null}<span class="text-caption text-muted">{t("k8s.requested", { v: row.f(row.request) })}</span>{/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
          {#if usageGap && metricsDown?.kind !== "noServer"}
            <p class="text-caption text-muted" data-testid="k8s-res-usage-gap">{usageGap.kind === "notYet" ? t("k8s.resNotYet") : t("k8s.resUnread", { why: usageGap.text })}</p>
          {/if}
        </section>
      {/if}
      <p class="text-caption text-muted">{t("k8s.resNoNetDisk")}</p>
    </div>
  {:else if tab === "logs"}
    <LogTail
      text={logsText}
      bind:live={following}
      bind:tail
      {fill}
      empty={t("k8s.noLogs")}
      testid="k8s"
      onterminal={onFollowLogs ? () => onFollowLogs?.(p, container, tail) : undefined}
    >
      {#if p.containers.length > 1}
        <label class="flex shrink-0 items-center gap-1 text-meta text-muted">
          {t("k8s.container")}
          <select
            class="rounded border border-edge bg-panel px-1.5 py-0.5 text-meta text-text outline-none focus:border-accent"
            bind:value={container}
            data-testid="k8s-log-container"
          >
            {#each p.containers as c (c)}
              <option value={c}>{c}</option>
            {/each}
          </select>
        </label>
      {/if}
    </LogTail>
  {:else if tab === "describe"}
    <div class="mb-1 flex justify-end">
      <CopyButton text={describeText} label={t("util.copy")} testid="k8s-copy-text" />
    </div>
    <pre
      data-testid="k8s-text"
      class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
    >{describeText || t("k8s.noLogs")}</pre>
  {:else}
    <div class="mb-1 flex justify-end">
      <CopyButton text={yamlText} label={t("util.copy")} testid="k8s-copy-text" />
    </div>
    <pre
      data-testid="k8s-text"
      class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text"
    >{yamlText || t("k8s.noLogs")}</pre>
  {/if}
{/if}
