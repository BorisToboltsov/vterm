<script lang="ts">
  // Branches sub-tab (Phase 29): local and remote branches and tags as a tree
  // (v1.27, `refRows`), and stashes, with checkout / create / rename / delete / merge
  // and stash apply/pop/drop. All mutations flow through the panel's `run`; the "send
  // to terminal" toggle (checkout echoed into the PTY as audit) is owned here and
  // passed via `echo`.
  //
  // A click selects: the row's commit comes up in the history where the history is on
  // screen, and the toolbar acts on the row. A double click switches to the branch.
  // The toolbar is a strip beside the tree in a wide panel, where height is short, and
  // a row above it in a narrow one, where width is.
  import Icon from "../ui/Icon.svelte";
  import FilterField from "../ui/FilterField.svelte";
  import Modal from "../ui/Modal.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import { tooltip } from "../actions/tooltip";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import type { IconName } from "../ui/icons";
  import type { GitBranch, GitStashEntry, GitTag, CommitFile, DiffLine, GitRunOpts } from "./git";
  import {
    checkoutArgs,
    createBranchArgs,
    deleteBranchArgs,
    renameBranchArgs,
    mergeArgs,
    rebaseArgs,
    setUpstreamArgs,
    compareBranchesArgs,
    pullArgs,
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
    updateBranchArgs,
  } from "./git";
  import { allFolderKeys, refRows, tagRef, toggledFavorite, type RefRow, type RefSection } from "./gitrefs";
  import type { GitOutput } from "../api";
  import { settings } from "../settings/settings.svelte";
  import { writeClipboard } from "../app/clipboard";
  import { notifySuccess, notifyError } from "../stores/toasts.svelte";
  import { fileStatusColor } from "./gitview";
  import { t } from "../i18n";
  import { REM_PX } from "../appearance/uiscale";

  let {
    panelItems = () => [],
    branches,
    tags = [],
    stashes,
    wide = false,
    sendToTerminal = $bindable(false),
    run,
    runQuery,
    openDiff,
    onreveal,
    onlyref,
  }: {
    panelItems?: () => MenuItem[];
    branches: GitBranch[];
    tags?: GitTag[];
    stashes: GitStashEntry[];
    /** The panel is wide: the history stands beside the tree. */
    wide?: boolean;
    sendToTerminal?: boolean;
    run: (args: string[], opts?: GitRunOpts) => Promise<boolean>;
    runQuery: (args: string[]) => Promise<GitOutput>;
    openDiff: (title: string, lines: DiffLine[]) => void;
    /** Bring a ref's commit up in the history: its short hash and its full ref. */
    onreveal?: (short: string, ref: string) => void;
    /** Show only this ref's history. */
    onlyref?: (ref: string) => void;
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

  const current = $derived(branches.find((b) => !b.remote && b.current)?.name ?? null);

  // ── The tree ───────────────────────────────────────────────────────────────
  let query = $state("");
  // What the user folded or unfolded, against what a row does by default.
  let opened = $state<ReadonlySet<string>>(new Set());
  let closed = $state<ReadonlySet<string>>(new Set());
  const isOpen = (key: string, byDefault: boolean): boolean =>
    closed.has(key) ? false : opened.has(key) ? true : byDefault;
  const rows = $derived(
    refRows({ branches, tags, favorites: settings.gitFavoriteBranches, query, isOpen }),
  );
  // «N of M» in the field while it narrows the tree — by the rule `refRows` matches by.
  const refsShown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? [...branches, ...tags].filter((r) => r.name.toLowerCase().includes(q)).length : null;
  });

  function toggleFolder(row: { key: string; open: boolean }) {
    const nextOpened = new Set(opened);
    const nextClosed = new Set(closed);
    if (row.open) {
      nextOpened.delete(row.key);
      nextClosed.add(row.key);
    } else {
      nextClosed.delete(row.key);
      nextOpened.add(row.key);
    }
    opened = nextOpened;
    closed = nextClosed;
  }
  function foldAll(fold: boolean) {
    const keys = allFolderKeys({ branches, tags, favorites: settings.gitFavoriteBranches });
    opened = fold ? new Set() : new Set(keys);
    closed = fold ? new Set(keys) : new Set();
  }

  const SECTION_LABEL: Record<RefSection, () => string> = {
    local: () => t("git.localBranches"),
    remote: () => t("git.remoteBranches"),
    tags: () => t("git.tags"),
  };
  /** Left padding of a tree row, px: one step a level. */
  const indent = (depth: number): string => `${(6 + depth * 12) / REM_PX}rem`;

  // ── The selected row, and what the toolbar does to it ─────────────────────
  let selectedRef = $state<string | null>(null);
  const selectedBranch = $derived(branches.find((b) => b.fullRef === selectedRef) ?? null);
  const selectedTag = $derived(tags.find((tag) => tagRef(tag) === selectedRef) ?? null);

  function pick(ref: string, short: string) {
    selectedRef = ref;
    if (wide) onreveal?.(short, ref);
  }
  function revealSelected() {
    if (selectedBranch) onreveal?.(selectedBranch.short, selectedBranch.fullRef);
    else if (selectedTag) onreveal?.(selectedTag.short, tagRef(selectedTag));
  }

  /** Local checkout name for a remote ref (`origin/feat` → `feat`). */
  const localName = (name: string) => name.replace(/^[^/]+\//, "");
  /** The branch part used in a web URL (strip the remote prefix for remotes). */
  const urlBranch = (b: GitBranch) => (b.remote ? localName(b.name) : b.name);

  function checkout(b: GitBranch) {
    if (b.current) return;
    void run(checkoutArgs(b.remote ? localName(b.name) : b.name), { echo: sendToTerminal });
  }

  const canDelete = $derived(!!selectedBranch && !selectedBranch.remote && !selectedBranch.current);
  function deleteSelected() {
    if (selectedBranch && canDelete) void run(deleteBranchArgs(selectedBranch.name), { destructive: true });
  }

  /** The checked-out branch pulls; another is moved to its upstream if it can fast-forward. */
  const updateArgs = $derived(
    !selectedBranch || selectedBranch.remote
      ? null
      : selectedBranch.current
        ? selectedBranch.upstream
          ? pullArgs()
          : null
        : updateBranchArgs(selectedBranch),
  );
  function updateSelected() {
    if (updateArgs) void run(updateArgs, { successKey: "git.branchUpdated" });
  }
  const updateHint = $derived(
    !selectedBranch ? t("git.pickBranch") : updateArgs ? t("git.updateBranch") : t("git.noUpstream"),
  );

  const canCompare = $derived(!!selectedBranch && !selectedBranch.current && !!current);
  const isFavorite = (name: string): boolean => settings.gitFavoriteBranches.includes(name);
  function toggleFavorite(name: string) {
    settings.gitFavoriteBranches = toggledFavorite(settings.gitFavoriteBranches, name);
  }

  function trackHint(b: GitBranch): string {
    const upstream = b.upstream ?? "";
    if (b.track?.gone) return t("git.trackGone", { upstream });
    return t("git.trackHint", { upstream, ahead: b.track?.ahead ?? 0, behind: b.track?.behind ?? 0 });
  }

  // ── New branch, rename ─────────────────────────────────────────────────────
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

  // ── Branch context menu (right-click) ──────────────────────────────────────
  // Declarative items for the shared ContextMenu; each closure captures `branch`
  // directly. Prod-protection unchanged: `run(…, { destructive })` still confirms.
  let searchField: FilterField | undefined;
  function openListMenu(e: MouseEvent, items: MenuItem[] = []) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = { x: e.clientX, y: e.clientY, items: [
      ...items, ...(items.length ? [{ kind: "separator" as const }] : []),
      { kind: "submenu", key: "refs-view", icon: "eye", label: t("list.view"), items: [
        { icon: "chevronDown", label: t("git.expandAll"), onSelect: () => foldAll(false) },
        { icon: "chevronUp", label: t("git.collapseAll"), onSelect: () => foldAll(true) },
        { label: t("git.sendToTerminal"), checked: sendToTerminal, onSelect: () => (sendToTerminal = !sendToTerminal) },
      ] },
      { kind: "submenu", key: "refs-search", icon: "search", label: t("list.filters"), items: [
        { label: t("list.find"), onSelect: () => searchField?.focus() },
        { label: t("list.clear"), disabled: !query, onSelect: () => (query = "") },
      ] },
      ...panelItems(),
    ] };
  }
  let ctxMenu = $state<OpenMenu | null>(null);
  // Create-branch / create-tag from a branch (name prompt).
  let ctxPrompt = $state<{ kind: "branch" | "tag"; from: string } | null>(null);
  let ctxName = $state("");

  function historyItems(short: string, ref: string): MenuItem[] {
    return [
      { icon: "history", label: t("git.showInHistory"), onSelect: () => onreveal?.(short, ref) },
      { icon: "filter", label: t("git.onlyThisRef"), onSelect: () => onlyref?.(ref) },
      { kind: "separator" },
    ];
  }

  function openMenu(e: MouseEvent, branch: GitBranch) {
    e.preventDefault();
    selectedRef = branch.fullRef;
    const items: MenuItem[] = historyItems(branch.short, branch.fullRef);
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
        icon: "tag",
        label: t("git.ctxCreateTag"),
        onSelect: () => startCtxPrompt("tag", branch.name),
      });
      items.push({ icon: "cloud", label: t("git.setUpstream"), onSelect: () => setUpstream(branch) });
      items.push({ icon: "pencil", label: t("git.rename"), onSelect: () => startRename(branch.name) });
      items.push({
        icon: "star",
        label: isFavorite(branch.name) ? t("git.unfavorite") : t("git.favorite"),
        onSelect: () => toggleFavorite(branch.name),
      });
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
      items.push({ icon: "copy", label: t("git.copyBranchName"), onSelect: () => copyName(branch.name) });
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
      items.push({ icon: "copy", label: t("git.copyBranchName"), onSelect: () => copyName(branch.name) });
      items.push({ icon: "cloud", label: t("git.copyBranchLink"), onSelect: () => copyBranchLink(branch) });
    }
    openListMenu(e, items);
  }

  function openTagMenu(e: MouseEvent, tag: GitTag) {
    e.preventDefault();
    selectedRef = tagRef(tag);
    openListMenu(e, [
      ...historyItems(tag.short, tagRef(tag)),
      { icon: "copy", label: t("git.copyRefName"), onSelect: () => copyName(tag.name) },
    ]);
  }

  async function copyName(name: string) {
    await writeClipboard(name);
    notifySuccess(t("git.copied"), { source: "git" });
  }
  async function copyBranchLink(b: GitBranch) {
    const res = await runQuery(remoteUrlArgs());
    const url = res.exitCode === 0 ? branchWebUrl(res.stdout.trim(), urlBranch(b)) : null;
    if (!url) {
      notifyError(t("git.noRemoteLink"), { source: "git" });
      return;
    }
    await writeClipboard(url);
    notifySuccess(t("git.copied"), { source: "git" });
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

{#snippet tool(icon: IconName, label: string, enabled: boolean, action: () => void, testid: string)}
  <button
    type="button"
    class="flex shrink-0 rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
    aria-label={label}
    use:tooltip={label}
    disabled={!enabled}
    data-testid={testid}
    onclick={action}
  >
    <Icon name={icon} size={13} />
  </button>
{/snippet}

{#snippet toolbar()}
  {@render tool("plus", t("git.newBranch"), true, () => { creating = !creating; newName = ""; }, "git-branch-new")}
  {@render tool("download", updateHint, !!updateArgs, updateSelected, "git-branch-update")}
  {@render tool("trash", selectedBranch?.current ? t("git.deleteCurrent") : selectedBranch ? t("git.deleteBranch") : t("git.pickBranch"), canDelete, deleteSelected, "git-branch-delete")}
  {@render tool("code", selectedBranch ? t("git.compareWithCurrent") : t("git.pickBranch"), canCompare, () => selectedBranch && compareWithCurrent(selectedBranch), "git-branch-compare")}
  {@render tool("star", selectedBranch && !selectedBranch.remote ? (isFavorite(selectedBranch.name) ? t("git.unfavorite") : t("git.favorite")) : t("git.pickBranch"), !!selectedBranch && !selectedBranch.remote, () => selectedBranch && toggleFavorite(selectedBranch.name), "git-branch-star")}
  {#if !wide}
    <!-- The history is behind a sub-tab here, so a click does not bring it up. -->
    {@render tool("history", selectedBranch || selectedTag ? t("git.showInHistory") : t("git.pickBranch"), !!selectedBranch || !!selectedTag, revealSelected, "git-branch-reveal")}
    <span class="flex-1"></span>
  {:else}
    <span class="my-0.5 w-4 border-t border-edge"></span>
  {/if}
  {@render tool("chevronDown", t("git.expandAll"), true, () => foldAll(false), "git-tree-expand")}
  {@render tool("chevronUp", t("git.collapseAll"), true, () => foldAll(true), "git-tree-collapse")}
{/snippet}

{#snippet treeRow(row: RefRow)}
  {#if row.kind === "section"}
    <button
      type="button"
      class="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-meta font-medium text-text/90 hover:bg-edge/40"
      style:padding-left={indent(row.depth)}
      aria-expanded={row.open}
      data-testid="git-tree-section"
      data-section={row.section}
      onclick={() => toggleFolder(row)}
    >
      <Icon name={row.open ? "chevronDown" : "chevronRight"} size={11} class="shrink-0 text-muted" />
      <span class="min-w-0 flex-1 truncate">{SECTION_LABEL[row.section]()}</span>
      <span class="shrink-0 text-caption font-normal text-muted">{row.count}</span>
    </button>
  {:else if row.kind === "folder"}
    <button
      type="button"
      class="flex w-full items-center gap-1 py-0.5 pr-2 text-left text-meta text-text/80 hover:bg-edge/40"
      style:padding-left={indent(row.depth)}
      aria-expanded={row.open}
      data-testid="git-tree-folder"
      onclick={() => toggleFolder(row)}
    >
      <Icon name={row.open ? "chevronDown" : "chevronRight"} size={11} class="shrink-0 text-muted" />
      <Icon name="folder" size={12} class="shrink-0 text-muted" />
      <span class="min-w-0 flex-1 truncate">{row.label}</span>
      <span class="shrink-0 text-caption text-muted">{row.count}</span>
    </button>
  {:else if row.kind === "branch"}
    {@const b = row.branch}
    {#if renaming === b.name}
      <div class="py-0.5 pr-2" style:padding-left={indent(row.depth)}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={renameName}
          autofocus
          class="w-full rounded border border-accent bg-panel px-1 text-meta text-text focus:outline-none"
          onkeydown={(e) => { if (e.key === "Enter") rename(b.name); if (e.key === "Escape") renaming = null; }}
        />
      </div>
    {:else}
      <button
        type="button"
        class="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-meta {b.current
          ? 'text-accent'
          : 'text-text/85'} {selectedRef === b.fullRef ? 'bg-edge/60' : 'hover:bg-edge/40'}"
        style:padding-left={indent(row.depth)}
        use:tooltip={t("git.branchRowHint", { name: b.name })}
        aria-current={b.current ? "true" : undefined}
        data-testid="git-tree-branch"
        data-branch={b.name}
        onclick={() => pick(b.fullRef, b.short)}
        ondblclick={() => checkout(b)}
        oncontextmenu={(e) => openMenu(e, b)}
      >
        {#if row.favorite}
          <span class="flex shrink-0 text-warn [&_path]:fill-current" data-testid="git-tree-star"><Icon name="star" size={12} /></span>
        {:else if b.current}
          <Icon name="check" size={12} class="shrink-0 text-accent" />
        {:else if b.remote}
          <Icon name="cloud" size={12} class="shrink-0 text-muted" />
        {:else}
          <Icon name="gitBranch" size={12} class="shrink-0 text-muted" />
        {/if}
        <span class="min-w-0 flex-1 truncate">{row.label}</span>
        {#if b.track && (b.track.ahead || b.track.behind)}
          <span class="shrink-0 text-caption tabular-nums text-accent" use:tooltip={trackHint(b)} data-testid="git-tree-track">
            {#if b.track.ahead}↑{b.track.ahead}{/if}{#if b.track.behind}↓{b.track.behind}{/if}
          </span>
        {:else if b.track?.gone}
          <span class="flex shrink-0 text-warn" use:tooltip={trackHint(b)} data-testid="git-tree-gone"><Icon name="alert" size={11} /></span>
        {/if}
        {#if b.worktree && !b.current}
          <span class="shrink-0 text-caption text-muted" use:tooltip={t("git.worktreeHint", { path: b.worktree })} data-testid="git-tree-worktree">{t("git.worktree")}</span>
        {/if}
      </button>
    {/if}
  {:else}
    {@const tag = row.tag}
    <button
      type="button"
      class="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-meta text-text/85 {selectedRef === tagRef(tag) ? 'bg-edge/60' : 'hover:bg-edge/40'}"
      style:padding-left={indent(row.depth)}
      use:tooltip={tag.name}
      data-testid="git-tree-tag"
      onclick={() => pick(tagRef(tag), tag.short)}
      oncontextmenu={(e) => openTagMenu(e, tag)}
    >
      <Icon name="tag" size={12} class="shrink-0 text-muted" />
      <span class="min-w-0 flex-1 truncate">{row.label}</span>
    </button>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 text-xs {wide ? '' : 'flex-col'}" data-testid="git-branches" role="presentation" oncontextmenu={(e) => openListMenu(e)}>
  <div
    class="flex shrink-0 items-center gap-px {wide ? 'flex-col border-r border-edge px-0.5 py-1' : 'border-b border-edge px-1.5 py-0.5'}"
    data-testid="git-branch-tools"
    data-vertical={wide}
  >
    {@render toolbar()}
  </div>

  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="shrink-0 border-b border-edge px-2 py-1">
      <FilterField
        bind:this={searchField}
        bind:value={query}
        placeholder={t("git.searchRefs")}
        shown={refsShown}
        total={refsShown === null ? null : branches.length + tags.length}
        testid="git-tree-search"
      />
    </div>
    {#if creating}
      <div class="shrink-0 border-b border-edge px-2 py-1">
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

    <div class="min-h-0 flex-1 overflow-auto py-0.5" data-testid="git-tree">
      {#if current}
        <div class="flex items-center gap-1.5 py-0.5 pr-2 text-meta text-text/85" style:padding-left={indent(0)} data-testid="git-tree-head">
          <Icon name="gitCommit" size={12} class="shrink-0 text-muted" />
          <span class="min-w-0 truncate">HEAD <span class="text-muted">{t("git.treeHead")}</span></span>
        </div>
      {/if}
      {#each rows as row (row.key)}
        {@render treeRow(row)}
      {/each}

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
                      <span class="truncate text-meta {fileStatusColor(f.status)}">{f.path}</span>
                      <Icon name="code" size={11} />
                    </button>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Send-to-terminal toggle -->
    <label class="flex shrink-0 items-center gap-2 border-t border-edge px-2 py-1.5 text-caption text-muted">
      <input type="checkbox" bind:checked={sendToTerminal} class="accent-accent" />
      {t("git.sendToTerminal")}
    </label>
  </div>
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
