<script lang="ts">
  // One commit, opened from the history (v1.15): the files it touched as a tree,
  // its message, who wrote it and when, and where it sits (parents, branches and
  // tags on it). Presentational — `GitGraph` owns the selection and the query;
  // this draws what it is handed.
  //
  // The content only: a wide panel puts it into a `SidePane` beside the history,
  // a narrow one into the strip under it. It owns no dialog and no menu — a file's
  // diff is asked of the panel (`onopenfile`) — because that is what lets the same
  // component stand in both places (`panelcontainer.guard`).
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import type { CommitDetail, CommitFile, GitCommit } from "./git";
  import {
    COMMIT_FILES_SHOWN,
    commitMoment,
    commitTree,
    committerLine,
    fileStatusColor,
    gitAge,
  } from "./gitview";
  import { t } from "./i18n";

  let {
    commit,
    detail = null,
    loading = false,
    failed = false,
    closed = new Set<string>(),
    known = () => false,
    fill = false,
    ontoggle,
    onopenfile,
    onselect,
    oncopy,
  }: {
    commit: GitCommit;
    /** What the query added: emails, the committer, the files. Null until it answers. */
    detail?: CommitDetail | null;
    loading?: boolean;
    /** The query came back with something that is not a commit. */
    failed?: boolean;
    /** Directories of the file tree the user folded. */
    closed?: ReadonlySet<string>;
    /** Whether a commit with this hash is in the history, so a parent can be jumped to. */
    known?: (hash: string) => boolean;
    /** Take the height of the place it stands in (a pane beside the list) and scroll there. */
    fill?: boolean;
    ontoggle?: (dir: string) => void;
    onopenfile?: (file: CommitFile) => void;
    onselect?: (hash: string) => void;
    oncopy?: (text: string) => void;
  } = $props();

  const merge = $derived(commit.parents.length > 1);
  const files = $derived(detail?.files ?? []);
  // A commit that touches thousands of files is drawn up to a limit, and says so.
  const tree = $derived(commitTree(files.slice(0, COMMIT_FILES_SHOWN), closed));
  const hidden = $derived(Math.max(0, files.length - COMMIT_FILES_SHOWN));
  const applied = $derived(detail ? committerLine(commit, detail) : null);
  /** Left padding of a tree row, px: one step a level. */
  const indent = (depth: number): string => `${4 + depth * 12}px`;
</script>

<!-- The files first, where the strip under the history always had them; the
     message and the facts below. In a pane the two scroll apart, so a commit of
     three hundred files does not push its author out of reach. -->
<div
  class="flex flex-col text-xs {fill ? 'min-h-0 flex-1' : ''}"
  data-testid="git-commit-detail"
  data-commit={commit.hash}
>
  <div class={fill ? "min-h-0 flex-1 overflow-auto" : ""} data-testid="git-commit-files">
    <div class="mb-1 flex flex-wrap items-baseline gap-x-2 text-meta text-muted">
      <span>{detail ? t("git.detailFiles", { n: files.length }) : t("git.detailFilesTitle")}</span>
      <!-- A merge has no diff of its own: said where the list is, not in a hint. -->
      {#if merge && detail}
        <span class="text-caption" data-testid="git-commit-merge-note">{t("git.detailMergeNote")}</span>
      {/if}
    </div>
    {#if failed}
      <p class="py-1 text-caption text-bad" data-testid="git-commit-failed">{t("git.detailFailed")}</p>
    {:else if loading || !detail}
      <p class="py-1 text-caption text-muted">{t("git.loading")}</p>
    {:else if files.length === 0}
      <p class="py-1 text-caption text-muted">{t("git.noFiles")}</p>
    {:else}
      {#each tree as row (row.kind === "dir" ? `d:${row.path}` : `f:${row.file.path}`)}
        {#if row.kind === "dir"}
          <button
            type="button"
            class="flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left text-meta text-text/80 hover:bg-edge/50"
            style:padding-left={indent(row.depth)}
            aria-expanded={row.open}
            data-testid="git-commit-dir"
            onclick={() => ontoggle?.(row.path)}
          >
            <Icon name={row.open ? "chevronDown" : "chevronRight"} size={11} class="shrink-0 text-muted" />
            <Icon name="folder" size={12} class="shrink-0 text-muted" />
            <span class="min-w-0 truncate">{row.label}</span>
            <span class="shrink-0 text-caption text-muted">{row.count}</span>
          </button>
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left hover:bg-edge/50"
            style:padding-left={indent(row.depth)}
            use:tooltip={row.file.orig ? `${row.file.orig} → ${row.file.path}` : row.file.path}
            data-testid="git-commit-file"
            onclick={() => onopenfile?.(row.file)}
          >
            <span class="w-3 shrink-0 text-center font-mono text-caption {fileStatusColor(row.file.status)}">{row.file.status}</span>
            <span class="min-w-0 truncate text-meta text-text/80">{row.name}</span>
          </button>
        {/if}
      {/each}
      {#if hidden > 0}
        <p class="py-1 text-caption text-muted" data-testid="git-commit-more">{t("git.detailMore", { n: hidden })}</p>
      {/if}
    {/if}
  </div>

  <div
    class="mt-2 border-t border-edge pt-1.5 {fill ? 'max-h-[50%] shrink-0 overflow-auto' : ''}"
    data-testid="git-commit-info"
  >
    <p class="break-words font-medium text-text">{commit.subject}</p>
    {#if commit.body}
      <p class="mt-1 whitespace-pre-wrap break-words text-text/80" data-testid="git-commit-body">{commit.body}</p>
    {/if}

    <dl class="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-meta">
      <dt class="text-muted">{t("git.detailCommit")}</dt>
      <dd class="flex min-w-0 items-center gap-1">
        <span class="min-w-0 truncate font-mono text-text/90" use:tooltip={commit.hash}>{commit.hash}</span>
        {#if oncopy}
          <button
            type="button"
            class="flex shrink-0 items-center rounded p-0.5 text-muted hover:bg-edge hover:text-text"
            aria-label={t("git.ctxCopySha")}
            use:tooltip={t("git.ctxCopySha")}
            data-testid="git-commit-copy"
            onclick={() => oncopy?.(commit.hash)}
          >
            <Icon name="copy" size={12} />
          </button>
        {/if}
      </dd>

      <dt class="text-muted">{t("git.detailAuthor")}</dt>
      <dd class="min-w-0 break-words text-text/90" data-testid="git-commit-author">
        <!-- Spaces are written as expressions: Svelte drops one at the edge of a tag. -->
        {commit.author}{#if detail?.authorEmail}{" "}<span class="text-muted">&lt;{detail.authorEmail}&gt;</span>{/if}
      </dd>

      <dt class="text-muted">{t("git.detailDate")}</dt>
      <dd class="text-text/90">
        {commitMoment(commit.timestamp)}<span class="text-muted">{` · ${gitAge(commit.timestamp)}`}</span>
      </dd>

      {#if applied}
        <dt class="text-muted">{t("git.detailCommitter")}</dt>
        <dd class="min-w-0 break-words text-text/90" data-testid="git-commit-committer">
          {applied.who}{#if applied.email}{" "}<span class="text-muted">&lt;{applied.email}&gt;</span>{/if}<span
            class="text-muted">{` · ${commitMoment(applied.at)}`}</span>
        </dd>
      {/if}

      {#if commit.parents.length}
        <dt class="text-muted">{t("git.detailParents")}</dt>
        <dd class="flex min-w-0 flex-wrap gap-x-2 font-mono">
          {#each commit.parents as parent (parent)}
            {#if onselect && known(parent)}
              <button
                type="button"
                class="rounded text-accent hover:underline"
                data-testid="git-commit-parent"
                onclick={() => onselect?.(parent)}
              >
                {parent.slice(0, 7)}
              </button>
            {:else}
              <span class="text-text/80">{parent.slice(0, 7)}</span>
            {/if}
          {/each}
        </dd>
      {/if}

      {#if commit.refs.length}
        <dt class="text-muted">{t("git.detailRefs")}</dt>
        <dd class="flex min-w-0 flex-wrap gap-1">
          {#each commit.refs as ref (ref)}
            <span class="rounded-sm bg-accent/20 px-1 text-caption leading-tight text-accent">{ref}</span>
          {/each}
        </dd>
      {/if}
    </dl>
  </div>
</div>
