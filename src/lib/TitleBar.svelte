<script lang="ts">
  // Custom (frameless) window title bar for Windows/Linux — the replacement for
  // the native caption + native menu bar, so the whole window chrome follows the
  // active theme instead of staying OS-light against a dark theme. NOT mounted on
  // macOS (native title bar + system menu bar stay); the parent gates it by host
  // OS. Thin shell: window ops go straight to the Tauri window API, the File/Help
  // dropdowns reuse the shared <ContextMenu>, and the resize-edge geometry is the
  // pure `windowchrome.ts` (tested there). The bar itself is the drag region
  // (`data-tauri-drag-region`), double-click maximises via Tauri.
  import { onDestroy, onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import AppLogo from "./AppLogo.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { t } from "./i18n";
  import { menuAnchor, resizeEdges } from "./windowchrome";

  let {
    onSettings,
    onAbout,
    onHelp,
    onManual,
    onMonitoring,
  }: {
    onSettings: () => void;
    onAbout: () => void;
    onHelp: () => void;
    onManual: () => void;
    onMonitoring: () => void;
  } = $props();

  const appWindow = getCurrentWindow();
  const edges = resizeEdges();

  let maximized = $state(false);
  let openKey = $state<"file" | "help" | null>(null);
  let openMenu = $state<OpenMenu | null>(null);

  // Window controls. Wrapped so a non-Tauri context (plain `pnpm dev` in a
  // browser, unit tests) can't throw out of an event handler.
  const guard = (fn: () => Promise<unknown>) => () => void fn().catch(() => {});
  const minimize = guard(() => appWindow.minimize());
  const toggleMaximize = guard(() => appWindow.toggleMaximize());
  const close = guard(() => appWindow.close());

  function startResize(dir: Parameters<typeof appWindow.startResizeDragging>[0]) {
    void appWindow.startResizeDragging(dir).catch(() => {});
  }

  // Keep the maximise/restore glyph in sync with the real window state.
  let unResized: (() => void) | null = null;
  onMount(() => {
    void (async () => {
      try {
        maximized = await appWindow.isMaximized();
        unResized = await appWindow.onResized(async () => {
          try {
            maximized = await appWindow.isMaximized();
          } catch {
            /* window gone */
          }
        });
      } catch {
        /* non-Tauri context — controls simply no-op */
      }
    })();
  });
  onDestroy(() => unResized?.());

  const fileItems = (): MenuItem[] => [
    { icon: "settings", label: t("menu.settings"), onSelect: onSettings },
    { icon: "barChart", label: t("menu.monitoring"), onSelect: onMonitoring },
    { kind: "separator" },
    { icon: "power", label: t("window.exit"), onSelect: close, danger: true },
  ];
  const helpItems = (): MenuItem[] => [
    { icon: "info", label: t("menu.about"), onSelect: onAbout },
    { icon: "bulb", label: t("menu.help"), onSelect: onHelp },
    { icon: "note", label: t("menu.manual"), onSelect: onManual },
  ];

  function openTop(key: "file" | "help", target: HTMLElement) {
    const { x, y } = menuAnchor(target.getBoundingClientRect());
    openKey = key;
    openMenu = { x, y, items: key === "file" ? fileItems() : helpItems() };
  }

  function onTopClick(key: "file" | "help", ev: MouseEvent) {
    if (openKey === key) {
      closeMenu();
      return;
    }
    openTop(key, ev.currentTarget as HTMLElement);
  }

  // While one top menu is open, hovering the other switches to it (native menu-bar
  // feel). Does nothing when no menu is open, so plain hover doesn't pop menus.
  function onTopEnter(key: "file" | "help", ev: PointerEvent) {
    if (openKey && openKey !== key) openTop(key, ev.currentTarget as HTMLElement);
  }

  function closeMenu() {
    openMenu = null;
    openKey = null;
  }
</script>

<!-- z-50 so the menu-bar buttons stay clickable above the <ContextMenu> backdrop
     (z-40) while a dropdown is open, enabling click/hover switching between File
     and Help. The dropdown itself (z-50, rendered after) still paints on top. -->
<div
  class="relative z-50 flex h-8 shrink-0 select-none items-center border-b border-edge bg-panel-alt pl-2 text-text"
  data-tauri-drag-region
>
  <!-- Decorative identity: pointer-events off so drags start on the bar itself. -->
  <div class="pointer-events-none flex items-center gap-2 pr-1">
    <AppLogo size={18} />
    <span class="text-xs font-medium text-muted">vterm</span>
  </div>

  <!-- HTML menu bar (replaces the native File/Help). -->
  <nav class="flex items-center" aria-label={t("window.menuBar")}>
    <button
      type="button"
      class="rounded px-2 py-1 text-xs {openKey === 'file'
        ? 'bg-edge text-text'
        : 'text-muted hover:bg-edge hover:text-text'}"
      aria-haspopup="menu"
      aria-expanded={openKey === "file"}
      onclick={(e) => onTopClick("file", e)}
      onpointerenter={(e) => onTopEnter("file", e)}
    >
      {t("menu.fileMenu")}
    </button>
    <button
      type="button"
      class="rounded px-2 py-1 text-xs {openKey === 'help'
        ? 'bg-edge text-text'
        : 'text-muted hover:bg-edge hover:text-text'}"
      aria-haspopup="menu"
      aria-expanded={openKey === "help"}
      onclick={(e) => onTopClick("help", e)}
      onpointerenter={(e) => onTopEnter("help", e)}
    >
      {t("menu.helpMenu")}
    </button>
  </nav>

  <!-- Draggable filler between the menu and the window controls. -->
  <div class="h-full flex-1" data-tauri-drag-region></div>

  <!-- Window controls. -->
  <div class="flex h-full items-stretch">
    <button
      type="button"
      class="flex w-11 items-center justify-center text-muted hover:bg-edge hover:text-text"
      use:tooltip={t("window.minimize")}
      aria-label={t("window.minimize")}
      onclick={minimize}
    >
      <Icon name="minus" size={15} />
    </button>
    <button
      type="button"
      class="flex w-11 items-center justify-center text-muted hover:bg-edge hover:text-text"
      use:tooltip={maximized ? t("window.restore") : t("window.maximize")}
      aria-label={maximized ? t("window.restore") : t("window.maximize")}
      onclick={toggleMaximize}
    >
      <Icon name={maximized ? "windowRestore" : "windowMaximize"} size={13} />
    </button>
    <button
      type="button"
      class="flex w-11 items-center justify-center text-muted hover:bg-danger hover:text-text"
      use:tooltip={t("window.close")}
      aria-label={t("window.close")}
      onclick={close}
    >
      <Icon name="close" size={15} />
    </button>
  </div>
</div>

<!-- Invisible resize grips along the window edges/corners (frameless windows lose
     the native ones). Hidden while maximised — a maximised window can't resize and
     the grips would sit off-screen. Low z so open modals/menus sit above them. -->
{#if !maximized}
  {#each edges as edge (edge.id)}
    <div
      class="fixed z-20"
      style="{edge.style};cursor:{edge.cursor}"
      onpointerdown={(e) => {
        if (e.button === 0) startResize(edge.dir);
      }}
      role="presentation"
    ></div>
  {/each}
{/if}

<ContextMenu menu={openMenu} onclose={closeMenu} />
