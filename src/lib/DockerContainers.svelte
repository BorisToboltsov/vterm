<script lang="ts">
  // Container list for the Docker panel (Phase 35, reworked Phase 36), grouped by
  // compose project. Each row now carries a single "View details" button plus a
  // right-click menu (shared ContextMenu) — the old five-icon hover strip moved
  // into the detail modal. The per-container facts (status/ports/cpu/mem) moved
  // off the row into a hover card. Presentational + action wiring only; arg
  // building is pure (docker.ts), the orchestrator's `run` executes.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import {
    startArgs,
    stopArgs,
    restartArgs,
    removeArgs,
    composeUpArgs,
    composeDownArgs,
    composeRestartArgs,
    containerInfoRows,
    isRunning,
    stateTone,
    type ComposeGroup,
    type DockerContainer,
    type DockerStat,
    type DockerInfoKey,
  } from "./docker";
  import type { MenuItem } from "./ctxmenu";
  import { t, type MessageKey } from "./i18n";

  let {
    groups,
    statsById,
    busy = false,
    run,
    onShell,
    onLogs,
    onInspect,
    onComposeLogs,
    onViewDetails,
    showMenu,
  }: {
    groups: ComposeGroup[];
    /** Live `docker stats` snapshot keyed by (short) container id. */
    statsById: Map<string, DockerStat>;
    busy?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    onShell: (c: DockerContainer) => void;
    onLogs: (c: DockerContainer) => void;
    onInspect: (c: DockerContainer) => void;
    onComposeLogs: (project: string) => void;
    onViewDetails: (c: DockerContainer) => void;
    /** Open the shared context menu at the event position with these items. */
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  const TONE: Record<string, string> = {
    ok: "bg-green-400",
    warn: "bg-amber-400",
    bad: "bg-red-500",
    idle: "bg-muted",
  };
  const INFO_LABEL: Record<DockerInfoKey, MessageKey> = {
    status: "docker.status",
    ports: "docker.ports",
    cpu: "docker.cpu",
    mem: "docker.mem",
    net: "docker.net",
    created: "docker.created",
  };

  function stat(c: DockerContainer): DockerStat | undefined {
    return statsById.get(c.id) ?? statsById.get(c.id.slice(0, 12));
  }

  /** Multi-line hover card content (label: value per line) — `.vt-tooltip` keeps newlines. */
  function infoTip(c: DockerContainer): string {
    return containerInfoRows(c, stat(c))
      .map((r) => `${t(INFO_LABEL[r.key])}: ${r.value}`)
      .join("\n");
  }

  function copyId(c: DockerContainer) {
    void navigator.clipboard?.writeText(c.id);
  }

  function menuItems(c: DockerContainer): MenuItem[] {
    return [
      { icon: "eye", label: t("docker.viewDetails"), onSelect: () => onViewDetails(c) },
      { kind: "separator" },
      isRunning(c)
        ? { icon: "stop", label: t("docker.stop"), onSelect: () => run(stopArgs([c.id]), { successKey: "docker.stopped" }) }
        : { icon: "play", label: t("docker.start"), onSelect: () => run(startArgs([c.id]), { successKey: "docker.started" }) },
      { icon: "refresh", label: t("docker.restart"), onSelect: () => run(restartArgs([c.id]), { successKey: "docker.restarted" }) },
      { icon: "terminal", label: t("docker.openShell"), onSelect: () => onShell(c) },
      { icon: "note", label: t("docker.viewLogs"), onSelect: () => onLogs(c) },
      { icon: "braces", label: t("docker.inspect"), onSelect: () => onInspect(c) },
      { kind: "separator" },
      { icon: "copy", label: t("docker.copyId"), onSelect: () => copyId(c) },
      { icon: "trash", label: t("docker.remove"), danger: true, onSelect: () => run(removeArgs([c.id], isRunning(c)), { destructive: true, successKey: "docker.removed" }) },
    ];
  }
</script>

<div class="h-full overflow-auto text-xs">
  {#each groups as g (g.project)}
    {#if g.project}
      <!-- Compose project header + group action bar -->
      <div class="flex items-center gap-1.5 border-b border-edge bg-panel px-2.5 py-1.5">
        <Icon name="container" size={13} class="text-accent" />
        <span class="min-w-0 flex-1 truncate font-medium text-white/85" use:tooltip={g.workdir ?? g.project}>{g.project}</span>
        <div class="flex items-center gap-0.5 text-muted">
          <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.composeUp")} aria-label={t("docker.composeUp")} onclick={() => run(composeUpArgs(g.project, g.workdir), { successKey: "docker.started" })}>
            <Icon name="play" size={13} />
          </button>
          <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.composeDown")} aria-label={t("docker.composeDown")} onclick={() => run(composeDownArgs(g.project, g.workdir), { destructive: true, successKey: "docker.stopped" })}>
            <Icon name="stop" size={13} />
          </button>
          <button class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40" disabled={busy} use:tooltip={t("docker.composeRestart")} aria-label={t("docker.composeRestart")} onclick={() => run(composeRestartArgs(g.project), { successKey: "docker.restarted" })}>
            <Icon name="refresh" size={12} />
          </button>
          <button class="rounded p-1 hover:bg-edge hover:text-white" use:tooltip={t("docker.composeLogs")} aria-label={t("docker.composeLogs")} onclick={() => onComposeLogs(g.project)}>
            <Icon name="note" size={12} />
          </button>
        </div>
      </div>
    {:else}
      <div class="border-b border-edge px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted">{t("docker.standalone")}</div>
    {/if}

    {#each g.containers as c (c.id)}
      <div
        class="group flex items-center gap-2 border-b border-edge/60 py-1.5 pr-2 hover:bg-edge/30 {g.project ? 'pl-5' : 'pl-2.5'}"
        oncontextmenu={(e) => showMenu(e, menuItems(c))}
        role="listitem"
      >
        <span class="h-[7px] w-[7px] shrink-0 rounded-full {TONE[stateTone(c.state)]}" use:tooltip={c.state}></span>
        <div class="min-w-0 flex-1" use:tooltip={infoTip(c)}>
          <div class="flex items-baseline gap-1.5">
            <span class="truncate font-medium text-white/90">{c.name}</span>
            <span class="truncate text-[10px] text-muted">{c.image}</span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-0.5 text-muted opacity-0 group-hover:opacity-100">
          {#if isRunning(c)}
            <button
              class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("docker.stop")}
              aria-label={t("docker.stop")}
              onclick={() => run(stopArgs([c.id]), { successKey: "docker.stopped" })}
            >
              <Icon name="stop" size={14} />
            </button>
            <button
              class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("docker.restart")}
              aria-label={t("docker.restart")}
              onclick={() => run(restartArgs([c.id]), { successKey: "docker.restarted" })}
            >
              <Icon name="refresh" size={13} />
            </button>
          {:else}
            <button
              class="rounded p-1 hover:bg-edge hover:text-white disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("docker.start")}
              aria-label={t("docker.start")}
              onclick={() => run(startArgs([c.id]), { successKey: "docker.started" })}
            >
              <Icon name="play" size={14} />
            </button>
          {/if}
          <button
            class="rounded p-1 hover:bg-edge hover:text-white"
            use:tooltip={t("docker.viewDetails")}
            aria-label={t("docker.viewDetails")}
            onclick={() => onViewDetails(c)}
          >
            <Icon name="eye" size={14} />
          </button>
        </div>
      </div>
    {/each}
  {/each}
</div>
