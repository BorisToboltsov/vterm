<script lang="ts">
  // Application top bar: a breadcrumb of the active connection (alias · user@host:port)
  // plus quick actions. The parent wires the callbacks, the copy and the recording
  // state; which actions stand on the bar, and in what order, is the user's
  // (v1.16, `settings.topbar`):
  //
  //  - a button is taken off or put on from the bar's right-click menu (also the
  //    Utilities panel, ⌘K and Settings), and dragged along the bar to reorder —
  //    the neighbours slide apart, the list changes once, on release;
  //  - a tool of the Utilities panel can stand here as a button of its own;
  //  - Utilities and Settings always stay; REC and the broadcast button are
  //    shown while a recording or a broadcast is on even if they were taken off;
  //  - what does not fit goes under «⋯», so the breadcrumb is never pushed out.
  //
  // What the bar shows is decided by the pure model (`topbaractions.ts`); this
  // draws it.
  import Icon from "./Icon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuAction, OpenMenu } from "./ctxmenu";
  import { tooltip } from "./actions/tooltip";
  import { glide } from "./actions/drag";
  import { motion } from "./motion";
  import { settings } from "./settings.svelte";
  import {
    actionUtility,
    fitTopbar,
    isTopbarId,
    mustShow,
    previewTopbar,
    shownTopbar,
    topbarRoom,
    type TopbarId,
    type TopbarState,
  } from "./topbaractions";
  import { actionIcon, actionLabel, topbarMenu } from "./topbarui";
  import { pinAction, resetTopbar, unpinAction } from "./stores/topbarpins.svelte";
  import { beginTopbarDrag, consumeTopbarClick, topbarDrag } from "./stores/topbardrag.svelte";
  import { t } from "./i18n";

  let {
    title,
    subtitle,
    connected,
    canRecord = false,
    recording = false,
    onToggleRecording,
    onOpenRecordings,
    onOpenMonitoring,
    onOpenSettings,
    onOpenUtilities,
    canBroadcast = false,
    broadcastActive = false,
    onToggleBroadcast,
    showNotes = false,
    hasNotes = false,
    onOpenNotes,
  }: {
    /** Active connection alias (or a fallback like "Not connected"). */
    title: string;
    /** `user@host:port` for an SSH tab; empty otherwise. */
    subtitle: string;
    /** SSH session is connected — enables the monitoring action. */
    connected: boolean;
    /** The active tab is live, so its session can be recorded (shows REC). */
    canRecord?: boolean;
    /** A recording is currently running on the active tab. */
    recording?: boolean;
    onToggleRecording: () => void;
    onOpenRecordings: () => void;
    onOpenMonitoring: () => void;
    onOpenSettings: () => void;
    /** Open the Utilities panel (keygen, CIDR, codecs, …) — on one tool, when named. */
    onOpenUtilities?: (utility?: string) => void;
    /** There is an active tab → the broadcast action is enabled (kept in its slot,
     *  dimmed + disabled otherwise, like REC/monitoring). */
    canBroadcast?: boolean;
    /** The active tab is a broadcast-group member → highlight + "remove" tooltip. */
    broadcastActive?: boolean;
    onToggleBroadcast?: () => void;
    /** A server is selected in the tree → show the notes action (even when not
     *  connected). Tied to the selection, not the active session. */
    showNotes?: boolean;
    /** The selected server has non-blank notes → show a filled indicator dot. */
    hasNotes?: boolean;
    onOpenNotes?: () => void;
  } = $props();

  // Width of the whole bar, px: what decides how many buttons fit.
  let barWidth = $state(0);
  const barState = $derived<TopbarState>({ recording, broadcastActive, showNotes });
  // While a button is in the air the bar draws the order its drop would give.
  const order = $derived(previewTopbar(settings.topbar, topbarDrag.id, topbarDrag.over));
  const all = $derived(shownTopbar(order, barState));
  const fit = $derived(
    fitTopbar(
      all.map((a) => a.id),
      topbarRoom(barWidth),
      (id) => mustShow(id, barState),
    ),
  );
  const visible = $derived(all.filter((a) => fit.shown.includes(a.id)));

  /** What a button does and whether it can now — one answer for the bar and for «⋯». */
  function act(id: TopbarId): { run: () => void; disabled: boolean; label: string } {
    const util = actionUtility(id);
    if (util !== null) return { run: () => onOpenUtilities?.(util), disabled: false, label: actionLabel(id) };
    switch (id) {
      case "broadcast":
        return {
          run: () => onToggleBroadcast?.(),
          disabled: !canBroadcast,
          label: broadcastActive ? t("broadcast.removeFromGroup") : t("broadcast.addToGroup"),
        };
      case "notes":
        return { run: () => onOpenNotes?.(), disabled: false, label: t("topbar.notes") };
      case "monitoring":
        return { run: onOpenMonitoring, disabled: !connected, label: t("topbar.monitoring") };
      case "record":
        return {
          run: onToggleRecording,
          disabled: !canRecord,
          label: recording ? t("recordings.stop") : t("recordings.start"),
        };
      case "recordings":
        return { run: onOpenRecordings, disabled: false, label: t("recordings.title") };
      case "utilities":
        return { run: () => onOpenUtilities?.(), disabled: false, label: t("util.open") };
      default:
        return { run: onOpenSettings, disabled: false, label: t("topbar.settings") };
    }
  }

  /** `data-testid` of a plain icon button — the ones tests and E2E already know. */
  function testid(id: TopbarId): string {
    const util = actionUtility(id);
    if (util !== null) return `topbar-util-${util}`;
    return id === "recordings" ? "open-recordings" : `topbar-${id}`;
  }

  let menu = $state<OpenMenu | null>(null);

  /** The bar's own menu: what is on it and what could be. */
  function openMenu(e: MouseEvent) {
    e.preventDefault();
    const under = (e.target as Element | null)?.closest<HTMLElement>("[data-topbar-item]");
    const target = under?.dataset.topbarItem;
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: topbarMenu(settings.topbar, isTopbarId(target) ? target : null, {
        pin: pinAction,
        unpin: unpinAction,
        reset: resetTopbar,
      }),
    };
  }

  /** «⋯»: the buttons that did not fit, as menu rows that do the same. */
  function openOverflow(e: MouseEvent) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: box.left,
      y: box.bottom + 2,
      items: fit.overflow.map((id): MenuAction => {
        const a = act(id);
        const icon = id === "record" && recording ? "stop" : actionIcon(id);
        return { icon, label: a.label, disabled: a.disabled, onSelect: a.run };
      }),
    };
  }

  /** The click that ends a drag belongs to the drag, not to the button under it. */
  function swallowDragClick(e: MouseEvent) {
    if (!consumeTopbarClick()) return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#snippet button(id: TopbarId)}
  {@const a = act(id)}
  {#if id === "broadcast"}
    <button
      class="flex items-center rounded p-1.5 {!canBroadcast
        ? 'cursor-not-allowed text-muted opacity-40'
        : broadcastActive
          ? 'text-accent hover:bg-edge'
          : 'text-muted hover:bg-edge hover:text-text'}"
      use:tooltip={a.label}
      aria-label={a.label}
      aria-pressed={broadcastActive}
      data-testid="topbar-broadcast"
      disabled={a.disabled}
      onclick={a.run}
    >
      <Icon name="broadcast" size={15} />
    </button>
  {:else if id === "notes"}
    <button
      class="relative flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text"
      use:tooltip={a.label}
      aria-label={a.label}
      data-testid="topbar-notes"
      onclick={a.run}
    >
      <Icon name="note" size={15} />
      {#if hasNotes}
        <span
          class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
          data-testid="topbar-notes-dot"
        ></span>
      {/if}
    </button>
  {:else if id === "record"}
    <button
      data-testid="record-toggle"
      class="flex items-center gap-1 rounded px-2 py-1 text-xs {!canRecord
        ? 'cursor-not-allowed text-muted opacity-40'
        : recording
          ? 'text-danger'
          : 'text-muted hover:bg-edge hover:text-text'}"
      use:tooltip={a.label}
      aria-label={a.label}
      aria-pressed={recording}
      disabled={a.disabled}
      onclick={a.run}
    >
      <span
        class="h-2.5 w-2.5 rounded-full {recording
          ? 'animate-pulse bg-danger'
          : 'border border-current'}"
      ></span>
      REC
    </button>
  {:else}
    <!-- Monitoring keeps its slot without a live session, like REC and broadcast:
         dimmed and disabled, so the bar does not reflow on connect. -->
    <button
      class="flex items-center rounded p-1.5 {a.disabled
        ? 'cursor-not-allowed text-muted opacity-40'
        : 'text-muted hover:bg-edge hover:text-text'}"
      use:tooltip={a.label}
      aria-label={a.label}
      data-testid={testid(id)}
      disabled={a.disabled}
      onclick={a.run}
    >
      <Icon name={actionIcon(id)} size={15} />
    </button>
  {/if}
{/snippet}

<header
  class="flex items-center gap-2 border-b border-edge bg-panel-alt px-3 py-1.5"
  bind:clientWidth={barWidth}
>
  {#if subtitle}
    <Icon name="server" size={14} class="shrink-0 text-muted" />
    <span class="shrink-0 truncate text-xs font-medium text-text">{title}</span>
    <span class="shrink-0 text-xs text-muted">·</span>
    <span class="min-w-0 truncate text-xs text-muted">{subtitle}</span>
  {:else}
    <span class="truncate text-xs text-muted">{title}</span>
  {/if}

  <div
    class="ml-auto flex shrink-0 items-center gap-1"
    role="toolbar"
    tabindex="-1"
    aria-label={t("topbar.bar")}
    data-topbar
    data-testid="topbar-actions"
    oncontextmenu={openMenu}
  >
    {#each visible as a (a.id)}
      <!-- The wrapper is what the drag and the menu go by: a disabled button
           hears no pointer events of its own, but they still pass through it.
           The dragged button keeps its slot, unseen — the copy at the pointer
           stands for it (`opacity-0`, not hidden: the slot must hit-test). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex shrink-0 {a.id === topbarDrag.id ? 'opacity-0' : ''}"
        data-topbar-item={a.id}
        data-topbar-pin={a.pinned ? settings.topbar.indexOf(a.id) : undefined}
        data-topbar-own={a.id === topbarDrag.id ? "" : undefined}
        animate:glide={motion()}
        onpointerdown={(e) => a.pinned && beginTopbarDrag(e, a.id)}
        onclickcapture={swallowDragClick}
      >
        {@render button(a.id)}
      </div>
    {/each}
    {#if fit.overflow.length > 0}
      <button
        class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-text"
        use:tooltip={t("topbar.more")}
        aria-label={t("topbar.more")}
        aria-haspopup="menu"
        data-testid="topbar-more"
        onclick={openOverflow}
      >
        <Icon name="dots" size={15} strokeWidth={3} />
      </button>
    {/if}
  </div>
</header>

<!-- The dragged button at the pointer. -->
{#if topbarDrag.id}
  <div
    aria-hidden="true"
    data-testid="topbar-drag-ghost"
    class="pointer-events-none fixed z-50 flex items-center justify-center overflow-hidden rounded-sm border border-accent bg-panel-alt text-xs text-accent shadow-lg"
    style="left: {topbarDrag.x}px; top: {topbarDrag.y}px; width: {topbarDrag.width}px; height: {topbarDrag.height}px"
  >
    {#if topbarDrag.id === "record"}
      REC
    {:else}
      <Icon name={actionIcon(topbarDrag.id)} size={15} />
    {/if}
  </div>
{/if}

<ContextMenu {menu} onclose={() => (menu = null)} />
