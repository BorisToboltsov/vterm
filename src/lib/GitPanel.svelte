<script lang="ts">
  // Git panel (Phase 29) — third right-dock tab. Orchestrates the repo view for
  // the terminal's current path (`terminalCwd`, OSC 7): a toolbar (repo, branch,
  // ahead/behind, fetch/pull/push, stash) over three sub-tabs — Graph, Changes,
  // Branches. Works on SSH and local tabs alike; the backend `git_run` dispatches
  // by session kind. All git logic is pure (`git.ts`); this owns data + actions.
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import { tooltip } from "./actions/tooltip";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import EmptyState from "./EmptyState.svelte";
  import GitGraph from "./GitGraph.svelte";
  import GitChanges from "./GitChanges.svelte";
  import GitBranches from "./GitBranches.svelte";
  import GitDiffView from "./GitDiffView.svelte";
  import { fileStatusColor } from "./gitview";
  import { gitRun, writeToTerminal } from "./api";
  import { submitLine } from "./terminput";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import {
    repoRootArgs,
    statusArgs,
    logArgs,
    branchesArgs,
    stashListArgs,
    fetchArgs,
    pullArgs,
    pushArgs,
    stashSaveArgs,
    discardFileArgs,
    discardAllArgs,
    showFileAtArgs,
    diffFileArgs,
    parseDiff,
    parseStatus,
    parseLog,
    parseBranches,
    parseStashes,
    buildGraph,
    isDestructive,
    isUncommittedChangesError,
    isRemoteConnectionError,
    parseSyncResult,
    type GitStatus,
    type GitFile,
    type GraphRow,
    type GitBranch,
    type GitStashEntry,
    type DiffLine,
  } from "./git";
  import { rememberSub, storedSub } from "./stores/dockstate.svelte";
  import { untrack } from "svelte";
  import { t } from "./i18n";

  let {
    sessionId,
    terminalCwd = null,
    followTerminal = false,
    onToggleFollowTerminal,
    onOpenDiff,
    onIgnore,
    prod = false,
    sessionReady = true,
    visible = true,
  }: {
    sessionId: string;
    terminalCwd?: string | null;
    followTerminal?: boolean;
    /**
     * The dock is showing this tab. The panel stays mounted behind another tab
     * (v1.0.14), and a hidden one must not re-run `git status` on every `cd` the
     * terminal reports — it reloads once when it comes back into view.
     */
    visible?: boolean;
    onToggleFollowTerminal?: () => void;
    /**
     * Open a changed file in the editor as an editable inline diff against HEAD.
     * `absPath` is the file's absolute path; `gitBase` is its HEAD content.
     */
    onOpenDiff?: (absPath: string, gitBase: string) => void;
    /** Append a pattern to the repo's `.gitignore` (absolute path + pattern). */
    onIgnore?: (gitignorePath: string, pattern: string) => void;
    /** Active tab is a prod-tagged server — destructive git ops need confirmation. */
    prod?: boolean;
    /** SSH tab is connected (local tabs are always ready). */
    sessionReady?: boolean;
  } = $props();

  type Sub = "graph" | "changes" | "branches";
  let activeSub = $state<Sub>(untrack(() => storedSub<Sub>(sessionId, "git", "changes")));
  let sendToTerminal = $state(false);

  let cwd = $derived(terminalCwd);
  let repoRoot = $state<string | null>(null);
  let isRepo = $state<boolean | null>(null); // null = unknown/not loaded yet
  let loading = $state(false);
  let busy = $state(false);

  let status = $state<GitStatus | null>(null);
  let rows = $state<GraphRow[]>([]);
  let branches = $state<GitBranch[]>([]);
  let stashes = $state<GitStashEntry[]>([]);

  // Network-op (fetch/pull/push) status strip + persistent remote-error badge.
  type SyncKind = "pull" | "push" | "fetch";
  let syncOp = $state<{ kind: SyncKind; running: boolean; message: string } | null>(null);
  let remoteError = $state<string | null>(null);
  let syncClearTimer: ReturnType<typeof setTimeout> | undefined;

  // Diff modal.
  let diffOpen = $state(false);
  let diffTitle = $state("");
  let diffLines = $state<DiffLine[]>([]);

  // Confirm dialog (prod destructive gate) — a pending resolver pattern.
  let confirmOpen = $state(false);
  let confirmText = $state("");
  let confirmResolve: ((ok: boolean) => void) | null = null;

  function askConfirm(text: string): Promise<boolean> {
    confirmText = text;
    confirmOpen = true;
    return new Promise((resolve) => (confirmResolve = resolve));
  }
  function settleConfirm(ok: boolean) {
    confirmOpen = false;
    confirmResolve?.(ok);
    confirmResolve = null;
  }

  // Uncommitted-changes dialog: the op the user tried when the working tree was
  // dirty (kept so we can retry it after stashing / discarding). The dialog lists
  // the changed files with per-file discard / open and whole-tree stash / discard.
  let dirtyArgs = $state<string[] | null>(null);
  const dirtyFiles = $derived(status?.files ?? []);

  function closeDirty() {
    dirtyArgs = null;
  }

  /** Run the pending op now (tree is expected clean) and report. */
  async function retryPending(successKey: string) {
    const args = dirtyArgs;
    dirtyArgs = null;
    if (args && (await run(args))) notifySuccess(t(successKey as Parameters<typeof t>[0]));
  }

  async function stashAndRetry() {
    if (await run(stashSaveArgs())) await retryPending("git.stashedAndSwitched");
    else closeDirty();
  }

  async function discardAllAndRetry() {
    if (await run(discardAllArgs(), { destructive: true })) await retryPending("git.switched");
    else closeDirty();
  }

  /** Discard one file; if the tree is now clean, switch automatically. */
  async function discardOne(file: GitFile) {
    if (!(await run(discardFileArgs(file), { destructive: true }))) return;
    if ((status?.files.length ?? 0) === 0) await retryPending("git.switched");
  }

  function openDirtyFile(file: GitFile) {
    void openInEditor(file.path);
    closeDirty();
  }

  const repoName = $derived(repoRoot ? repoRoot.split("/").filter(Boolean).pop() ?? repoRoot : "");
  const branchName = $derived(status?.branch ?? null);

  /** Read-only git call — no reload. Returns captured output. */
  async function runQuery(args: string[]) {
    if (!cwd) return { stdout: "", stderr: "no cwd", exitCode: -1 };
    return gitRun(sessionId, cwd, args);
  }

  /** Mutating git call: prod-confirm, optional terminal echo, then reload. */
  async function run(
    args: string[],
    opts: { destructive?: boolean; echo?: boolean; successKey?: string } = {},
  ): Promise<boolean> {
    if (!cwd || busy) return false;
    if (prod && (opts.destructive || isDestructive(args))) {
      const ok = await askConfirm(`git ${args.join(" ")}`);
      if (!ok) return false;
    }
    busy = true;
    try {
      if (opts.echo && sendToTerminal) {
        // Run it in the user's shell so it's visible in scrollback (audit), then
        // reload once the shell has had a moment to apply it.
        await writeToTerminal(sessionId, new TextEncoder().encode(submitLine(`git ${args.join(" ")}`)));
        setTimeout(() => void loadAll(), 700);
        return true;
      }
      // Mutations can touch the working tree / network (checkout runs filters,
      // pull/push/fetch hit the remote) — allow more time than read-only loads.
      // `mirror: true` audits the op into the active recording (not the terminal).
      const res = await gitRun(sessionId, cwd, args, 120, true);
      if (res.exitCode !== 0) {
        // Blocked by uncommitted changes → explain it and offer stash + retry
        // instead of surfacing git's raw multi-line English abort.
        if (isUncommittedChangesError(res.stderr)) {
          dirtyArgs = args;
          return false;
        }
        notifyError(res.stderr.trim() || res.stdout.trim() || t("git.opFailed"));
        await loadAll();
        return false;
      }
      if (opts.successKey) notifySuccess(t(opts.successKey as Parameters<typeof t>[0]));
      await loadAll();
      return true;
    } catch (e) {
      notifyError(String(e));
      return false;
    } finally {
      busy = false;
    }
  }

  function runningLabel(kind: SyncKind): string {
    return kind === "push"
      ? t("git.pushRunning")
      : kind === "pull"
        ? t("git.pullRunning")
        : t("git.fetchRunning");
  }
  function doneMessage(kind: SyncKind, res: ReturnType<typeof parseSyncResult>): string {
    const base = kind === "push" ? t("git.pushed") : kind === "pull" ? t("git.pulled") : t("git.fetched");
    if (res.upToDate) return `${base} · ${t("git.upToDate")}`;
    return res.range ? `${base}: ${res.range}` : base;
  }

  /**
   * Run a network op (fetch/pull/push) with a status strip and a persistent
   * remote-error badge. Unreachable/auth failures set `remoteError` (triangle on
   * the buttons); a dirty-tree pull opens the stash dialog; other errors toast.
   */
  async function syncRun(kind: SyncKind, args: string[]) {
    if (!cwd || busy) return;
    clearTimeout(syncClearTimer);
    remoteError = null;
    syncOp = { kind, running: true, message: runningLabel(kind) };
    busy = true;
    try {
      const res = await gitRun(sessionId, cwd, args, 120, true);
      if (res.exitCode !== 0) {
        const err = res.stderr.trim() || res.stdout.trim();
        syncOp = null;
        if (isRemoteConnectionError(err)) remoteError = err;
        else if (isUncommittedChangesError(err)) dirtyArgs = args;
        else notifyError(err || t("git.opFailed"));
        await loadAll();
        return;
      }
      syncOp = {
        kind,
        running: false,
        message: doneMessage(kind, parseSyncResult(`${res.stdout}\n${res.stderr}`)),
      };
      syncClearTimer = setTimeout(() => {
        if (syncOp && !syncOp.running) syncOp = null;
      }, 4000);
      await loadAll();
    } catch (e) {
      syncOp = null;
      notifyError(String(e));
    } finally {
      busy = false;
    }
  }

  function openDiff(title: string, lines: DiffLine[]) {
    diffTitle = title;
    diffLines = lines;
    diffOpen = true;
  }

  /**
   * Open a changed file (repo-relative path) in the editor as an editable inline
   * diff against its HEAD version. Used by the Changes tab and the dirty dialog.
   */
  async function openInEditor(relPath: string) {
    if (!onOpenDiff || !repoRoot) return;
    const base = await runQuery(showFileAtArgs("HEAD", relPath));
    const gitBase = base.exitCode === 0 ? base.stdout : "";
    const sep = repoRoot.endsWith("/") ? "" : "/";
    onOpenDiff(`${repoRoot}${sep}${relPath}`, gitBase);
  }

  /** Read-only unified diff of a working-tree file (staged or not). */
  async function openReadonlyDiff(relPath: string, staged: boolean) {
    const res = await runQuery(diffFileArgs(relPath, staged));
    openDiff(relPath, parseDiff(res.stdout));
  }

  /** Append a pattern to the repo's .gitignore (delegated to the page's file IO). */
  function ignoreInRepo(pattern: string) {
    if (!onIgnore || !repoRoot) return;
    const sep = repoRoot.endsWith("/") ? "" : "/";
    onIgnore(`${repoRoot}${sep}.gitignore`, pattern);
  }

  /** Absolute path of a repo-relative file (for "copy absolute path"). */
  function absPath(relPath: string): string {
    if (!repoRoot) return relPath;
    const sep = repoRoot.endsWith("/") ? "" : "/";
    return `${repoRoot}${sep}${relPath}`;
  }

  /** Load repo state for the current cwd (all local/cheap — no network). */
  async function loadAll() {
    if (!cwd || (!sessionReady && isRepo === null)) return;
    loading = true;
    try {
      const root = await gitRun(sessionId, cwd, repoRootArgs());
      if (root.exitCode !== 0) {
        isRepo = false;
        repoRoot = null;
        status = null;
        rows = [];
        branches = [];
        stashes = [];
        return;
      }
      isRepo = true;
      repoRoot = root.stdout.trim();
      const [st, log, br, stash] = await Promise.all([
        gitRun(sessionId, cwd, statusArgs()),
        gitRun(sessionId, cwd, logArgs()),
        gitRun(sessionId, cwd, branchesArgs()),
        gitRun(sessionId, cwd, stashListArgs()),
      ]);
      status = parseStatus(st.stdout);
      rows = buildGraph(parseLog(log.stdout));
      branches = parseBranches(br.stdout);
      stashes = parseStashes(stash.stdout);
    } catch (e) {
      notifyError(String(e));
    } finally {
      loading = false;
    }
  }

  // Reload when the terminal cwd changes, and once when the tab comes back into
  // view — a `cd` that happened while the panel was hidden still has to land, and
  // the reload also covers a commit made in the terminal without moving. Network
  // ops (fetch/pull/push) stay manual.
  $effect(() => {
    void cwd;
    void sessionReady;
    void visible;
    if (cwd && sessionReady && visible) void loadAll();
  });

  // Remember the sub-tab for the next mount of this session's panel. Untracked
  // write: creating this session's entry touches the state the call reads.
  $effect(() => {
    const sub = activeSub;
    untrack(() => rememberSub(sessionId, "git", sub));
  });

  const changeCount = $derived(status ? status.files.length : 0);
  const SUBS: { id: Sub; label: string }[] = [
    { id: "graph", label: t("git.graph") },
    { id: "changes", label: t("git.changes") },
    { id: "branches", label: t("git.branches") },
  ];
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  {#if !cwd}
    <EmptyState icon="gitBranch" title={t("git.noPath")} hint={t("git.noPathHint")}>
      {#if onToggleFollowTerminal}
        <button
          class="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-panel-alt hover:bg-accent-hover"
          onclick={onToggleFollowTerminal}
        >
          <Icon name="terminal" size={14} />
          {t("git.enablePathSync")}
        </button>
      {/if}
    </EmptyState>
  {:else if isRepo === false}
    <EmptyState icon="gitBranch" title={t("git.notRepo")} hint={cwd} />
  {:else}
    <!-- Toolbar: name · pull · push · refresh · fetch · follow (single row) -->
    <div class="flex items-center gap-0.5 border-b border-edge px-2 py-1.5">
      <Icon name="gitBranch" size={15} />
      <div class="min-w-0 flex-1 px-1">
        <div class="truncate font-medium text-text/90" use:tooltip={repoRoot ?? ""}>{repoName}</div>
        {#if branchName}
          <div class="truncate text-caption text-muted">
            {branchName}{#if status && (status.ahead || status.behind)}
              <span class="text-accent"> ↑{status.ahead} ↓{status.behind}</span>
            {/if}
          </div>
        {/if}
      </div>
      <button class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("git.pull")} aria-label={t("git.pull")} onclick={() => syncRun("pull", pullArgs())}>
        <Icon name="download" size={15} />
        {#if remoteError}<span use:tooltip={remoteError} class="text-warn"><Icon name="alert" size={11} /></span>{/if}
      </button>
      <button class="flex items-center rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("git.push")} aria-label={t("git.push")} onclick={() => syncRun("push", pushArgs())}>
        <Icon name="upload" size={15} />
        {#if remoteError}<span use:tooltip={remoteError} class="text-warn"><Icon name="alert" size={11} /></span>{/if}
      </button>
      <button class="rounded p-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.refresh")} aria-label={t("git.refresh")} onclick={() => loadAll()}>
        <Icon name="refresh" size={14} />
      </button>
      <button class="rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40" disabled={busy} use:tooltip={t("git.fetch")} aria-label={t("git.fetch")} onclick={() => syncRun("fetch", fetchArgs())}>
        <Icon name="cloud" size={13} />
      </button>
      {#if onToggleFollowTerminal}
        <button class="rounded p-1 hover:bg-edge hover:text-text {followTerminal ? 'text-accent' : 'text-muted'}" use:tooltip={t("sftp.followTerminal")} aria-label={t("sftp.followTerminal")} onclick={onToggleFollowTerminal}>
          <Icon name="terminal" size={13} />
        </button>
      {/if}
    </div>

    <!-- Sync status strip (Phase 29): indeterminate progress while a network op
         runs, then a transient result summary. -->
    {#if syncOp}
      {#if syncOp.running}
        <div class="h-0.5 overflow-hidden bg-edge">
          <div class="git-indet h-full w-2/5 bg-accent"></div>
        </div>
      {/if}
      <div class="flex items-center gap-2 border-b border-edge px-2 py-1 text-meta text-text/80">
        {#if syncOp.running}
          <span class="git-spin inline-block h-3 w-3 shrink-0 rounded-full border-2 border-edge" style="border-top-color: var(--color-accent)"></span>
        {:else}
          <Icon name="check" size={13} class="shrink-0 text-ok" />
        {/if}
        <span class="truncate">{syncOp.message}</span>
      </div>
    {/if}

    <!-- Sub-tabs -->
    <div class="flex border-b border-edge text-meta">
      {#each SUBS as s (s.id)}
        <button
          data-testid={`git-subtab-${s.id}`}
          class="flex flex-1 items-center justify-center gap-1 border-b-2 py-1.5 {activeSub === s.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}"
          aria-current={activeSub === s.id ? "true" : undefined}
          onclick={() => (activeSub = s.id)}
        >
          {s.label}
          {#if s.id === "changes" && changeCount}
            <span class="rounded-full bg-warn/20 px-1.5 text-caption text-warn">{changeCount}</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Active sub-view -->
    <div class="min-h-0 flex-1">
      {#if activeSub === "graph"}
        <GitGraph {rows} {run} {runQuery} {openDiff} />
      {:else if activeSub === "changes"}
        {#if status}
          <GitChanges
            {status}
            {busy}
            {run}
            onOpenInEditor={openInEditor}
            onOpenReadonlyDiff={openReadonlyDiff}
            onIgnore={ignoreInRepo}
            {absPath}
            {runQuery}
          />
        {/if}
      {:else}
        <GitBranches {branches} {stashes} bind:sendToTerminal {run} {runQuery} {openDiff} />
      {/if}
    </div>
  {/if}
</div>

<GitDiffView open={diffOpen} title={diffTitle} lines={diffLines} onclose={() => (diffOpen = false)} />

<ConfirmDialog
  open={confirmOpen}
  title={t("git.confirmProdTitle")}
  confirmLabel={t("common.ok")}
  onconfirm={() => settleConfirm(true)}
  oncancel={() => settleConfirm(false)}
>
  {t("git.confirmProdBody")}
  <code class="mt-1 block break-all rounded bg-panel px-1 py-0.5 text-text/80">{confirmText}</code>
</ConfirmDialog>

<Modal
  open={dirtyArgs !== null}
  title={t("git.dirtyTitle")}
  onclose={closeDirty}
  showClose
  width="w-[26rem] max-w-[92vw]"
>
  <p class="mb-2 text-xs text-muted">{t("git.dirtyBody")}</p>
  <div class="mb-3 max-h-56 overflow-auto rounded border border-edge">
    {#each dirtyFiles as f (f.path)}
      <div class="group flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-edge/40">
        <span class="w-3 shrink-0 text-center font-mono text-caption {fileStatusColor(f.index === '.' ? f.work : f.index)}">{f.index === "." ? f.work : f.index}</span>
        <span class="min-w-0 flex-1 truncate text-text/80" use:tooltip={f.path}>{f.path}</span>
        {#if onOpenDiff}
          <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-text group-hover:opacity-100" use:tooltip={t("git.openFile")} aria-label={t("git.openFile")} onclick={() => openDirtyFile(f)}>
            <Icon name="pencil" size={12} />
          </button>
        {/if}
        <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-text group-hover:opacity-100" use:tooltip={t("git.discardFile")} aria-label={t("git.discardFile")} onclick={() => discardOne(f)}>
          <Icon name="trash" size={12} />
        </button>
      </div>
    {/each}
  </div>
  <div class="flex flex-wrap justify-end gap-2">
    <button class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={closeDirty}>{t("common.cancel")}</button>
    <button class="rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger hover:text-panel-alt" onclick={discardAllAndRetry}>{t("git.discardAllAndSwitch")}</button>
    <button class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover" onclick={stashAndRetry}>{t("git.stashAndSwitch")}</button>
  </div>
</Modal>

<style>
  /* Sync status strip: cheap transform-only animations, disabled under
     prefers-reduced-motion (global motion guard, Phase 27/28). */
  .git-indet {
    animation: git-slide 1.1s ease-in-out infinite;
  }
  .git-spin {
    animation: git-spin-kf 0.8s linear infinite;
  }
  @keyframes git-slide {
    0% {
      transform: translateX(-120%);
    }
    100% {
      transform: translateX(320%);
    }
  }
  @keyframes git-spin-kf {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .git-indet {
      animation: none;
      width: 100%;
    }
    .git-spin {
      animation: none;
    }
  }
</style>
