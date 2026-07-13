<script lang="ts">
  // Branches sub-tab (Phase 29): local + remote branches and stashes, with
  // checkout / create / rename / delete / merge and stash apply/pop/drop. All
  // mutations flow through the panel's `run`; the "send to terminal" toggle
  // (checkout echoed into the PTY as audit) is owned here and passed via `echo`.
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { IconName } from "./icons";
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
  let menu = $state<{ x: number; y: number; branch: GitBranch } | null>(null);
  // Create-branch / create-tag from a branch (name prompt).
  let ctxPrompt = $state<{ kind: "branch" | "tag"; from: string } | null>(null);
  let ctxName = $state("");

  function openMenu(e: MouseEvent, branch: GitBranch) {
    e.preventDefault();
    const mx = Math.min(e.clientX, window.innerWidth - 230);
    const my = Math.min(e.clientY, window.innerHeight - 340);
    menu = { x: Math.max(4, mx), y: Math.max(4, my), branch };
  }
  function closeMenu() {
    menu = null;
  }
  // Capture the branch before closing (menu.branch goes stale once unmounted).
  function menuAction(fn: (b: GitBranch) => Promise<unknown> | unknown) {
    const b = menu?.branch;
    closeMenu();
    if (b) void fn(b);
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
  <div class="flex items-center justify-between px-2 py-1 text-[11px] uppercase tracking-wide text-muted">
    <span>{t("git.localBranches")}</span>
    <button
      class="rounded px-1 hover:bg-edge hover:text-white"
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
        class="w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-white placeholder:text-muted focus:border-accent focus:outline-none"
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
          class="min-w-0 flex-1 rounded border border-accent bg-panel px-1 text-[11px] text-white focus:outline-none"
          onkeydown={(e) => { if (e.key === "Enter") rename(b.name); if (e.key === "Escape") renaming = null; }}
        />
      {:else}
        <button
          class="min-w-0 flex-1 truncate text-left {b.current ? 'text-accent' : 'text-white/80'}"
          disabled={b.current}
          use:tooltip={b.current ? t("git.currentBranch") : t("git.checkout")}
          onclick={() => run(checkoutArgs(b.name), { echo: sendToTerminal })}
        >{b.name}</button>
        <div class="flex shrink-0 opacity-0 group-hover:opacity-100">
          {#if !b.current}
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.mergeInto", { current: current ?? "" })} aria-label={t("git.merge")} onclick={() => run(mergeArgs(b.name), { destructive: true, successKey: "git.merged" })}>
              <Icon name="gitMerge" size={13} />
            </button>
          {/if}
          <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.rename")} aria-label={t("git.rename")} onclick={() => startRename(b.name)}>
            <Icon name="pencil" size={12} />
          </button>
          {#if !b.current}
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.deleteBranch")} aria-label={t("git.deleteBranch")} onclick={() => run(deleteBranchArgs(b.name), { destructive: true })}>
              <Icon name="trash" size={12} />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  <!-- Remote branches -->
  {#if remotes.length}
    <div class="mt-1 border-t border-edge/40 px-2 py-1 text-[11px] uppercase tracking-wide text-muted">{t("git.remoteBranches")}</div>
    {#each remotes as b (b.fullRef)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40" oncontextmenu={(e) => openMenu(e, b)}>
        <Icon name="cloud" size={13} />
        <button
          class="min-w-0 flex-1 truncate text-left text-white/70"
          use:tooltip={t("git.checkoutTracking")}
          onclick={() => run(checkoutArgs(localName(b.name)), { echo: sendToTerminal })}
        >{b.name}</button>
      </div>
    {/each}
  {/if}

  <!-- Stashes -->
  {#if stashes.length}
    <div class="mt-1 border-t border-edge/40 px-2 py-1 text-[11px] uppercase tracking-wide text-muted">{t("git.stashes")}</div>
    {#each stashes as s (s.ref)}
      <div class="border-b border-edge/20">
        <div class="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-edge/40 {expandedStash === s.index ? 'bg-edge/30' : ''}">
          <Icon name={expandedStash === s.index ? "chevronDown" : "stash"} size={13} />
          <button class="min-w-0 flex-1 truncate text-left text-white/80" use:tooltip={t("git.stashPreview")} onclick={() => toggleStash(s.index)}>{s.subject}</button>
          <div class="flex shrink-0 opacity-0 group-hover:opacity-100">
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.stashApply")} aria-label={t("git.stashApply")} onclick={() => run(stashApplyArgs(s.index), { successKey: "git.stashApplied" })}>
              <Icon name="download" size={13} />
            </button>
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.stashPop")} aria-label={t("git.stashPop")} onclick={() => run(stashPopArgs(s.index), { destructive: true, successKey: "git.stashApplied" })}>
              <Icon name="arrowsUpDown" size={13} />
            </button>
            <button class="rounded px-1 text-muted hover:bg-edge hover:text-white" use:tooltip={t("git.stashDrop")} aria-label={t("git.stashDrop")} onclick={() => run(stashDropArgs(s.index), { destructive: true })}>
              <Icon name="trash" size={12} />
            </button>
          </div>
        </div>
        {#if expandedStash === s.index}
          <div class="bg-panel/50 px-2 py-1">
            {#if loadingStashFiles}
              <p class="py-1 text-[10px] text-muted">{t("git.loading")}</p>
            {:else if stashFiles.length === 0}
              <p class="py-1 text-[10px] text-muted">{t("git.noFiles")}</p>
            {:else}
              {#each stashFiles as f (f.path)}
                <button class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-edge/50" onclick={() => showStashFile(s.index, f.path)}>
                  <span class="w-3 shrink-0 text-center font-mono text-[10px] {fileStatusColor(f.status)}">{f.status}</span>
                  <span class="truncate text-[11px] text-white/80">{f.path}</span>
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
  <label class="mt-auto flex items-center gap-2 border-t border-edge px-2 py-1.5 text-[10px] text-muted">
    <input type="checkbox" bind:checked={sendToTerminal} class="accent-accent" />
    {t("git.sendToTerminal")}
  </label>
</div>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") closeMenu();
  }}
/>

<!-- Branch context menu -->
{#if menu}
  {@const b = menu.branch}
  <button
    type="button"
    aria-label={t("common.closeDialog")}
    class="fixed inset-0 z-40 cursor-default"
    onclick={closeMenu}
    oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}
  ></button>
  <div
    class="fixed z-50 w-56 rounded-md border border-edge bg-panel py-1 text-xs shadow-lg"
    style="left:{menu.x}px; top:{menu.y}px"
    role="menu"
  >
    {#if !b.remote}
      {#if !b.current}
        {@render item("gitBranch", t("git.checkout"), () => menuAction((br) => run(checkoutArgs(br.name), { echo: sendToTerminal })))}
        {#if current}
          {@render item("gitMerge", t("git.mergeInto", { current }), () => menuAction((br) => run(mergeArgs(br.name), { destructive: true, successKey: "git.merged" })))}
          {@render item("history", t("git.rebaseOnto", { current }), () => menuAction((br) => run(rebaseArgs(br.name), { destructive: true, successKey: "git.rebased" })))}
        {/if}
        <div class="my-1 border-t border-edge/60"></div>
      {/if}
      {@render item("gitBranch", t("git.ctxCreateBranch"), () => menuAction((br) => startCtxPrompt("branch", br.name)))}
      {@render item("check", t("git.ctxCreateTag"), () => menuAction((br) => startCtxPrompt("tag", br.name)))}
      {@render item("cloud", t("git.setUpstream"), () => menuAction((br) => setUpstream(br)))}
      {@render item("pencil", t("git.rename"), () => menuAction((br) => startRename(br.name)))}
      {#if !b.current}
        {@render item("trash", t("git.deleteBranch"), () => menuAction((br) => run(deleteBranchArgs(br.name), { destructive: true })))}
      {/if}
      <div class="my-1 border-t border-edge/60"></div>
      {#if !b.current && current}
        {@render item("code", t("git.compareWithCurrent"), () => menuAction((br) => compareWithCurrent(br)))}
      {/if}
      {@render item("copy", t("git.copyBranchName"), () => menuAction((br) => copyName(br)))}
      {@render item("cloud", t("git.copyBranchLink"), () => menuAction((br) => copyBranchLink(br)))}
    {:else}
      {@render item("gitBranch", t("git.checkoutTracking"), () => menuAction((br) => run(checkoutArgs(localName(br.name)), { echo: sendToTerminal })))}
      {#if current}
        {@render item("gitMerge", t("git.mergeInto", { current }), () => menuAction((br) => run(mergeArgs(br.name), { destructive: true, successKey: "git.merged" })))}
        {@render item("history", t("git.rebaseOnto", { current }), () => menuAction((br) => run(rebaseArgs(br.name), { destructive: true, successKey: "git.rebased" })))}
        <div class="my-1 border-t border-edge/60"></div>
        {@render item("code", t("git.compareWithCurrent"), () => menuAction((br) => compareWithCurrent(br)))}
      {/if}
      {@render item("copy", t("git.copyBranchName"), () => menuAction((br) => copyName(br)))}
      {@render item("cloud", t("git.copyBranchLink"), () => menuAction((br) => copyBranchLink(br)))}
    {/if}
  </div>
{/if}

{#snippet item(icon: IconName, label: string, onclick: () => void)}
  <button
    type="button"
    class="flex w-full items-center gap-2 px-2 py-1 text-left text-muted hover:bg-edge hover:text-white"
    role="menuitem"
    {onclick}
  >
    <Icon name={icon} size={13} />
    <span class="truncate">{label}</span>
  </button>
{/snippet}

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
    class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white placeholder:text-muted focus:border-accent focus:outline-none"
    onkeydown={(e) => {
      if (e.key === "Enter") confirmCtxPrompt();
      if (e.key === "Escape") ctxPrompt = null;
    }}
  />
  <div class="mt-3 flex justify-end gap-2">
    <button class="rounded px-3 py-1 text-sm text-muted hover:text-white" onclick={() => (ctxPrompt = null)}>{t("common.cancel")}</button>
    <button class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40" disabled={!ctxName.trim()} onclick={confirmCtxPrompt}>{t("common.create")}</button>
  </div>
</Modal>
