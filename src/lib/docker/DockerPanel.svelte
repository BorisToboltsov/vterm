<script lang="ts">
  // Docker panel (Phase 35) — fourth right-dock tab. Orchestrates the container
  // view for the active session's host (SSH or local): a toolbar (engine version
  // + refresh) over three sub-tabs — Containers (grouped by compose), Images,
  // Networks & volumes. Works on SSH and local tabs alike; the backend
  // `container_run` dispatches by session kind. All docker logic is pure
  // (docker.ts); this owns data + polling + actions. Mirrors GitPanel.
  //
  // The live view re-polls every `refreshSec` (default 3s) — a snapshot, never a
  // stream (`docker stats --no-stream`, `logs --tail`); interactive follow lives
  // in a real terminal (the shell button). Offline invariant intact: the daemon
  // is reached over the user's own session, never from the WebView.
  import Icon from "../ui/Icon.svelte";
  import type { AttachTarget } from "../tabs/tabattach";
  import EmptyState from "../ui/EmptyState.svelte";
  import Skeleton from "../ui/Skeleton.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import DockerContainers from "./DockerContainers.svelte";
  import DockerImages from "./DockerImages.svelte";
  import DockerDiskUsage from "./DockerDiskUsage.svelte";
  import DockerTreeSections from "./DockerTreeSections.svelte";
  import DockerImageDetail from "./DockerImageDetail.svelte";
  import DockerNetworkDetail from "./DockerNetworkDetail.svelte";
  import DockerVolumeDetail from "./DockerVolumeDetail.svelte";
  import DockerStackDetail from "./DockerStackDetail.svelte";
  import DockerItemModal from "./DockerItemModal.svelte";
  import { stackOf } from "./dockerstack";
  import { networkSubnetsArgs, parseNetworkSubnets, type DockerItem } from "./dockeritems";
  import { isSharedNetwork, type GraphPick } from "./dockernet";
  import DockerNetworks from "./DockerNetworks.svelte";
  import DockerTextModal from "./DockerTextModal.svelte";
  import DockerDetailModal from "./DockerDetailModal.svelte";
  import DockerDetail from "./DockerDetail.svelte";
  import DockerText from "./DockerText.svelte";
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
  import type { LogTailSize } from "../ui/loglines";
  import { hideableFields } from "../ui/colfit";
  import { keepPresent } from "../ui/listselect";
  import { hiddenFields, toggleField } from "../stores/colwidths.svelte";
  import { partWidth } from "../stores/panelsplit.svelte";
  import { wideWhen } from "../actions/panelwide.svelte";
  import { tooltip } from "../actions/tooltip";
  import { containerRun, dockerLogin } from "../api";
  import { settings } from "../settings/settings.svelte";
  import { notifyError, notifySuccess } from "../stores/toasts.svelte";
  import {
    versionArgs,
    psArgs,
    imagesArgs,
    networksArgs,
    volumesArgs,
    statsArgs,
    composeLogsArgs,
    followLogsArgv,
    inspectArgs,
    execShellArgv,
    loginArgs,
    registryLabel,
    parsePs,
    parseImages,
    parseNetworks,
    parseVolumes,
    parseStats,
    parseAvailability,
    inspectFactsArgs,
    parseFacts,
    staleFacts,
    factsKey,
    dockerAttention,
    restartBaseline,
    type DockerFacts,
    type FactsEntry,
    type AttentionReason,
    DOCKER_GROUP_ADD_CMD,
    needsConfirm,
    containerSchema,
    parseMemUsed,
    pruneImagesArgs,
    startArgs,
    stopArgs,
    restartArgs,
    removeArgs,
    isRunning,
    diskUsageArgs,
    diskDetailArgs,
    eventsArgs,
    parseEvents,
    eventsOf,
    resourceReadings,
    type ContainerEvent,
    type IoTotals,
    parseDiskUsage,
    parseDiskDetail,
    imageContainers,
    imageSchema,
    type DiskRow,
    type DiskDetail,
    CONTAINER_ORDER,
    IMAGE_ORDER,
    STANDALONE,
    type DockerAvailability,
    type DockerImage,
    type DockerNetwork,
    type DockerVolume,
    type DockerStat,
    type DockerContainer,
    type DockerDetailTab,
    type DockerRegistry,
  } from "./docker";
  import { parsePercent, pushSamples, type LoadHistory } from "../monitoring/loadhistory";
  import { pushReadings, type History } from "../monitoring/monhistory";
  import {
    collapsedGroups,
    keepAside,
    keptAside,
    listFilter,
    logView,
    rememberSub,
    setGroupsCollapsed,
    setListFilter,
    storedSub,
    type DockerAside,
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
     * (v1.0.14) so its data survives the switch, but polling a daemon nobody is
     * looking at is exactly what the "poll only while watched" rule forbids.
     */
    visible?: boolean;
    /** Active tab is a prod-tagged server — destructive ops need confirmation. */
    prod?: boolean;
    /** Open a real terminal tab running `command` (docker exec shell). */
    onOpenShell?: (argv: string[], target?: AttachTarget) => void;
    /** Hand a container's state + logs to the AI assistant (Phase 41). */
    onAsk?: (context: string) => void;
  } = $props();

  // Live-view poll interval (seconds), from settings (default 3s).
  const refreshSec = $derived(settings.dockerRefreshSec);

  type Sub = "containers" | "images" | "networks";
  // Restored per session, so switching terminal tabs (which does remount the dock)
  // does not drop the user back on Containers.
  let activeSub = $state<Sub>(untrack(() => storedSub<Sub>(sessionId, "docker", "containers")));

  let availability = $state<DockerAvailability | null>(null); // null = checking
  let busy = $state(false);
  // False until the first data load after a positive probe completes — drives the
  // skeleton so the panel never flashes "No containers" before the first `ps`.
  let firstLoadDone = $state(false);

  let statsById = $state<Map<string, DockerStat>>(new Map());
  // CPU history per container id, fed by the poll that already runs (Phase 42).
  let cpuHistory = $state<LoadHistory>({});
  // What `inspect` tells per container id (v1.33): the ceilings (Phase 43), the
  // restart count, the addresses, the times. Asked once for the whole batch and
  // again only for what changed or grew old (`staleFacts`) — a steady panel asks
  // once in `FACTS_TTL_MS`, not on every poll.
  let factsCache = $state<Map<string, FactsEntry>>(new Map());
  const factsById = $derived(new Map<string, DockerFacts>([...factsCache].map(([id, e]) => [id, e.facts])));
  // The restart count each container had when the panel first saw it: a count
  // that was there before is history, one that grows is news (`dockerAttention`).
  let baseline = $state<Map<string, number>>(new Map());
  let images = $state<DockerImage[]>([]);
  let networks = $state<DockerNetwork[]>([]);
  let volumes = $state<DockerVolume[]>([]);
  // Every container, ungrouped — what the networks sub-tab reads ports and
  // membership from (v1.5). The same `ps` the containers sub-tab already runs.
  let containers = $state<DockerContainer[]>([]);
  // List or graph in the networks sub-tab, remembered like the sub-tab itself.
  type NetView = "list" | "graph";
  let netView = $state<NetView>(untrack(() => storedSub<NetView>(sessionId, "dockerNet", "list")));

  function pickNetView(view: NetView) {
    netView = view;
    rememberSub(sessionId, "dockerNet", view);
  }

  // The filter rows of the three sub-tabs (v1.29, ADR 0050): what each list is
  // narrowed to and which of its groups are folded are this session's
  // (`dockstate`); how it is ordered and grouped is the app's, per list.
  const filterOf = (list: ListId): ListFilter => listFilter(sessionId, list);
  const setFilter = (list: ListId) => (next: ListFilter) => setListFilter(sessionId, list, next);
  const foldOf = (list: ListId) => collapsedGroups(sessionId, list);
  const toggleFold = (list: ListId) => (key: string) =>
    setGroupsCollapsed(sessionId, list, [key], !collapsedGroups(sessionId, list).includes(key));

  function statOf(c: DockerContainer): DockerStat | undefined {
    return statsById.get(c.id) ?? statsById.get(c.id.slice(0, 12));
  }
  // The schema reads the live snapshot when it compares: ordering by CPU follows the poll.
  const CONTAINERS = containerSchema((c) => ({ cpu: parsePercent(statOf(c)?.cpu), mem: parseMemUsed(statOf(c)?.mem) }));
  const SORT_LABEL: Record<string, MessageKey> = {
    name: "docker.name",
    image: "docker.image",
    state: "docker.status",
    cpu: "docker.cpu",
    mem: "docker.mem",
    size: "docker.size",
    created: "docker.created",
  };
  const CONTAINER_LABELS: ListLabels = {
    group: (id) => t(id === "compose" ? "docker.compose" : "docker.status"),
    sort: (id) => t(SORT_LABEL[id]),
    facet: (id) => t(id === "compose" ? "docker.compose" : "docker.status"),
    value: (facet, v) => (facet === "compose" && v === STANDALONE ? t("docker.standalone") : v),
  };
  const IMAGE_LABELS: ListLabels = {
    group: () => t("docker.repository"),
    sort: (id) => t(SORT_LABEL[id]),
    facet: (id) => t(id === "use" ? "docker.imageUse" : "docker.imageKind"),
    value: (f, v) =>
      f === "use"
        ? t(v === "used" ? "docker.imageUsed" : "docker.imageUnused")
        : t(v === "dangling" ? "docker.imageDangling" : "docker.imageTagged"),
  };
  const containerFilter = $derived(filterOf("docker.containers"));
  const containerOrder = $derived(listOrder("docker.containers", CONTAINERS, CONTAINER_ORDER));
  const containerView = $derived(applyView(containers, CONTAINERS, containerFilter, containerOrder));
  // What docker takes on the disk and who uses what (stage 2): undefined — being
  // asked, null — the answer could not be read. Asked when the images or the
  // networks view opens, on «Refresh» and after a removal — never on the poll.
  let disk = $state<DiskRow[] | null | undefined>(undefined);
  let diskDetail = $state.raw<DiskDetail | null | undefined>(undefined);
  // The «in use» facet exists only once docker has said who uses what.
  const IMAGES = $derived(imageSchema(diskDetail ? (img: DockerImage) => imageContainers(img, diskDetail) : undefined));
  const imageFilter = $derived(filterOf("docker.images"));
  const imageOrder = $derived(listOrder("docker.images", IMAGES, IMAGE_ORDER));
  const imageView = $derived(applyView(images, IMAGES, imageFilter, imageOrder));

  // What happened to the containers in the last minutes (stage 3): a snapshot of
  // `docker events` with every poll — the deaths a restart policy hides from `ps`.
  let events = $state.raw<ContainerEvent[]>([]);
  // The resources view's history (stage 3): CPU, memory and the I/O rates of
  // every container, one sample per poll, kept by the panel so the view opens
  // with what was polled while it was closed.
  let resHistory = $state.raw<History>({});
  let resSeq = $state(-1);
  let ioTotals: IoTotals = new Map();

  // Containers picked for an action on several at once (stage 2).
  let picked = $state.raw<ReadonlySet<string>>(new Set());
  const pickedContainers = $derived(containers.filter((c) => picked.has(c.id)));

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
  // Shared right-click menu (containers + images) and the container detail modal.
  let menu = $state<OpenMenu | null>(null);
  let detailOpen = $state(false);
  // By id: the poll hands over a new object for the same container every few seconds.
  let detailId = $state<string | null>(null);
  // How the details' log is read — the session's, in the dock store (v1.34): the
  // details are rebuilt across the width threshold and when the tab comes back.
  const detailLog = untrack(() => logView(sessionId, "docker"));

  function showMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, items };
  }

  // The view of the open details — the panel's, not the details' own: a dialog
  // (narrow) and the pane beside the list (wide) are two instances, and going
  // across the width threshold must show what was on screen, not Overview again.
  // Details open on the log (v1.33) and keep the view while another row is
  // picked: the list beside them is browsed, log after log.
  let detailTab = $state<DockerDetailTab>("logs");
  // An image, a network or a volume picked in the column of names (stage 4):
  // its details stand beside the list where a container's do.
  let sideItem = $state.raw<DockerItem | null>(null);
  function openItem(item: DockerItem) {
    if (modalOpen) closeModal();
    detailOpen = false;
    sideItem = item;
  }
  /** A node of the topology picked twice: a container's details, or a network's. */
  function openGraphPick(p: GraphPick) {
    if (p.kind === "container") {
      const c = containers.find((x) => x.id === p.id);
      if (c) openDetails(c);
    } else openItem({ kind: "network", name: p.name });
  }
  /** Open a container by id — from an image's, a network's or a volume's list of users. */
  function openContainerById(id: string) {
    const c = containers.find((x) => x.id === id || id.startsWith(x.id) || x.id.startsWith(id));
    if (c) openDetails(c);
  }

  function openDetails(c: DockerContainer, tab?: DockerDetailTab) {
    sideItem = null;
    if (tab) detailTab = tab;
    else if (!detailOpen) detailTab = "logs";
    // A text asked for earlier (a stack's log) stands in front of the details:
    // picking a container asks for the container.
    if (modalOpen) closeModal();
    detailId = c.id;
    detailOpen = true;
  }

  // What stood beside the list when the panel was last on screen (v1.34): put
  // back once the first poll says it is still there; until then nothing is
  // written over it. A terminal-tab switch rebuilds the panel.
  let restoring: DockerAside | null = untrack(() => keptAside(sessionId, "docker"));
  $effect(() => {
    if (!firstLoadDone || !restoring) return;
    const was = restoring;
    restoring = null;
    untrack(() => {
      if (was.kind === "item") sideItem = was.item;
      else if (containers.some((c) => c.id === was.id)) {
        detailTab = was.tab;
        detailId = was.id;
        detailOpen = true;
      }
    });
  });
  $effect(() => {
    const next: DockerAside | null =
      detailOpen && detailId
        ? { kind: "container", id: detailId, tab: detailTab }
        : sideItem
          ? { kind: "item", item: { ...sideItem } }
          : null;
    if (restoring) return;
    untrack(() => keepAside(sessionId, "docker", next));
  });
  // Keep the open detail modal's container in sync with fresh poll data (so its
  // Overview/stats update live); close it if the container disappears.
  const liveDetail = $derived.by(() => {
    if (!detailId) return null;
    return containers.find((c) => c.id === detailId) ?? null;
  });
  const detailStat = $derived.by(() => {
    const c = liveDetail;
    if (!c) return undefined;
    return statsById.get(c.id) ?? statsById.get(c.id.slice(0, 12));
  });

  // Text modal (logs / inspect). `modalArgs` is re-run on each poll while
  // `modalLive` (logs) so the buffer stays fresh; inspect is fetched once.
  let modalOpen = $state(false);
  // Something stands beside the list (logs, inspect, details): the row is
  // two parts with a border the user drags.
  const sideOpen = $derived(wide && (modalOpen || detailOpen || sideItem !== null));
  // The column of names goes on with the images, networks and volumes while
  // something stands beside it (stage 4): one column to pick anything from.
  const treeShown = $derived(sideOpen && activeSub === "containers");
  // Each network's subnets, for the topology and the column (`network inspect`, one call for all).
  let subnets = $state.raw<ReadonlyMap<string, { subnets: string[]; internal: boolean }>>(new Map());
  let subnetsOf = "";
  const ipsOf = (c: DockerContainer): string[] =>
    (factsById.get(c.id)?.addresses ?? []).map((a) => a.ipv4 || a.ipv6).filter(Boolean);
  const sideStack = $derived.by(() => {
    const item = sideItem;
    return item?.kind === "stack" ? stackOf(containers, item.project) : null;
  });
  const sideImage = $derived.by(() => {
    const item = sideItem;
    return item?.kind === "image" ? (images.find((i) => i.id === item.id) ?? null) : null;
  });
  let modalTitle = $state("");
  let modalText = $state("");
  let modalLive = $state(false);
  let modalArgs = $state<string[] | null>(null);
  // A stack's log, read like a container's: followed or held, how many lines.
  let modalProject = $state<string | null>(null);
  let modalFollowing = $state(true);
  let modalTail = $state<LogTailSize>(200);

  // Prod destructive-confirm (pending resolver pattern, like GitPanel).
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

  /** Read-only docker call (no confirm, no reload). */
  async function runQuery(args: string[], timeout = 20) {
    return containerRun(sessionId, args, timeout);
  }

  /**
   * Mutating docker call: confirm disruptive/destructive ops (every server, Phase
   * 36 point 3 — with an extra warning on prod), execute (mirrored into the
   * recording as audit, Phase 36 point 7), then reload. Never throws on a non-zero
   * docker exit — surfaces stderr as a toast.
   */
  async function run(
    args: string[],
    opts: { destructive?: boolean; successKey?: string; label?: string } = {},
  ): Promise<boolean> {
    if (busy) return false;
    if (opts.destructive || needsConfirm(args)) {
      // An action on several containers names them, not their ids (stage 2).
      const ok = await askConfirm(opts.label ?? args.join(" "));
      if (!ok) return false;
    }
    busy = true;
    try {
      const res = await containerRun(sessionId, args, 120, true);
      if (res.exitCode !== 0) {
        notifyError(res.stderr.trim() || res.stdout.trim() || t("docker.opFailed"));
        await refresh();
        return false;
      }
      if (opts.successKey) notifySuccess(t(opts.successKey as MessageKey));
      await refresh();
      // A removal or a prune changes what the disk holds and who uses what.
      const removes = ["rm", "rmi", "prune"].some((w) => args.slice(1, 3).includes(w));
      if (removes && activeSub !== "containers") void loadDisk();
      if (removes && treeShown) void loadTree();
      return true;
    } catch (e) {
      notifyError(String(e));
      return false;
    } finally {
      busy = false;
    }
  }

  /**
   * Ask `inspect` about the containers whose facts are missing, changed or old
   * (`staleFacts`), in one call, and forget the ones that are gone. A steady
   * panel makes no call at all on most polls, which is why this can sit inside
   * the poll without adding load.
   */
  async function loadFacts(list: readonly DockerContainer[]) {
    const now = Date.now();
    const live = list.map((c) => c.id);
    const next = new Map([...factsCache].filter(([id]) => live.includes(id)));
    const stale = staleFacts(list, next, now);
    if (stale.length > 0) {
      try {
        const res = await runQuery(inspectFactsArgs(stale));
        // `docker ps` yields short ids, `docker inspect` echoes the full 64-char
        // one, so the two are matched by prefix — keying the cache off the raw
        // inspect id would mean it never hits and we would re-inspect every poll.
        const answered = new Set<string>();
        for (const [fullId, facts] of parseFacts(res.stdout)) {
          const c = list.find((x) => stale.includes(x.id) && fullId.startsWith(x.id));
          if (!c) continue;
          next.set(c.id, { facts, key: factsKey(c), at: now });
          answered.add(c.id);
        }
        // Anything the inspect did not answer for is recorded as "nothing known",
        // so we do not re-ask on every poll for a container docker won't describe.
        for (const c of list) {
          if (stale.includes(c.id) && !answered.has(c.id)) {
            next.set(c.id, { facts: BLANK_FACTS, key: factsKey(c), at: now });
          }
        }
      } catch {
        /* facts are an enrichment — the panel works without them */
      }
    }
    factsCache = next;
    baseline = restartBaseline(baseline, factsById, live);
  }

  const BLANK_FACTS: DockerFacts = {
    cpuCores: null,
    memBytes: null,
    restarts: null,
    networkMode: "",
    addresses: [],
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    oomKilled: false,
    ports: "",
  };

  /** The networks' subnets — asked again only when the set of networks changes. */
  async function loadSubnets() {
    const names = networks.map((n) => n.name).filter(isSharedNetwork);
    const key = names.join("\n");
    if (names.length === 0 || key === subnetsOf) return;
    try {
      const res = await runQuery(networkSubnetsArgs(names));
      if (res.exitCode === 0) {
        subnets = parseNetworkSubnets(res.stdout);
        subnetsOf = key;
      }
    } catch {
      /* subnets are an enrichment */
    }
  }

  // The column's images, networks and volumes: read when it appears and on
  // «Refresh» — not on the containers' poll, they change on the user's action.
  let treeStale = true;
  async function loadTree() {
    treeStale = false;
    const [im, ns, vs] = await Promise.allSettled([runQuery(imagesArgs()), runQuery(networksArgs()), runQuery(volumesArgs())]);
    if (im.status === "fulfilled") images = parseImages(im.value.stdout);
    if (ns.status === "fulfilled") networks = parseNetworks(ns.value.stdout);
    if (vs.status === "fulfilled") volumes = parseVolumes(vs.value.stdout);
    if (!diskDetail) void loadDisk();
  }
  $effect(() => {
    if (treeShown) untrack(() => void loadTree());
  });

  /** Ask docker what the disk holds and who uses what — two reads, side by side. */
  async function loadDisk() {
    if (!sessionReady || !availability?.ok) return;
    const [sum, det] = await Promise.allSettled([runQuery(diskUsageArgs(), 60), runQuery(diskDetailArgs(), 60)]);
    disk = sum.status === "fulfilled" && sum.value.exitCode === 0 ? parseDiskUsage(sum.value.stdout) : null;
    diskDetail = det.status === "fulfilled" && det.value.exitCode === 0 ? parseDiskDetail(det.value.stdout) : null;
  }

  // ── Several containers at once (stage 2) ──────────────────────────────────

  const namesOf = (list: readonly DockerContainer[]): string => list.map((c) => c.name).join(" ");
  async function bulk(kind: "start" | "stop" | "restart" | "remove") {
    const all = pickedContainers;
    const running = all.filter(isRunning);
    const stopped = all.filter((c) => !isRunning(c));
    if (kind === "start" && stopped.length) {
      await run(startArgs(stopped.map((c) => c.id)), { successKey: "docker.started" });
    } else if (kind === "stop" && running.length) {
      await run(stopArgs(running.map((c) => c.id)), { successKey: "docker.stopped", label: `docker stop ${namesOf(running)}` });
    } else if (kind === "restart" && all.length) {
      await run(restartArgs(all.map((c) => c.id)), { successKey: "docker.restarted", label: `docker restart ${namesOf(all)}` });
    } else if (kind === "remove" && all.length) {
      const force = running.length > 0;
      const ok = await run(removeArgs(all.map((c) => c.id), force), {
        destructive: true,
        successKey: "docker.removed",
        label: `docker rm${force ? " -f" : ""} ${namesOf(all)}`,
      });
      if (ok) picked = new Set();
    }
  }

  /** Probe whether docker is usable on this host (drives the empty state). */
  async function checkAvailability() {
    try {
      const res = await runQuery(versionArgs());
      availability = parseAvailability(res.stdout, res.stderr, res.exitCode);
    } catch (e) {
      availability = { ok: false, reason: "unknown", detail: String(e) };
    }
  }

  /**
   * Re-probe from the unavailable state (e.g. the user just started the daemon
   * or joined the docker group) — mirrors the mount effect. Flips back to the
   * checking placeholder, then re-runs the probe + first load.
   */
  async function retry() {
    availability = null;
    firstLoadDone = false;
    await checkAvailability();
    await refresh();
  }

  /** Reload the active sub-tab's data (+ stats for containers, + live modal). */
  async function refresh() {
    if (!sessionReady || !availability?.ok) return;
    try {
      if (activeSub === "containers") {
        const [ps, st, ev] = await Promise.all([
          runQuery(psArgs()),
          runQuery(statsArgs()),
          runQuery(eventsArgs()).catch(() => null),
        ]);
        containers = parsePs(ps.stdout);
        // Events are an enrichment: a docker that refuses them leaves the last answer.
        if (ev && ev.exitCode === 0) events = parseEvents(ev.stdout);
        picked = keepPresent(picked, containers.map((c) => c.id));
        const map = new Map<string, DockerStat>();
        for (const s of parseStats(st.stdout)) map.set(s.id, s);
        statsById = map;
        // Fold this snapshot into the rolling history. Keyed off the `ps` list so
        // a container that vanished between the two commands drops its history.
        const live = containers.map((c) => c.id);
        const cpu = new Map<string, number>();
        for (const id of live) {
          const pct = parsePercent((map.get(id) ?? map.get(id.slice(0, 12)))?.cpu);
          if (pct != null) cpu.set(id, pct);
        }
        cpuHistory = pushSamples(cpuHistory, live, cpu);
        const res = resourceReadings([...map.values()], containers, ioTotals, Date.now(), parsePercent);
        ioTotals = res.totals;
        resSeq += 1;
        resHistory = pushReadings(resHistory, resSeq, res.readings);
        await loadFacts(containers);
      } else if (activeSub === "images") {
        images = parseImages((await runQuery(imagesArgs())).stdout);
      } else {
        // `ps` rides along: ports and network membership are fields of it.
        const [ns, vs, ps] = await Promise.all([
          runQuery(networksArgs()),
          runQuery(volumesArgs()),
          runQuery(psArgs()),
        ]);
        networks = parseNetworks(ns.stdout);
        volumes = parseVolumes(vs.stdout);
        containers = parsePs(ps.stdout);
        // The topology draws addresses and subnets: the facts and one `network inspect`.
        await loadFacts(containers);
        await loadSubnets();
      }
      if (treeShown && activeSub === "containers" && treeStale) await loadTree();
      if (modalOpen && modalLive && modalFollowing && modalArgs) {
        const res = await runQuery(modalArgs, 30);
        modalText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
      }
    } catch (e) {
      notifyError(String(e));
    } finally {
      firstLoadDone = true;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function openShell(c: DockerContainer) {
    onOpenShell?.(execShellArgv(c.id), { kind: "container", name: c.name, image: c.image });
    notifySuccess(t("docker.shellOpened", { name: c.name }));
  }

  /** Follow a container's log live in a terminal tab (`docker logs -f`). */
  function followLogs(c: DockerContainer, tail: number) {
    onOpenShell?.(followLogsArgv(c.id, tail), { kind: "container", name: c.name, image: c.image });
    notifySuccess(t("docker.logsFollowOpened", { name: c.name }));
  }

  async function openText(title: string, args: string[], live: boolean) {
    modalTitle = title;
    modalArgs = args;
    modalLive = live;
    modalText = "";
    modalOpen = true;
    const res = await runQuery(args, 30);
    modalText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
  }

  // A container's log and inspect are views of its details (v1.33) — one place
  // to read a container, whichever way it was asked for.
  function openLogs(c: DockerContainer) {
    openDetails(c, "logs");
  }
  function openComposeLogs(project: string) {
    modalProject = project;
    modalFollowing = true;
    void openText(t("docker.logsTitle", { name: project }), composeLogsArgs(project, modalTail), true);
  }
  function openInspect(c: DockerContainer) {
    openDetails(c, "inspect");
  }
  function openImageInspect(img: DockerImage) {
    const name = `${img.repository}:${img.tag}`;
    void openText(t("docker.inspectTitle", { name }), inspectArgs(img.id), false);
  }
  function closeModal() {
    modalOpen = false;
    modalArgs = null;
    modalLive = false;
    modalProject = null;
  }

  // A new tail size for a stack's log is a new question: ask it now.
  $effect(() => {
    const lines = modalTail;
    const project = untrack(() => modalProject);
    if (!project) return;
    untrack(() => {
      modalArgs = composeLogsArgs(project, lines);
      void runQuery(modalArgs, 30).then((res) => {
        if (modalProject === project) modalText = res.stdout + (res.stderr.trim() ? `\n${res.stderr}` : "");
      });
    });
  });

  // ── Registry login (Phase 36, point 6) ───────────────────────────────────────

  const registries = $derived<DockerRegistry[]>(settings.dockerRegistries);

  /** Log the session's docker into `reg` (password read from keychain on backend). */
  async function loginRegistry(reg: DockerRegistry) {
    if (busy) return;
    busy = true;
    try {
      const res = await dockerLogin(sessionId, reg.url, loginArgs(reg.url, reg.username));
      if (res.exitCode !== 0) {
        notifyError(res.stderr.trim() || res.stdout.trim() || t("docker.loginFailed"));
      } else {
        notifySuccess(t("docker.loginOk", { registry: registryLabel(reg.url) }));
      }
    } catch (e) {
      notifyError(String(e));
    } finally {
      busy = false;
    }
  }

  /** Open the registry picker as a context menu anchored to the login button. */
  function openLoginMenu(e: MouseEvent) {
    const items: MenuItem[] = registries.map((reg) => ({
      icon: "container",
      label: `${registryLabel(reg.url)} · ${reg.username}`,
      onSelect: () => loginRegistry(reg),
    }));
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { x: r.left, y: r.bottom + 2, items };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  // Check availability when the session becomes ready (or changes).
  $effect(() => {
    void sessionId;
    if (sessionReady) {
      availability = null;
      firstLoadDone = false;
      // Another host's containers are not this host's history, and ids collide
      // across hosts often enough (same compose file) to matter.
      cpuHistory = {};
      factsCache = new Map();
      baseline = new Map();
      picked = new Set();
      disk = undefined;
      diskDetail = undefined;
      sideItem = null;
      subnets = new Map();
      subnetsOf = "";
      treeStale = true;
      events = [];
      resHistory = {};
      resSeq = -1;
      ioTotals = new Map();
      void checkAvailability().then(() => refresh());
    }
  });

  // Reload when the sub-tab changes (and remember it for the next mount). The
  // store write is untracked: creating this session's entry writes the same state
  // the call reads, which would otherwise make the effect its own trigger.
  $effect(() => {
    const sub = activeSub;
    untrack(() => rememberSub(sessionId, "docker", sub));
    if (availability?.ok) {
      void refresh();
      // What the disk holds is read when its views open, not on every poll.
      if (sub !== "containers") untrack(() => void loadDisk());
    }
  });

  // Poll the live view while docker is available AND the tab is on screen. A
  // hidden panel keeps its data (that is the point of staying mounted) but stops
  // asking for new data — one snapshot on return replaces it.
  $effect(() => {
    const sec = Math.max(1, refreshSec);
    if (!visible || !sessionReady || !availability?.ok) return;
    const id = setInterval(() => void refresh(), sec * 1000);
    return () => clearInterval(id);
  });

  // Coming back into view: refresh once immediately rather than showing whatever
  // the snapshot was when the user left.
  let wasVisible = untrack(() => visible);
  $effect(() => {
    const back = visible && !wasVisible;
    wasVisible = visible;
    if (back) untrack(() => void refresh());
  });

  // Close the detail modal if its container disappears (removed elsewhere / poll).
  $effect(() => {
    if (detailOpen && firstLoadDone && !liveDetail) detailOpen = false;
  });

  const ATTENTION_TEXT: Record<AttentionReason, MessageKey> = {
    crashing: "docker.attnCrashing",
    dead: "docker.attnDead",
    restarting: "docker.attnRestarting",
    oom: "docker.attnOom",
    unhealthy: "docker.attnUnhealthy",
    restarts: "docker.attnRestarts",
    exited: "docker.attnExited",
  };
  const attention = $derived(
    dockerAttention(containers, factsById, baseline, Date.now(), events).map((a) => ({
      key: a.id,
      name: a.name,
      tone: a.tone,
      reason: t(ATTENTION_TEXT[a.reason]),
      detail: a.detail,
    })),
  );
  // The topology frames a container in trouble in the strip's colour.
  const troubleById = $derived(new Map(attention.map((a) => [a.key, a.tone] as const)));
  const troubleOf = (id: string): "warn" | "bad" | null => troubleById.get(id) ?? null;

  function pickAttention(id: string) {
    const c = containers.find((x) => x.id === id);
    if (c) openDetails(c, "logs");
  }

  // The «View» menu's columns: what the user may take off the table — only where
  // the list is a table.
  const COLUMN_LABEL: Record<string, MessageKey> = {
    image: "docker.image",
    state: "docker.state",
    ports: "docker.ports",
    ip: "docker.address",
  };
  const columnMenu = $derived.by(() => {
    if (!listWide) return [];
    const hidden = hiddenFields("docker.containers");
    return [
      { kind: "separator" as const },
      {
        kind: "submenu" as const,
        key: "columns",
        icon: "table" as const,
        label: t("list.columns"),
        items: hideableFields("docker.containers").map((id) => ({
          label: t(COLUMN_LABEL[id]),
          checked: !hidden.includes(id),
          onSelect: () => toggleField("docker.containers", id),
        })),
      },
    ];
  });

  const SUBS: { id: Sub; label: string }[] = [
    { id: "containers", label: t("docker.containers") },
    { id: "images", label: t("docker.images") },
    { id: "networks", label: t("docker.networksVolumes") },
  ];

  const unavailableHint = $derived.by(() => {
    if (!availability || availability.ok) return "";
    const key: MessageKey =
      availability.reason === "missing"
        ? "docker.missing"
        : availability.reason === "daemon"
          ? "docker.daemonDown"
          : availability.reason === "denied"
            ? "docker.denied"
            : "docker.unknownErr";
    return t(key);
  });
</script>

{#snippet treeAfter()}
  <DockerTreeSections {images} {networks} {volumes} usage={diskDetail} picked={sideItem} onpick={openItem} />
{/snippet}

<!-- `@container`: the panel lays itself out by its own width (`@wide:`), so one
     component serves a narrow side dock and the full-width bottom dock. -->
<div class="@container flex h-full min-h-0 flex-col text-xs" use:wideWhen={(w) => (wide = w)} data-wide={wide}>
  {#if !sessionReady}
    <EmptyState icon="container" title={t("docker.checking")} />
  {:else if availability === null}
    <EmptyState icon="container" title={t("docker.checking")} />
  {:else if !availability.ok}
    <EmptyState icon="container" title={t("docker.unavailableTitle")} hint={unavailableHint}>
      {#if availability.reason === "denied"}
        <div class="flex flex-col items-center gap-1.5">
          <div class="flex items-center gap-1.5 rounded border border-edge bg-panel-alt px-2 py-1">
            <code class="select-text font-mono text-meta text-text">{DOCKER_GROUP_ADD_CMD}</code>
            <CopyButton text={DOCKER_GROUP_ADD_CMD} testid="docker-denied-copy" />
          </div>
          <p class="max-w-xs text-meta leading-relaxed text-muted">{t("docker.deniedRelogin")}</p>
        </div>
      {/if}
      <button
        class="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge hover:text-text disabled:opacity-40"
        data-testid="docker-retry"
        onclick={() => retry()}
      >
        {t("docker.retry")}
      </button>
    </EmptyState>
  {:else}
    <!-- Header: title and actions on one line, sub-tabs under them. In a wide
         container the three share a single row — there the panel has width to
         spare and little height. -->
    <div class="flex flex-wrap items-center border-b border-edge @wide:flex-nowrap" data-testid="docker-header">
      <div class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 @wide:flex-none @wide:pr-3">
        <Icon name="container" size={15} class="shrink-0 text-accent" />
        <div class="min-w-0 flex-1">
          <div class="font-medium text-text/90">{t("docker.panelTitle")}</div>
          <div class="truncate text-caption text-muted">{t("docker.serverVersion", { version: availability.version })}</div>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5 py-1.5 pl-1.5 pr-2 @wide:order-3 @wide:ml-auto">
        {#if registries.length > 0}
          <button class="rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.registryLogin")} aria-label={t("docker.registryLogin")} onclick={openLoginMenu}>
            <Icon name="key" size={14} />
          </button>
        {/if}
        <button class="rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.refresh")} aria-label={t("docker.refresh")} onclick={() => { void refresh(); if (activeSub !== "containers") void loadDisk(); }}>
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <!-- Sub-tabs -->
      <div class="flex basis-full border-t border-edge text-meta @wide:order-2 @wide:basis-auto @wide:self-stretch @wide:border-t-0">
        {#each SUBS as s (s.id)}
          <button
            data-testid={`docker-subtab-${s.id}`}
            class="flex-1 border-b-2 py-1.5 text-center @wide:flex-none @wide:px-4 {activeSub === s.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
            aria-current={activeSub === s.id ? "true" : undefined}
            onclick={() => (activeSub = s.id)}
          >
            {s.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Active sub-view; in a wide panel logs, inspect and a container's
         details open beside it (below), not over it. -->
    <div class="relative flex min-h-0 flex-1" bind:clientWidth={rowWidth}>
    <!-- The list is a query container of its own (v1.33): its rows are a table
         or two-line rows by the list's width, not the panel's — with details
         beside it, a wide panel's list is a narrow one. -->
    <div
      class="@container min-h-0 min-w-0 {sideOpen ? 'shrink-0' : 'flex-1'}"
      style:width={sideOpen ? partWidth("docker", rowWidth) : null}
      use:wideWhen={(w) => (listWide = w)}
      data-testid="docker-list-part"
      data-list-wide={listWide}
      data-morph
    >
      {#if !firstLoadDone}
        <!-- Skeleton until the first load completes (Phase 36, point 2) — never
             flash "No containers" on a host that actually has some. -->
        <div class="space-y-2 p-2.5" data-testid="docker-skeleton" aria-hidden="true">
          {#each [0, 1, 2, 3, 4] as i (i)}
            <div class="flex items-center gap-2">
              <Skeleton width="7px" height="7px" class="shrink-0 rounded-full" />
              <Skeleton width="{40 + ((i * 13) % 45)}%" height="0.7rem" />
            </div>
          {/each}
        </div>
      {:else if activeSub === "containers"}
        {#if containers.length === 0}
          <EmptyState icon="container" title={t("docker.noContainers")} hint={t("docker.noContainersHint")} />
        {:else}
          <div class="flex h-full min-h-0 flex-col">
          <AttentionStrip items={attention} bind:open={attentionOpen} onpick={pickAttention} testid="docker-attention" />
          <ListHeader
            items={containers}
            schema={CONTAINERS}
            filter={containerFilter}
            onfilter={setFilter("docker.containers")}
            order={containerOrder}
            onorder={(o) => setListOrder("docker.containers", o)}
            shown={containerView.shown}
            total={containerView.total}
            labels={CONTAINER_LABELS}
            placeholder={t("docker.filterContainers")}
            wide={listWide}
            onmenu={(m) => (menu = m)}
            extra={columnMenu}
            fold={(c) => setGroupsCollapsed(sessionId, "docker.containers", containerView.groups.map((g) => g.key), c)}
            testid="docker-list-header"
          />
          {#if picked.size > 0}
            {@const running = pickedContainers.filter(isRunning).length}
            <!-- An action on the picked containers at once; the confirmation names them. -->
            <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge bg-accent/10 px-2 py-1 text-meta" data-testid="docker-picked-bar">
              <span class="mr-1 text-text/90">{t("docker.picked", { n: picked.size })}</span>
              <button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy || running === picked.size} data-testid="docker-picked-start" onclick={() => bulk("start")}><Icon name="play" size={12} />{t("docker.start")}</button>
              <button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy || running === 0} data-testid="docker-picked-stop" onclick={() => bulk("stop")}><Icon name="stop" size={12} />{t("docker.stop")}</button>
              <button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} data-testid="docker-picked-restart" onclick={() => bulk("restart")}><Icon name="refresh" size={12} />{t("docker.restart")}</button>
              <button class="flex items-center gap-1 rounded px-1.5 py-0.5 text-danger hover:bg-edge disabled:opacity-40" disabled={busy} data-testid="docker-picked-remove" onclick={() => bulk("remove")}><Icon name="trash" size={12} />{t("docker.remove")}</button>
              <button class="ml-auto rounded p-1 text-muted hover:bg-edge hover:text-text" aria-label={t("docker.pickedClear")} use:tooltip={t("docker.pickedClear")} data-testid="docker-picked-clear" onclick={() => (picked = new Set())}><Icon name="close" size={12} /></button>
            </div>
          {/if}
          <div class="min-h-0 flex-1">
          {#if containerView.shown === 0}
            <FilteredEmpty
              summary={filterSummary(CONTAINERS, containerFilter, listMenuText(CONTAINER_LABELS))}
              onreset={() => setListFilter(sessionId, "docker.containers", NO_FILTER)}
            />
          {:else}
          <DockerContainers
            groups={containerView.groups}
            grouped={containerView.grouped}
            grouping={containerOrder.group}
            collapsed={foldOf("docker.containers")}
            ontoggle={toggleFold("docker.containers")}
            sort={containerOrder.sort}
            onsort={(key) => setListOrder("docker.containers", { ...containerOrder, sort: nextSort(CONTAINERS, containerOrder.sort, key) })}
            {statsById}
            {cpuHistory}
            {factsById}
            all={containers}
            selectedId={detailOpen ? (liveDetail?.id ?? null) : null}
            {picked}
            onpick={(next) => (picked = next)}
            after={treeShown ? treeAfter : undefined}
            {busy}
            {run}
            onShell={openShell}
            onLogs={openLogs}
            onInspect={openInspect}
            onComposeLogs={openComposeLogs}
            onStackOpen={(project) => openItem({ kind: "stack", project })}
            onViewDetails={openDetails}
            {showMenu}
          />
          {/if}
          </div>
          </div>
        {/if}
      {:else if activeSub === "images"}
        <!-- What the disk holds stands above the images, with or without any:
             the build cache and the volumes take room on a host with no images. -->
        <div class="flex h-full min-h-0 flex-col">
        <DockerDiskUsage rows={disk} />
        {#if images.length === 0}
          <div class="min-h-0 flex-1"><EmptyState icon="container" title={t("docker.noImages")} /></div>
        {:else}
          <div class="flex min-h-0 flex-1 flex-col">
            <ListHeader
              items={images}
              schema={IMAGES}
              filter={imageFilter}
              onfilter={setFilter("docker.images")}
              order={imageOrder}
              onorder={(o) => setListOrder("docker.images", o)}
              shown={imageView.shown}
              total={imageView.total}
              labels={IMAGE_LABELS}
              placeholder={t("docker.filterImages")}
              wide={listWide}
              onmenu={(m) => (menu = m)}
              fold={(c) => setGroupsCollapsed(sessionId, "docker.images", imageView.groups.map((g) => g.key), c)}
              testid="docker-images-header"
            >
              <button
                class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-edge hover:text-text disabled:opacity-40"
                disabled={busy}
                onclick={() => run(pruneImagesArgs(), { destructive: true, successKey: "docker.pruned" })}
              >
                <Icon name="trash" size={12} />
                {t("docker.pruneImages")}
              </button>
            </ListHeader>
            <div class="min-h-0 flex-1">
              {#if imageView.shown === 0}
                <FilteredEmpty
                  summary={filterSummary(IMAGES, imageFilter, listMenuText(IMAGE_LABELS))}
                  onreset={() => setListFilter(sessionId, "docker.images", NO_FILTER)}
                />
              {:else}
                <DockerImages
                  groups={imageView.groups}
                  grouped={imageView.grouped}
                  collapsed={foldOf("docker.images")}
                  ontoggle={toggleFold("docker.images")}
                  {busy}
                  detail={diskDetail}
                  {run}
                  onInspect={openImageInspect}
                  {showMenu}
                />
              {/if}
            </div>
          </div>
        {/if}
        </div>
      {:else}
        <DockerNetworks
          {networks}
          {volumes}
          usage={diskDetail}
          ips={ipsOf}
          {subnets}
          trouble={troubleOf}
          onopen={openGraphPick}
          {containers}
          facts={factsById}
          view={netView}
          onView={pickNetView}
          {busy}
          {run}
          wide={listWide}
          filter={filterOf("docker.networks")}
          onfilter={setFilter("docker.networks")}
          collapsed={foldOf("docker.networks")}
          ontoggle={toggleFold("docker.networks")}
          onmenu={(m) => (menu = m)}
        />
      {/if}
    </div>
    {#if sideOpen}
      <!-- Text asked for last (logs, inspect) stands in front of the details,
           as the dialogs stack; closing it shows them again. -->
      <!-- The border between the list and what stands beside it is dragged
           (`PanelDivider`); the share is the store's, one for every session. -->
      <PanelDivider split="docker" width={rowWidth} />
      <div class="min-h-0 min-w-0 flex-1" data-testid="docker-side" in:aside={motion(MOTION_BASE)} out:aside={motion(MOTION_BASE)}>
        {#if modalOpen}
          <SidePane title={modalTitle} onclose={closeModal} testid="docker-side-text">
            <DockerText text={modalText} live={modalLive} bind:following={modalFollowing} bind:tail={modalTail} fill />
          </SidePane>
        {:else if sideItem}
          {@const item = sideItem}
          <SidePane title={item.kind === "image" ? item.label : item.kind === "stack" ? item.project : item.name} onclose={() => (sideItem = null)} testid="docker-side-item">
            {#if item.kind === "image"}
              <DockerImageDetail image={sideImage} detail={diskDetail} {busy} {refreshSec} {run} runQuery={(a, tm) => runQuery(a, tm)} onopen={openContainerById} onclose={() => (sideItem = null)} />
            {:else if item.kind === "stack"}
              <DockerStackDetail stack={sideStack} fill {busy} {refreshSec} {run} runQuery={(a, tm) => runQuery(a, tm)} onopen={openContainerById} />
            {:else if item.kind === "network"}
              <DockerNetworkDetail name={item.name} {busy} {refreshSec} {run} runQuery={(a, tm) => runQuery(a, tm)} onopen={openContainerById} onclose={() => (sideItem = null)} />
            {:else}
              <DockerVolumeDetail name={item.name} usage={diskDetail} {busy} {refreshSec} {run} runQuery={(a, tm) => runQuery(a, tm)} onopen={openContainerById} onclose={() => (sideItem = null)} />
            {/if}
          </SidePane>
        {:else}
          <SidePane
            title={liveDetail?.name ?? ""}
            onclose={() => (detailOpen = false)}
            testid="docker-side-detail"
          >
            <DockerDetail
              active
              fill
              bind:tab={detailTab}
              log={detailLog}
              container={liveDetail}
              stat={detailStat}
              facts={liveDetail ? factsById.get(liveDetail.id) : undefined}
              events={liveDetail ? eventsOf(events, liveDetail.id) : []}
              history={resHistory}
              seq={resSeq}
              {containers}
              {busy}
              {refreshSec}
              {run}
              runQuery={(args, timeout) => runQuery(args, timeout)}
              onShell={openShell}
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
<DockerTextModal
  open={modalOpen && !wide}
  title={modalTitle}
  text={modalText}
  live={modalLive}
  bind:following={modalFollowing}
  bind:tail={modalTail}
  onclose={closeModal}
/>

<DockerDetailModal
  open={detailOpen && !wide}
  bind:tab={detailTab}
  log={detailLog}
  container={liveDetail}
  stat={detailStat}
  facts={liveDetail ? factsById.get(liveDetail.id) : undefined}
  events={liveDetail ? eventsOf(events, liveDetail.id) : []}
  history={resHistory}
  seq={resSeq}
  {containers}
  {busy}
  {refreshSec}
  {run}
  runQuery={(args, timeout) => runQuery(args, timeout)}
  onShell={openShell}
  onFollowLogs={onOpenShell ? followLogs : undefined}
  {onAsk}
  onclose={() => (detailOpen = false)}
/>

<!-- An image's, a network's, a volume's or a stack's details where there is no room beside the list. -->
<DockerItemModal
  open={sideItem !== null && !wide}
  item={sideItem}
  image={sideImage}
  stack={sideStack}
  usage={diskDetail}
  {busy}
  {refreshSec}
  {run}
  runQuery={(a, tm) => runQuery(a, tm)}
  onopen={(id) => {
    sideItem = null;
    openContainerById(id);
  }}
  onclose={() => (sideItem = null)}
/>

<ContextMenu {menu} onclose={() => (menu = null)} />

<ConfirmDialog
  open={confirmOpen}
  title={t("docker.confirmTitle")}
  confirmLabel={t("common.ok")}
  onconfirm={() => settleConfirm(true)}
  oncancel={() => settleConfirm(false)}
>
  {t("docker.confirmBody")}
  <code class="mt-1 block break-all rounded bg-panel px-1 py-0.5 text-text/80">{confirmText}</code>
  {#if prod}
    <span class="mt-1 block text-meta text-danger">{t("docker.confirmProdWarn")}</span>
  {/if}
</ConfirmDialog>
