<script lang="ts">
  // Kubernetes panel (Phase 37) — fifth right-dock tab. A distinct orchestration
  // driver (its own view), not folded into the Docker panel. Orchestrates the
  // cluster view for the active session's host (SSH or local): a toolbar (server
  // version + context/namespace selectors + all-namespaces toggle + refresh) over
  // two sub-tabs — Pods (grouped by owner) and Workloads. Works on SSH and local
  // tabs alike; the backend `kubectl_run` dispatches by session kind. All kubectl
  // logic is pure (k8s.ts); this owns data + polling + actions. Mirrors DockerPanel.
  //
  // The live view re-polls every `refreshSec` (default 5s) — a snapshot, never a
  // stream (`top pods` one-shot, `logs --tail`); interactive follow lives in a real
  // terminal (the shell button). The `--context`/`--namespace`/`-A` scope is baked
  // into every argv (withScope); kubeconfig is never mutated. Offline invariant
  // intact: the cluster API is reached over the user's own session, not the WebView.
  import Icon from "./Icon.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Skeleton from "./Skeleton.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import K8sPods from "./K8sPods.svelte";
  import K8sWorkloads from "./K8sWorkloads.svelte";
  import K8sNetwork from "./K8sNetwork.svelte";
  import K8sCluster from "./K8sCluster.svelte";
  import K8sDetailModal from "./K8sDetailModal.svelte";
  import K8sTextModal from "./K8sTextModal.svelte";
  import { tooltip } from "./actions/tooltip";
  import { kubectlRun } from "./api";
  import { settings } from "./settings.svelte";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import {
    kubectlProg,
    withScope,
    objectScope,
    versionArgs,
    contextsArgs,
    currentContextArgs,
    namespacesArgs,
    podsArgs,
    workloadsArgs,
    topPodsArgs,
    servicesArgs,
    ingressArgs,
    nodesArgs,
    eventsArgs,
    describeArgs,
    getYamlArgs,
    execShellCommand,
    portForwardCommand,
    parsePods,
    parseWorkloads,
    parseNamespaces,
    parseContexts,
    parseTopPods,
    parseServices,
    parseIngress,
    parseNodes,
    parseEvents,
    metricsKey,
    parseCpuMillis,
    groupByOwner,
    parseAvailability,
    needsConfirm,
    type K8sScope,
    type K8sAvailability,
    type PodGroup,
    type K8sWorkload,
    type K8sPod,
    type K8sPodMetrics,
    type K8sService,
    type K8sIngress,
    type K8sNode,
    type K8sEvent,
  } from "./k8s";
  import { pushSamples, type LoadHistory } from "./loadhistory";
  import { dockState, rememberSub, storedSub } from "./stores/dockstate.svelte";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { untrack } from "svelte";
  import { t, type MessageKey } from "./i18n";

  let {
    sessionId,
    sessionReady = true,
    prod = false,
    visible = true,
    onOpenShell,
    onAsk,
  }: {
    sessionId: string;
    /** SSH tab is connected (local tabs are always ready). */
    sessionReady?: boolean;
    /**
     * The dock is showing this tab. The panel stays mounted behind another tab
     * (v1.0.14) — scope and pods survive the switch — but a cluster nobody is looking
     * at is not polled.
     */
    visible?: boolean;
    /** Active tab is a prod-tagged server — destructive ops get an extra warning. */
    prod?: boolean;
    /** Open a real terminal tab running `command` (kubectl exec shell). */
    onOpenShell?: (command: string) => void;
    /** Hand a pod's state + logs to the AI assistant (Phase 41). */
    onAsk?: (context: string) => void;
  } = $props();

  const refreshSec = $derived(settings.k8sRefreshSec);
  const prog = $derived(kubectlProg(settings.kubectlPath));

  type Sub = "pods" | "workloads" | "network" | "cluster";
  let activeSub = $state<Sub>(untrack(() => storedSub<Sub>(sessionId, "k8s", "pods")));

  // Scope selection (baked into every argv; kubeconfig untouched). Remembered per
  // session (v1.0.14): re-picking context and namespace by hand after every tab
  // switch was the most expensive thing the old remount threw away.
  let scopeContext = $state<string | null>(null);
  let scopeNamespace = $state<string | null>(null); // null = context's default namespace
  let scopeAll = $state(false);
  const scope = $derived<K8sScope>({
    context: scopeContext,
    namespace: scopeNamespace,
    allNamespaces: scopeAll,
  });

  let contexts = $state<string[]>([]);
  let namespaces = $state<string[]>([]);

  let availability = $state<K8sAvailability | null>(null); // null = checking
  let busy = $state(false);
  // False until the first data load after a positive probe completes — drives the
  // skeleton so the panel never flashes "No pods" before the first `get`.
  let firstLoadDone = $state(false);

  let podGroups = $state<PodGroup[]>([]);
  let metricsByKey = $state<Map<string, K8sPodMetrics>>(new Map());
  // CPU history (millicores) per pod, fed by the `top pods` poll already running.
  let cpuHistory = $state<LoadHistory>({});
  let workloads = $state<K8sWorkload[]>([]);
  let services = $state<K8sService[]>([]);
  let ingresses = $state<K8sIngress[]>([]);
  let nodes = $state<K8sNode[]>([]);
  let events = $state<K8sEvent[]>([]);

  let menu = $state<OpenMenu | null>(null);

  // Pod detail modal.
  let detailOpen = $state(false);
  let detailPod = $state<K8sPod | null>(null);

  // Shared text modal (workload describe / YAML — read-only).
  let textOpen = $state(false);
  let textTitle = $state("");
  let textBody = $state("");

  // Confirm dialog (pending-resolver pattern, like DockerPanel).
  let confirmOpen = $state(false);
  let confirmText = $state("");
  let confirmResolve: ((ok: boolean) => void) | null = null;

  function askConfirm(text: string): Promise<boolean> {
    confirmText = text;
    confirmOpen = true;
    return new Promise((resolve) => (confirmResolve = resolve));
  }
  function settleConfirm(ok: boolean) {
    confirmOpen = false;
    confirmResolve?.(ok);
    confirmResolve = null;
  }

  function showMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, items };
  }

  // ── Execution helpers ────────────────────────────────────────────────────────

  /** Full argv for a view-level command, scoped by the current UI selection. */
  function viewArgs(bare: string[], opts: { namespaced?: boolean; scoped?: boolean } = {}): string[] {
    return withScope(prog, bare, scope, opts);
  }
  /** Full argv for a per-object command, targeting the object's own namespace. */
  function objArgs(bare: string[], namespace: string): string[] {
    return withScope(prog, bare, objectScope(scope, namespace));
  }

  /** Read-only kubectl call (no confirm, no reload). Per-object namespace scope. */
  function runQuery(bare: string[], namespace: string, timeout = 30) {
    return kubectlRun(sessionId, objArgs(bare, namespace), timeout, false);
  }

  /**
   * Mutating kubectl call for a single object: confirm disruptive/destructive ops
   * (every server — with an extra warning on prod), execute (mirrored into the
   * recording as `[k8s] $ …` audit), then reload. `bare` is the subcommand-first
   * argv from a builder; scope is applied for the object's namespace. Never throws
   * on a non-zero kubectl exit — surfaces stderr as a toast.
   */
  async function run(
    bare: string[],
    namespace: string,
    opts: { successKey?: string } = {},
  ): Promise<boolean> {
    if (busy) return false;
    if (needsConfirm(bare)) {
      const ok = await askConfirm(objArgs(bare, namespace).join(" "));
      if (!ok) return false;
    }
    busy = true;
    try {
      const res = await kubectlRun(sessionId, objArgs(bare, namespace), 120, true);
      if (res.exitCode !== 0) {
        notifyError(res.stderr.trim() || res.stdout.trim() || t("k8s.opFailed"));
        await refresh();
        return false;
      }
      if (opts.successKey) notifySuccess(t(opts.successKey as MessageKey));
      await refresh();
      return true;
    } catch (e) {
      notifyError(String(e));
      return false;
    } finally {
      busy = false;
    }
  }

  function openShell(pod: K8sPod, container: string | null) {
    onOpenShell?.(execShellCommand(prog, pod.name, pod.namespace, container, scope));
    notifySuccess(t("k8s.shellOpened", { name: pod.name }));
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  /**
   * Enumerate kubeconfig contexts + preselect the current one (first init only).
   * Returns the cluster's current context so the caller can fall back to it when a
   * remembered one has since disappeared.
   */
  async function loadSelectors(): Promise<string> {
    try {
      const [ctxs, cur] = await Promise.all([
        kubectlRun(sessionId, withScope(prog, contextsArgs(), scope, { scoped: false }), 15, false),
        kubectlRun(sessionId, withScope(prog, currentContextArgs(), scope, { scoped: false }), 15, false),
      ]);
      contexts = parseContexts(ctxs.stdout);
      const current = cur.stdout.trim();
      if (!scopeContext && current) scopeContext = current;
      return current;
    } catch {
      contexts = [];
      return "";
    }
  }

  /** List namespaces for the namespace selector (best-effort — needs a reachable cluster). */
  async function loadNamespaces() {
    try {
      const res = await kubectlRun(
        sessionId,
        withScope(prog, namespacesArgs(), scope, { namespaced: false }),
        15,
        false,
      );
      namespaces = parseNamespaces(res.stdout);
    } catch {
      namespaces = [];
    }
  }

  /** Probe whether kubectl + the cluster are usable (drives the empty state). */
  async function checkAvailability(): Promise<K8sAvailability> {
    let result: K8sAvailability;
    try {
      const res = await kubectlRun(sessionId, viewArgs(versionArgs(), { namespaced: false }), 15, false);
      result = parseAvailability(res.stdout, res.stderr, res.exitCode);
    } catch (e) {
      result = { ok: false, reason: "unknown", detail: String(e) };
    }
    availability = result;
    return result;
  }

  /** Reload the active sub-tab's data (+ pod metrics). */
  async function refresh() {
    if (!sessionReady || !availability?.ok) return;
    try {
      if (activeSub === "pods") {
        const [pods, top] = await Promise.all([
          kubectlRun(sessionId, viewArgs(podsArgs()), 20, false),
          kubectlRun(sessionId, viewArgs(topPodsArgs()), 20, false),
        ]);
        podGroups = groupByOwner(parsePods(pods.stdout));
        const map = new Map<string, K8sPodMetrics>();
        for (const m of parseTopPods(top.stdout)) map.set(metricsKey(m.namespace, m.name), m);
        metricsByKey = map;
        // Fold this snapshot into the rolling CPU history (Phase 42). Keyed off the
        // pod list, so a pod that was rescheduled between the two commands is dropped.
        const live = podGroups.flatMap((g) => g.pods.map((p) => metricsKey(p.namespace, p.name)));
        const cpu = new Map<string, number>();
        for (const key of live) {
          const millis = parseCpuMillis(map.get(key)?.cpu);
          if (millis != null) cpu.set(key, millis);
        }
        cpuHistory = pushSamples(cpuHistory, live, cpu);
      } else if (activeSub === "workloads") {
        const res = await kubectlRun(sessionId, viewArgs(workloadsArgs()), 20, false);
        workloads = parseWorkloads(res.stdout);
      } else if (activeSub === "network") {
        const [svc, ing] = await Promise.all([
          kubectlRun(sessionId, viewArgs(servicesArgs()), 20, false),
          kubectlRun(sessionId, viewArgs(ingressArgs()), 20, false),
        ]);
        services = parseServices(svc.stdout);
        ingresses = parseIngress(ing.stdout);
      } else {
        // Cluster: nodes are cluster-scoped (no namespace flag); events respect scope.
        const [nd, ev] = await Promise.all([
          kubectlRun(sessionId, viewArgs(nodesArgs(), { namespaced: false }), 20, false),
          kubectlRun(sessionId, viewArgs(eventsArgs()), 20, false),
        ]);
        nodes = parseNodes(nd.stdout);
        events = parseEvents(ev.stdout);
      }
    } catch (e) {
      notifyError(String(e));
    } finally {
      firstLoadDone = true;
    }
  }

  /** Probe + first load against the current scope (from mount, retry, or scope change). */
  async function reinit() {
    availability = null;
    firstLoadDone = false;
    const a = await checkAvailability();
    if (a.ok) {
      await loadNamespaces();
      await refresh();
    } else {
      firstLoadDone = true;
    }
  }

  /** Full init: restore (or reset) scope, enumerate contexts, then probe + load. */
  async function initAll() {
    const saved = dockState(sessionId).k8sScope;
    scopeContext = saved?.context ?? null;
    scopeNamespace = saved?.namespace ?? null;
    scopeAll = saved?.allNamespaces ?? false;
    contexts = [];
    namespaces = [];
    const current = await loadSelectors();
    // A remembered context the kubeconfig no longer has would bake a broken
    // `--context` into every argv, and every command would fail with it — fall
    // back to the cluster's current one instead of failing quietly under a scope
    // the selector still shows as chosen.
    if (scopeContext && contexts.length > 0 && !contexts.includes(scopeContext)) {
      scopeContext = current || null;
      scopeNamespace = null;
    }
    await reinit();
  }

  function retry() {
    void initAll();
  }

  // ── Scope selectors ──────────────────────────────────────────────────────────

  function pickContext(v: string) {
    scopeContext = v || null;
    scopeNamespace = null; // namespaces differ per context
    scopeAll = false;
    // A different cluster can hold a pod with the same namespace/name; carrying
    // the old series over would draw one cluster's load on another's row.
    cpuHistory = {};
    void reinit();
  }
  function pickNamespace(v: string) {
    scopeNamespace = v || null;
    scopeAll = false;
    void refresh();
  }
  function toggleAll() {
    scopeAll = !scopeAll;
    void refresh();
  }

  // ── Workload describe / YAML (read-only text modal) ──────────────────────────

  async function openText(title: string, bare: string[], namespace: string) {
    textTitle = title;
    textBody = "";
    textOpen = true;
    const res = await runQuery(bare, namespace, 30);
    textBody = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }
  function describeObj(kind: string, name: string, namespace: string) {
    void openText(`${t("k8s.describe")} — ${name}`, describeArgs(kind, name), namespace);
  }
  function yamlObj(kind: string, name: string, namespace: string) {
    void openText(`${t("k8s.yaml")} — ${name}`, getYamlArgs(kind, name), namespace);
  }

  /** Open `kubectl port-forward` in a real terminal tab (process lives in the PTY). */
  function portForward(target: string, namespace: string, port: number) {
    onOpenShell?.(portForwardCommand(prog, target, namespace, port, port, scope));
    notifySuccess(t("k8s.portForwardStarted", { target }));
  }

  // ── Detail modal live sync ───────────────────────────────────────────────────

  function openDetails(pod: K8sPod) {
    detailPod = pod;
    detailOpen = true;
  }
  const liveDetailPod = $derived.by(() => {
    if (!detailPod) return null;
    for (const g of podGroups) {
      const f = g.pods.find((p) => p.namespace === detailPod!.namespace && p.name === detailPod!.name);
      if (f) return f;
    }
    return null;
  });
  const detailMetrics = $derived.by(() => {
    const p = liveDetailPod;
    if (!p) return undefined;
    return metricsByKey.get(metricsKey(p.namespace, p.name)) ?? metricsByKey.get(metricsKey("", p.name));
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  // Full init when the session becomes ready (or changes).
  $effect(() => {
    void sessionId;
    if (sessionReady) {
      // Another cluster's pods are not this one's history.
      cpuHistory = {};
      void initAll();
    }
  });

  // Reload when the sub-tab changes (and remember it for the next mount). Store
  // writes are untracked here and below: creating this session's entry writes the
  // same state the call reads, which would make the effect its own trigger.
  $effect(() => {
    const sub = activeSub;
    untrack(() => rememberSub(sessionId, "k8s", sub));
    if (availability?.ok) void refresh();
  });

  // Remember the scope selection for the next mount of this session's panel.
  $effect(() => {
    const picked = {
      context: scopeContext,
      namespace: scopeNamespace,
      allNamespaces: scopeAll,
    };
    untrack(() => (dockState(sessionId).k8sScope = picked));
  });

  // Poll the live view while the cluster is available AND the tab is on screen.
  // A hidden panel keeps what it has and stops asking for more.
  $effect(() => {
    const sec = Math.max(1, refreshSec);
    if (!visible || !sessionReady || !availability?.ok) return;
    const id = setInterval(() => void refresh(), sec * 1000);
    return () => clearInterval(id);
  });

  // Coming back into view: one immediate snapshot, so the list is not as old as
  // the moment the user left it.
  let wasVisible = untrack(() => visible);
  $effect(() => {
    const back = visible && !wasVisible;
    wasVisible = visible;
    if (back) untrack(() => void refresh());
  });

  // Close the detail modal if its pod disappears (deleted elsewhere / poll).
  $effect(() => {
    if (detailOpen && firstLoadDone && !liveDetailPod) detailOpen = false;
  });

  const SUBS: { id: Sub; label: string }[] = [
    { id: "pods", label: t("k8s.pods") },
    { id: "workloads", label: t("k8s.workloads") },
    { id: "network", label: t("k8s.network") },
    { id: "cluster", label: t("k8s.cluster") },
  ];

  const unavailableHint = $derived.by(() => {
    if (!availability || availability.ok) return "";
    const key: MessageKey =
      availability.reason === "missing"
        ? "k8s.missing"
        : availability.reason === "no-config"
          ? "k8s.noConfig"
          : availability.reason === "unreachable"
            ? "k8s.unreachable"
            : availability.reason === "forbidden"
              ? "k8s.forbidden"
              : "k8s.unknownErr";
    return t(key);
  });
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  {#if !sessionReady || availability === null}
    <EmptyState icon="kubernetes" title={t("k8s.checking")} />
  {:else if !availability.ok}
    <EmptyState icon="kubernetes" title={t("k8s.unavailableTitle")} hint={unavailableHint}>
      <button
        class="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge hover:text-text disabled:opacity-40"
        data-testid="k8s-retry"
        onclick={retry}
      >
        {t("k8s.retry")}
      </button>
    </EmptyState>
  {:else}
    <!-- Toolbar -->
    <div class="flex items-center gap-1.5 border-b border-edge px-2 py-1.5">
      <Icon name="kubernetes" size={15} class="text-accent" />
      <div class="min-w-0 flex-1">
        <div class="font-medium text-text/90">{t("k8s.panelTitle")}</div>
        <div class="truncate text-caption text-muted">{t("k8s.clusterVersion", { version: availability.serverVersion })}</div>
      </div>
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
        disabled={busy}
        use:tooltip={t("k8s.refresh")}
        aria-label={t("k8s.refresh")}
        onclick={() => refresh()}
      >
        <Icon name="refresh" size={14} />
      </button>
    </div>

    <!-- Scope selectors -->
    <div class="flex items-center gap-1.5 border-b border-edge px-2 py-1.5 text-meta">
      {#if contexts.length > 0}
        <select
          data-testid="k8s-context"
          class="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-text outline-none focus:border-accent"
          value={scopeContext ?? ""}
          use:tooltip={t("k8s.context")}
          onchange={(e) => pickContext(e.currentTarget.value)}
        >
          {#each contexts as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      {/if}
      <select
        data-testid="k8s-namespace"
        class="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-text outline-none focus:border-accent disabled:opacity-40"
        value={scopeNamespace ?? ""}
        disabled={scopeAll}
        use:tooltip={t("k8s.namespace")}
        onchange={(e) => pickNamespace(e.currentTarget.value)}
      >
        <option value="">{t("k8s.defaultNamespace")}</option>
        {#each namespaces as ns (ns)}
          <option value={ns}>{ns}</option>
        {/each}
      </select>
      <button
        data-testid="k8s-all-ns"
        class="shrink-0 rounded border px-1.5 py-0.5 {scopeAll ? 'border-accent text-accent' : 'border-edge text-muted hover:text-text'}"
        use:tooltip={t("k8s.allNamespaces")}
        aria-label={t("k8s.allNamespaces")}
        aria-pressed={scopeAll}
        onclick={toggleAll}
      >
        -A
      </button>
    </div>

    <!-- Sub-tabs -->
    <div class="flex border-b border-edge text-meta">
      {#each SUBS as s (s.id)}
        <button
          data-testid={`k8s-subtab-${s.id}`}
          class="flex-1 border-b-2 py-1.5 text-center {activeSub === s.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
          aria-current={activeSub === s.id ? "true" : undefined}
          onclick={() => (activeSub = s.id)}
        >
          {s.label}
        </button>
      {/each}
    </div>

    <!-- Active sub-view -->
    <div class="min-h-0 flex-1">
      {#if !firstLoadDone}
        <div class="space-y-2 p-2.5" data-testid="k8s-skeleton" aria-hidden="true">
          {#each [0, 1, 2, 3, 4] as i (i)}
            <div class="flex items-center gap-2">
              <Skeleton width="7px" height="7px" class="shrink-0 rounded-full" />
              <Skeleton width="{40 + ((i * 13) % 45)}%" height="0.7rem" />
            </div>
          {/each}
        </div>
      {:else if activeSub === "pods"}
        {#if podGroups.length === 0}
          <EmptyState icon="container" title={t("k8s.noPods")} hint={t("k8s.noPodsHint")} />
        {:else}
          <K8sPods
            groups={podGroups}
            {metricsByKey}
            {cpuHistory}
            {busy}
            {run}
            {openShell}
            onViewDetails={openDetails}
            {showMenu}
          />
        {/if}
      {:else if activeSub === "workloads"}
        {#if workloads.length === 0}
          <EmptyState icon="rocket" title={t("k8s.noWorkloads")} hint={t("k8s.noWorkloadsHint")} />
        {:else}
          <K8sWorkloads {workloads} {busy} {run} onDescribe={describeObj} onYaml={yamlObj} {showMenu} />
        {/if}
      {:else if activeSub === "network"}
        {#if services.length === 0 && ingresses.length === 0}
          <EmptyState icon="network" title={t("k8s.noServices")} hint={t("k8s.noServicesHint")} />
        {:else}
          <K8sNetwork
            {services}
            {ingresses}
            {busy}
            {run}
            onDescribe={describeObj}
            onYaml={yamlObj}
            onPortForward={portForward}
            {showMenu}
          />
        {/if}
      {:else if nodes.length === 0 && events.length === 0}
        <EmptyState icon="server" title={t("k8s.noNodes")} hint={t("k8s.noNodesHint")} />
      {:else}
        <K8sCluster {nodes} {events} {busy} {run} onDescribe={describeObj} onYaml={yamlObj} {showMenu} />
      {/if}
    </div>
  {/if}
</div>

<K8sDetailModal
  open={detailOpen}
  pod={liveDetailPod}
  metrics={detailMetrics}
  {busy}
  {refreshSec}
  {run}
  {runQuery}
  {openShell}
  {onAsk}
  onclose={() => (detailOpen = false)}
/>

<K8sTextModal open={textOpen} title={textTitle} text={textBody} onclose={() => (textOpen = false)} />

<ContextMenu {menu} onclose={() => (menu = null)} />

<ConfirmDialog
  open={confirmOpen}
  title={t("k8s.confirmTitle")}
  confirmLabel={t("common.ok")}
  onconfirm={() => settleConfirm(true)}
  oncancel={() => settleConfirm(false)}
>
  {t("k8s.confirmBody")}
  <code class="mt-1 block break-all rounded bg-panel px-1 py-0.5 text-text/80">{confirmText}</code>
  {#if prod}
    <span class="mt-1 block text-meta text-danger">{t("k8s.confirmProdWarn")}</span>
  {/if}
</ConfirmDialog>
