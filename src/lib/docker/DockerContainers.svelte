<script lang="ts">
  // Container list for the Docker panel (Phase 35, reworked Phase 36), grouped by
  // compose project. Each row now carries a single "View details" button plus a
  // right-click menu (shared ContextMenu) — the old five-icon hover strip moved
  // into the detail modal. The per-container facts (status/ports/cpu/mem) moved
  // off the row into a hover card. Presentational + action wiring only; arg
  // building is pure (docker.ts), the orchestrator's `run` executes.
  //
  // v1.33: a click on a row opens its details (beside the list in a wide panel —
  // the list is then the column of names the details are read against); the
  // table's columns are fitted to the list's own width (`colfit.ts`), so the name
  // stays whole when the details take half the row; the state column says the
  // health check, the exit and the restarts; a column says the address.
  import Icon from "../ui/Icon.svelte";
  import Sparkline from "../monitoring/Sparkline.svelte";
  import { tooltip } from "../actions/tooltip";
  import { historyMax, padHistory, parsePercent, type LoadHistory } from "../monitoring/loadhistory";
  import {
    startArgs,
    stopArgs,
    restartArgs,
    removeArgs,
    composeUpArgs,
    composeDownArgs,
    composeRestartArgs,
    containerInfoRows,
    containerAddress,
    shownPorts,
    dockerDate,
    parseMemUsed,
    groupUsage,
    isRunning,
    stateSummary,
    stateTone,
    type DockerContainer,
    type DockerStat,
    type DockerFacts,
    type DockerInfoKey,
  } from "./docker";
  import { portChip, portRows } from "./dockernet";
  import type { MenuItem } from "../ui/ctxmenu";
  import ColumnHead from "../ui/ColumnHead.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import SortTitle from "../ui/SortTitle.svelte";
  import type { ListGroup, ListSort } from "../ui/listview";
  import type { Snippet } from "svelte";
  import { columnVars } from "../ui/colwidths";
  import { fitColumns } from "../ui/colfit";
  import { pick, pickMode, type PickMode } from "../ui/listselect";
  import { stackOf, usesOwnFiles } from "./dockerstack";
  import { columns, hiddenFields } from "../stores/colwidths.svelte";
  import { uiPx } from "../settings/settings.svelte";
  import { t, currentLocale, type MessageKey } from "../i18n";

  let {
    groups,
    grouped = true,
    grouping = "compose",
    collapsed = [],
    ontoggle = () => {},
    sort = null,
    onsort = undefined,
    statsById,
    cpuHistory = {},
    factsById = new Map(),
    all = [],
    selectedId = null,
    picked = new Set<string>(),
    onpick = undefined,
    after = undefined,
    busy = false,
    run,
    onShell,
    onLogs,
    onInspect,
    onComposeLogs,
    onStackOpen = undefined,
    onViewDetails,
    showMenu,
  }: {
    /** The list as `listview.ts` lays it out; one group without a header when not grouped. */
    groups: ListGroup<DockerContainer>[];
    grouped?: boolean;
    /** What the groups are — compose stacks get their icon, rollup tooltip and actions. */
    grouping?: string;
    collapsed?: readonly string[];
    ontoggle?: (key: string) => void;
    /** The list's order, for the column titles; null — the titles do not order. */
    sort?: ListSort | null;
    onsort?: (key: string) => void;
    /** Live `docker stats` snapshot keyed by (short) container id. */
    statsById: Map<string, DockerStat>;
    /** Rolling CPU-percent history per container id (Phase 42). */
    cpuHistory?: LoadHistory;
    /** What `inspect` told per container id (ceilings, restarts, addresses); absent = not asked yet. */
    factsById?: ReadonlyMap<string, DockerFacts>;
    /** Every container, ungrouped — whose network a `container:` one shares is named from it. */
    all?: readonly DockerContainer[];
    /** The container whose details are open: its row is marked. */
    selectedId?: string | null;
    /** The rows picked for an action on several at once (stage 2); absent `onpick` — no picking. */
    picked?: ReadonlySet<string>;
    onpick?: (next: Set<string>) => void;
    /** After the containers, in the same scroll: the rest of the column of names (stage 4). */
    after?: Snippet;
    busy?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    onShell: (c: DockerContainer) => void;
    onLogs: (c: DockerContainer) => void;
    onInspect: (c: DockerContainer) => void;
    onComposeLogs: (project: string) => void;
    /** Open a compose stack's details — its services, log, configuration (stage 5). */
    onStackOpen?: (project: string) => void;
    onViewDetails: (c: DockerContainer) => void;
    /** Open the shared context menu at the event position with these items. */
    showMenu: (e: MouseEvent, items: MenuItem[]) => void;
  } = $props();

  const TONE: Record<string, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
    idle: "bg-muted",
  };
  // The resizable columns of the wide layout → the CSS variables their cells read.
  const COLS = {
    "--c-name": "docker.name",
    "--c-image": "docker.image",
    "--c-status": "docker.status",
    "--c-ports": "docker.ports",
    "--c-ip": "docker.ip",
  } as const;
  // The list's visible height: a column's border can be dragged anywhere along
  // it, so the grip in the header reaches this far down (ColumnGrip, `--list-h`).
  let listHeight = $state(0);
  // Its width: what the table's columns are fitted to — the list's own, not the
  // panel's, which still counts the details beside it.
  let listWidth = $state(0);
  const fit = $derived(fitColumns("docker.containers", columns.widths, hiddenFields("docker.containers"), listWidth / uiPx(1)));
  const shows = (id: string): boolean => fit.shown.includes(id);
  // A cell the table has no room for, or the user hid, is gone from the table;
  // the narrow layout draws the name and the image anyway.
  const off = (id: string): string => (shows(id) ? "" : "@wide:hidden");
  const FIELD_LABEL: Record<string, MessageKey> = {
    image: "docker.image",
    state: "docker.state",
    ports: "docker.ports",
    ip: "docker.address",
  };
  const droppedText = $derived(fit.dropped.map((id) => t(FIELD_LABEL[id])).join(", "));
  const STATE_TEXT: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", idle: "text-muted" };
  // A table cell in a wide container: the rule on its right, the row's vertical
  // padding (the row itself has none there, so the rule runs edge to edge) and
  // one line height for both text sizes.
  const CELL = "@wide:border-r @wide:border-edge/40 @wide:py-1.5 @wide:leading-4";
  const INFO_LABEL: Record<DockerInfoKey, MessageKey> = {
    status: "docker.status",
    ports: "docker.ports",
    portsConfigured: "docker.portsConfigured",
    cpu: "docker.cpu",
    mem: "docker.mem",
    net: "docker.net",
    created: "docker.created",
  };

  function stat(c: DockerContainer): DockerStat | undefined {
    return statsById.get(c.id) ?? statsById.get(c.id.slice(0, 12));
  }

  /**
   * Memory usage against the container's configured ceiling, or null when it has
   * none. Deliberately not derived from `docker stats`' MemPerc: for an unlimited
   * container that percentage is a share of **host** RAM, which would render as a
   * bar filling toward a limit that does not exist.
   */
  function memUsage(c: DockerContainer) {
    const limit = factsById.get(c.id)?.memBytes ?? null;
    const used = parseMemUsed(stat(c)?.mem);
    if (limit == null || used == null || !(limit > 0)) return null;
    const ratio = used / limit;
    return {
      pct: Math.min(100, ratio * 100),
      tone: ratio >= 0.9 ? "bad" : ratio >= 0.75 ? "warn" : "ok",
    };
  }

  const MEM_BAR: Record<string, string> = { ok: "bg-accent", warn: "bg-warn", bad: "bg-bad" };

  /** Human bytes for the compose rollup ("1.6 GiB"). */
  function fmtMem(bytes: number | null): string {
    if (bytes == null) return "—";
    const u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  /** Threshold colour for the CPU sparkline — same tones as the state dot. */
  function cpuColor(pct: number | null): string {
    if (pct == null) return "var(--color-muted)";
    if (pct >= 75) return "var(--color-bad)";
    if (pct >= 50) return "var(--color-warn)";
    return "var(--color-accent)";
  }

  /** Multi-line hover card content (label: value per line) — `.vt-tooltip` keeps newlines. */
  function infoTip(c: DockerContainer): string {
    return containerInfoRows(c, stat(c), factsById.get(c.id))
      .map((r) => `${t(INFO_LABEL[r.key])}: ${r.key === "created" ? dockerDate(r.value, currentLocale()) : r.value}`)
      .join("\n");
  }

  /** The direction a column orders the list in now, or null. */
  function sortedBy(key: string): "asc" | "desc" | null {
    return sort?.key === key ? sort.dir : null;
  }
  const orderBy = (key: string) => (onsort ? () => onsort(key) : undefined);

  /** A stack's working directory — of the first of its containers that reports one. */
  function workdirOf(items: DockerContainer[]): string | null {
    return items.find((c) => c.workdir)?.workdir ?? null;
  }

  // The rows as shown — what a Shift-click range runs over (a folded group's rows
  // are not shown and are not taken) — and the last row picked one by one.
  const shownOrder = $derived(groups.flatMap((g) => (grouped && collapsed.includes(g.key) ? [] : g.items.map((c) => c.id))));
  let anchor: string | null = null;
  function pickRow(id: string, mode: PickMode) {
    if (!onpick) return;
    onpick(pick(picked, shownOrder, anchor, id, mode));
    if (mode === "toggle") anchor = id;
  }
  const picking = $derived(picked.size > 0);

  /** Whether a stack came up from its own files — then `up` from its directory is not offered. */
  function ownFiles(items: readonly DockerContainer[], project: string): boolean {
    const st = stackOf(items, project);
    return st ? usesOwnFiles(st) : false;
  }

  function copyId(c: DockerContainer) {
    void navigator.clipboard?.writeText(c.id);
  }

  /** The address cell: what it says and what its tooltip adds. */
  function addressCell(c: DockerContainer): { text: string; tip: string; muted: boolean } {
    const a = containerAddress(c, factsById.get(c.id), all);
    switch (a.kind) {
      case "ip":
        return {
          text: a.all.length > 1 ? `${a.first} +${a.all.length - 1}` : a.first,
          tip: [...a.all.map((x) => `${x.network}: ${[x.ipv4, x.ipv6].filter(Boolean).join(" · ")}`), t("docker.addressInside")].join("\n"),
          muted: false,
        };
      case "host":
        return { text: t("docker.addressHostShort"), tip: t("docker.addressHost"), muted: true };
      case "none":
        return { text: t("docker.addressNoneShort"), tip: t("docker.addressNone"), muted: true };
      case "shared":
        return { text: `→ ${a.with}`, tip: t("docker.addressShared", { name: a.with }), muted: true };
      case "down":
        return { text: "—", tip: t("docker.addressDown"), muted: true };
      default:
        return { text: "—", tip: "", muted: true };
    }
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

<!-- The column widths are CSS variables on the list: the header and every row
     read the same ones, so dragging a border is one style write, not one per row. -->
<div
  class="h-full overflow-auto text-xs"
  bind:clientHeight={listHeight}
  bind:clientWidth={listWidth}
  style="{columnVars(columns.widths, COLS)}{listHeight > 0 ? `; --list-h: ${listHeight}px` : ''}"
>
  <!-- Column titles — only where there are columns, i.e. in a wide container. The
       header repeats a row's structure (padding, state-dot slot, cells, the
       metrics box) so its borders stand exactly over the rows' borders, and
       shrinks the same way when the list is tight. -->
  <div
    class="sticky top-0 z-10 hidden items-stretch gap-2 border-b border-edge bg-panel-alt pl-2.5 pr-2 text-meta font-medium text-muted @wide:flex"
    data-testid="docker-columns"
  >
    <span class="w-[0.4375rem] shrink-0"></span>
    <div class="flex min-w-0 flex-1 items-stretch">
      <ColumnHead col="docker.name" label={t("docker.name")} class="w-[var(--c-name)] pr-2" sorted={sortedBy("name")} onsort={orderBy("name")} />
      {#if shows("image")}
        <ColumnHead col="docker.image" label={t("docker.image")} class="w-[var(--c-image)] px-2 shrink-0" sorted={sortedBy("image")} onsort={orderBy("image")} />
      {/if}
      {#if shows("state")}
        <ColumnHead col="docker.status" label={t("docker.state")} class="w-[var(--c-status)] px-2 shrink-0" sorted={sortedBy("state")} onsort={orderBy("state")} />
      {/if}
      {#if shows("ports")}
        <ColumnHead col="docker.ports" label={t("docker.ports")} class="w-[var(--c-ports)] px-2 shrink-0" />
      {/if}
      {#if shows("ip")}
        <ColumnHead col="docker.ip" label={t("docker.address")} class="w-[var(--c-ip)] px-2 shrink-0" />
      {/if}
      {#if fit.dropped.length > 0}
        <!-- What the width took off, said rather than silently gone. -->
        <span
          class="ml-1 shrink-0 self-center rounded border border-edge px-1 text-caption"
          use:tooltip={t("list.columnsDropped", { names: droppedText })}
          data-testid="docker-columns-dropped">+{fit.dropped.length}</span
        >
      {/if}
    </div>
    <span class="w-[6.5rem] shrink-0 self-center truncate text-right">
      {#if onsort}
        <SortTitle label={t("docker.cpu")} sorted={sortedBy("cpu")} onsort={() => onsort("cpu")} testid="column-sort-docker.cpu" align="right" />
      {:else}
        {t("docker.cpu")}
      {/if}
    </span>
  </div>
  {#each groups as g (g.key)}
    {@const compose = grouping === "compose" && !g.rest}
    {@const folded = grouped && collapsed.includes(g.key)}
    {#if grouped}
      <!-- Group header: a compose stack carries its rollup — what the whole
           stack costs, summed from the snapshot the panel already holds, the
           analogue of the k8s owner rollup — and its actions. -->
      {@const usage = groupUsage(g.items, statsById, parsePercent)}
      {@const workdir = workdirOf(g.items)}
      <GroupHeader
        label={g.rest ? t("docker.standalone") : g.label}
        count={g.items.length}
        collapsed={folded}
        ontoggle={() => ontoggle(g.key)}
        icon={compose ? "container" : undefined}
        rest={g.rest}
        hint={compose ? (workdir ?? g.label) : undefined}
        testid="docker-group"
      >
        {#snippet summary()}
          {#if usage.cpu != null || usage.mem != null}
            <span class="shrink-0 text-caption tabular-nums text-muted">
              {t("docker.groupUsage", {
                cpu: usage.cpu != null ? `${Math.round(usage.cpu)}%` : "—",
                mem: fmtMem(usage.mem),
              })}
            </span>
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if compose}
            <div class="flex items-center gap-0.5 text-muted">
              <!-- `up` reads the project's directory: a stack brought up from its own
                   files would come up as another definition — not offered (stage 5). -->
              <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy || ownFiles(g.items, g.key)} use:tooltip={ownFiles(g.items, g.key) ? t("docker.stackUpOwnFiles") : t("docker.composeUp")} aria-label={t("docker.composeUp")} data-testid="docker-stack-up-all" onclick={() => run(composeUpArgs(g.key, workdir), { successKey: "docker.started" })}>
                <Icon name="play" size={13} />
              </button>
              <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.composeDown")} aria-label={t("docker.composeDown")} onclick={() => run(composeDownArgs(g.key, workdir), { destructive: true, successKey: "docker.stopped" })}>
                <Icon name="stop" size={13} />
              </button>
              <button class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("docker.composeRestart")} aria-label={t("docker.composeRestart")} onclick={() => run(composeRestartArgs(g.key), { successKey: "docker.restarted" })}>
                <Icon name="refresh" size={12} />
              </button>
              <button class="rounded p-1 hover:bg-edge hover:text-text" use:tooltip={t("docker.composeLogs")} aria-label={t("docker.composeLogs")} onclick={() => onComposeLogs(g.key)}>
                <Icon name="note" size={12} />
              </button>
              {#if onStackOpen}
                <button class="rounded p-1 hover:bg-edge hover:text-text" use:tooltip={t("docker.stackOpen")} aria-label={t("docker.stackOpen")} data-testid="docker-stack-open" onclick={() => onStackOpen(g.key)}>
                  <Icon name="info" size={12} />
                </button>
              {/if}
            </div>
          {/if}
        {/snippet}
      </GroupHeader>
    {/if}

    {#each folded ? [] : g.items as c (c.id)}
      {@const history = cpuHistory[c.id] ?? []}
      {@const cpuNow = parsePercent(stat(c)?.cpu)}
      {@const mem = memUsage(c)}
      {@const summary = stateSummary(c, factsById.get(c.id))}
      {@const restarts = factsById.get(c.id)?.restarts ?? 0}
      {@const addr = addressCell(c)}
      <!-- A click opens the details; the keyboard has the row's own button for it
           (the eye) — the row is a list item, not a second button around them. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div
        class="group flex cursor-default items-center gap-2 border-b border-edge/60 py-1.5 pr-2 @wide:items-stretch @wide:py-0 {grouped ? 'pl-5 @wide:pl-2.5' : 'pl-2.5'} {picked.has(c.id) ? 'bg-accent/15' : selectedId === c.id ? 'bg-accent/10' : 'hover:bg-edge/30'}"
        oncontextmenu={(e) => showMenu(e, menuItems(c))}
        onmousedown={(e) => {
          // Shift-click takes a run of rows; it must not select their text too.
          if (e.shiftKey && onpick) e.preventDefault();
        }}
        onclick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          const mode = onpick ? pickMode(e) : null;
          if (mode) pickRow(c.id, mode);
          else onViewDetails(c);
        }}
        role="listitem"
        aria-current={selectedId === c.id ? "true" : undefined}
        data-testid="docker-row"
      >
        <!-- The state dot, and in its place the row's checkbox: on hover, and on
             every row while some are picked — the table keeps its columns. -->
        <span class="relative flex h-[0.4375rem] w-[0.4375rem] shrink-0 items-center justify-center @wide:self-center">
          <span
            class="h-[0.4375rem] w-[0.4375rem] rounded-full {TONE[stateTone(c.state)]} {onpick ? (picking ? 'opacity-0' : 'group-hover:opacity-0') : ''}"
            use:tooltip={c.state}
          ></span>
          {#if onpick}
            <input
              type="checkbox"
              class="absolute h-3 w-3 cursor-default accent-accent {picking ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}"
              checked={picked.has(c.id)}
              aria-label={t("list.pickRow", { name: c.name })}
              data-testid="docker-row-pick"
              onclick={(e) => {
                e.stopPropagation();
                pickRow(c.id, e.shiftKey ? "range" : "toggle");
              }}
            />
          {/if}
        </span>
        <!-- Name over image, not side by side (v1.0.14). In the dock's 384px the
             two share ~240px, so a compose-generated name ("edge-proxy-canary-2")
             left the image as "ghcr.io/vc…" — the half that says *what is actually
             running*. Two lines cost 10px of row height and show both.
             In a wide container (v1.1) the row has the room that argument lacked:
             name and image go side by side as columns, and the status and ports
             the hover card held come out next to them — one line per container,
             which is what a short bottom dock needs. There the row is a table
             row: the cells take the user's column widths and run the full height
             of the row, so their right borders join into column rules (the
             compose indent is dropped — every row has to start at the same x). -->
        <div class="min-w-0 flex-1 @wide:flex @wide:items-stretch" use:tooltip={infoTip(c)}>
          <div class="flex min-w-0 items-baseline gap-1.5 @wide:w-[var(--c-name)] @wide:pr-2 {CELL}">
            <span class="truncate font-medium text-text/90">{c.name}</span>
            <!-- The narrow row has no state column: a container in trouble says so here. -->
            {#if summary.tone === "warn" || summary.tone === "bad"}
              <span class="shrink-0 text-caption @wide:hidden {STATE_TEXT[summary.tone]}">{summary.word}</span>
            {/if}
            {#if restarts > 0}
              <span class="shrink-0 text-caption text-warn @wide:hidden">↻{restarts}</span>
            {/if}
          </div>
          <div class="truncate text-caption text-muted @wide:w-[var(--c-image)] @wide:shrink-0 @wide:px-2 {CELL} {off('image')}" data-testid="docker-col-image">{c.image}</div>
          {#if shows("state")}
            <div class="hidden truncate text-caption @wide:block @wide:w-[var(--c-status)] @wide:shrink-0 @wide:px-2 {CELL}" data-testid="docker-col-status" use:tooltip={c.status}>
              <span class={STATE_TEXT[summary.tone]}>{summary.word}</span>{#if summary.age}<span class="text-muted">{` · ${summary.age}`}</span>{/if}{#if restarts > 0}<span class="text-warn">{` · ↻${restarts}`}</span>{/if}
            </div>
          {/if}
          {#if shows("ports")}
            <!-- A stopped container's ports are those it is set to publish: dashed, nothing listens yet. -->
            {@const pp = shownPorts(c, factsById.get(c.id))}
            <div class="hidden truncate text-caption text-muted @wide:block @wide:w-[var(--c-ports)] @wide:shrink-0 @wide:px-2 {CELL}" data-testid="docker-col-ports" data-configured={pp.configured || undefined} use:tooltip={pp.configured ? `${pp.ports}\n${t("docker.portInactive")}` : pp.ports}>
              {#each portRows(pp.ports) as row, i (i)}<span class="mr-1 rounded border px-1 {pp.configured ? 'border-dashed border-edge' : 'border-edge'} {row.reach === 'all' && !pp.configured ? 'text-text/85' : ''}">{portChip(row)}</span>{/each}
            </div>
          {/if}
          {#if shows("ip")}
            <div class="hidden truncate font-mono text-caption @wide:block @wide:w-[var(--c-ip)] @wide:shrink-0 @wide:px-2 {CELL} {addr.muted ? 'text-muted' : 'text-text/85'}" data-testid="docker-col-ip" use:tooltip={addr.tip}>{addr.text}</div>
          {/if}
        </div>
        <!-- CPU shape and the hover actions share one reserved box, stacked and
             cross-faded. Swapping them with `hidden`/`flex` would resize the row
             under the pointer — the design system's no-reflow rule for hover
             actions. Both layers are absolute, so the reserved width is fixed. -->
        <div class="relative h-5 w-[6.5rem] shrink-0 @wide:self-center">
          {#if history.length > 0}
            <div
              class="absolute inset-0 flex items-center justify-end gap-1.5 transition-opacity duration-150 group-hover:opacity-0"
              use:tooltip={infoTip(c)}
            >
              <Sparkline
                values={padHistory(history)}
                max={historyMax(history, 100)}
                color={cpuColor(cpuNow)}
                class="h-3.5 w-12"
              />
              <span class="w-8 text-right tabular-nums" style="color: {cpuColor(cpuNow)}">
                {cpuNow != null ? `${Math.round(cpuNow)}%` : "—"}
              </span>
              <!-- Memory against the container's own ceiling. Absent entirely when
                   no `--memory` was set: there is nothing to be a fraction of. -->
              {#if mem}
                <span
                  class="h-1 w-5 shrink-0 overflow-hidden rounded bg-edge"
                  use:tooltip={t("docker.memLimit", { used: stat(c)?.mem ?? "—" })}
                >
                  <span class="block h-full {MEM_BAR[mem.tone]}" style="width: {mem.pct}%"></span>
                </span>
              {/if}
            </div>
          {/if}
          <div
            class="absolute inset-0 flex items-center justify-end gap-0.5 text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          >
          {#if isRunning(c)}
            <button
              class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("docker.stop")}
              aria-label={t("docker.stop")}
              onclick={() => run(stopArgs([c.id]), { successKey: "docker.stopped" })}
            >
              <Icon name="stop" size={14} />
            </button>
            <button
              class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("docker.restart")}
              aria-label={t("docker.restart")}
              onclick={() => run(restartArgs([c.id]), { successKey: "docker.restarted" })}
            >
              <Icon name="refresh" size={13} />
            </button>
          {:else}
            <button
              class="rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
              disabled={busy}
              use:tooltip={t("docker.start")}
              aria-label={t("docker.start")}
              onclick={() => run(startArgs([c.id]), { successKey: "docker.started" })}
            >
              <Icon name="play" size={14} />
            </button>
          {/if}
          <button
            class="rounded p-1 hover:bg-edge hover:text-text"
            use:tooltip={t("docker.viewDetails")}
            aria-label={t("docker.viewDetails")}
            onclick={() => onViewDetails(c)}
          >
            <Icon name="eye" size={14} />
          </button>
          </div>
        </div>
      </div>
    {/each}
  {/each}
  {@render after?.()}
</div>
