<script lang="ts">
  // Branches sub-tab (Phase 29): local + remote branches and stashes, with
  // checkout / create / rename / delete / merge and stash apply/pop/drop. All
  // mutations flow through the panel's `run`; the "send to terminal" toggle
  // (checkout echoed into the PTY as audit) is owned here and passed via `echo`.
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import type { GitBranch, GitStashEntry, CommitFile, DiffLine } from "./git";
  import {
    checkoutArgs,
    createBranchArgs,
    deleteBranchArgs,
    renameBranchArgs,
    mergeArgs,
    rebaseArgs,
    setUpstreamArgs,
    compareBranchesArgs,
    tagArgs,
    remoteUrlArgs,
    branchWebUrl,
    stashApplyArgs,
    stashPopArgs,
    stashDropArgs,
    stashFilesArgs,
    stashFileDiffArgs,
    parseCommitFiles,
    parseDiff,
  } from "./git";
  import type { GitOutput } from "./api";
  import { writeClipboard } from "./clipboard";
  import { notifySuccess, notifyError } from "./stores/toasts.svelte";
  import { relTime, fileStatusColor } from "./gitview";
  import { t } from "./i18n";

  let {
    branches,
    stashes,
    sendToTerminal = $bindable(false),
    run,
    runQuery,
    openDiff,
  }: {
    branches: GitBranch[];
    stashes: GitStashEntry[];
    sendToTerminal?: boolean;
    run: (args: string[], opts?: { destructive?: boolean; echo?: boolean; successKey?: string }) => Promise<boolean>;
    runQuery: (args: string[]) => Promise<GitOutput>;
    openDiff: (title: string, lines: DiffLine[]) => void;
  } = $props();

  // Expandable stash preview: click a stash to list its files, click a file for a
  // read-only diff (editing stashed content makes no sense).
  let expandedStash = $state<number | null>(null);
  let stashFiles = $state<CommitFile[]>([]);
  let loadingStashFiles = $state(false);

  async function toggleStash(index: number) {
    if (expandedStash === index) {
      expandedStash = null;
      stashFiles = [];
      return;
    }
    expandedStash = index;
    stashFiles = [];
    loadingStashFiles = true;
    try {
      const res = await runQuery(stashFilesArgs(index));
      stashFiles = parseCommitFiles(res.stdout);
    } finally {
      loadingStashFiles = false;
    }
  }

  async function showStashFile(index: number, path: string) {
    const res = await runQuery(stashFileDiffArgs(index, path));
    openDiff(path, parseDiff(res.stdout));
  }

  const locals = $derived(branches.filter((b) => !b.remote));
  const remotes = $derived(branches.filter((b) => b.remote));
  const current = $derived(locals.find((b) => b.current)?.name ?? null);

  let creating = $state(false);
  let newName = $state("");
  let renaming = $state<string | null>(null);
  let renameName = $state("");

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const ok = await run(createBranchArgs(name), { echo: sendToTerminal, successKey: "git.branchCreated" });
    if (ok) {
      newName = "";
      creating = false;
    }
  }

  async function rename(old: string) {
    const name = renameName.trim();
    if (!name || name === old) {
      renaming = null;
      return;
    }
    const ok = await run(renameBranchArgs(old, name));
    if (ok) renaming = null;
  }

  function startRename(name: string) {
    renaming = name;
    renameName = name;
  }

  /** Local checkout name for a remote ref (`origin/feat` → `feat`). */
  const localName = (name: string) => name.replace(/^[^/]+\//, "");
  /** The branch part used in a web URL (strip the remote prefix for remotes). */
  const urlBranch = (b: GitBranch) => (b.remote ? localName(b.name) : b.name);

  // ── Branch context menu (right-click) ──────────────────────────────────────
  // Declarative items for the shared ContextMenu; each closure captures `branch`
  // directly. Prod-protection unchanged: `run(…, { destructive })` still confirms.
  let ctxMenu = $state<OpenMenu | null>(null);
  // Create-branch / create-tag from a branch (name prompt).
  let ctxPrompt = $state<{ kind: "branch" | "tag"; from: string } | null>(null);
  let ctxName = $state("");

  function openMenu(e: MouseEvent, branch: GitBranch) {
    e.preventDefault();
    const items: MenuItem[] = [];
    if (!branch.remote) {
      if (!branch.current) {
        items.push({
          icon: "gitBranch",
          label: t("git.checkout"),
          onSelect: () => run(checkoutArgs(branch.name), { echo: sendToTerminal }),
        });
        if (current) {
          items.push({
            icon: "gitMerge",
            label: t("git.mergeInto", { current }),
            onSelect: () => run(mergeArgs(branch.name), { destructive: true, successKey: "git.merged" }),
          });
          items.push({
            icon: "history",
            label: t("git.rebaseOnto", { current }),
            onSelect: () => run(rebaseArgs(branch.name), { destructive: true, successKey: "git.rebased" }),
          });
        }
        items.push({ kind: "separator" });
      }
      items.push({
        icon: "gitBranch",
        label: t("git.ctxCreateBranch"),
        onSelect: () => startCtxPrompt("branch", branch.name),
      });
      items.push({
        icon: "check",
        label: t("git.ctxCreateTag"),
        onSelect: () => startCtxPrompt("tag", branch.name),
      });
      items.push({ icon: "cloud", label: t("git.setUpstream"), onSelect: () => setUpstream(branch) });
      items.push({ icon: "pencil", label: t("git.rename"), onSelect: () => startRename(branch.name) });
      if (!branch.current) {
        items.push({
          icon: "trash",
          label: t("git.deleteBranch"),
          onSelect: () => run(deleteBranchArgs(branch.name), { destructive: true }),
        });
      }
      items.push({ kind: "separator" });
      if (!branch.current && current) {
        items.push({
          icon: "code",
          label: t("git.compareWithCurrent"),
          onSelect: () => compareWithCurrent(branch),
        });
      }
      items.push({ icon: "copy", label: t("git.copyBranchName"), onSelect: () => copyName(branch) });
      items.push({ icon: "cloud", label: t("git.copyBranchLink"), onSelect: () => copyBranchLink(branch) });
    } else {
      items.push({
        icon: "gitBranch",
        label: t("git.checkoutTracking"),
        onSelect: () => run(checkoutArgs(localName(branch.name)), { echo: sendToTerminal }),
      });
      if (current) {
        items.push({
          icon: "gitMerge",
          label: t("git.mergeInto", { current }),
          onSelect: () => run(mergeArgs(branch.name), { destructive: true, successKey: "git.merged" }),
        });
        items.push({
          icon: "history",
          label: t("git.rebaseOnto", { current }),
          onSelect: () => run(rebaseArgs(branch.name), { destructive: true, successKey: "git.rebased" }),
        });
        items.push({ kind: "separator" });
        items.push({
          icon: "code",
          label: t("git.compareWithCurrent"),
          onSelect: () => compareWithCurrent(branch),
        });
      }
      items.push({ icon: "copy", label: t("git.copyBranchName"), onSelect: () => copyName(branch) });
      items.push({ icon: "cloud", label: t("git.copyBranchLink"), onSelect: () => copyBranchLink(branch) });
    }
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  async function copyName(b: GitBranch) {
    await writeClipboard(b.name);
    notifySuccess(t("git.copied"));
  }
  async function copyBranchLink(b: GitBranch) {
    const res = await runQuery(remoteUrlArgs());
    const url = res.exitCode === 0 ? branchWebUrl(res.stdout.trim(), urlBranch(b)) : null;
    if (!url) {
      notifyError(t("git.noRemoteLink"));
      return;
    }
    await writeClipboard(url);
    notifySuccess(t("git.copied"));
  }
  async function compareWithCurrent(b: GitBranch) {
    if (!current) return;
    const res = await runQuery(compareBranchesArgs(current, b.name));
    openDiff(`${current} ↔ ${b.name}`, parseDiff(res.stdout));
  }
  function setUpstream(b: GitBranch) {
    void run(setUpstreamArgs(b.name, `origin/${b.name}`), { successKey: "git.upstreamSet" });
  }

  function startCtxPrompt(kind: "branch" | "tag", from: string) {
    ctxPrompt = { kind, from };
    ctxName = "";
  }
  async function confirmCtxPrompt() {
    const name = ctxName.trim();
    const p = ctxPrompt;
    if (!name || !p) {
      ctxPrompt = null;
      return;
    }
    const args = p.kind === "branch" ? createBranchArgs(name, p.from) : tagArgs(name, p.from);
    const ok = await run(args, {
      successKey: p.kind === "branch" ? "git.branchCreated" : "git.tagCreated",
    });
    if (ok) ctxPrompt = null;
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-auto text-xs">
  <!-- Local branches -->
  <div class="flex items-center justify-between px-2 py-1 text-caption uppercase tracking-wider text-muted">
    <span>{t("git.localBranches")}</span>
    <button
      class="rounded px-1 hover:bg-edge hover:text-text"
      use:tooltip={t("git.newBranch")}
      aria-label={t("git.newBranch")}
      onclick={() => { creating = !creating; newName = ""; }}
    >
      <Icon name="plus" size={13} />
    </button>
  </div>
  {#if creating}
    <div class="px-2 pb-1">
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={newName}
        autofocus
        placeholder={t("git.branchNamePlaceholder")}
        class="w-full rounded border border-edge bg-panel px-2 py-1 text-meta text-text placeholder:text-muted focus:border-accent focus:outline-none"
        onkeydown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") creating = false; }}
      />
    </div>
  {/if}
  {#each locals as b (b.fullRef)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40 {b.current ? 'bg-edge/30' : ''}" oncontextmenu={(e) => openMenu(e, b)}>
      <Icon name={b.current ? "check" : "gitBranch"} size={13} />
      {#if renaming === b.name}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={renameName}
          autofocus
          class="min-w-0 flex-1 rounded border border-accent bg-panel px-1 text-meta text-text focus:outline-none"
          onkeydown={(e) => { if (e.key === "Enter") rename(b.name); if (e.key === "Escape") renaming = null; }}
        />
      {:else}
        <button
          class="min-w-0 flex-1 truncate text-left {b.current ? 'text-accent' : 'text-text/80'}"
          disabled={b.current}
          use:tooltip={b.current ? t("git.currentBranch") : t("git.checkout")}
          onclick={() => run(checkoutArgs(b.name), { echo: sendToTerminal })}
        >{b.name}</button>
        <div class="flex shrink-0 opacity-0 group-hover:opacity-100">
          {#if !b.current}
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.mergeInto", { current: current ?? "" })} aria-label={t("git.merge")} onclick={() => run(mergeArgs(b.name), { destructive: true, successKey: "git.merged" })}>
              <Icon name="gitMerge" size={13} />
            </button>
          {/if}
          <button class="rounded px-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.rename")} aria-label={t("git.rename")} onclick={() => startRename(b.name)}>
            <Icon name="pencil" size={12} />
          </button>
          {#if !b.current}
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.deleteBranch")} aria-label={t("git.deleteBranch")} onclick={() => run(deleteBranchArgs(b.name), { destructive: true })}>
              <Icon name="trash" size={12} />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  <!-- Remote branches -->
  {#if remotes.length}
    <div class="mt-1 border-t border-edge/40 px-2 py-1 text-caption uppercase tracking-wider text-muted">{t("git.remoteBranches")}</div>
    {#each remotes as b (b.fullRef)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40" oncontextmenu={(e) => openMenu(e, b)}>
        <Icon name="cloud" size={13} />
        <button
          class="min-w-0 flex-1 truncate text-left text-text/70"
          use:tooltip={t("git.checkoutTracking")}
          onclick={() => run(checkoutArgs(localName(b.name)), { echo: sendToTerminal })}
        >{b.name}</button>
      </div>
    {/each}
  {/if}

  <!-- Stashes -->
  {#if stashes.length}
    <div class="mt-1 border-t border-edge/40 px-2 py-1 text-caption uppercase tracking-wider text-muted">{t("git.stashes")}</div>
    {#each stashes as s (s.ref)}
      <div class="border-b border-edge/20">
        <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40 {expandedStash === s.index ? 'bg-edge/30' : ''}">
          <Icon name={expandedStash === s.index ? "chevronDown" : "stash"} size={13} />
          <button class="min-w-0 flex-1 truncate text-left text-text/80" use:tooltip={t("git.stashPreview")} onclick={() => toggleStash(s.index)}>{s.subject}</button>
          <div class="flex shrink-0 opacity-0 group-hover:opacity-100">
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.stashApply")} aria-label={t("git.stashApply")} onclick={() => run(stashApplyArgs(s.index), { successKey: "git.stashApplied" })}>
              <Icon name="download" size={13} />
            </button>
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.stashPop")} aria-label={t("git.stashPop")} onclick={() => run(stashPopArgs(s.index), { destructive: true, successKey: "git.stashApplied" })}>
              <Icon name="arrowsUpDown" size={13} />
            </button>
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-text" use:tooltip={t("git.stashDrop")} aria-label={t("git.stashDrop")} onclick={() => run(stashDropArgs(s.index), { destructive: true })}>
              <Icon name="trash" size={12} />
            </button>
          </div>
        </div>
        {#if expandedStash === s.index}
          <div class="bg-panel/50 px-2 py-1">
            {#if loadingStashFiles}
              <p class="py-1 text-caption text-muted">{t("git.loading")}</p>
            {:else if stashFiles.length === 0}
              <p class="py-1 text-caption text-muted">{t("git.noFiles")}</p>
            {:else}
              {#each stashFiles as f (f.path)}
                <button class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-edge/50" onclick={() => showStashFile(s.index, f.path)}>
                  <span class="w-3 shrink-0 text-center font-mono text-caption {fileStatusColor(f.status)}">{f.status}</span>
                  <span class="truncate text-meta text-text/80">{f.path}</span>
                  <Icon name="code" size={11} />
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  <!-- Send-to-terminal toggle -->
  <label class="mt-auto flex items-center gap-2 border-t border-edge px-2 py-1.5 text-caption text-muted">
    <input type="checkbox" bind:checked={sendToTerminal} class="accent-accent" />
    {t("git.sendToTerminal")}
  </label>
</div>

<ContextMenu menu={ctxMenu} onclose={() => (ctxMenu = null)} />

<!-- Create branch / tag from a branch -->
<Modal
  open={ctxPrompt !== null}
  title={ctxPrompt?.kind === "tag" ? t("git.createTagTitle") : t("git.createBranchTitle")}
  onclose={() => (ctxPrompt = null)}
>
  <!-- svelte-ignore a11y_autofocus -->
  <input
    bind:value={ctxName}
    autofocus
    placeholder={ctxPrompt?.kind === "tag" ? t("git.tagNamePlaceholder") : t("git.branchNamePlaceholder")}
    class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
    onkeydown={(e) => {
      if (e.key === "Enter") confirmCtxPrompt();
      if (e.key === "Escape") ctxPrompt = null;
    }}
  />
  <div class="mt-3 flex justify-end gap-2">
    <button class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => (ctxPrompt = null)}>{t("common.cancel")}</button>
    <button class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40" disabled={!ctxName.trim()} onclick={confirmCtxPrompt}>{t("common.create")}</button>
  </div>
</Modal>
