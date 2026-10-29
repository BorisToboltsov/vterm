<script lang="ts">
  // Commit graph sub-tab (Phase 29). Continuous single-SVG rail layout ("Contour"
  // style): one SVG overlays the whole scroll height so rails never break between
  // rows; commit rows are fixed-height HTML beneath it. Lane assignment + segments
  // come from buildGraph (pure). Right-click a commit → actions menu (checkout,
  // branch/tag here, reset, cherry-pick, revert, compare, copy).
  //
  // A selected commit opens its details (v1.15, `GitCommitDetail`): in a wide
  // panel beside the list, when the row holds both (`fitsBeside`); otherwise in a
  // strip under it. Never between the rows — they stay uniform, so the SVG stays
  // aligned. The list is a query container of its own: a wide list shows each
  // commit's author and the moment it was made, a narrow one only its age.
  import Modal from "./Modal.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import SidePane from "./SidePane.svelte";
  import PanelDivider from "./PanelDivider.svelte";
  import GitCommitDetail from "./GitCommitDetail.svelte";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import type {
    GraphRow,
    CommitDetail,
    CommitFile,
    GitCommit,
    ResetMode,
    DiffLine,
    GitRunOpts,
  } from "./git";
  import {
    commitDetailArgs,
    mergeFilesArgs,
    mergeFileDiffArgs,
    parseCommitDetail,
    parseNameStatusZ,
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
  import type { GitOutput } from "./api";
  import { tooltip } from "./actions/tooltip";
  import { commitMoment, commitTooltip, gitAge } from "./gitview";
  import { fitsBeside } from "./panelsplit";
  import { partWidth } from "./stores/panelsplit.svelte";
  import { writeClipboard } from "./clipboard";
  import { notifySuccess, notifyError } from "./stores/toasts.svelte";
  import { t } from "./i18n";

  let {
    rows,
    wide = false,
    run,
    runQuery,
    openDiff,
  }: {
    rows: GraphRow[];
    /** The panel is in its wide layout: a commit's details may stand beside the list. */
    wide?: boolean;
    run: (args: string[], opts?: GitRunOpts) => Promise<boolean>;
    runQuery: (args: string[]) => Promise<GitOutput>;
    openDiff: (title: string, lines: DiffLine[]) => void;
  } = $props();

  const RESET_MODES: ResetMode[] = ["soft", "mixed", "hard"];

  const H = 30; // fixed row height — the SVG bands are H tall, so alignment holds
  const COL_W = 16; // lane spacing
  const PAD = 12; // left padding before lane 0
  const R = 5; // node radius
  const MAX_LANES = 8; // clamp graph width in the narrow dock
  const x = (col: number) => PAD + Math.min(col, MAX_LANES) * COL_W;
  const laneCount = $derived(Math.max(1, ...rows.map((r) => Math.min(r.lanes, MAX_LANES + 1))));
  const graphW = $derived(PAD + laneCount * COL_W + 6);

  let selected = $state<string | null>(null);
  // What the query added to the selected commit; null until it answers.
  let detail = $state<CommitDetail | null>(null);
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

  // Context menu.
  let ctxMenu = $state<OpenMenu | null>(null);

  // Name prompt (create branch / tag from a commit).
  let prompt = $state<{ kind: "branch" | "tag"; hash: string } | null>(null);
  let promptName = $state("");

  // Build a full-height path for one segment, offset into row `i`'s band.
  function segPath(seg: GraphRow["segments"][number], i: number): string {
    const top = i * H;
    const mid = top + H / 2;
    const bot = top + H;
    let ax: number, ay: number, bx: number, by: number;
    if (seg.kind === "out") {
      ax = x(seg.from);
      ay = mid;
      bx = x(seg.to);
      by = bot;
    } else if (seg.kind === "in") {
      ax = x(seg.from);
      ay = top;
      bx = x(seg.to);
      by = mid;
    } else {
      ax = x(seg.from);
      ay = top;
      bx = x(seg.to);
      by = bot;
    }
    if (ax === bx) return `M${ax} ${ay} L${bx} ${by}`;
    const cy = (ay + by) / 2;
    return `M${ax} ${ay} C${ax} ${cy} ${bx} ${cy} ${bx} ${by}`;
  }

  function closeDetail() {
    selected = null;
    detail = null;
    loadingDetail = false;
    detailFailed = false;
  }

  /** The answer for `hash`, or null when it is not one. A merge takes a second call. */
  async function readDetail(commit: GitCommit): Promise<CommitDetail | null> {
    const res = await runQuery(commitDetailArgs(commit.hash));
    const parsed = res.exitCode === 0 ? parseCommitDetail(res.stdout) : null;
    if (!parsed || commit.parents.length < 2) return parsed;
    // `git show` lists nothing for a clean merge: its files are its diff
    // against the first parent, and the pane says that is what they are.
    const diff = await runQuery(mergeFilesArgs(commit.hash));
    return diff.exitCode === 0 ? { ...parsed, files: parseNameStatusZ(diff.stdout) } : null;
  }

  async function select(hash: string) {
    if (selected === hash) {
      closeDetail();
      return;
    }
    const commit = rows.find((r) => r.commit.hash === hash)?.commit;
    if (!commit) return;
    selected = hash;
    detail = null;
    detailFailed = false;
    closedDirs = new Set();
    loadingDetail = true;
    let answer: CommitDetail | null;
    try {
      answer = await readDetail(commit);
    } catch {
      answer = null;
    }
    // Another commit was picked while this one was being read: its answer wins.
    if (selected !== hash) return;
    detail = answer;
    detailFailed = answer === null;
    loadingDetail = false;
  }

  function toggleDir(path: string) {
    const next = new Set(closedDirs);
    if (!next.delete(path)) next.add(path);
    closedDirs = next;
  }

  async function showFile(commit: GitCommit, file: CommitFile) {
    const args =
      commit.parents.length > 1
        ? mergeFileDiffArgs(commit.hash, file.path)
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
      { icon: "check", label: t("git.ctxCreateTag"), onSelect: () => startPrompt("tag", commit.hash) },
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
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  async function copyText(text: string) {
    await writeClipboard(text);
    notifySuccess(t("git.copied"));
  }
  const copySha = (c: GitCommit) => copyText(c.hash);
  async function copyMsg(c: GitCommit) {
    await writeClipboard(c.subject);
    notifySuccess(t("git.copied"));
  }
  async function copyLink(c: GitCommit) {
    const res = await runQuery(remoteUrlArgs());
    const url = res.exitCode === 0 ? commitWebUrl(res.stdout.trim(), c.hash) : null;
    if (!url) {
      notifyError(t("git.noRemoteLink"));
      return;
    }
    await writeClipboard(url);
    notifySuccess(t("git.copied"));
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

{#if rows.length === 0}
  <p class="px-3 py-6 text-center text-xs text-muted">{t("git.noCommits")}</p>
{:else}
  <div class="flex h-full min-h-0 text-xs {beside ? '' : 'flex-col'}" bind:clientWidth={rowWidth}>
    <!-- `@container`: the list lays its rows out by its own width — it holds rows
         and the rail SVG, no dialog or menu (those stand beside the root). -->
    <div
      class="@container relative min-h-0 overflow-auto {beside && sel ? 'shrink-0' : 'flex-1'}"
      style:width={beside && sel ? partWidth("gitCommit", rowWidth) : null}
      data-testid="git-graph"
    >
      <!-- Continuous rail overlay — one SVG for the whole column. -->
      <svg
        class="pointer-events-none absolute left-0 top-0"
        width={graphW}
        height={rows.length * H}
        aria-hidden="true"
      >
        {#each rows as row, i (row.commit.hash)}
          {#each row.segments as seg, si (si)}
            <path d={segPath(seg, i)} fill="none" stroke={seg.color} stroke-width="2" stroke-linecap="round" />
          {/each}
        {/each}
        {#each rows as row, i (row.commit.hash)}
          {@const cy = i * H + H / 2}
          {#if row.commit.head}
            <circle cx={x(row.col)} cy={cy} r={R + 3} fill={row.color} opacity="0.25" />
          {/if}
          {#if row.commit.parents.length > 1}
            <!-- merge node: donut -->
            <circle cx={x(row.col)} cy={cy} r={R} fill={row.color} stroke="var(--color-panel-alt)" stroke-width="2" />
            <circle cx={x(row.col)} cy={cy} r={R * 0.4} fill="var(--color-panel-alt)" />
          {:else}
            <circle cx={x(row.col)} cy={cy} r={R} fill={row.color} stroke="var(--color-panel-alt)" stroke-width="2" />
          {/if}
        {/each}
      </svg>

      <!-- Commit rows (fixed height each, so the SVG stays aligned). -->
      {#each rows as row, i (row.commit.hash)}
        <button
          type="button"
          style="height:{H}px; padding-left:{graphW}px"
          class="flex w-full items-center gap-1.5 pr-1 text-left {i % 2 === 1
            ? 'bg-white/[0.015]'
            : ''} {selected === row.commit.hash
            ? 'bg-edge/60'
            : row.commit.head
              ? 'bg-accent/5'
              : ''} hover:bg-edge/40"
          use:tooltip={commitTooltip(row.commit)}
          onclick={() => select(row.commit.hash)}
          oncontextmenu={(e) => openMenu(e, row.commit)}
        >
          {#each row.commit.refs as ref (ref)}
            <span class="shrink-0 rounded-sm bg-accent/20 px-1 text-caption leading-tight text-accent">{ref}</span>
          {/each}
          <span class="min-w-0 flex-1 truncate {row.commit.head ? 'text-text' : 'text-text/90'}">{row.commit.subject}</span>
          <!-- A wide list: who and at what moment. A narrow one: how long ago. -->
          <span class="hidden w-32 shrink-0 truncate text-meta text-muted @wide:block" data-testid="git-row-author">{row.commit.author}</span>
          <span class="hidden w-28 shrink-0 text-right text-caption tabular-nums text-muted @wide:block" data-testid="git-row-moment">{commitMoment(row.commit.timestamp)}</span>
          <span class="shrink-0 text-caption text-muted @wide:hidden" data-testid="git-row-age">{gitAge(row.commit.timestamp)}</span>
        </button>
      {/each}
    </div>

    <!-- The selected commit's details: one content, two places. -->
    {#snippet commitDetail(commit: GitCommit, fill: boolean)}
      <GitCommitDetail
        {commit}
        {detail}
        loading={loadingDetail}
        failed={detailFailed}
        closed={closedDirs}
        known={(hash) => rows.some((r) => r.commit.hash === hash)}
        {fill}
        ontoggle={toggleDir}
        onopenfile={(file) => showFile(commit, file)}
        onselect={(hash) => select(hash)}
        oncopy={(text) => copyText(text)}
      />
    {/snippet}
    {#if sel}
      {#if beside}
        <PanelDivider split="gitCommit" width={rowWidth} />
        <div class="min-h-0 min-w-0 flex-1" data-testid="git-commit-side">
          <SidePane title={`${sel.short} · ${sel.subject}`} onclose={closeDetail} testid="git-commit-pane">
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
