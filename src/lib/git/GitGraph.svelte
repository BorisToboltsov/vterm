<script lang="ts">
  // Commit graph sub-tab (Phase 29). One SVG overlays the whole scroll height so
  // lines never break between rows; commit rows are fixed-height HTML beneath it,
  // and only those near the view are drawn (a history can reach `LOG_CAP` commits).
  // Lanes and colours come from buildGraph, the shape of a line from edgePath (pure,
  // `gitlanes.ts`). Right-click a commit → actions menu (checkout, branch/tag here,
  // reset, cherry-pick, revert, compare, copy).
  //
  // A selected commit opens its details (v1.15, `GitCommitDetail`): in a wide
  // panel beside the list, when the row holds both (`fitsBeside`), where one is
  // always shown; otherwise in a strip under it. Never between the rows — they stay
  // uniform, so the SVG stays aligned. The list measures itself (v1.27): how tall a
  // row is depends on its width, so the rows and the SVG read the same number.
  import { swallowed } from "../api/diag";
  import Modal from "../ui/Modal.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import SidePane from "../ui/SidePane.svelte";
  import { aside } from "../actions/fluidglide";
  import { MOTION_BASE, motion } from "../ui/motion";
  import PanelDivider from "../ui/PanelDivider.svelte";
  import GitCommitDetail from "./GitCommitDetail.svelte";
  import GitLogFilter from "./GitLogFilter.svelte";
  import GitRefChip from "./GitRefChip.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import type {
    CommitDetail,
    CommitFile,
    GitBranch,
    GitCommit,
    LogFilter,
    ResetMode,
    DiffLine,
    GitRunOpts,
  } from "./git";
  import {
    branchContainsArgs,
    commitDetailArgs,
    commitDiffArgs,
    CURRENT_BRANCH,
    isFiltered,
    LOG_CAP,
    mergeFilesArgs,
    mergeFileDiffArgs,
    NO_FILTER,
    parseCommitDetail,
    parseContains,
    parseRawNumstatZ,
    showFileArgs,
    diffCommitWorkingArgs,
    parseDiff,
    checkoutCommitArgs,
    createBranchArgs,
    tagArgs,
    resetArgs,
    cherryPickArgs,
    revertArgs,
    remoteUrlArgs,
    commitWebUrl,
  } from "./git";
  import { edgePath, reachableFromHead, type GraphRow } from "./gitlanes";
  import { refLabels } from "./gitrefs";
  import type { GitOutput } from "../api";
  import { tooltip } from "../actions/tooltip";
  import { commitTreeDirs, gitAge, isLogWide } from "./gitview";
  import { rowTooltip, whenLabel } from "./gitui";
  import { fitsBeside } from "../layout/panelsplit";
  import { partWidth } from "../stores/panelsplit.svelte";
  import { settings, uiPx } from "../settings/settings.svelte";
  import { windowRange } from "../ui/virtuallist";
  import { writeClipboard } from "../app/clipboard";
  import { notifySuccess, notifyError } from "../stores/toasts.svelte";
  import { untrack } from "svelte";
  import { t } from "../i18n";
  import { REM_PX } from "../appearance/uiscale";

  let {
    panelItems = () => [],
    rows,
    wide = false,
    filter = NO_FILTER,
    branches = [],
    hasMore = false,
    loadingMore = false,
    searchError = null,
    reveal = null,
    run,
    runQuery,
    openDiff,
    onfilter,
    onloadmore,
    onfilehistory,
  }: {
    panelItems?: () => MenuItem[];
    rows: GraphRow[];
    /** The panel is in its wide layout: a commit's details may stand beside the list. */
    wide?: boolean;
    /** What git narrowed the history to. */
    filter?: LogFilter;
    branches?: readonly GitBranch[];
    /** There may be more commits than loaded: the last load came back full. */
    hasMore?: boolean;
    loadingMore?: boolean;
    /** Why git refused the search (a broken pattern, say). */
    searchError?: string | null;
    /** A commit to scroll to and select; a new `seq` asks again. */
    reveal?: { hash: string; seq: number } | null;
    run: (args: string[], opts?: GitRunOpts) => Promise<boolean>;
    runQuery: (args: string[]) => Promise<GitOutput>;
    openDiff: (title: string, lines: DiffLine[]) => void;
    onfilter?: (filter: LogFilter) => void;
    onloadmore?: () => void;
    /** Show the history of one file (repo-relative path). */
    onfilehistory?: (path: string) => void;
  } = $props();

  const RESET_MODES: ResetMode[] = ["soft", "mixed", "hard"];

  const ONE_LINE_H = 26; // a row with columns, for a dock short on height
  const TWO_LINE_H = 38; // the subject on a line of its own, for one short on width
  const COL_W = 14; // lane spacing
  const PAD = 11; // left padding before lane 0
  const R = 3.5; // node radius
  const MAX_LANES = 8; // clamp graph width in the narrow dock
  const ROW_LABELS = 2; // labels a one-line row shows before it counts the rest
  const x = (col: number) => PAD + Math.min(col, MAX_LANES) * COL_W;
  const laneCount = $derived(rows.reduce((n, r) => Math.max(n, Math.min(r.lanes, MAX_LANES + 1)), 1));
  const graphW = $derived(PAD * 2 + (laneCount - 1) * COL_W);

  // Width and height of the list itself, px (0 until measured), and the row they give.
  let listEl = $state<HTMLElement | undefined>();
  let listWidth = $state(0);
  let viewH = $state(0);
  let scrollTop = $state(0);
  const oneLine = $derived(isLogWide(listWidth, uiPx(REM_PX)));
  // The constants above are at 100 %, and so is everything the rails are drawn from:
  // their SVG scales as a whole through its viewBox. Only the rows themselves and
  // the room they leave for it are sized by the interface scale.
  const H = $derived(oneLine ? ONE_LINE_H : TWO_LINE_H);
  const rowPx = $derived(uiPx(H));
  const win = $derived(windowRange(scrollTop, viewH, rowPx, rows.length));
  const shown = $derived(rows.slice(win.start, win.end));
  // Rows stop taking the pointer while the list moves: see `listScrolling` in FileBrowser.
  let scrolling = $state(false);
  let scrollIdle: ReturnType<typeof setTimeout> | undefined;
  function onScroll(e: Event) {
    scrollTop = (e.currentTarget as HTMLElement).scrollTop;
    scrolling = true;
    clearTimeout(scrollIdle);
    scrollIdle = setTimeout(() => (scrolling = false), 150);
  }

  const filtered = $derived(isFiltered(filter));
  const commits = $derived(rows.map((r) => r.commit));
  // The commits of the current branch stand out; a search shows scattered commits,
  // where what HEAD reaches says nothing, and the current branch's own history is
  // all of it.
  const onHead = $derived(
    settings.gitHighlightCurrent && !filtered && filter.branch !== CURRENT_BRANCH
      ? reachableFromHead(commits)
      : new Set<string>(),
  );
  const authors = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const c of commits) seen.set(c.author, (seen.get(c.author) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  });

  // The line under the pointer stands out, the rest step back.
  let hoverLine = $state<number | null>(null);
  const lineOpacity = (line: number): number => (hoverLine === null || hoverLine === line ? 1 : 0.18);
  const rail = (color: number): string => `var(--color-rail-${color})`;

  const subjectTone = (c: GitCommit): string =>
    c.parents.length > 1
      ? "text-muted"
      : onHead.size === 0 || onHead.has(c.hash)
        ? "text-text"
        : "text-text/70";
  const differentCommitter = (c: GitCommit): boolean => !!c.committer && c.committer !== c.author;

  let selected = $state<string | null>(null);
  // What the query added to the selected commit; null until it answers.
  let detail = $state<CommitDetail | null>(null);
  // Which parent a merge's files are told against (v1.34): the first — what came
  // into the branch — unless the user picked another. A new commit starts at 1.
  let mergeParent = $state(1);
  let loadingDetail = $state(false);
  let detailFailed = $state(false);
  // Directories of the selected commit's file tree the user folded.
  let closedDirs = $state<ReadonlySet<string>>(new Set());
  const sel = $derived(selected ? rows.find((r) => r.commit.hash === selected)?.commit : undefined);

  // Width of the row the list and the details share, px.
  let rowWidth = $state(0);
  // Beside the list only in a wide panel, and only while the row holds two parts;
  // there is no width threshold of its own (`fitsBeside`).
  const beside = $derived(wide && fitsBeside(rowWidth));
  // The user picked it, rather than the column beside the list showing the top one.
  let picked = false;

  // Beside the list the details are always on screen: nothing picked, the commit
  // HEAD stands on. In the strip nothing opens by itself, and what opened by itself
  // does not follow the panel there.
  $effect(() => {
    if (beside && rows.length && !sel) {
      const top = rows.find((r) => r.commit.head) ?? rows[0];
      untrack(() => void open(top.commit.hash));
    } else if (!beside && selected && !picked) {
      untrack(() => closeDetail());
    }
  });

  // Asked from the branch tree: this commit, on screen and selected.
  $effect(() => {
    const ask = reveal;
    if (!ask) return;
    untrack(() => {
      const at = rows.findIndex((r) => r.commit.hash === ask.hash);
      if (at < 0) return;
      picked = true;
      if (selected !== ask.hash) void open(ask.hash);
      const top = Math.max(0, at * rowPx - viewH / 2 + rowPx / 2);
      scrollTop = top;
      if (listEl) listEl.scrollTop = top;
    });
  });

  // Where the commit stands among the branches: comes after the details, or never.
  let contained = $state<string[] | null>(null);

  // Context menu.
  let listHeader = $state<{ contextItems(): MenuItem[] }>();
  function openListMenu(e: MouseEvent, items: MenuItem[] = []) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = { x: e.clientX, y: e.clientY, items: [
      ...items, ...(items.length ? [{ kind: "separator" as const }] : []),
      ...(listHeader?.contextItems() ?? []), ...panelItems(),
    ] };
  }
  let ctxMenu = $state<OpenMenu | null>(null);

  // Name prompt (create branch / tag from a commit).
  let prompt = $state<{ kind: "branch" | "tag"; hash: string } | null>(null);
  let promptName = $state("");

  function closeDetail() {
    selected = null;
    detail = null;
    contained = null;
    loadingDetail = false;
    detailFailed = false;
    picked = false;
  }

  /** The answer for `hash`, or null when it is not one. A merge takes a second call. */
  async function readDetail(commit: GitCommit, parent: number): Promise<CommitDetail | null> {
    const res = await runQuery(commitDetailArgs(commit.hash));
    const parsed = res.exitCode === 0 ? parseCommitDetail(res.stdout) : null;
    if (!parsed || commit.parents.length < 2) return parsed;
    // `git show` lists nothing for a clean merge: its files are its diff
    // against a parent, and the pane says which one.
    const diff = await runQuery(mergeFilesArgs(commit.hash, parent));
    return diff.exitCode === 0 ? { ...parsed, files: parseRawNumstatZ(diff.stdout) } : null;
  }

  /** Tell the open merge's files against another of its parents. */
  async function pickParent(parent: number) {
    const hash = selected;
    const commit = rows.find((r) => r.commit.hash === hash)?.commit;
    if (!hash || !commit || commit.parents.length < 2 || parent === mergeParent) return;
    mergeParent = parent;
    loadingDetail = true;
    detailFailed = false;
    let answer: CommitDetail | null;
    try {
      const diff = await runQuery(mergeFilesArgs(hash, parent));
      answer = diff.exitCode === 0 && detail ? { ...detail, files: parseRawNumstatZ(diff.stdout) } : null;
    } catch {
      answer = null;
    }
    // Another commit or another parent was picked meanwhile: that answer wins.
    if (selected !== hash || mergeParent !== parent) return;
    closedDirs = new Set();
    detail = answer;
    detailFailed = answer === null;
    loadingDetail = false;
  }

  /** A click on a row: another commit opens; the one open closes where it can close. */
  function select(hash: string) {
    if (selected === hash) {
      if (!beside) closeDetail();
      return;
    }
    picked = true;
    void open(hash);
  }

  async function open(hash: string) {
    const commit = rows.find((r) => r.commit.hash === hash)?.commit;
    if (!commit) return;
    selected = hash;
    detail = null;
    mergeParent = 1;
    contained = null;
    detailFailed = false;
    closedDirs = new Set();
    loadingDetail = true;
    void readContained(hash);
    let answer: CommitDetail | null;
    try {
      answer = await readDetail(commit, 1);
    } catch {
      answer = null;
    }
    // Another commit was picked while this one was being read: its answer wins.
    if (selected !== hash) return;
    detail = answer;
    detailFailed = answer === null;
    loadingDetail = false;
  }

  /** The branches a commit is on. A failure leaves the row out: it adds, it does not decide. */
  async function readContained(hash: string) {
    try {
      const res = await runQuery(branchContainsArgs(hash));
      if (selected === hash && res.exitCode === 0) contained = parseContains(res.stdout);
    } catch (e) {
      /* the details stand without it */
      swallowed("git", "the branches holding the commit were not found", e);
    }
  }

  function toggleDir(path: string) {
    const next = new Set(closedDirs);
    if (!next.delete(path)) next.add(path);
    closedDirs = next;
  }

  function foldAll(fold: boolean) {
    closedDirs = fold ? commitTreeDirs(detail?.files ?? []) : new Set();
  }

  async function showCommitDiff(commit: GitCommit) {
    const res = await runQuery(commitDiffArgs(commit.hash, commit.parents.length > 1, mergeParent));
    openDiff(`${commit.short} · ${commit.subject}`, parseDiff(res.stdout));
  }

  function openFileMenu(e: MouseEvent, commit: GitCommit, file: CommitFile) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { icon: "code", label: t("git.openDiff"), onSelect: () => showFile(commit, file) },
        { icon: "history", label: t("git.fileHistory"), onSelect: () => onfilehistory?.(file.path) },
        { kind: "separator" },
        { icon: "copy", label: t("git.copyPath"), onSelect: () => copyText(file.path) },
      ],
    };
  }

  async function showFile(commit: GitCommit, file: CommitFile) {
    const args =
      commit.parents.length > 1
        ? mergeFileDiffArgs(commit.hash, file.path, mergeParent)
        : showFileArgs(commit.hash, file.path);
    const res = await runQuery(args);
    openDiff(file.path, parseDiff(res.stdout));
  }

  // Build the right-click actions as a declarative list for the shared
  // ContextMenu. Each item's closure captures `commit` directly (no staleness),
  // and ContextMenu closes the menu before running the action. Prod-protection is
  // unchanged: `run(…, { destructive })` still confirms on prod servers.
  function openMenu(e: MouseEvent, commit: GitCommit) {
    e.preventDefault();
    const items: MenuItem[] = [
      {
        icon: "gitCommit",
        label: t("git.ctxCheckout"),
        onSelect: () => run(checkoutCommitArgs(commit.hash), { destructive: true }),
      },
      {
        icon: "gitBranch",
        label: t("git.ctxCreateBranch"),
        onSelect: () => startPrompt("branch", commit.hash),
      },
      { icon: "tag", label: t("git.ctxCreateTag"), onSelect: () => startPrompt("tag", commit.hash) },
      { kind: "separator" },
      {
        icon: "gitMerge",
        label: t("git.ctxCherryPick"),
        onSelect: () => run(cherryPickArgs(commit.hash), { successKey: "git.cherryPicked" }),
      },
      {
        icon: "history",
        label: t("git.ctxRevert"),
        onSelect: () => run(revertArgs(commit.hash), { successKey: "git.reverted" }),
      },
      {
        kind: "submenu",
        key: "reset",
        icon: "refresh",
        label: t("git.ctxReset"),
        items: RESET_MODES.map((mode) => ({
          label: mode === "hard" ? `${mode} (${t("git.destructive")})` : mode,
          danger: mode === "hard",
          onSelect: () => run(resetArgs(commit.hash, mode), { destructive: mode === "hard" }),
        })),
      },
      { kind: "separator" },
      { icon: "code", label: t("git.ctxCompare"), onSelect: () => compareWorking(commit) },
      { kind: "separator" },
      { icon: "copy", label: t("git.ctxCopySha"), onSelect: () => copySha(commit) },
      { icon: "copy", label: t("git.ctxCopyMsg"), onSelect: () => copyMsg(commit) },
      { icon: "cloud", label: t("git.ctxCopyLink"), onSelect: () => copyLink(commit) },
    ];
    openListMenu(e, items);
  }

  async function copyText(text: string) {
    await writeClipboard(text);
    notifySuccess(t("git.copied"), { source: "git" });
  }
  const copySha = (c: GitCommit) => copyText(c.hash);
  async function copyMsg(c: GitCommit) {
    await writeClipboard(c.subject);
    notifySuccess(t("git.copied"), { source: "git" });
  }
  async function copyLink(c: GitCommit) {
    const res = await runQuery(remoteUrlArgs());
    const url = res.exitCode === 0 ? commitWebUrl(res.stdout.trim(), c.hash) : null;
    if (!url) {
      notifyError(t("git.noRemoteLink"), { source: "git" });
      return;
    }
    await writeClipboard(url);
    notifySuccess(t("git.copied"), { source: "git" });
  }
  async function compareWorking(c: GitCommit) {
    const res = await runQuery(diffCommitWorkingArgs(c.hash));
    openDiff(`${c.short} ↔ ${t("git.workingTree")}`, parseDiff(res.stdout));
  }

  function startPrompt(kind: "branch" | "tag", hash: string) {
    prompt = { kind, hash };
    promptName = "";
  }
  async function confirmPrompt() {
    const name = promptName.trim();
    if (!name || !prompt) {
      prompt = null;
      return;
    }
    const args =
      prompt.kind === "branch" ? createBranchArgs(name, prompt.hash) : tagArgs(name, prompt.hash);
    const ok = await run(args, {
      successKey: prompt.kind === "branch" ? "git.branchCreated" : "git.tagCreated",
    });
    if (ok) prompt = null;
  }

</script>

{#if rows.length === 0 && !filtered && !searchError}
  <div role="presentation" class="h-full" oncontextmenu={(e) => openListMenu(e)} data-testid="git-graph-empty"><p class="px-3 py-6 text-center text-xs text-muted">{t("git.noCommits")}</p></div>
{:else}
  <div class="relative flex h-full min-h-0 text-xs {beside ? '' : 'flex-col'}" bind:clientWidth={rowWidth} data-testid="git-graph-row">
    <!-- The list and its search. It holds no dialog of its own: the filter bar's
         stand beside it, and a commit's menu stands at the root. -->
    <div
      class="flex min-h-0 min-w-0 flex-col {beside ? 'shrink-0' : 'flex-1'}"
      data-morph
      style:width={beside ? partWidth("gitCommit", rowWidth) : null}
      role="presentation"
      oncontextmenu={(e) => openListMenu(e)}
      data-testid="git-graph-column"
    >
      {#if onfilter}
        <GitLogFilter bind:this={listHeader} {filter} full={oneLine} {authors} {branches} {onfilter} />
      {/if}
      {#if searchError}
        <p class="border-b border-edge px-2 py-1 text-meta text-bad" data-testid="git-search-error">{t("git.searchFailed", { error: searchError })}</p>
      {/if}
      <div
        class="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
        bind:this={listEl}
        bind:clientWidth={listWidth}
        bind:clientHeight={viewH}
        onscroll={onScroll}
        data-testid="git-graph"
      >
        {#if rows.length === 0}
          <p class="px-3 py-6 text-center text-xs text-muted" data-testid="git-no-matches">{t("git.noMatches")}</p>
        {/if}
        <div class="relative" style:height={`${win.totalHeight}px`}>
          <!-- Continuous rail overlay — one SVG for the whole column, drawn near the view. -->
          <svg
            class="pointer-events-none absolute left-0 top-0"
            width={uiPx(graphW)}
            height={win.totalHeight}
            viewBox="0 0 {graphW} {rows.length * H}"
            aria-hidden="true"
            data-testid="git-rails"
          >
            {#each shown as row, j (row.commit.hash)}
              {@const cy = (win.start + j) * H + H / 2}
              {#each row.edges as edge, n (n)}
                <path d={edgePath(edge, cy, cy + H, x)} fill="none" stroke={rail(edge.color)} stroke-width="1.6" stroke-linecap="round" opacity={lineOpacity(edge.line)} data-line={edge.line} />
              {/each}
              {#if row.cut && !filtered}
                <path d={`M${x(row.col)} ${cy}V${cy + H / 2}`} fill="none" stroke={rail(row.color)} stroke-width="1.6" stroke-dasharray="2 3" opacity={lineOpacity(row.line)} data-testid="git-rail-cut" />
              {/if}
            {/each}
            {#each shown as row, j (row.commit.hash)}
              {@const cy = (win.start + j) * H + H / 2}
              {#if row.commit.head}
                <circle cx={x(row.col)} cy={cy} r={R + 2.5} fill="none" stroke={rail(row.color)} stroke-width="1.2" opacity={0.7 * lineOpacity(row.line)} />
              {/if}
              {#if row.commit.parents.length > 1}
                <!-- merge node: hollow -->
                <circle cx={x(row.col)} cy={cy} r={R - 0.2} fill="var(--color-panel-alt)" stroke={rail(row.color)} stroke-width="1.6" opacity={lineOpacity(row.line)} />
              {:else}
                <circle cx={x(row.col)} cy={cy} r={R} fill={rail(row.color)} opacity={lineOpacity(row.line)} />
              {/if}
            {/each}
          </svg>

          <!-- Commit rows (fixed height each, so the SVG stays aligned). -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            style:transform={`translateY(${win.padTop}px)`}
            class={scrolling ? "pointer-events-none" : ""}
            onmouseleave={() => (hoverLine = null)}
          >
            {#each shown as row (row.commit.hash)}
              {@const c = row.commit}
              {@const labels = refLabels(c.refs, settings.gitShowTags)}
              <button
                type="button"
                style:height={`${rowPx}px`}
                style:padding-left={`${uiPx(graphW)}px`}
                class="flex w-full items-center gap-1.5 pr-2 text-left {selected === c.hash
                  ? 'bg-edge/60'
                  : onHead.has(c.hash)
                    ? 'bg-accent/5'
                    : ''} hover:bg-edge/40"
                use:tooltip={rowTooltip(c)}
                data-testid="git-row"
                data-on-head={onHead.has(c.hash)}
                onmouseenter={() => (hoverLine = row.line)}
                onclick={() => select(c.hash)}
                oncontextmenu={(e) => openMenu(e, c)}
              >
                {#if oneLine}
                  <span class="min-w-0 truncate {subjectTone(c)}">{c.subject}</span>
                  <span class="ml-auto flex min-w-0 max-w-[45%] shrink-0 items-center justify-end gap-1 overflow-hidden pl-1">
                    {#each labels.slice(0, ROW_LABELS) as label (`${label.kind}:${label.name}`)}
                      <GitRefChip {label} color={row.color} flat />
                    {/each}
                    {#if labels.length > ROW_LABELS}
                      <span class="shrink-0 text-caption text-muted">+{labels.length - ROW_LABELS}</span>
                    {/if}
                  </span>
                  <span class="w-32 shrink-0 truncate text-meta text-muted" data-testid="git-row-author">{c.author}{differentCommitter(c) ? "*" : ""}</span>
                  <span class="w-28 shrink-0 text-right text-caption tabular-nums text-muted" data-testid="git-row-moment">{whenLabel(c.timestamp)}</span>
                {:else}
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate {subjectTone(c)}">{c.subject}</span>
                      <span class="shrink-0 text-caption text-muted" data-testid="git-row-age">{gitAge(c.timestamp)}</span>
                    </span>
                    <span class="flex h-4 min-w-0 items-center gap-1.5">
                      {#if labels.length}
                        <span class="flex min-w-0 max-w-[62%] items-center gap-1">
                          <GitRefChip label={labels[0]} color={row.color} />
                          {#if labels.length > 1}<span class="shrink-0 text-caption text-muted">+{labels.length - 1}</span>{/if}
                        </span>
                      {/if}
                      <span class="min-w-0 truncate text-meta text-muted" data-testid="git-row-author">{c.author}{differentCommitter(c) ? "*" : ""}</span>
                    </span>
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
        <!-- History does not just stop: it says it was cut, and where more comes from. -->
        {#if rows.length && (hasMore || rows.length >= LOG_CAP)}
          <div class="flex items-center justify-center gap-2 border-t border-edge px-2 py-1 text-caption text-muted" data-testid="git-log-more">
            <span>{filtered ? t("git.shownFound", { n: rows.length }) : t("git.shownLast", { n: rows.length })}</span>
            {#if hasMore}
              <button type="button" class="text-accent hover:underline disabled:opacity-40" disabled={loadingMore} data-testid="git-load-more" onclick={() => onloadmore?.()}>{t("git.loadMore")}</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- The selected commit's details: one content, two places. -->
    {#snippet commitDetail(commit: GitCommit, fill: boolean)}
      <GitCommitDetail
        {commit}
        {detail}
        {contained}
        loading={loadingDetail}
        failed={detailFailed}
        closed={closedDirs}
        parent={mergeParent}
        onparent={(n) => void pickParent(n)}
        known={(hash) => rows.some((r) => r.commit.hash === hash)}
        color={rows.find((r) => r.commit.hash === commit.hash)?.color ?? 0}
        {fill}
        ontoggle={toggleDir}
        onfoldall={foldAll}
        ondiff={() => showCommitDiff(commit)}
        onopenfile={(file) => showFile(commit, file)}
        onfilemenu={(e, file) => openFileMenu(e, commit, file)}
        onselect={(hash) => select(hash)}
        oncopy={(text) => copyText(text)}
      />
    {/snippet}
    {#if sel}
      {#if beside}
        <PanelDivider split="gitCommit" width={rowWidth} />
        <div class="min-h-0 min-w-0 flex-1" data-testid="git-commit-side" in:aside={motion(MOTION_BASE)} out:aside={motion(MOTION_BASE)}>
          <SidePane title={`${sel.short} · ${sel.subject}`} testid="git-commit-pane">
            {@render commitDetail(sel, true)}
          </SidePane>
        </div>
      {:else}
        <div
          class="max-h-[55%] shrink-0 overflow-auto border-t border-edge bg-panel/60 px-2 py-1.5"
          data-testid="git-commit-strip"
        >
          {@render commitDetail(sel, false)}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<ContextMenu menu={ctxMenu} onclose={() => (ctxMenu = null)} />

<!-- Create branch / tag name prompt -->
<Modal
  open={!!prompt}
  title={prompt?.kind === "tag" ? t("git.createTagTitle") : t("git.createBranchTitle")}
  onclose={() => (prompt = null)}
>
  <!-- svelte-ignore a11y_autofocus -->
  <input
    bind:value={promptName}
    autofocus
    placeholder={prompt?.kind === "tag" ? t("git.tagNamePlaceholder") : t("git.branchNamePlaceholder")}
    class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
    onkeydown={(e) => {
      if (e.key === "Enter") confirmPrompt();
      if (e.key === "Escape") prompt = null;
    }}
  />
  <div class="mt-3 flex justify-end gap-2">
    <button class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => (prompt = null)}>{t("common.cancel")}</button>
    <button class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover disabled:opacity-40" disabled={!promptName.trim()} onclick={confirmPrompt}>{t("common.create")}</button>
  </div>
</Modal>
