<script lang="ts">
  // One dock (v1.1): the chrome around the tool panels that live on one side of
  // the window — left, right or bottom. Three instances of this component replace
  // the single hard-wired right dock; which panels each holds, the tab it shows,
  // its size and collapse come from the layout store, and the panels themselves
  // are rendered by the `panel` snippet the page supplies (content-only).
  //
  // Left/right collapse to a thin rail of vertical tab labels; the bottom dock
  // collapses to its own tab strip. Tabs can be dragged to another dock (or
  // reordered) — the other tabs slide apart to show where it lands — and moved
  // or hidden from their right-click menu.
  import { untrack, type Snippet } from "svelte";
  import { tooltip } from "./actions/tooltip";
  import { glide, resizableHandle } from "./actions/drag";
  import {
    availablePanels,
    COLLAPSED_RAIL,
    effectiveSize,
    isSessionPanel,
    offeredPanels,
    previewPanels,
    shownPanel,
    type DockSide,
    type PanelId,
  } from "./docklayout";
  import { panelLabel, tabMenuItems } from "./dockui";
  import { motion } from "./motion";
  import { settings } from "./settings.svelte";
  import {
    activatePanel,
    layout,
    movePanel,
    setDockCollapsed,
    setDockSize,
    setPanelHidden,
  } from "./stores/layout.svelte";
  import { beginPanelDrag, consumeDragClick, dockDrag } from "./stores/dockdrag.svelte";
  import { notifyInfo } from "./stores/toasts.svelte";
  import type { DockConnection } from "./stores/tabs.svelte";
  import type { OpenMenu } from "./ctxmenu";
  import type { IconName } from "./icons";
  import ContextMenu from "./ContextMenu.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    side,
    sessionId = null,
    sessionKind = "ssh",
    connection = "offline",
    stripHeight = 0,
    panel,
  }: {
    side: DockSide;
    /** The session the session panels work on; null = no tab is open, and only
     *  the global panels (the server tree) are offered. */
    sessionId?: string | null;
    sessionKind?: "ssh" | "local";
    /** State of that session (`dockConnection`): an offline session replaces its
     *  panels with one notice. */
    connection?: DockConnection;
    /** Height in px of the bar this dock's tab strip stands next to (the terminal
     *  tab bar, for the left dock), so the two bottom borders form one line. That
     *  bar grows when the first tab opens; 0 = not measured, use the default. */
    stripHeight?: number;
    /** Renders one tool panel, content-only. `visible` tells it whether it is on
     *  screen — a hidden panel stays mounted but must not poll. */
    panel: Snippet<[PanelId, boolean]>;
  } = $props();

  /**
   * Height of the collapsed bottom dock: its tab strip shrunk to `h-6` + the 1px
   * top border — the height of the status bar under it, so the two read as one
   * footer rather than as a thick bar on a thin one.
   */
  const BOTTOM_STRIP = 25;

  const BORDER: Record<DockSide, string> = {
    left: "border-r",
    right: "border-l",
    bottom: "border-t",
  };
  // The handle straddles the dock's inner border (2px each way), so the seam
  // stays flush and the strip overlays it — accent on hover — instead of wedging
  // a gap between the dock and the terminal.
  const HANDLE: Record<DockSide, string> = {
    left: "inset-y-0 -right-0.5 w-1 cursor-col-resize",
    right: "inset-y-0 -left-0.5 w-1 cursor-col-resize",
    bottom: "inset-x-0 -top-0.5 h-1 cursor-row-resize",
  };
  const ZONE: Record<DockSide, string> = {
    left: "inset-y-0 left-0 w-12",
    right: "inset-y-0 right-0 w-12",
    bottom: "inset-x-0 bottom-0 h-12",
  };

  const vertical = $derived(side !== "bottom");
  const dock = $derived(layout.docks[side]);
  const hasSession = $derived(sessionId !== null);
  // Panels the user hid in settings are not offered — like session panels with
  // no session, they keep their place in the dock and simply are not drawn.
  const hidden = $derived(settings.hiddenPanels);
  const tabs = $derived(availablePanels(dock, hasSession, hidden));
  const active = $derived(shownPanel(dock, hasSession, hidden));
  const collapsed = $derived(dock.collapsed);
  // The right dock stands as a rail on top of the bottom dock's right corner —
  // the bottom strip then carries a cell that takes its border down to the
  // status bar (see `strip`).
  const rightRail = $derived(
    side === "bottom" &&
      layout.docks.right.collapsed &&
      availablePanels(layout.docks.right, hasSession, hidden).length > 0,
  );

  let innerHeight = $state(0);
  const size = $derived(effectiveSize(side, dock.size, innerHeight));

  // No session to run on: a session panel shows one notice instead of itself.
  // It stays mounted underneath (its state survives the reconnect) but counts as
  // hidden — pollers stop, and on the way back it takes one fresh snapshot,
  // exactly as when the user returns from another tab of the dock.
  const offline = $derived(connection === "offline");
  const paneShown = (id: PanelId): boolean =>
    id === active && !collapsed && !(offline && isSessionPanel(id));
  const offlineNotice = $derived(
    !collapsed && active !== null && isSessionPanel(active) && offline,
  );

  // A session panel belongs to one session: its key carries the session id, so a
  // switch to another terminal tab builds a fresh panel while the server tree —
  // the one global panel — is left alone.
  const paneKey = (id: PanelId): string => (isSessionPanel(id) ? `${sessionId}/${id}` : id);

  // Which panels exist in the DOM. A panel is mounted the first time it is on
  // screen and then kept — switching tabs or collapsing the dock only hides it
  // (v1.0.14). Destroying it threw away everything it held: the SFTP panel came
  // back asking to connect again (the channel was never closed), the file panel
  // jumped to home, the k8s panel forgot the picked context/namespace, and Docker
  // re-probed the daemon from scratch. Lazy, so a panel the user never opens —
  // and a dock that starts collapsed — costs nothing.
  //
  // Hidden panels must not keep polling — that is what the `visible` argument of
  // the `panel` snippet is for, and `dockpanels.guard.test.ts` keeps the two
  // halves together.
  let visited = $state<string[]>([]);
  $effect(() => {
    const live = tabs.map(paneKey);
    const open = active && !collapsed ? paneKey(active) : null;
    untrack(() => {
      // Keys of another session, or of a panel that moved to another dock, go.
      const kept = visited.filter((k) => live.includes(k));
      const next = open && !kept.includes(open) ? [...kept, open] : kept;
      if (next.length !== visited.length || next.some((k, i) => k !== visited[i])) {
        visited = next;
      }
    });
  });
  const panes = $derived(
    tabs.filter((id) => visited.includes(paneKey(id)) || (id === active && !collapsed)),
  );

  function pick(id: PanelId) {
    if (consumeDragClick()) return;
    activatePanel(side, id);
    setDockCollapsed(side, false);
  }

  function toggle() {
    if (consumeDragClick()) return;
    setDockCollapsed(side, !collapsed);
  }

  // ── Resize ─────────────────────────────────────────────────────────────────
  let resizing = $state(false);
  let startSize = 0;
  function onResize(dx: number, dy: number) {
    const delta = side === "left" ? dx : side === "right" ? -dx : -dy;
    // Store what can actually be drawn: dragging the bottom dock past its share of
    // the window would otherwise bank height the handle then has to "pay back"
    // before it moves again.
    setDockSize(side, effectiveSize(side, startSize + delta, innerHeight));
  }

  // ── Moving and hiding tabs ─────────────────────────────────────────────────
  let menu = $state<OpenMenu | null>(null);
  function openMenu(e: MouseEvent, id: PanelId) {
    e.preventDefault();
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: tabMenuItems(side, id, {
        onMove: (to) => movePanel(id, to),
        onHide: () => {
          setPanelHidden(id, true);
          // The tab is gone from the screen — say where the way back is.
          notifyInfo(t("dock.hiddenHint", { panel: panelLabel(id) }));
        },
      }),
    };
  }

  const dragging = $derived(dockDrag.panel !== null);
  /** This dock is where the dragged tab would land (an empty dock's edge lights up). */
  const dropHere = $derived(dockDrag.panel !== null && dockDrag.over?.side === side);
  // While a tab is in the air the strip draws the order the drop would give, so
  // the other tabs slide apart for it (`animate:glide`) and close up where it
  // left. The dragged tab itself stays in the strip as an invisible slot — the
  // floating copy (DockDragGhost) is what follows the pointer. Only the strip
  // previews: the panels below keep the committed layout until the drop.
  const stripTabs = $derived(
    dockDrag.panel === null
      ? tabs
      : offeredPanels(
          previewPanels(layout.docks, dockDrag.panel, dockDrag.over)[side],
          hasSession,
          hidden,
        ),
  );
  // A tab's index in the dock's full panel list — what a drop index refers to,
  // even while some of the dock's panels are not offered (no session, hidden).
  const panelIndex = (id: PanelId): number => dock.panels.indexOf(id);
  /** The slot held open for the dragged tab — hit-testing keeps the target on it. */
  const slot = (id: PanelId): "" | undefined => (id === dockDrag.panel ? "" : undefined);

  const toggleIcon = $derived<IconName>(
    side === "left"
      ? "chevronLeft"
      : side === "right"
        ? "chevronRight"
        : collapsed
          ? "chevronUp"
          : "chevronDown",
  );
</script>

<svelte:window bind:innerHeight />

{#snippet toggleButton()}
  <button
    data-testid={`dock-toggle-${side}`}
    class="shrink-0 self-center rounded p-1 text-muted hover:bg-edge hover:text-text"
    use:tooltip={t(collapsed ? "dock.expand" : "dock.collapse")}
    aria-label={t(collapsed ? "dock.expand" : "dock.collapse")}
    onclick={toggle}
  >
    <Icon name={toggleIcon} size={16} />
  </button>
{/snippet}

<!-- Horizontal tabs + collapse. The left dock's strip stands next to the
     terminal tab bar and takes that bar's height (`stripHeight`; `min-h-8` until
     it is measured — the bar's own minimum) so the two bottom borders form one
     line across the window. The right dock sits under that bar and keeps its
     natural height.

     On the bottom dock the strip is also the collapsed state. It starts with a
     corner cell as wide as a side dock's rail (`w-9`) holding the collapse
     button: the button stands right under the left rail's own, and the cell's
     border takes that rail's border down to the status bar. While the right dock
     is a rail too, a matching cell ends the strip under it. Collapsed, the strip
     is as tall as the status bar below. -->
{#snippet strip()}
  <div
    data-dock-axis="x"
    data-testid={`dock-strip-${side}`}
    style={side === "left" && stripHeight > 0 ? `height: ${stripHeight}px` : undefined}
    class="flex shrink-0 select-none border-b text-xs {side === 'right'
      ? 'items-center border-edge'
      : side === 'left'
        ? 'min-h-8 items-stretch border-edge'
        : `items-stretch transition-[height] duration-200 ease-out ${
            collapsed ? 'h-6 border-transparent' : 'h-8 border-edge'
          }`}"
  >
    {#if side === "right"}{@render toggleButton()}{/if}
    {#if side === "bottom"}
      <div
        data-testid="dock-corner-left"
        class="flex w-9 shrink-0 items-center justify-center border-r border-edge"
      >
        {@render toggleButton()}
      </div>
    {/if}
    {#each stripTabs as id (id)}
      <button
        data-testid={`dock-tab-${id}`}
        data-dock-tab={panelIndex(id)}
        data-dock-placeholder={slot(id)}
        animate:glide={motion()}
        class="relative min-w-0 touch-none border-b-2 text-center {vertical
          ? 'flex-1 truncate px-1 py-1.5'
          : 'shrink-0 px-4'} {id === dockDrag.panel
          ? 'border-transparent opacity-0'
          : active === id && !collapsed
            ? 'border-accent text-accent'
            : `border-transparent hover:text-text ${active === id ? 'text-text' : 'text-muted'}`}"
        aria-current={active === id ? "true" : undefined}
        onpointerdown={(e) => beginPanelDrag(e, id)}
        oncontextmenu={(e) => openMenu(e, id)}
        onclick={() => pick(id)}
      >
        {panelLabel(id)}
      </button>
    {/each}
    {#if side === "left"}{@render toggleButton()}{/if}
    {#if rightRail}
      <div
        data-testid="dock-corner-right"
        aria-hidden="true"
        class="ml-auto w-9 shrink-0 border-l border-edge"
      ></div>
    {/if}
  </div>
{/snippet}

<!-- Panel content. Every visited panel stays in the DOM; the ones not on screen
     are hidden, not destroyed (see `visited` above). The fade is the
     `vt-dock-pane` CSS animation, which the reduced-motion guard in app.css
     covers. -->
{#snippet body()}
  {#if offlineNotice}
    <!-- Reconnecting lives in the terminal area (one button, not one per
         panel); the dock only says why it has nothing to show. -->
    <div class="vt-dock-pane min-h-0 flex-1" data-testid="dock-offline">
      <EmptyState
        icon="plug"
        title={t(sessionKind === "ssh" ? "dock.offlineTitle" : "dock.localEndedTitle")}
        hint={t(sessionKind === "ssh" ? "dock.offlineHint" : "dock.localEndedHint")}
      />
    </div>
  {/if}
  {#each panes as id (paneKey(id))}
    <div
      data-testid={`dock-pane-${id}`}
      class="min-h-0 flex-1 {paneShown(id) ? 'vt-dock-pane' : 'hidden'}"
    >
      {@render panel(id, paneShown(id))}
    </div>
  {/each}
{/snippet}

{#if tabs.length > 0}
  <div
    data-testid={`dock-${side}`}
    class="relative shrink-0 {vertical ? 'h-full' : 'w-full'} {resizing
      ? ''
      : vertical
        ? 'transition-[width] duration-200 ease-out'
        : 'transition-[height] duration-200 ease-out'}"
    style={vertical
      ? `width: ${collapsed ? COLLAPSED_RAIL : size}px`
      : `height: ${collapsed ? BOTTOM_STRIP : size}px`}
  >
    <div
      data-dock-drop={side}
      class="relative h-full w-full overflow-hidden border-edge bg-panel-alt {BORDER[side]}"
    >
      {#if vertical}
        {#if collapsed}
          <!-- Vertical tabs (a thin rail): click expands to that tab -->
          <div data-dock-axis="y" class="flex w-9 select-none flex-col items-center gap-2 py-2">
            <button
              data-testid={`dock-expand-${side}`}
              class="rounded p-1 text-muted hover:bg-edge hover:text-text"
              use:tooltip={t("dock.expand")}
              aria-label={t("dock.expand")}
              onclick={toggle}
            >
              <Icon name={side === "left" ? "chevronRight" : "chevronLeft"} size={16} />
            </button>
            {#each stripTabs as id (id)}
              <!-- `text-meta` (11px), not the `text-caption` every other uppercase label
                   uses (Phase 44): this is an interactive tab label, not a caption, and
                   it is set vertically — rotated glyphs at 10px are markedly harder to
                   read. Deliberate exception; don't "unify" it away. -->
              <button
                data-testid={`dock-vtab-${id}`}
                data-dock-tab={panelIndex(id)}
                data-dock-placeholder={slot(id)}
                animate:glide={motion()}
                class="relative touch-none rounded px-1 py-1.5 text-meta uppercase tracking-wider [writing-mode:vertical-rl] {id ===
                dockDrag.panel
                  ? 'opacity-0'
                  : active === id
                    ? 'bg-edge text-text'
                    : 'text-muted hover:text-text'}"
                aria-current={active === id ? "true" : undefined}
                onpointerdown={(e) => beginPanelDrag(e, id)}
                oncontextmenu={(e) => openMenu(e, id)}
                onclick={() => pick(id)}
              >
                {panelLabel(id)}
              </button>
            {/each}
          </div>
        {/if}
        <!-- Clip-reveal: the content is pinned to the dock's full width and
             anchored to the edge that does not move, so the growing container
             uncovers already laid-out content instead of reflowing it. -->
        <div
          class="absolute inset-y-0 flex flex-col {side === 'left' ? 'left-0' : 'right-0'} {collapsed
            ? 'hidden'
            : ''}"
          style="width: {size}px"
        >
          {@render strip()}
          {@render body()}
        </div>
      {:else}
        <!-- The bottom dock is pinned to its full height and anchored to its top
             edge: the tab strip rides that edge and is all that is left when the
             dock is collapsed; the panels below it are uncovered, not reflowed. -->
        <div class="absolute inset-x-0 top-0 flex flex-col" style="height: {size - 1}px">
          {@render strip()}
          {@render body()}
        </div>
      {/if}
    </div>
    {#if !collapsed}
      <div
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label={t("dock.resize")}
        data-testid={`dock-resize-${side}`}
        class="absolute z-10 hover:bg-accent {resizing ? 'bg-accent' : 'bg-transparent'} {HANDLE[
          side
        ]}"
        use:resizableHandle={{
          onStart: () => {
            resizing = true;
            startSize = size;
          },
          onResize,
          onEnd: () => (resizing = false),
        }}
      ></div>
    {/if}
  </div>
{:else if dragging}
  <!-- A dock with nothing to show is not drawn at all, so while a tab is being
       dragged its edge of the window offers itself as a drop zone. An overlay,
       not a strip in the layout: a strip would resize the terminal mid-drag. -->
  <div
    data-dock-drop={side}
    data-testid={`dock-zone-${side}`}
    aria-hidden="true"
    class="fixed z-40 border-2 border-dashed {dropHere
      ? 'border-accent bg-accent/25'
      : 'border-accent/50 bg-accent/10'} {ZONE[side]}"
  ></div>
{/if}

<!-- While resizing: keep the resize cursor and suppress text selection. -->
{#if resizing}
  <div class="fixed inset-0 z-50 select-none {vertical ? 'cursor-col-resize' : 'cursor-row-resize'}"></div>
{/if}

<ContextMenu {menu} onclose={() => (menu = null)} />
