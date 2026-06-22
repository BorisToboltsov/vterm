<script lang="ts">
  // Left panel: searchable, foldered tree of saved servers with pointer-based
  // drag-and-drop (servers into folders; folders into folders). Owns its own
  // search/collapse/drag UI state and emits intents via callbacks; all data
  // mutation (persisting moves, opening modals) happens in the parent.
  import type { ServerProfile } from "./types";
  import {
    buildTreeRows,
    dropAllowed as treeDropAllowed,
    groupOf,
    nameOf,
    type TreeRow,
  } from "./tree";
  import { dropTargetAt, passedThreshold } from "./actions/drag";
  import { layout } from "./stores/layout.svelte";
  import Icon from "./Icon.svelte";
  import { fade } from "svelte/transition";
  import EmptyState from "./EmptyState.svelte";

  let {
    servers,
    folders,
    selectedId,
    onSelect,
    onConnect,
    onAddServer,
    onEditServer,
    onDeleteServer,
    onNewFolder,
    onRenameFolder,
    onDeleteFolder,
    onMoveServer,
    onMoveFolder,
    animateWidth = true,
  }: {
    servers: ServerProfile[];
    folders: string[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onConnect: () => void;
    onAddServer: () => void;
    onEditServer: (server: ServerProfile) => void;
    onDeleteServer: (server: ServerProfile) => void;
    onNewFolder: (parent: string) => void;
    onRenameFolder: (path: string) => void;
    onDeleteFolder: (path: string) => void;
    onMoveServer: (id: string, group: string | null) => void;
    onMoveFolder: (path: string, parent: string | null) => void;
    /** Animate width changes (collapse). Disabled while the user drags-resizes. */
    animateWidth?: boolean;
  } = $props();

  /** Width of the collapsed strip (matches the w-9 = 36px rail). */
  const COLLAPSED_W = 36;

  let serverSearch = $state("");

  // Collapsed folder paths, persisted between runs.
  const COLLAPSE_KEY = "vterm.collapsedFolders";
  let collapsedFolders = $state<string[]>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]");
      } catch {
        return [];
      }
    })(),
  );
  $effect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedFolders));
    } catch {
      /* non-fatal */
    }
  });

  const treeRows = $derived<TreeRow[]>(
    buildTreeRows({ servers, folders, search: serverSearch, collapsed: collapsedFolders }),
  );

  function toggleFolder(path: string) {
    collapsedFolders = collapsedFolders.includes(path)
      ? collapsedFolders.filter((p) => p !== path)
      : [...collapsedFolders, path];
  }

  // ── Drag servers and folders into folders (pointer-based) ──────────────────
  type DragItem = { kind: "server" | "folder"; id: string };
  let listEl = $state<HTMLDivElement>();
  let dragCandidate: DragItem | null = null;
  let dragKind = $state<"server" | "folder" | null>(null);
  let dragId = $state<string | null>(null);
  let dropTarget = $state<string | null>(null);
  let startX = 0;
  let startY = 0;
  let dragX = $state(0);
  let dragY = $state(0);

  const draggingServer = $derived(
    dragKind === "server" && dragId
      ? (servers.find((s) => s.id === dragId) ?? null)
      : null,
  );
  const draggingFolder = $derived(dragKind === "folder" ? dragId : null);
  const dropAllowed = (target: string | null) => treeDropAllowed(target, dragKind, dragId);

  function startDrag(event: PointerEvent, item: DragItem) {
    if ((event.target as HTMLElement).closest("button")) return;
    dragCandidate = item;
    startX = event.clientX;
    startY = event.clientY;
  }
  const serverPointerDown = (e: PointerEvent, id: string) =>
    startDrag(e, { kind: "server", id });
  const folderPointerDown = (e: PointerEvent, path: string) =>
    startDrag(e, { kind: "folder", id: path });

  function listPointerMove(event: PointerEvent) {
    if (dragCandidate === null || !listEl) return;
    if (dragId === null) {
      if (!passedThreshold(startX, startY, event.clientX, event.clientY, 5)) return;
      dragKind = dragCandidate.kind;
      dragId = dragCandidate.id;
      listEl.setPointerCapture(event.pointerId);
    }
    dragX = event.clientX;
    dragY = event.clientY;
    dropTarget = dropTargetAt(event.clientX, event.clientY);
  }

  function listPointerUp(event: PointerEvent) {
    const kind = dragKind;
    const id = dragId;
    const target = dropTarget;
    if (id !== null) {
      try {
        listEl?.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (kind === "server" && target !== null) {
        const server = servers.find((s) => s.id === id);
        if (server && groupOf(server) !== target) onMoveServer(id, target || null);
      } else if (kind === "folder" && dropAllowed(target)) {
        onMoveFolder(id, target || null);
      }
    }
    dragCandidate = null;
    dragKind = null;
    dragId = null;
    dropTarget = null;
  }
</script>

<aside
  style="width: {layout.leftCollapsed ? COLLAPSED_W : layout.leftWidth}px"
  class="flex shrink-0 flex-col overflow-hidden border-r border-edge bg-panel-alt {animateWidth
    ? 'transition-[width] duration-200 ease-out'
    : ''}"
>
  {#if layout.leftCollapsed}
    <div class="flex w-9 flex-col items-center gap-3 py-2">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-white"
        title="Expand server list"
        aria-label="Expand server list"
        onclick={() => (layout.leftCollapsed = false)}
      >
        <Icon name="chevronRight" size={16} />
      </button>
      <span
        class="text-[10px] uppercase tracking-wider text-muted [writing-mode:vertical-rl]"
      >
        Servers
      </span>
    </div>
  {:else}
    <div
      class="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wider text-muted"
    >
      <span>Saved servers</span>
      <button
        class="rounded p-0.5 hover:bg-edge hover:text-white"
        title="Collapse server list"
        aria-label="Collapse server list"
        onclick={() => (layout.leftCollapsed = true)}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
    </div>
    <div class="flex items-center gap-1 px-2 pb-2">
      <input
        data-testid="server-search"
        class="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-xs text-white outline-none focus:border-accent"
        placeholder="Search servers, tags…"
        bind:value={serverSearch}
      />
      <button
        class="flex shrink-0 items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
        title="New folder"
        aria-label="New folder"
        onclick={() => onNewFolder("")}
      >
        <Icon name="folderPlus" size={14} />
      </button>
    </div>
    <div
      bind:this={listEl}
      data-drop=""
      role="tree"
      tabindex="-1"
      onpointermove={listPointerMove}
      onpointerup={listPointerUp}
      class="min-h-0 flex-1 overflow-y-auto {dragId ? 'cursor-grabbing select-none' : ''}"
    >
      <!-- Vertical guides marking each nesting level. -->
      {#snippet guides(depth: number)}
        {#each Array.from({ length: depth }) as _, i (i)}
          <span
            class="pointer-events-none absolute bottom-0 top-0 border-l border-muted/30"
            style="left: {i * 16 + 8}px"
          ></span>
        {/each}
      {/snippet}
      {#each treeRows as row (row.kind === "folder" ? "f:" + row.path : "s:" + row.server.id)}
        {#if row.kind === "folder"}
          <div
            data-drop={row.path}
            role="treeitem"
            aria-selected="false"
            tabindex="-1"
            style="padding-left: {row.depth * 16}px"
            onpointerdown={(e) => folderPointerDown(e, row.path)}
            class="group relative flex cursor-grab items-center gap-1 border-l-2 border-transparent py-1 pr-2 text-sm transition duration-150 {dropTarget ===
              row.path && dropAllowed(row.path)
              ? 'bg-accent/20 ring-1 ring-inset ring-accent'
              : 'hover:bg-edge'} {dragKind === 'folder' && dragId === row.path
              ? 'opacity-50'
              : ''}"
          >
            {@render guides(row.depth)}
            <button
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:text-white"
              title={collapsedFolders.includes(row.path) ? "Expand" : "Collapse"}
              aria-label="Toggle folder"
              onclick={() => toggleFolder(row.path)}
            >
              <Icon name={collapsedFolders.includes(row.path) ? "chevronRight" : "chevronDown"} size={14} />
            </button>
            <Icon name="folder" size={15} class="text-muted" />
            <span class="truncate font-medium">{row.name}</span>
            <span class="shrink-0 text-[10px] text-muted">{row.count}</span>
            <div
              class="invisible ml-auto flex shrink-0 items-center gap-1 group-hover:visible"
            >
              <button
                class="rounded p-0.5 text-muted hover:text-accent"
                title="Rename folder"
                aria-label="Rename folder"
                onclick={() => onRenameFolder(row.path)}
              >
                <Icon name="pencil" size={13} />
              </button>
              <button
                class="rounded p-0.5 text-muted hover:text-accent"
                title="New subfolder"
                aria-label="New subfolder"
                onclick={() => onNewFolder(row.path)}
              >
                <Icon name="plus" size={13} />
              </button>
              <button
                class="rounded p-0.5 text-muted hover:text-danger"
                title="Delete folder"
                aria-label="Delete folder"
                onclick={() => onDeleteFolder(row.path)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        {:else}
          <div
            data-testid="server-row"
            data-server-alias={row.server.alias}
            role="button"
            tabindex="0"
            style="padding-left: {row.depth * 16}px"
            class="group relative flex w-full cursor-pointer items-start gap-1 border-l-2 py-2 pr-7 text-left text-sm transition duration-150 hover:bg-edge {selectedId ===
            row.server.id
              ? 'border-accent bg-edge'
              : 'border-transparent'} {dragKind === 'server' && dragId === row.server.id
              ? 'opacity-50'
              : ''}"
            onpointerdown={(e) => serverPointerDown(e, row.server.id)}
            onclick={() => onSelect(row.server.id)}
            ondblclick={onConnect}
            onkeydown={(e) => e.key === "Enter" && onSelect(row.server.id)}
          >
            {@render guides(row.depth)}
            <!-- Empty toggle column so servers align with folder icons. -->
            <span class="h-4 w-4 shrink-0"></span>
            <div class="min-w-0 flex-1">
              <div class="font-medium">{row.server.alias}</div>
              <div class="text-xs text-muted">
                {row.server.username}@{row.server.host}:{row.server.port}
              </div>
              {#if row.server.tags.length > 0}
                <div class="mt-1 flex flex-wrap gap-1">
                  {#each row.server.tags as tag (tag)}
                    <span class="rounded bg-edge px-1.5 py-0.5 text-[10px] text-muted">{tag}</span>
                  {/each}
                </div>
              {/if}
            </div>
            <div
              class="invisible absolute right-1.5 top-1.5 flex items-center gap-1 group-hover:visible"
            >
              <button
                class="rounded p-0.5 text-muted hover:text-accent"
                title="Edit server"
                aria-label="Edit server"
                onclick={(e) => {
                  e.stopPropagation();
                  onEditServer(row.server);
                }}
              >
                <Icon name="pencil" size={13} />
              </button>
              <button
                class="rounded p-0.5 text-muted hover:text-danger"
                title="Delete server"
                aria-label="Delete server"
                onclick={(e) => {
                  e.stopPropagation();
                  onDeleteServer(row.server);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        {/if}
      {:else}
        {#if servers.length === 0}
          <EmptyState
            icon="server"
            title="Пока нет серверов"
            hint="Добавьте первый сервер, чтобы подключиться по SSH."
          >
            <button
              data-testid="empty-add-server"
              class="rounded bg-edge px-3 py-1 text-sm font-medium hover:bg-accent hover:text-panel-alt"
              onclick={onAddServer}
            >
              Добавить сервер
            </button>
          </EmptyState>
        {:else}
          <div class="px-3 py-4 text-center text-sm text-muted">Ничего не найдено</div>
        {/if}
      {/each}
    </div>
  {/if}
</aside>

<!-- Drag ghosts (pointer-events-none so elementFromPoint still sees the target). -->
{#if draggingServer}
  <div
    in:fade={{ duration: 120 }}
    class="pointer-events-none fixed z-50 w-56 rounded border border-accent bg-panel-alt px-3 py-2 text-sm opacity-90 shadow-lg"
    style="left: {dragX + 12}px; top: {dragY + 8}px"
  >
    <div class="font-medium">{draggingServer.alias}</div>
    <div class="truncate text-xs text-muted">
      {draggingServer.username}@{draggingServer.host}:{draggingServer.port}
    </div>
  </div>
{/if}
{#if draggingFolder}
  <div
    in:fade={{ duration: 120 }}
    class="pointer-events-none fixed z-50 flex items-center gap-2 rounded border border-accent bg-panel-alt px-3 py-1.5 text-sm opacity-90 shadow-lg"
    style="left: {dragX + 12}px; top: {dragY + 8}px"
  >
    <Icon name="folder" size={15} />
    <span class="font-medium">{nameOf(draggingFolder)}</span>
  </div>
{/if}
