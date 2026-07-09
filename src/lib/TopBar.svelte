<script lang="ts">
  // Application top bar: a breadcrumb of the active connection (alias · user@host:port)
  // plus quick actions — recording (REC toggle + library), monitoring (only while an
  // SSH session is connected) and settings. Pure presentational; the parent wires the
  // callbacks, the copy and the recording state.
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
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
    <button
      class="flex items-center rounded p-1.5 {!canBroadcast
        ? 'cursor-not-allowed text-muted opacity-40'
        : broadcastActive
          ? 'text-accent hover:bg-edge'
          : 'text-muted hover:bg-edge hover:text-white'}"
      use:tooltip={broadcastActive ? t("broadcast.removeFromGroup") : t("broadcast.addToGroup")}
      aria-label={broadcastActive ? t("broadcast.removeFromGroup") : t("broadcast.addToGroup")}
      aria-pressed={broadcastActive}
      data-testid="topbar-broadcast"
      disabled={!canBroadcast}
      onclick={() => onToggleBroadcast?.()}
    >
      <Icon name="broadcast" size={15} />
    </button>
    {#if showNotes}
      <button
        class="relative flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
        use:tooltip={t("topbar.notes")}
        aria-label={t("topbar.notes")}
        data-testid="topbar-notes"
        onclick={() => onOpenNotes?.()}
      >
        <Icon name="note" size={15} />
        {#if hasNotes}
          <span
            class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
            data-testid="topbar-notes-dot"
          ></span>
        {/if}
      </button>
    {/if}
    <!-- Monitoring and REC keep their slots even without a live session so the
         cluster never reflows; they're dimmed + disabled until a session exists. -->
    <button
      class="flex items-center rounded p-1.5 {connected
        ? 'text-muted hover:bg-edge hover:text-white'
        : 'cursor-not-allowed text-muted opacity-40'}"
      use:tooltip={t("topbar.monitoring")}
      aria-label={t("topbar.monitoring")}
      data-testid="topbar-monitoring"
      disabled={!connected}
      onclick={onOpenMonitoring}
    >
      <Icon name="barChart" size={15} />
    </button>
    <button
      data-testid="record-toggle"
      class="flex items-center gap-1 rounded px-2 py-1 text-xs {!canRecord
        ? 'cursor-not-allowed text-muted opacity-40'
        : recording
          ? 'text-danger'
          : 'text-muted hover:bg-edge hover:text-white'}"
      use:tooltip={recording ? t("recordings.stop") : t("recordings.start")}
      aria-label={recording ? t("recordings.stop") : t("recordings.start")}
      aria-pressed={recording}
      disabled={!canRecord}
      onclick={onToggleRecording}
    >
      <span
        class="h-2.5 w-2.5 rounded-full {recording
          ? 'animate-pulse bg-danger'
          : 'border border-current'}"
      ></span>
      REC
    </button>
    <button
      data-testid="open-recordings"
      class="flex items-center rounded p-1.5 text-muted hover:bg-edge hover:text-white"
      use:tooltip={t("recordings.title")}
      aria-label={t("recordings.title")}
      onclick={onOpenRecordings}
    >
      <Icon name="activity" size={15} />
    </button>
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
