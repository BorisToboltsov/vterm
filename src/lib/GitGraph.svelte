<script lang="ts">
  // Commit graph sub-tab (Phase 29). Continuous single-SVG rail layout ("Contour"
  // style): one SVG overlays the whole scroll height so rails never break between
  // rows; commit rows are fixed-height HTML beneath it. Lane assignment + segments
  // come from buildGraph (pure). Right-click a commit → actions menu (checkout,
  // branch/tag here, reset, cherry-pick, revert, compare, copy). Selected commit's
  // files show in a bottom strip (keeps rows uniform so the SVG stays aligned).
  import Modal from "./Modal.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import type { GraphRow, CommitFile, GitCommit, ResetMode, DiffLine } from "./git";
  import {
    commitFilesArgs,
    parseCommitFiles,
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
  import { fileStatusColor, relTime, commitTooltip } from "./gitview";
  import { writeClipboard } from "./clipboard";
  import { notifySuccess, notifyError } from "./stores/toasts.svelte";
  import { t } from "./i18n";

  let {
    rows,
    run,
    runQuery,
    openDiff,
  }: {
    rows: GraphRow[];
    run: (args: string[], opts?: { destructive?: boolean; echo?: boolean; successKey?: string }) => Promise<boolean>;
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
  let files = $state<CommitFile[]>([]);
  let loadingFiles = $state(false);

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

  async function select(hash: string) {
    if (selected === hash) {
      selected = null;
      files = [];
      return;
    }
    selected = hash;
    files = [];
    loadingFiles = true;
    try {
      const res = await runQuery(commitFilesArgs(hash));
      files = parseCommitFiles(res.stdout);
    } finally {
      loadingFiles = false;
    }
  }

  async function showFile(hash: string, path: string) {
    const res = await runQuery(showFileArgs(hash, path));
    openDiff(path, parseDiff(res.stdout));
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

  async function copySha(c: GitCommit) {
    await writeClipboard(c.hash);
    notifySuccess(t("git.copied"));
  }
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
  <div class="flex h-full min-h-0 flex-col text-xs">
    <div class="relative min-h-0 flex-1 overflow-auto" data-testid="git-graph">
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
          <span class="truncate {row.commit.head ? 'text-text' : 'text-text/90'}">{row.commit.subject}</span>
          <span class="ml-auto shrink-0 text-caption text-muted">{relTime(row.commit.timestamp)}</span>
        </button>
      {/each}
    </div>

    <!-- Selected-commit detail strip. -->
    {#if selected}
      {@const sel = rows.find((r) => r.commit.hash === selected)?.commit}
      {#if sel}
        <div class="max-h-44 shrink-0 overflow-auto border-t border-edge bg-panel/60 px-2 py-1.5">
          <div class="mb-1 flex items-center gap-1.5 text-meta">
            <span class="font-mono text-muted">{sel.short}</span>
            <span class="truncate text-text/80">{sel.subject}</span>
          </div>
          {#if loadingFiles}
            <p class="py-1 text-caption text-muted">{t("git.loading")}</p>
          {:else if files.length === 0}
            <p class="py-1 text-caption text-muted">{t("git.noFiles")}</p>
          {:else}
            {#each files as f (f.path)}
              <button
                type="button"
                class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-edge/50"
                onclick={() => showFile(sel.hash, f.path)}
              >
                <span class="w-3 shrink-0 text-center font-mono text-caption {fileStatusColor(f.status)}">{f.status}</span>
                <span class="truncate text-meta text-text/80">{f.path}</span>
              </button>
            {/each}
          {/if}
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
