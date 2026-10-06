<script lang="ts">
  // One session tool panel inside a dock (v1.1): files / git / Docker / k8s / AI.
  // The dock (Dock.svelte) owns the chrome and decides which panel is on screen;
  // this component only picks the panel for an id and wires it to the session.
  // The content panels are rendered embedded (content-only).
  //
  // A panel never learns which dock it is in. Left, right or bottom, it gets the
  // same props and adapts to the space it actually has (container queries) — a
  // second "horizontal" copy of each panel is exactly what this avoids
  // (`docklayout.guard`).
  import type { PanelId } from "./docklayout";
  import SftpPanel from "./SftpPanel.svelte";
  import LocalFilePanel from "./LocalFilePanel.svelte";
  import AiChat from "./AiChat.svelte";
  import GitPanel from "./GitPanel.svelte";
  import DockerPanel from "./DockerPanel.svelte";
  import K8sPanel from "./K8sPanel.svelte";
  import type { RawContext } from "./aicontext";
  import type { PromptVars } from "./aicore";
  import type { AiExecMode } from "./ai";
  import type { DockConnection } from "./stores/tabs.svelte";
  import type { AttachTarget } from "./tabattach";

  let {
    id,
    visible,
    kind,
    sessionId,
    chatPromptId = null,
    serverExecMode = null,
    connection = "offline",
    terminalCwd = null,
    followTerminal = false,
    onToggleFollowTerminal,
    onEnablePathSync,
    onOpenFile,
    onOpenLocalFile,
    onOpenGitDiff,
    onIgnoreGitignore,
    onSftpNavigate,
    onOpenContainerShell,
    onAskAi,
    getAiContext,
    aiSelectionLines = 0,
    aiRecording = false,
    promptVars = {},
    aiProd = false,
    aiNoAi = false,
  }: {
    /** Which session panel to render (the server tree is not one of them). */
    id: Exclude<PanelId, "servers">;
    /** On screen right now: the dock is open on this panel and the session is live.
     *  A hidden panel stays mounted but must not poll (`dockpanels.guard`). */
    visible: boolean;
    kind: "ssh" | "local";
    sessionId: string;
    /** The active server's chosen chat prompt id (server-scoped AI persona). */
    chatPromptId?: string | null;
    /** Per-server execution-mode override, or null to use the global setting. */
    serverExecMode?: AiExecMode | null;
    /** State of the tab's session (`dockConnection`): the panels only run while
     *  it is connected. */
    connection?: DockConnection;
    /** Terminal cwd (OSC 7 / OS poll) — the file panel follows it when on, git when off. */
    terminalCwd?: string | null;
    /** Whether the file panel should follow the terminal's cwd (per-tab toggle). */
    followTerminal?: boolean;
    onToggleFollowTerminal?: () => void;
    /** Git's "enable path sync": shell cwd reporting without two-way following. */
    onEnablePathSync?: () => void;
    onOpenFile?: (path: string, name: string, gotoLine?: number) => void;
    onOpenLocalFile?: (path: string) => void;
    /** Open a git-changed file as an editable inline diff (absolute path + HEAD base). */
    onOpenGitDiff?: (absPath: string, gitBase: string) => void;
    /** Append a pattern to the repo's `.gitignore` (absolute path + pattern). */
    onIgnoreGitignore?: (gitignorePath: string, pattern: string) => void;
    /** User navigated in the SFTP panel → cd the terminal too (two-way OSC 7). */
    onSftpNavigate?: (path: string) => void;
    /** Docker panel → open a real terminal tab running an `exec` shell command. */
    onOpenContainerShell?: (argv: string[], target?: AttachTarget) => void;
    /** Hand a container/pod's state + logs to the AI assistant (Phase 41). */
    onAskAi?: (context: string, kind: "container" | "pod") => void;
    /** Reads live session context for the AI tab (selection/buffer/recording/metadata). */
    getAiContext?: () => Promise<RawContext> | RawContext;
    /** Lines selected in this session's terminal (0 = none) — for the AI caption. */
    aiSelectionLines?: number;
    /** This session is being recorded — the AI recording tier has something to add. */
    aiRecording?: boolean;
    /** Values for `{os}`/`{host}`/… placeholders in the user's AI prompt (Phase 41). */
    promptVars?: PromptVars;
    /** The active server is prod-flagged — bars AI auto-execution (17.4). */
    aiProd?: boolean;
    /** The active server is `noAi`-flagged — blocks AI context + execution (17.7). */
    aiNoAi?: boolean;
  } = $props();

  const sessionReady = $derived(connection === "connected");
</script>

{#if id === "files"}
  {#if kind === "ssh"}
    <SftpPanel
      embedded
      {sessionId}
      {sessionReady}
      {terminalCwd}
      {followTerminal}
      {visible}
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
      {visible}
      {onToggleFollowTerminal}
      onOpenFile={onOpenLocalFile}
      onUserNavigate={onSftpNavigate}
    />
  {/if}
{:else if id === "git"}
  <GitPanel
    {sessionId}
    {terminalCwd}
    {followTerminal}
    {visible}
    {onToggleFollowTerminal}
    {onEnablePathSync}
    onOpenDiff={onOpenGitDiff}
    onIgnore={onIgnoreGitignore}
    prod={aiProd}
    {sessionReady}
  />
{:else if id === "docker"}
  <DockerPanel
    {sessionId}
    prod={aiProd}
    {visible}
    {sessionReady}
    onOpenShell={onOpenContainerShell}
    onAsk={onAskAi ? (ctx) => onAskAi(ctx, "container") : undefined}
  />
{:else if id === "k8s"}
  <K8sPanel
    {sessionId}
    prod={aiProd}
    {visible}
    {sessionReady}
    onOpenShell={onOpenContainerShell}
    onAsk={onAskAi ? (ctx) => onAskAi(ctx, "pod") : undefined}
  />
{:else if id === "ai"}
  <AiChat
    getContext={getAiContext}
    {sessionId}
    {chatPromptId}
    {serverExecMode}
    prod={aiProd}
    noAi={aiNoAi}
    isLocal={kind === "local"}
    {promptVars}
    selectionLines={aiSelectionLines}
    hasRecording={aiRecording}
  />
{/if}
