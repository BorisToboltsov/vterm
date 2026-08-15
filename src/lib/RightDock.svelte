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
  import type { PromptVars } from "./aicore";
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
    onAskAi,
    getAiContext,
    promptVars = {},
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
    /** Hand a container/pod's state + logs to the AI assistant (Phase 41). */
    onAskAi?: (context: string, kind: "container" | "pod") => void;
    /** Reads live session context for the AI tab (selection/buffer/recording/metadata). */
    getAiContext?: () => Promise<RawContext> | RawContext;
    /** Values for `{os}`/`{host}`/… placeholders in the user's AI prompt (Phase 41). */
    promptVars?: PromptVars;
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

  // Which panels exist in the DOM. A tab is mounted on its first visit and then
  // kept — switching tabs only hides it (v1.0.14). Destroying the panel threw
  // away everything it held: the SFTP panel came back asking to connect again
  // (the channel was never closed), the file panel jumped to home, the k8s panel
  // forgot the picked context/namespace, and Docker re-probed the daemon from
  // scratch on every flip. Lazy so a tab the user never opens costs nothing.
  //
  // Hidden panels must not keep polling — that is what the `visible` prop below
  // is for, and `dockpanels.guard.test.ts` keeps the two halves together.
  let mounted = $state<DockTab[]>([activeTab]);
  $effect(() => {
    if (!mounted.includes(activeTab)) mounted.push(activeTab);
  });
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
        class="rounded p-1 text-muted hover:bg-edge hover:text-text"
        use:tooltip={t("sftp.expandPanel")}
        aria-label={t("sftp.expandPanel")}
        onclick={() => (collapsed = false)}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
      {#each TABS as tab (tab.id)}
        <!-- `text-meta` (11px), not the `text-caption` every other uppercase label
             uses (Phase 44): this is an interactive tab label, not a caption, and
             it is set vertically — rotated glyphs at 10px are markedly harder to
             read. Deliberate exception; don't "unify" it away. -->
        <button
          data-testid={`dock-vtab-${tab.id}`}
          class="rounded px-1 py-1.5 text-meta uppercase tracking-wider [writing-mode:vertical-rl] {activeTab ===
          tab.id
            ? 'bg-edge text-text'
            : 'text-muted hover:text-text'}"
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
          class="rounded p-1 text-muted hover:bg-edge hover:text-text"
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
              : 'border-transparent text-muted hover:text-text'}"
            aria-current={activeTab === tab.id ? "true" : undefined}
            onclick={() => (activeTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- Tab content. Every visited panel stays in the DOM; the inactive ones are
           hidden, not destroyed (see `mounted` above). The fade that used to ride
           the `{#key}` remount is now the `vt-dock-pane` CSS animation, which the
           reduced-motion guard in app.css covers. -->
      {#if mounted.includes("files")}
        <div class="min-h-0 flex-1 {activeTab === 'files' ? 'vt-dock-pane' : 'hidden'}">
          {#if kind === "ssh"}
            <SftpPanel
              embedded
              {sessionId}
              {sessionReady}
              {terminalCwd}
              {followTerminal}
              visible={activeTab === "files"}
              {onToggleFollowTerminal}
              {onOpenFile}
              onUserNavigate={onSftpNavigate}
            />
          {:else}
            <LocalFilePanel
              embedded
              {sessionId}
              {terminalCwd}
              {followTerminal}
              visible={activeTab === "files"}
              {onToggleFollowTerminal}
              onOpenFile={onOpenLocalFile}
              onUserNavigate={onSftpNavigate}
            />
          {/if}
        </div>
      {/if}
      {#if mounted.includes("git")}
        <div class="min-h-0 flex-1 {activeTab === 'git' ? 'vt-dock-pane' : 'hidden'}">
          <GitPanel
            {sessionId}
            {terminalCwd}
            {followTerminal}
            visible={activeTab === "git"}
            {onToggleFollowTerminal}
            onOpenDiff={onOpenGitDiff}
            onIgnore={onIgnoreGitignore}
            prod={aiProd}
            sessionReady={kind === "ssh" ? sessionReady : true}
          />
        </div>
      {/if}
      {#if mounted.includes("docker")}
        <div class="min-h-0 flex-1 {activeTab === 'docker' ? 'vt-dock-pane' : 'hidden'}">
          <DockerPanel
            {sessionId}
            prod={aiProd}
            visible={activeTab === "docker"}
            sessionReady={kind === "ssh" ? sessionReady : true}
            onOpenShell={onOpenContainerShell}
            onAsk={onAskAi ? (ctx) => onAskAi(ctx, "container") : undefined}
          />
        </div>
      {/if}
      {#if mounted.includes("k8s")}
        <div class="min-h-0 flex-1 {activeTab === 'k8s' ? 'vt-dock-pane' : 'hidden'}">
          <K8sPanel
            {sessionId}
            prod={aiProd}
            visible={activeTab === "k8s"}
            sessionReady={kind === "ssh" ? sessionReady : true}
            onOpenShell={onOpenContainerShell}
            onAsk={onAskAi ? (ctx) => onAskAi(ctx, "pod") : undefined}
          />
        </div>
      {/if}
      {#if mounted.includes("ai")}
        <div class="min-h-0 flex-1 {activeTab === 'ai' ? 'vt-dock-pane' : 'hidden'}">
          <AiChat
            getContext={getAiContext}
            {sessionId}
            {chatPromptId}
            {serverExecMode}
            prod={aiProd}
            noAi={aiNoAi}
            isLocal={kind === "local"}
            {promptVars}
          />
        </div>
      {/if}
    </div>
  {/if}
</div>
