<script lang="ts">
  // Working-tree sub-tab (Phase 29): staged / unstaged file lists with per-file
  // stage / unstage / discard actions, multi-select discard/stage, "discard all",
  // and the commit box. Grouping is pure (git.ts); mutations go through `run`.
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import type { GitStatus, GitFile } from "./git";
  import {
    stagedFiles,
    unstagedFiles,
    stageArgs,
    unstageArgs,
    discardArgs,
    cleanArgs,
    stageAllArgs,
    unstageAllArgs,
    stashSaveArgs,
    stashPushFileArgs,
    commitArgs,
    stagedDiffArgs,
    pushArgs,
  } from "./git";
  import { writeClipboard } from "./clipboard";
  import { notifySuccess } from "./stores/toasts.svelte";
  import { fileStatusColor } from "./gitview";
  import { t } from "./i18n";
  import { notifyError } from "./stores/toasts.svelte";
  import { settings } from "./settings.svelte";
  import { aiReady, activeEndpoint, resolvePromptContent, defaultPrompt } from "./ai";
  import { buildRawContext, type BuiltContext } from "./aicontext";
  import { generateOnce } from "./stores/aichat.svelte";
  import AiConsentDialog from "./AiConsentDialog.svelte";

  let {
    status,
    busy,
    run,
    onOpenInEditor,
    onOpenReadonlyDiff,
    onIgnore,
    absPath,
    runQuery,
  }: {
    status: GitStatus;
    busy: boolean;
    run: (args: string[], opts?: { destructive?: boolean; successKey?: string }) => Promise<boolean>;
    /** Open a changed file (repo-relative path) as an editable inline diff. */
    onOpenInEditor: (path: string) => void;
    /** Open a read-only unified diff of a file (staged or working-tree). */
    onOpenReadonlyDiff: (path: string, staged: boolean) => void;
    /** Append a pattern to the repo's .gitignore. */
    onIgnore: (pattern: string) => void;
    /** Absolute path of a repo-relative file (for "copy absolute path"). */
    absPath: (path: string) => string;
    /** Read-only git query — used to fetch the staged diff for the AI drafter. */
    runQuery: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  } = $props();

  let message = $state("");

  const staged = $derived(stagedFiles(status.files));
  const unstaged = $derived(unstagedFiles(status.files));
  // Split for the two header actions: restore tracked changes vs delete untracked.
  const trackedUnstaged = $derived(unstaged.filter((f) => f.work !== "?"));
  const untrackedUnstaged = $derived(unstaged.filter((f) => f.work === "?"));
  // ── AI commit-message drafter (Phase 41) ────────────────────────────────────
  // The staged diff already says *what* changed; the model drafts a subject and
  // the *why*. Output lands in the textarea for editing — it is never committed
  // directly.
  const aiOn = $derived(aiReady(settings.ai));
  const draftEndpoint = $derived(activeEndpoint(settings.ai));
  let drafting = $state(false);
  let draftConsent = $state<BuiltContext | null>(null);

  /** Fetch the staged diff, redact it, and open the consent dialog. */
  async function draftMessage() {
    if (drafting || staged.length === 0) return;
    drafting = true;
    try {
      const res = await runQuery(stagedDiffArgs());
      const diff = res.stdout.trim();
      if (!diff) {
        notifyError(t("git.aiNoStaged"));
        return;
      }
      const ctx = buildRawContext(diff, "Staged diff");
      if (!ctx.text) return;
      draftConsent = ctx;
    } catch {
      notifyError(t("git.aiFailed"));
    } finally {
      drafting = false;
    }
  }

  /** Stream the drafted message into the commit box (replacing what is there). */
  async function confirmDraft() {
    const ctx = draftConsent;
    if (!ctx) return;
    draftConsent = null;
    drafting = true;
    message = "";
    await generateOnce({
      system: resolvePromptContent(
        settings.ai.prompts.commit,
        null,
        defaultPrompt("commit"),
      ),
      content: ctx.text,
      settings: settings.ai,
      onToken: (text) => (message += text),
      onDone: () => {
        drafting = false;
        message = message.trim();
      },
      onError: (msg) => {
        drafting = false;
        notifyError(msg);
      },
    });
  }

  const canCommit = $derived(staged.length > 0 && message.trim().length > 0 && !busy);

  // Multi-select over the unstaged list (paths); stale paths drop out of
  // `selFiles` automatically after a reload.
  let selected = $state(new Set<string>());
  const unstagedByPath = $derived(new Map(unstaged.map((f) => [f.path, f])));
  const selFiles = $derived(
    [...selected]
      .map((p) => unstagedByPath.get(p))
      .filter((f): f is GitFile => f !== undefined),
  );

  // Files pending a discard confirmation (bulk actions ask; per-file trash doesn't).
  let pendingDiscard = $state<GitFile[] | null>(null);
  // All-untracked → phrase the dialog as deleting files, not discarding changes.
  const pendingIsDelete = $derived(
    pendingDiscard !== null && pendingDiscard.every((f) => f.work === "?"),
  );

  function statusChar(f: GitFile, isStaged: boolean): string {
    const c = isStaged ? f.index : f.work;
    return c === "?" ? "U" : c;
  }

  function toggle(path: string) {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selected = next;
  }

  /** Restore tracked paths + clean untracked ones, then clear the selection. */
  async function discardFiles(files: GitFile[]) {
    const tracked = files.filter((f) => f.work !== "?").map((f) => f.path);
    const untracked = files.filter((f) => f.work === "?").map((f) => f.path);
    if (tracked.length) await run(discardArgs(tracked), { destructive: true });
    if (untracked.length) await run(cleanArgs(untracked), { destructive: true });
    selected = new Set();
  }

  function askDiscard(files: GitFile[]) {
    if (files.length) pendingDiscard = files;
  }
  async function confirmDiscard() {
    const files = pendingDiscard;
    pendingDiscard = null;
    if (files) await discardFiles(files);
  }

  async function stageSelected() {
    if (selFiles.length) {
      await run(stageArgs(selFiles.map((f) => f.path)));
      selected = new Set();
    }
  }

  // ── File context menu (right-click) ────────────────────────────────────────
  // Declarative items for the shared ContextMenu; closures capture file/staged
  // directly. Prod-protection is unchanged (discard confirms via ConfirmDialog).
  let ctxMenu = $state<OpenMenu | null>(null);

  function openMenu(e: MouseEvent, file: GitFile, isStaged: boolean) {
    e.preventDefault();
    const untracked = file.work === "?";
    const ext = fileExt(file.path);
    const items: MenuItem[] = [
      isStaged
        ? { icon: "minus", label: t("git.unstage"), onSelect: () => run(unstageArgs([file.path])) }
        : { icon: "plus", label: t("git.stage"), onSelect: () => run(stageArgs([file.path])) },
      { icon: "pencil", label: t("git.openFile"), onSelect: () => onOpenInEditor(file.path) },
      {
        icon: "code",
        label: t("git.openDiff"),
        onSelect: () => onOpenReadonlyDiff(file.path, isStaged),
      },
      { kind: "separator" },
    ];
    if (!isStaged) {
      items.push({
        icon: untracked ? "trash" : "history",
        label: untracked ? t("git.deleteFile") : t("git.discard"),
        onSelect: () => discardFiles([file]),
      });
    }
    if (!untracked) {
      items.push({
        icon: "stash",
        label: t("git.stashFile"),
        onSelect: () => run(stashPushFileArgs(file.path), { successKey: "git.stashed" }),
      });
    }
    items.push({ kind: "separator" });
    items.push({ icon: "copy", label: t("git.copyPath"), onSelect: () => copyPath(file.path, false) });
    items.push({
      icon: "copy",
      label: t("git.copyAbsPath"),
      onSelect: () => copyPath(file.path, true),
    });
    items.push({ kind: "separator" });
    items.push({ icon: "eye", label: t("git.ignoreFile"), onSelect: () => onIgnore(`/${file.path}`) });
    if (ext) {
      items.push({
        icon: "eye",
        label: t("git.ignoreExt", { ext }),
        onSelect: () => onIgnore(`*.${ext}`),
      });
    }
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  function fileExt(path: string): string {
    const base = path.split("/").pop() ?? "";
    const i = base.lastIndexOf(".");
    return i > 0 ? base.slice(i + 1) : "";
  }

  async function copyPath(path: string, absolute: boolean) {
    await writeClipboard(absolute ? absPath(path) : path);
    notifySuccess(t("git.copied"));
  }

  async function commit(push: boolean) {
    if (!canCommit) return;
    const ok = await run(commitArgs(message.trim()), { successKey: "git.committed" });
    if (ok) {
      message = "";
      if (push) await run(pushArgs(), { successKey: "git.pushed" });
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col text-xs">
  <div class="min-h-0 flex-1 overflow-auto">
    <!-- Staged -->
    <div class="flex items-center justify-between px-2 py-1 text-caption uppercase tracking-wider text-muted">
      <span>{t("git.staged")} ({staged.length})</span>
      {#if staged.length}
        <button
          class="rounded px-1 hover:bg-edge hover:text-white"
          use:tooltip={t("git.unstageAll")}
          aria-label={t("git.unstageAll")}
          onclick={() => run(unstageAllArgs())}
        >
          <Icon name="minus" size={13} />
        </button>
      {/if}
    </div>
    {#if staged.length === 0}
      <p class="px-2 pb-1 text-caption text-muted">{t("git.nothingStaged")}</p>
    {:else}
      {#each staged as f (f.path)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40" oncontextmenu={(e) => openMenu(e, f, true)}>
          <span class="w-3 shrink-0 text-center font-mono text-caption {fileStatusColor(statusChar(f, true))}">{statusChar(f, true)}</span>
          <button class="min-w-0 flex-1 truncate text-left text-meta text-white/80" onclick={() => onOpenInEditor(f.path)}>{f.path}</button>
          <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-white group-hover:opacity-100" use:tooltip={t("git.openFile")} aria-label={t("git.openFile")} onclick={() => onOpenInEditor(f.path)}>
            <Icon name="pencil" size={12} />
          </button>
          <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-white group-hover:opacity-100" use:tooltip={t("git.unstage")} aria-label={t("git.unstage")} onclick={() => run(unstageArgs([f.path]))}>
            <Icon name="minus" size={13} />
          </button>
        </div>
      {/each}
    {/if}

    <!-- Unstaged -->
    <div class="mt-1 flex items-center justify-between border-t border-edge/40 px-2 py-1 text-caption uppercase tracking-wider text-muted">
      <span>{t("git.changes")} ({unstaged.length})</span>
      {#if unstaged.length}
        <div class="flex items-center">
          {#if trackedUnstaged.length}
            <button
              class="rounded px-1 hover:bg-edge hover:text-danger"
              use:tooltip={t("git.restoreAll")}
              aria-label={t("git.restoreAll")}
              onclick={() => askDiscard(trackedUnstaged)}
            >
              <Icon name="history" size={13} />
            </button>
          {/if}
          {#if untrackedUnstaged.length}
            <button
              class="rounded px-1 hover:bg-edge hover:text-danger"
              use:tooltip={t("git.cleanUntracked")}
              aria-label={t("git.cleanUntracked")}
              onclick={() => askDiscard(untrackedUnstaged)}
            >
              <Icon name="trash" size={12} />
            </button>
          {/if}
          <button
            class="rounded px-1 hover:bg-edge hover:text-white"
            use:tooltip={t("git.stageAll")}
            aria-label={t("git.stageAll")}
            onclick={() => run(stageAllArgs())}
          >
            <Icon name="plus" size={13} />
          </button>
          <button
            class="rounded px-1 hover:bg-edge hover:text-white disabled:opacity-40"
            use:tooltip={t("git.stashSave")}
            aria-label={t("git.stashSave")}
            disabled={busy}
            onclick={() => run(stashSaveArgs(), { successKey: "git.stashed" })}
          >
            <Icon name="stash" size={13} />
          </button>
        </div>
      {/if}
    </div>

    <!-- Selection action bar -->
    {#if selFiles.length}
      <div class="flex items-center gap-1.5 border-b border-edge/40 bg-accent/10 px-2 py-1 text-caption text-white/80">
        <span class="flex-1">{t("git.selectedN", { count: selFiles.length })}</span>
        <button class="rounded px-1 text-muted hover:bg-edge hover:text-danger" use:tooltip={t("git.discardSelected")} aria-label={t("git.discardSelected")} onclick={() => askDiscard(selFiles)}>
          <Icon name="trash" size={12} />
        </button>
        <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.stageSelected")} aria-label={t("git.stageSelected")} onclick={stageSelected}>
          <Icon name="plus" size={13} />
        </button>
        <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.clearSelection")} aria-label={t("git.clearSelection")} onclick={() => (selected = new Set())}>
          <Icon name="close" size={12} />
        </button>
      </div>
    {/if}

    {#if unstaged.length === 0}
      <p class="px-2 pb-1 text-caption text-muted">{t("git.clean")}</p>
    {:else}
      {#each unstaged as f (f.path)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40 {selected.has(f.path) ? 'bg-accent/10' : ''}" oncontextmenu={(e) => openMenu(e, f, false)}>
          <input type="checkbox" class="shrink-0 accent-accent" checked={selected.has(f.path)} onchange={() => toggle(f.path)} aria-label={t("git.select")} />
          <span class="w-3 shrink-0 text-center font-mono text-caption {fileStatusColor(statusChar(f, false))}">{statusChar(f, false)}</span>
          <button class="min-w-0 flex-1 truncate text-left text-meta text-white/80" onclick={() => onOpenInEditor(f.path)}>{f.path}</button>
          <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-white group-hover:opacity-100" use:tooltip={t("git.openFile")} aria-label={t("git.openFile")} onclick={() => onOpenInEditor(f.path)}>
            <Icon name="pencil" size={12} />
          </button>
          <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-danger group-hover:opacity-100" use:tooltip={f.work === "?" ? t("git.deleteFile") : t("git.discard")} aria-label={f.work === "?" ? t("git.deleteFile") : t("git.discard")} onclick={() => discardFiles([f])}>
            <Icon name={f.work === "?" ? "trash" : "history"} size={f.work === "?" ? 12 : 13} />
          </button>
          <button class="shrink-0 rounded px-1 text-muted opacity-0 hover:bg-edge hover:text-white group-hover:opacity-100" use:tooltip={t("git.stage")} aria-label={t("git.stage")} onclick={() => run(stageArgs([f.path]))}>
            <Icon name="plus" size={13} />
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Commit box -->
  <div class="border-t border-edge p-2">
    <div class="relative">
      <textarea
        bind:value={message}
        rows="2"
        placeholder={t("git.commitPlaceholder")}
        class="w-full resize-none rounded border border-edge bg-panel px-2 py-1 pr-7 text-meta text-white placeholder:text-muted focus:border-accent focus:outline-none"
      ></textarea>
      {#if aiOn}
        <button
          data-testid="git-ai-message"
          class="absolute right-1 top-1 rounded p-0.5 text-muted hover:text-accent disabled:opacity-40"
          use:tooltip={t("git.aiMessage")}
          aria-label={t("git.aiMessage")}
          disabled={busy || drafting || staged.length === 0}
          onclick={draftMessage}
        >
          <Icon name="aiMark" size={13} class={drafting ? "animate-pulse" : ""} />
        </button>
      {/if}
    </div>
    <div class="mt-1.5 flex gap-1.5">
      <button
        class="flex flex-1 items-center justify-center gap-1 rounded bg-accent px-2 py-1 text-meta font-medium text-panel-alt hover:bg-accent-hover disabled:opacity-40"
        disabled={!canCommit}
        onclick={() => commit(false)}
      >
        <Icon name="gitCommit" size={13} />
        {t("git.commit")}
      </button>
      <button
        class="flex items-center justify-center gap-1 rounded border border-edge px-2 py-1 text-meta text-muted hover:bg-edge hover:text-white disabled:opacity-40"
        use:tooltip={t("git.commitAndPush")}
        aria-label={t("git.commitAndPush")}
        disabled={!canCommit}
        onclick={() => commit(true)}
      >
        <Icon name="upload" size={13} />
      </button>
    </div>
  </div>
</div>

<ConfirmDialog
  open={pendingDiscard !== null}
  title={pendingIsDelete ? t("git.deleteTitle") : t("git.discardTitle")}
  confirmLabel={pendingIsDelete ? t("common.delete") : t("git.discard")}
  onconfirm={confirmDiscard}
  oncancel={() => (pendingDiscard = null)}
>
  {pendingIsDelete
    ? t("git.deleteBody", { count: pendingDiscard?.length ?? 0 })
    : t("git.discardBody", { count: pendingDiscard?.length ?? 0 })}
</ConfirmDialog>

<ContextMenu menu={ctxMenu} onclose={() => (ctxMenu = null)} />

{#if draftConsent && draftEndpoint}
  <!-- The staged diff is session context like any other: redacted, previewed and
       confirmed before it leaves the machine. -->
  <AiConsentDialog
    open
    context={draftConsent}
    endpointName={draftEndpoint.name}
    endpointUrl={draftEndpoint.baseUrl}
    onconfirm={confirmDraft}
    oncancel={() => (draftConsent = null)}
  />
{/if}
