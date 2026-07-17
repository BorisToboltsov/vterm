<script lang="ts">
  // Shared right dock (Phase 17.2). One collapsible/resizable panel with two tabs —
  // "SFTP" (files) and "AI" (chat). Collapsed: vertical tab labels in a thin strip;
  // expanded: horizontal tabs above the active tab's content. The content panels
  // are rendered embedded (content-only) — this component owns the chrome.
  import type { DockTab } from "./stores/layout.svelte";
  import { tooltip } from "./actions/tooltip";
  import SftpPanel from "./SftpPanel.svelte";
  import LocalFilePanel from "./LocalFilePanel.svelte";
  import AiChat from "./AiChat.svelte";
  import GitPanel from "./GitPanel.svelte";
  import DockerPanel from "./DockerPanel.svelte";
  import K8sPanel from "./K8sPanel.svelte";
  import type { RawContext } from "./aicontext";
  import type { AiExecMode } from "./ai";
  import Icon from "./Icon.svelte";
  import { t } from "./i18n";

  let {
    width = 384,
    collapsed = $bindable(false),
    activeTab = $bindable<DockTab>("files"),
    animateWidth = true,
    kind,
    sessionId,
    chatPromptId = null,
    serverExecMode = null,
    sessionReady = false,
    terminalCwd = null,
    followTerminal = false,
    onToggleFollowTerminal,
    onOpenFile,
    onOpenLocalFile,
    onOpenGitDiff,
    onIgnoreGitignore,
    onSftpNavigate,
    onOpenContainerShell,
    getAiContext,
    aiProd = false,
    aiNoAi = false,
  }: {
    width?: number;
    collapsed?: boolean;
    activeTab?: DockTab;
    animateWidth?: boolean;
    kind: "ssh" | "local";
    sessionId: string;
    /** The active server's chosen chat prompt id (server-scoped AI persona). */
    chatPromptId?: string | null;
    /** Per-server execution-mode override, or null to use the global setting. */
    serverExecMode?: AiExecMode | null;
    sessionReady?: boolean;
    /** Terminal cwd (OSC 7) for this session — the file panel follows it when on. */
    terminalCwd?: string | null;
    /** Whether the file panel should follow the terminal's cwd (per-tab toggle). */
    followTerminal?: boolean;
    onToggleFollowTerminal?: () => void;
    onOpenFile?: (path: string, name: string, gotoLine?: number) => void;
    onOpenLocalFile?: (path: string) => void;
    /** Open a git-changed file as an editable inline diff (absolute path + HEAD base). */
    onOpenGitDiff?: (absPath: string, gitBase: string) => void;
    /** Append a pattern to the repo's `.gitignore` (absolute path + pattern). */
    onIgnoreGitignore?: (gitignorePath: string, pattern: string) => void;
    /** User navigated in the SFTP panel → cd the terminal too (two-way OSC 7). */
    onSftpNavigate?: (path: string) => void;
    /** Docker panel → open a real terminal tab running an `exec` shell command. */
    onOpenContainerShell?: (command: string) => void;
    /** Reads live session context for the AI tab (selection/buffer/recording/metadata). */
    getAiContext?: () => Promise<RawContext> | RawContext;
    /** The active server is prod-flagged — bars AI auto-execution (17.4). */
    aiProd?: boolean;
    /** The active server is `noAi`-flagged — blocks AI context + execution (17.7). */
    aiNoAi?: boolean;
  } = $props();

  const COLLAPSED_W = 36;
  const TABS: { id: DockTab; label: string }[] = [
    { id: "files", label: "SFTP" },
    { id: "git", label: t("git.panelTitle") },
    { id: "docker", label: t("docker.panelTitle") },
    { id: "k8s", label: "k8s" },
    { id: "ai", label: t("ai.panelTitle") },
  ];

  function pick(tab: DockTab) {
    activeTab = tab;
    collapsed = false;
  }
</script>

<div
  style="width: {collapsed ? COLLAPSED_W : width}px"
  class="relative flex h-full shrink-0 flex-col overflow-hidden border-l border-edge bg-panel-alt {animateWidth
    ? 'transition-[width] duration-200 ease-out'
    : ''}"
>
  {#if collapsed}
    <!-- Vertical tabs (a thin strip): click expands to that tab -->
    <div class="flex w-9 flex-col items-center gap-2 py-2">
      <button
        class="rounded p-1 text-muted hover:bg-edge hover:text-white"
        use:tooltip={t("sftp.expandPanel")}
        aria-label={t("sftp.expandPanel")}
        onclick={() => (collapsed = false)}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
      {#each TABS as tab (tab.id)}
        <button
          data-testid={`dock-vtab-${tab.id}`}
          class="rounded px-1 py-1.5 text-[11px] uppercase tracking-wider [writing-mode:vertical-rl] {activeTab ===
          tab.id
            ? 'bg-edge text-white'
            : 'text-muted hover:text-white'}"
          aria-current={activeTab === tab.id ? "true" : undefined}
          onclick={() => pick(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
  {:else}
    <div class="absolute inset-y-0 right-0 flex flex-col" style="width: {width}px">
      <!-- Horizontal tabs + collapse -->
      <div class="flex items-center border-b border-edge text-xs">
        <button
          class="rounded p-1 text-muted hover:bg-edge hover:text-white"
          use:tooltip={t("sftp.collapsePanel")}
          aria-label={t("sftp.collapsePanel")}
          onclick={() => (collapsed = true)}
        >
          <Icon name="chevronRight" size={16} />
        </button>
        {#each TABS as tab (tab.id)}
          <button
            data-testid={`dock-tab-${tab.id}`}
            class="flex-1 border-b-2 py-1.5 text-center {activeTab === tab.id
              ? 'border-accent text-accent'
              : 'border-transparent text-muted hover:text-white'}"
            aria-current={activeTab === tab.id ? "true" : undefined}
            onclick={() => (activeTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- Active tab content -->
      <div class="min-h-0 flex-1">
        {#if activeTab === "files"}
          {#if kind === "ssh"}
            <SftpPanel
              embedded
              {sessionId}
              {sessionReady}
              {terminalCwd}
              {followTerminal}
              {onToggleFollowTerminal}
              {onOpenFile}
              onUserNavigate={onSftpNavigate}
            />
          {:else}
            <LocalFilePanel
              embedded
              {terminalCwd}
              {followTerminal}
              {onToggleFollowTerminal}
              onOpenFile={onOpenLocalFile}
            />
          {/if}
        {:else if activeTab === "git"}
          <GitPanel
            {sessionId}
            {terminalCwd}
            {followTerminal}
            {onToggleFollowTerminal}
            onOpenDiff={onOpenGitDiff}
            onIgnore={onIgnoreGitignore}
            prod={aiProd}
            sessionReady={kind === "ssh" ? sessionReady : true}
          />
        {:else if activeTab === "docker"}
          <DockerPanel
            {sessionId}
            prod={aiProd}
            sessionReady={kind === "ssh" ? sessionReady : true}
            onOpenShell={onOpenContainerShell}
          />
        {:else if activeTab === "k8s"}
          <K8sPanel
            {sessionId}
            prod={aiProd}
            sessionReady={kind === "ssh" ? sessionReady : true}
            onOpenShell={onOpenContainerShell}
          />
        {:else}
          <AiChat
            getContext={getAiContext}
            {sessionId}
            {chatPromptId}
            {serverExecMode}
            prod={aiProd}
            noAi={aiNoAi}
          />
        {/if}
      </div>
    </div>
  {/if}
</div>
