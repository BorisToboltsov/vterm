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
  import Icon from "../ui/Icon.svelte";
  import type { AttachTarget } from "../tabs/tabattach";
  import EmptyState from "../ui/EmptyState.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import K8sPods from "./K8sPods.svelte";
  import K8sWorkloads from "./K8sWorkloads.svelte";
  import K8sNetwork from "./K8sNetwork.svelte";
  import K8sCluster from "./K8sCluster.svelte";
  import K8sDetailModal from "./K8sDetailModal.svelte";
  import K8sTextModal from "./K8sTextModal.svelte";
  import K8sDetail from "./K8sDetail.svelte";
  import K8sText from "./K8sText.svelte";
  import SidePane from "../ui/SidePane.svelte";
  import { aside } from "../actions/fluidglide";
  import { MOTION_BASE, motion } from "../ui/motion";
  import ListHeader from "../ui/ListHeader.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import { applyView, filterSummary, nextSort, NO_FILTER, type ListFilter } from "../ui/listview";
  import { listOrder, setListOrder, type ListId } from "../stores/listview.svelte";
  import PanelDivider from "../ui/PanelDivider.svelte";
  import AttentionStrip from "../ui/AttentionStrip.svelte";
  import { hideableFields } from "../ui/colfit";
  import { hiddenFields, toggleField } from "../stores/colwidths.svelte";
  import { partWidth } from "../stores/panelsplit.svelte";
  import { wideWhen } from "../actions/panelwide.svelte";
  import { tooltip } from "../actions/tooltip";
  import { kubectlRun } from "../api";
  import { settings } from "../settings/settings.svelte";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
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
    endpointSlicesArgs,
    describeArgs,
    getYamlArgs,
    execShellArgv,
    followLogsArgv,
    portForwardArgv,
    listItems,
    podsOf,
    podItem,
    parsePodDetail,
    parseWorkloads,
    parseNamespaces,
    parseContexts,
    parseTopPods,
    parseServices,
    parseIngress,
    parseNodes,
    parseEvents,
    parseEndpointSlices,
    listFailure,
    metricsKey,
    parseCpuMillis,
    parseMemMiB,
    podSchema,
    POD_ORDER,
    WORKLOAD_SCHEMA,
    WORKLOAD_ORDER,
    EVENT_ORDER,
    EVENT_SCHEMA,
    parseAvailability,
    needsConfirm,
    podAttention,
    podRestartBaseline,
    type PodAttentionReason,
    type K8sScope,
    type K8sAvailability,
    type K8sWorkload,
    type K8sPod,
    type K8sPodMetrics,
    type K8sService,
    type K8sIngress,
    type K8sNode,
    type K8sEvent,
    type K8sEndpointSlice,
    type K8sDetailTab,
  } from "./k8s";
  import { buildRoutes } from "./k8sroute";
  import { pushSamples, type LoadHistory } from "../monitoring/loadhistory";
  import {
    collapsedGroups,
    dockState,
    listFilter,
    rememberSub,
    setGroupsCollapsed,
    setListFilter,
    storedSub,
  } from "../stores/dockstate.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { untrack } from "svelte";
  import { t, type MessageKey } from "../i18n";

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
    onOpenShell?: (argv: string[], target?: AttachTarget) => void;
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

  let podList = $state<K8sPod[]>([]);
  // The objects of the same answer, as kubectl gave them: «Overview» of the pod
  // whose details are open is read from here (stage 1) — no call of its own.
  let podObjects = $state.raw<Record<string, unknown>[]>([]);
  let metricsByKey = $state<Map<string, K8sPodMetrics>>(new Map());
  // CPU history (millicores) per pod, fed by the `top pods` poll already running.
  let cpuHistory = $state<LoadHistory>({});
  let workloads = $state<K8sWorkload[]>([]);
  let services = $state<K8sService[]>([]);
  let ingresses = $state<K8sIngress[]>([]);
  // The Network sub-tab has two views of the same lists (v1.5). The route needs
  // EndpointSlices on top of them, and they are asked for only while it is on
  // screen — the list view polls exactly what it polled before.
  type NetView = "list" | "route";
  let netView = $state<NetView>(untrack(() => storedSub<NetView>(sessionId, "k8sNet", "list")));
  // null = not known: not asked for, on their way, or refused (`netErrors.slices`).
  let slices = $state<K8sEndpointSlice[] | null>(null);
  // Why a list could not be read, per source; null = it was read. Kept apart from
  // the lists because an unread list and an empty one must not look the same.
  let netErrors = $state<{ services: string | null; ingress: string | null; slices: string | null }>({
    services: null,
    ingress: null,
    slices: null,
  });
  const routes = $derived(
    netView === "route" ? buildRoutes(services, netErrors.ingress === null ? ingresses : null, slices) : null,
  );
  let nodes = $state<K8sNode[]>([]);
  let events = $state<K8sEvent[]>([]);

  let menu = $state<OpenMenu | null>(null);

  // The filter rows of the lists (v1.29, ADR 0050): what each is narrowed to and
  // which groups are folded are this session's (`dockstate`); how it is ordered
  // and grouped is the app's, per list. The namespace and the context stay the
  // scope above: they are part of the command, not a filter of its answer.
  const setFilter = (list: ListId) => (next: ListFilter) => setListFilter(sessionId, list, next);
  const foldOf = (list: ListId) => collapsedGroups(sessionId, list);
  const toggleFold = (list: ListId) => (key: string) =>
    setGroupsCollapsed(sessionId, list, [key], !collapsedGroups(sessionId, list).includes(key));
  const podMetrics = (p: K8sPod) =>
    metricsByKey.get(metricsKey(p.namespace, p.name)) ?? metricsByKey.get(metricsKey("", p.name));
  // The schema reads the live snapshot when it compares: ordering by CPU follows the poll.
  const PODS = podSchema((p) => ({ cpu: parseCpuMillis(podMetrics(p)?.cpu), mem: parseMemMiB(podMetrics(p)?.mem) }));
  const SORT_LABEL: Record<string, MessageKey> = {
    name: "k8s.name",
    restarts: "k8s.restarts",
    cpu: "k8s.cpu",
    mem: "k8s.mem",
    age: "k8s.age",
  };
  const GROUP_LABEL: Record<string, MessageKey> = {
    owner: "k8s.owner",
    node: "k8s.node",
    namespace: "k8s.namespace",
    kind: "k8s.kind",
  };
  const POD_LABELS: ListLabels = {
    group: (id) => t(GROUP_LABEL[id]),
    sort: (id) => t(SORT_LABEL[id]),
    facet: (id) => t(id === "node" ? "k8s.node" : "k8s.status"),
  };
  const WORKLOAD_LABELS: ListLabels = {
    group: (id) => t(GROUP_LABEL[id]),
    sort: (id) => t(SORT_LABEL[id]),
    facet: () => t("k8s.kind"),
  };
  const podFilter = $derived(listFilter(sessionId, "k8s.pods"));
  const podOrder = $derived(listOrder("k8s.pods", PODS, POD_ORDER));
  const podView = $derived(applyView(podList, PODS, podFilter, podOrder));
  const workloadFilter = $derived(listFilter(sessionId, "k8s.workloads"));
  const workloadOrder = $derived(listOrder("k8s.workloads", WORKLOAD_SCHEMA, WORKLOAD_ORDER));
  const workloadView = $derived(applyView(workloads, WORKLOAD_SCHEMA, workloadFilter, workloadOrder));

  // The wide layout (v1.7): the panel is laid out by its container query, but
  // whether details open beside the list or as a dialog is behaviour, not layout
  // — that reads the same threshold here (`panelwide.ts`).
  let wide = $state(false);
  // Width of that row, px — what the border is dragged within.
  let rowWidth = $state(0);
  // The list's own layout (v1.33): the panel can be wide while the list, with
  // details beside it, is not — its filter row and its table follow the list.
  let listWide = $state(false);
  let attentionOpen = $state(true);
  // The restart count each pod had when the panel first saw it (`podAttention`).
  let restartsSeen = $state<Map<string, number>>(new Map());
  // Pod detail modal.
  let detailOpen = $state(false);
  let detailPod = $state<K8sPod | null>(null);
  // The view of the open details and the container picked in it — the panel's,
  // not the details' own: a dialog (narrow) and the pane beside the list (wide)
  // are two instances, and going across the width threshold must show what was
  // on screen, not Overview again.
  let detailTab = $state<K8sDetailTab>("logs");
  let detailContainer = $state<string | null>(null);

  // Shared text modal (workload describe / YAML — read-only).
  let textOpen = $state(false);
  // Something stands beside the list (describe, YAML, a pod's details): the
  // row is two parts with a border the user drags.
  const sideOpen = $derived(wide && (textOpen || detailOpen));
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
    onOpenShell?.(execShellArgv(prog, pod.name, pod.namespace, container, scope), {
      kind: "pod",
      name: pod.name,
      container: container ?? undefined,
    });
  }

  /** Follow a pod's log live in a terminal tab (`kubectl logs -f`). */
  function followLogs(pod: K8sPod, container: string | null, tail: number) {
    onOpenShell?.(followLogsArgv(prog, pod.name, pod.namespace, container, scope, tail), {
      kind: "pod",
      name: pod.name,
      container: container ?? undefined,
    });
    notifySuccess(t("k8s.logsFollowOpened", { name: pod.name }));
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
        const listed = listItems(pods.stdout);
        podList = podsOf(listed);
        podObjects = listed;
        restartsSeen = podRestartBaseline(restartsSeen, podList);
        const map = new Map<string, K8sPodMetrics>();
        for (const m of parseTopPods(top.stdout)) map.set(metricsKey(m.namespace, m.name), m);
        metricsByKey = map;
        // Fold this snapshot into the rolling CPU history (Phase 42). Keyed off the
        // pod list, so a pod that was rescheduled between the two commands is dropped.
        const live = podList.map((p) => metricsKey(p.namespace, p.name));
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
        const forRoute = netView === "route";
        const [svc, ing, eps] = await Promise.all([
          kubectlRun(sessionId, viewArgs(servicesArgs()), 20, false),
          kubectlRun(sessionId, viewArgs(ingressArgs()), 20, false),
          forRoute ? kubectlRun(sessionId, viewArgs(endpointSlicesArgs()), 20, false) : null,
        ]);
        services = parseServices(svc.stdout);
        ingresses = parseIngress(ing.stdout);
        const slicesError = eps ? listFailure(eps.stdout, eps.stderr, eps.exitCode) : null;
        // An answer asked for under the other view — the user switched while it
        // was on its way — says nothing about the slices this view needs: a late
        // list-view reload must not wipe the endpoints the route's own brought.
        const current = forRoute === (netView === "route");
        netErrors = {
          services: listFailure(svc.stdout, svc.stderr, svc.exitCode),
          ingress: listFailure(ing.stdout, ing.stderr, ing.exitCode),
          slices: current ? slicesError : netErrors.slices,
        };
        if (current) slices = eps && slicesError === null ? parseEndpointSlices(eps.stdout) : null;
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
    restartsSeen = new Map();
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

  /**
   * Switch the Network view. The slices on hand are dropped either way: the route
   * must not be drawn from endpoints older than the services beside them, so it
   * starts from "on their way" and fills on the reload below.
   */
  function pickNetView(view: NetView) {
    if (view === netView) return;
    netView = view;
    slices = null;
    netErrors.slices = null;
    rememberSub(sessionId, "k8sNet", view);
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
    onOpenShell?.(portForwardArgv(prog, target, namespace, port, port, scope));
    notifySuccess(t("k8s.portForwardStarted", { target }));
  }

  // ── Detail modal live sync ───────────────────────────────────────────────────

  function openDetails(pod: K8sPod, tab?: K8sDetailTab) {
    // Details open on the log (v1.33) and keep the view while another row is
    // picked: the list beside them is browsed, log after log. Another pod starts
    // from its default container.
    const same = detailOpen && detailPod?.namespace === pod.namespace && detailPod?.name === pod.name;
    if (tab) detailTab = tab;
    else if (!detailOpen) detailTab = "logs";
    if (!same) detailContainer = null;
    // A text asked for earlier (describe, YAML) stands in front of the details:
    // picking a pod asks for the pod.
    textOpen = false;
    detailPod = pod;
    detailOpen = true;
  }

  const ATTENTION_TEXT: Record<PodAttentionReason, MessageKey> = {
    failing: "k8s.attnFailing",
    pending: "k8s.attnPending",
    notReady: "k8s.attnNotReady",
    restarts: "k8s.attnRestarts",
  };
  const attention = $derived(
    podAttention(podList, restartsSeen).map((a) => ({
      key: a.key,
      name: a.name,
      tone: a.tone,
      reason: t(ATTENTION_TEXT[a.reason]),
      detail: a.detail,
    })),
  );
  function pickAttention(key: string) {
    const pod = podList.find((p) => metricsKey(p.namespace, p.name) === key);
    if (pod) openDetails(pod, "logs");
  }

  // The «View» menu's columns: what the user may take off the table — only where
  // the list is a table.
  const COLUMN_LABEL: Record<string, MessageKey> = {
    namespace: "k8s.namespace",
    ip: "k8s.podIp",
    node: "k8s.node",
    restarts: "k8s.restarts",
    spark: "k8s.cpuTrend",
    mem: "k8s.mem",
    limits: "k8s.limits",
    age: "k8s.age",
  };
  const columnMenu = $derived.by(() => {
    if (!listWide) return [];
    const hidden = hiddenFields("k8s.pods");
    return [
      { kind: "separator" as const },
      {
        kind: "submenu" as const,
        key: "columns",
        icon: "table" as const,
        label: t("list.columns"),
        items: hideableFields("k8s.pods").map((id) => ({
          label: t(COLUMN_LABEL[id]),
          checked: !hidden.includes(id),
          onSelect: () => toggleField("k8s.pods", id),
        })),
      },
    ];
  });
  const liveDetailPod = $derived.by(() => {
    if (!detailPod) return null;
    return podList.find((p) => p.namespace === detailPod!.namespace && p.name === detailPod!.name) ?? null;
  });
  const podDetail = $derived(
    detailOpen && liveDetailPod
      ? parsePodDetail(podItem(podObjects, liveDetailPod.namespace, liveDetailPod.name))
      : null,
  );
  const detailMetrics = $derived.by(() => {
    const p = liveDetailPod;
    if (!p) return undefined;
    return metricsByKey.get(metricsKey(p.namespace, p.name)) ?? metricsByKey.get(metricsKey("", p.name));
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  // Full init when the session becomes ready (or changes) — and on nothing else.
  // `initAll` is untracked: everything it reads before its first `await` (the
  // remembered scope, and `scope`/`prog` inside the argv it builds) would become
  // a dependency of this effect, and it then WRITES that scope itself. The effect
  // re-ran on its own result, ahead of the effect that remembers the scope, so it
  // reset the context it had just picked and probed again — every answer from
  // `kubectl` started two more probes. On a host with a kubeconfig that was an
  // exponential storm of `kubectl` on the session's server (v1.1.0).
  $effect(() => {
    void sessionId;
    if (sessionReady) {
      // Another cluster's pods are not this one's history.
      cpuHistory = {};
      restartsSeen = new Map();
      untrack(() => void initAll());
    }
  });

  // Reload when the sub-tab changes (and remember it for the next mount). Store
  // writes are untracked here and below: creating this session's entry writes the
  // same state the call reads, which would make the effect its own trigger. The
  // reload is untracked for the same reason as the init above: `refresh` reads
  // the scope, and every scope change already reloads on its own — tracked, each
  // pick of a namespace ran `kubectl` twice.
  $effect(() => {
    const sub = activeSub;
    untrack(() => {
      rememberSub(sessionId, "k8s", sub);
      if (availability?.ok) void refresh();
    });
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

<!-- `@container`: the panel lays itself out by its own width (`@wide:`), so one
     component serves a narrow side dock and the full-width bottom dock. -->
<div class="@container flex h-full min-h-0 flex-col text-xs" use:wideWhen={(w) => (wide = w)} data-wide={wide}>
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
    <!-- Header: title + refresh, the scope selectors and the sub-tabs — three
         lines in a narrow dock, one row in a wide container, where the panel has
         width to spare and little height. -->
    <div class="flex flex-wrap items-center border-b border-edge @wide:flex-nowrap" data-testid="k8s-header">
      <div class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 @wide:flex-none @wide:pr-3">
        <Icon name="kubernetes" size={15} class="shrink-0 text-accent" />
        <div class="min-w-0 flex-1">
          <div class="font-medium text-text/90">{t("k8s.panelTitle")}</div>
          <div class="truncate text-caption text-muted">{t("k8s.clusterVersion", { version: availability.serverVersion })}</div>
        </div>
      </div>
      <div class="flex shrink-0 items-center py-1.5 pl-1.5 pr-2 @wide:order-4">
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
      <div class="flex basis-full items-center gap-1.5 border-t border-edge px-2 py-1.5 text-meta @wide:order-3 @wide:ml-auto @wide:basis-auto @wide:border-t-0 @wide:py-0 @wide:pr-0">
        {#if contexts.length > 0}
          <select
            data-testid="k8s-context"
            class="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-text outline-none focus:border-accent @wide:w-44 @wide:flex-none"
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
          class="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-0.5 text-text outline-none focus:border-accent disabled:opacity-40 @wide:w-44 @wide:flex-none"
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
      <div class="flex basis-full border-t border-edge text-meta @wide:order-2 @wide:basis-auto @wide:self-stretch @wide:border-t-0">
        {#each SUBS as s (s.id)}
          <button
            data-testid={`k8s-subtab-${s.id}`}
            class="flex-1 border-b-2 py-1.5 text-center @wide:flex-none @wide:px-4 {activeSub === s.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
            aria-current={activeSub === s.id ? "true" : undefined}
            onclick={() => (activeSub = s.id)}
          >
            {s.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Active sub-view -->
    <!-- In a wide panel describe/YAML and a pod's details open beside the
         list (below), not over it. -->
    <div class="relative flex min-h-0 flex-1" bind:clientWidth={rowWidth}>
    <!-- The list is a query container of its own (v1.33): its rows are a table
         or two-line rows by the list's width, not the panel's — with details
         beside it, a wide panel's list is a narrow one. -->
    <div
      class="@container min-h-0 min-w-0 {sideOpen ? 'shrink-0' : 'flex-1'}"
      style:width={sideOpen ? partWidth("k8s", rowWidth) : null}
      use:wideWhen={(w) => (listWide = w)}
      data-testid="k8s-list-part"
      data-list-wide={listWide}
      data-morph
    >
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
        {#if podList.length === 0}
          <EmptyState icon="container" title={t("k8s.noPods")} hint={t("k8s.noPodsHint")} />
        {:else}
          <div class="flex h-full min-h-0 flex-col">
            <AttentionStrip items={attention} bind:open={attentionOpen} onpick={pickAttention} testid="k8s-attention" />
            <ListHeader
              items={podList}
              schema={PODS}
              filter={podFilter}
              onfilter={setFilter("k8s.pods")}
              order={podOrder}
              onorder={(o) => setListOrder("k8s.pods", o)}
              shown={podView.shown}
              total={podView.total}
              labels={POD_LABELS}
              placeholder={t("k8s.filterPods")}
              wide={listWide}
              onmenu={(m) => (menu = m)}
              extra={columnMenu}
              fold={(c) => setGroupsCollapsed(sessionId, "k8s.pods", podView.groups.map((g) => g.key), c)}
              testid="k8s-pods-header"
            />
            <div class="min-h-0 flex-1">
              {#if podView.shown === 0}
                <FilteredEmpty
                  summary={filterSummary(PODS, podFilter, listMenuText(POD_LABELS))}
                  onreset={() => setListFilter(sessionId, "k8s.pods", NO_FILTER)}
                />
              {:else}
                <K8sPods
                  groups={podView.groups}
                  grouped={podView.grouped}
                  grouping={podOrder.group}
                  collapsed={foldOf("k8s.pods")}
                  ontoggle={toggleFold("k8s.pods")}
                  sort={podOrder.sort}
                  onsort={(key) => setListOrder("k8s.pods", { ...podOrder, sort: nextSort(PODS, podOrder.sort, key) })}
                  {metricsByKey}
                  {cpuHistory}
                  allNamespaces={scope.allNamespaces}
                  selectedKey={detailOpen && liveDetailPod ? metricsKey(liveDetailPod.namespace, liveDetailPod.name) : null}
                  {run}
                  {openShell}
                  onViewDetails={(p) => openDetails(p)}
                  {showMenu}
                />
              {/if}
            </div>
          </div>
        {/if}
      {:else if activeSub === "workloads"}
        {#if workloads.length === 0}
          <EmptyState icon="rocket" title={t("k8s.noWorkloads")} hint={t("k8s.noWorkloadsHint")} />
        {:else}
          <div class="flex h-full min-h-0 flex-col">
            <ListHeader
              items={workloads}
              schema={WORKLOAD_SCHEMA}
              filter={workloadFilter}
              onfilter={setFilter("k8s.workloads")}
              order={workloadOrder}
              onorder={(o) => setListOrder("k8s.workloads", o)}
              shown={workloadView.shown}
              total={workloadView.total}
              labels={WORKLOAD_LABELS}
              placeholder={t("k8s.name")}
              wide={listWide}
              onmenu={(m) => (menu = m)}
              fold={(c) => setGroupsCollapsed(sessionId, "k8s.workloads", workloadView.groups.map((g) => g.key), c)}
              testid="k8s-workloads-header"
            />
            <div class="min-h-0 flex-1">
              {#if workloadView.shown === 0}
                <FilteredEmpty
                  summary={filterSummary(WORKLOAD_SCHEMA, workloadFilter, listMenuText(WORKLOAD_LABELS))}
                  onreset={() => setListFilter(sessionId, "k8s.workloads", NO_FILTER)}
                />
              {:else}
                <K8sWorkloads
                  groups={workloadView.groups}
                  grouped={workloadView.grouped}
                  grouping={workloadOrder.group}
                  collapsed={foldOf("k8s.workloads")}
                  ontoggle={toggleFold("k8s.workloads")}
                  {busy}
                  {run}
                  onDescribe={describeObj}
                  onYaml={yamlObj}
                  {showMenu}
                />
              {/if}
            </div>
          </div>
        {/if}
      {:else if activeSub === "network"}
        <K8sNetwork
          {services}
          {ingresses}
          view={netView}
          onView={pickNetView}
          {routes}
          servicesError={netErrors.services}
          ingressError={netErrors.ingress}
          slicesError={netErrors.slices}
          {run}
          onDescribe={describeObj}
          onYaml={yamlObj}
          onPortForward={portForward}
          {showMenu}
        />
      {:else if nodes.length === 0 && events.length === 0}
        <EmptyState icon="server" title={t("k8s.noNodes")} hint={t("k8s.noNodesHint")} />
      {:else}
        <K8sCluster
          {nodes}
          {events}
          {busy}
          {run}
          onDescribe={describeObj}
          onYaml={yamlObj}
          {showMenu}
          wide={listWide}
          eventFilter={listFilter(sessionId, "k8s.events")}
          oneventfilter={setFilter("k8s.events")}
          eventOrder={listOrder("k8s.events", EVENT_SCHEMA, EVENT_ORDER)}
          oneventorder={(o) => setListOrder("k8s.events", o)}
          collapsed={foldOf("k8s.events")}
          ontoggle={toggleFold("k8s.events")}
          onmenu={(m) => (menu = m)}
        />
      {/if}
    </div>
    {#if sideOpen}
      <!-- Text asked for last (describe, YAML) stands in front of the pod's
           details, as the dialogs stack; closing it shows them again. -->
      <!-- The border between the list and what stands beside it is dragged
           (`PanelDivider`); the share is the store's, one for every session. -->
      <PanelDivider split="k8s" width={rowWidth} />
      <div class="min-h-0 min-w-0 flex-1" data-testid="k8s-side" in:aside={motion(MOTION_BASE)} out:aside={motion(MOTION_BASE)}>
        {#if textOpen}
          <SidePane title={textTitle} onclose={() => (textOpen = false)} testid="k8s-side-text">
            <K8sText text={textBody} fill />
          </SidePane>
        {:else}
          <SidePane
            title={liveDetailPod?.name ?? ""}
            onclose={() => (detailOpen = false)}
            testid="k8s-side-detail"
          >
            <K8sDetail
              active
              fill
              bind:tab={detailTab}
              bind:container={detailContainer}
              pod={liveDetailPod}
              detail={podDetail}
              metrics={detailMetrics}
              {busy}
              {refreshSec}
              {run}
              {runQuery}
              {openShell}
              onFollowLogs={onOpenShell ? followLogs : undefined}
              {onAsk}
              onclose={() => (detailOpen = false)}
            />
          </SidePane>
        {/if}
      </div>
    {/if}
    </div>
  {/if}
</div>

<!-- The same two as dialogs — where the panel has no room to show them beside
     the list. Outside the root: it is a query container (see INVARIANTS). -->
<K8sDetailModal
  open={detailOpen && !wide}
  bind:tab={detailTab}
  bind:container={detailContainer}
  pod={liveDetailPod}
  detail={podDetail}
  metrics={detailMetrics}
  {busy}
  {refreshSec}
  {run}
  {runQuery}
  {openShell}
  onFollowLogs={onOpenShell ? followLogs : undefined}
  {onAsk}
  onclose={() => (detailOpen = false)}
/>

<K8sTextModal open={textOpen && !wide} title={textTitle} text={textBody} onclose={() => (textOpen = false)} />

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
