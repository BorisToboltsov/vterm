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
  import Icon from "./Icon.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Skeleton from "./Skeleton.svelte";
  import CopyButton from "./CopyButton.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import DockerContainers from "./DockerContainers.svelte";
  import DockerImages from "./DockerImages.svelte";
  import DockerNetworks from "./DockerNetworks.svelte";
  import DockerTextModal from "./DockerTextModal.svelte";
  import DockerDetailModal from "./DockerDetailModal.svelte";
  import { tooltip } from "./actions/tooltip";
  import { containerRun, dockerLogin } from "./api";
  import { settings } from "./settings.svelte";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import {
    versionArgs,
    psArgs,
    imagesArgs,
    networksArgs,
    volumesArgs,
    statsArgs,
    logsArgs,
    composeLogsArgs,
    inspectArgs,
    execShellCommand,
    loginArgs,
    registryLabel,
    parsePs,
    parseImages,
    parseNetworks,
    parseVolumes,
    parseStats,
    parseAvailability,
    DOCKER_GROUP_ADD_CMD,
    groupByCompose,
    needsConfirm,
    type DockerAvailability,
    type ComposeGroup,
    type DockerImage,
    type DockerNetwork,
    type DockerVolume,
    type DockerStat,
    type DockerContainer,
    type DockerRegistry,
  } from "./docker";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { t, type MessageKey } from "./i18n";

  let {
    sessionId,
    sessionReady = true,
    prod = false,
    onOpenShell,
  }: {
    sessionId: string;
    /** SSH tab is connected (local tabs are always ready). */
    sessionReady?: boolean;
    /** Active tab is a prod-tagged server — destructive ops need confirmation. */
    prod?: boolean;
    /** Open a real terminal tab running `command` (docker exec shell). */
    onOpenShell?: (command: string) => void;
  } = $props();

  // Live-view poll interval (seconds), from settings (default 3s).
  const refreshSec = $derived(settings.dockerRefreshSec);

  type Sub = "containers" | "images" | "networks";
  let activeSub = $state<Sub>("containers");

  let availability = $state<DockerAvailability | null>(null); // null = checking
  let busy = $state(false);
  // False until the first data load after a positive probe completes — drives the
  // skeleton so the panel never flashes "No containers" before the first `ps`.
  let firstLoadDone = $state(false);

  let groups = $state<ComposeGroup[]>([]);
  let statsById = $state<Map<string, DockerStat>>(new Map());
  let images = $state<DockerImage[]>([]);
  let networks = $state<DockerNetwork[]>([]);
  let volumes = $state<DockerVolume[]>([]);

  // Shared right-click menu (containers + images) and the container detail modal.
  let menu = $state<OpenMenu | null>(null);
  let detailOpen = $state(false);
  let detailContainer = $state<DockerContainer | null>(null);

  function showMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, items };
  }

  function openDetails(c: DockerContainer) {
    detailContainer = c;
    detailOpen = true;
  }
  // Keep the open detail modal's container in sync with fresh poll data (so its
  // Overview/stats update live); close it if the container disappears.
  const liveDetail = $derived.by(() => {
    if (!detailContainer) return null;
    for (const g of groups) {
      const found = g.containers.find((c) => c.id === detailContainer!.id);
      if (found) return found;
    }
    return null;
  });
  const detailStat = $derived.by(() => {
    const c = liveDetail;
    if (!c) return undefined;
    return statsById.get(c.id) ?? statsById.get(c.id.slice(0, 12));
  });

  // Text modal (logs / inspect). `modalArgs` is re-run on each poll while
  // `modalLive` (logs) so the buffer stays fresh; inspect is fetched once.
  let modalOpen = $state(false);
  let modalTitle = $state("");
  let modalText = $state("");
  let modalLive = $state(false);
  let modalArgs = $state<string[] | null>(null);

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
    opts: { destructive?: boolean; successKey?: string } = {},
  ): Promise<boolean> {
    if (busy) return false;
    if (opts.destructive || needsConfirm(args)) {
      const ok = await askConfirm(args.join(" "));
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
      return true;
    } catch (e) {
      notifyError(String(e));
      return false;
    } finally {
      busy = false;
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
        const [ps, st] = await Promise.all([runQuery(psArgs()), runQuery(statsArgs())]);
        groups = groupByCompose(parsePs(ps.stdout));
        const map = new Map<string, DockerStat>();
        for (const s of parseStats(st.stdout)) map.set(s.id, s);
        statsById = map;
      } else if (activeSub === "images") {
        images = parseImages((await runQuery(imagesArgs())).stdout);
      } else {
        const [ns, vs] = await Promise.all([runQuery(networksArgs()), runQuery(volumesArgs())]);
        networks = parseNetworks(ns.stdout);
        volumes = parseVolumes(vs.stdout);
      }
      if (modalOpen && modalLive && modalArgs) {
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
    onOpenShell?.(execShellCommand(c.id));
    notifySuccess(t("docker.shellOpened", { name: c.name }));
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

  function openLogs(c: DockerContainer) {
    void openText(t("docker.logsTitle", { name: c.name }), logsArgs(c.id), true);
  }
  function openComposeLogs(project: string) {
    void openText(t("docker.logsTitle", { name: project }), composeLogsArgs(project), true);
  }
  function openInspect(c: DockerContainer) {
    void openText(t("docker.inspectTitle", { name: c.name }), inspectArgs(c.id), false);
  }
  function openImageInspect(img: DockerImage) {
    const name = `${img.repository}:${img.tag}`;
    void openText(t("docker.inspectTitle", { name }), inspectArgs(img.id), false);
  }
  function closeModal() {
    modalOpen = false;
    modalArgs = null;
    modalLive = false;
  }

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
      void checkAvailability().then(() => refresh());
    }
  });

  // Reload when the sub-tab changes.
  $effect(() => {
    void activeSub;
    if (availability?.ok) void refresh();
  });

  // Poll the live view while docker is available.
  $effect(() => {
    const sec = Math.max(1, refreshSec);
    if (!sessionReady || !availability?.ok) return;
    const id = setInterval(() => void refresh(), sec * 1000);
    return () => clearInterval(id);
  });

  // Close the detail modal if its container disappears (removed elsewhere / poll).
  $effect(() => {
    if (detailOpen && firstLoadDone && !liveDetail) detailOpen = false;
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

<div class="flex h-full min-h-0 flex-col text-xs">
  {#if !sessionReady}
    <EmptyState icon="container" title={t("docker.checking")} />
  {:else if availability === null}
    <EmptyState icon="container" title={t("docker.checking")} />
  {:else if !availability.ok}
    <EmptyState icon="container" title={t("docker.unavailableTitle")} hint={unavailableHint}>
      {#if availability.reason === "denied"}
        <div class="flex flex-col items-center gap-1.5">
          <div class="flex items-center gap-1.5 rounded border border-edge bg-panel-alt px-2 py-1">
            <code class="select-text font-mono text-[11px] text-text">{DOCKER_GROUP_ADD_CMD}</code>
            <CopyButton text={DOCKER_GROUP_ADD_CMD} testid="docker-denied-copy" />
          </div>
          <p class="max-w-xs text-[11px] leading-relaxed text-muted">{t("docker.deniedRelogin")}</p>
        </div>
      {/if}
      <button
        class="rounded border border-edge px-2.5 py-1 text-xs text-muted hover:bg-edge hover:text-white disabled:opacity-40"
        data-testid="docker-retry"
        onclick={() => retry()}
      >
        {t("docker.retry")}
      </button>
    </EmptyState>
  {:else}
    <!-- Toolbar -->
    <div class="flex items-center gap-1.5 border-b border-edge px-2 py-1.5">
      <Icon name="container" size={15} class="text-accent" />
      <div class="min-w-0 flex-1">
        <div class="font-medium text-white/90">{t("docker.panelTitle")}</div>
        <div class="truncate text-[10px] text-muted">{t("docker.serverVersion", { version: availability.version })}</div>
      </div>
      {#if registries.length > 0}
        <button class="rounded p-1 text-muted hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.registryLogin")} aria-label={t("docker.registryLogin")} onclick={openLoginMenu}>
          <Icon name="key" size={14} />
        </button>
      {/if}
      <button class="rounded p-1 text-muted hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.refresh")} aria-label={t("docker.refresh")} onclick={() => refresh()}>
        <Icon name="refresh" size={14} />
      </button>
    </div>

    <!-- Sub-tabs -->
    <div class="flex border-b border-edge text-[11px]">
      {#each SUBS as s (s.id)}
        <button
          data-testid={`docker-subtab-${s.id}`}
          class="flex-1 border-b-2 py-1.5 text-center {activeSub === s.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-white'}"
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
        {#if groups.length === 0}
          <EmptyState icon="container" title={t("docker.noContainers")} hint={t("docker.noContainersHint")} />
        {:else}
          <DockerContainers
            {groups}
            {statsById}
            {busy}
            {run}
            onShell={openShell}
            onLogs={openLogs}
            onInspect={openInspect}
            onComposeLogs={openComposeLogs}
            onViewDetails={openDetails}
            {showMenu}
          />
        {/if}
      {:else if activeSub === "images"}
        <DockerImages {images} {busy} {run} onInspect={openImageInspect} {showMenu} />
      {:else}
        <DockerNetworks {networks} {volumes} {busy} {run} />
      {/if}
    </div>
  {/if}
</div>

<DockerTextModal open={modalOpen} title={modalTitle} text={modalText} live={modalLive} onclose={closeModal} />

<DockerDetailModal
  open={detailOpen}
  container={liveDetail}
  stat={detailStat}
  {busy}
  {refreshSec}
  {run}
  runQuery={(args, timeout) => runQuery(args, timeout)}
  onShell={openShell}
  onclose={() => (detailOpen = false)}
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
  <code class="mt-1 block break-all rounded bg-panel px-1 py-0.5 text-white/80">{confirmText}</code>
  {#if prod}
    <span class="mt-1 block text-[11px] text-danger">{t("docker.confirmProdWarn")}</span>
  {/if}
</ConfirmDialog>
