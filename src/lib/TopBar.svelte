<script lang="ts">
  // Application top bar: a breadcrumb of the active connection (alias · user@host:port)
  // plus quick actions — monitoring (only while an SSH session is connected) and
  // settings. Pure presentational; the parent wires the callbacks and the copy.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t } from "./i18n";

  let {
    title,
    subtitle,
    connected,
    onOpenMonitoring,
    onOpenSettings,
  }: {
    /** Active connection alias (or a fallback like "Not connected"). */
    title: string;
    /** `user@host:port` for an SSH tab; empty otherwise. */
    subtitle: string;
    /** SSH session is connected — enables the monitoring action. */
    connected: boolean;
    onOpenMonitoring: () => void;
    onOpenSettings: () => void;
  } = $props();
</script>

<header class="flex items-center gap-2 border-b border-edge bg-panel-alt px-3 py-1.5">
  {#if subtitle}
    <Icon name="server" size={14} class="shrink-0 text-muted" />
    <span class="shrink-0 truncate text-xs font-medium text-text">{title}</span>
    <span class="shrink-0 text-xs text-muted">·</span>
    <span class="min-w-0 truncate text-xs text-muted">{subtitle}</span>
  {:else}
    <span class="truncate text-xs text-muted">{title}</span>
  {/if}

  <div class="ml-auto flex shrink-0 items-center gap-1">
    {#if connected}
      <button
        class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
        use:tooltip={t("topbar.monitoring")}
        aria-label={t("topbar.monitoring")}
        data-testid="topbar-monitoring"
        onclick={onOpenMonitoring}
      >
        <Icon name="barChart" size={15} />
      </button>
    {/if}
    <button
      class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
      use:tooltip={t("topbar.settings")}
      aria-label={t("topbar.settings")}
      data-testid="topbar-settings"
      onclick={onOpenSettings}
    >
      <Icon name="settings" size={15} />
    </button>
  </div>
</header>
