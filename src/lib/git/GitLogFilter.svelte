<script lang="ts">
  // The search and filters over the history. Git applies them (`logArgs`), so a
  // search reaches commits that were never loaded. With room for it each filter is
  // a button of its own; in a narrow list all of them stand behind one.
  import FilterField from "../ui/FilterField.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import Icon from "../ui/Icon.svelte";
  import Modal from "../ui/Modal.svelte";
  import { tooltip } from "../actions/tooltip";
  import type { MenuAction, MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { settings } from "../settings/settings.svelte";
  import {
    CURRENT_BRANCH,
    isFiltered,
    LOG_SINCE,
    scopeFilter,
    type GitBranch,
    type LogFilter,
    type LogScope,
    type LogSince,
  } from "./git";
  import { untrack } from "svelte";
  import { t } from "../i18n";

  let {
    filter,
    full = false,
    authors = [],
    branches = [],
    onfilter,
  }: {
    filter: LogFilter;
    /** The list has room for a button per filter. */
    full?: boolean;
    /** Who wrote the commits loaded, the most frequent first. */
    authors?: readonly string[];
    branches?: readonly GitBranch[];
    onfilter: (filter: LogFilter) => void;
  } = $props();

  const SEARCH_DELAY_MS = 350;
  /** Branches the filter menu offers, beside the current one and the favourites. */
  const RECENT_BRANCHES = 12;
  const MENU_AUTHORS = 15;

  let draft = $state(untrack(() => filter.text));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let menu = $state<OpenMenu | null>(null);
  let pathOpen = $state(false);
  let pathDraft = $state("");

  // What set the filter from outside (a reset, a file's history) shows in the box.
  $effect(() => {
    const text = filter.text;
    untrack(() => {
      if (text !== draft) draft = text;
    });
  });

  function commitText() {
    clearTimeout(timer);
    if (draft !== filter.text) onfilter({ ...filter, text: draft });
  }
  function typed() {
    clearTimeout(timer);
    timer = setTimeout(commitText, SEARCH_DELAY_MS);
  }
  function clearText() {
    clearTimeout(timer);
    draft = "";
    if (filter.text) onfilter({ ...filter, text: "" });
  }

  const SINCE_LABEL = (since: LogSince): string =>
    since === "today"
      ? t("git.filterToday")
      : since === "week"
        ? t("git.filterWeek")
        : since === "month"
          ? t("git.filterMonth")
          : t("git.filterYear");

  const refName = (ref: string): string => ref.replace(/^refs\/(heads|remotes|tags)\//, "");
  /** One branch by its name, not the scope the history is read in. */
  const named = (branch: string | null): branch is string => !!branch && branch !== CURRENT_BRANCH;
  /** The current branch or every ref: the user's choice, kept for the next history (ADR 0067). */
  function pickScope(scope: LogScope) {
    settings.gitLogScope = scope;
    onfilter({ ...filter, branch: scopeFilter(scope).branch });
  }

  function branchItems(): MenuAction[] {
    const locals = branches.filter((b) => !b.remote);
    const first = locals.filter((b) => b.current || settings.gitFavoriteBranches.includes(b.name));
    const recent = locals
      .filter((b) => !first.includes(b))
      .sort((a, b) => b.date - a.date)
      .slice(0, RECENT_BRANCHES);
    const pickable = [...first, ...recent].map((b) => b.fullRef);
    if (named(filter.branch) && !pickable.includes(filter.branch)) pickable.unshift(filter.branch);
    return [
      { label: t("git.filterBranchAll"), checked: !filter.branch, onSelect: () => pickScope("all") },
      { label: t("git.filterBranchCurrent"), checked: filter.branch === CURRENT_BRANCH, onSelect: () => pickScope("head") },
      ...pickable.map((ref) => ({
        label: refName(ref),
        checked: filter.branch === ref,
        onSelect: () => onfilter({ ...filter, branch: ref }),
      })),
    ];
  }
  function authorItems(): MenuAction[] {
    const names = authors.slice(0, MENU_AUTHORS);
    if (filter.author && !names.includes(filter.author)) names.unshift(filter.author);
    return [
      { label: t("git.filterAuthorAll"), checked: !filter.author, onSelect: () => onfilter({ ...filter, author: null }) },
      ...names.map((name) => ({
        label: name,
        checked: filter.author === name,
        onSelect: () => onfilter({ ...filter, author: name }),
      })),
    ];
  }
  function dateItems(): MenuAction[] {
    return [
      { label: t("git.filterDateAll"), checked: !filter.since, onSelect: () => onfilter({ ...filter, since: null }) },
      ...LOG_SINCE.map((since) => ({
        label: SINCE_LABEL(since),
        checked: filter.since === since,
        onSelect: () => onfilter({ ...filter, since }),
      })),
    ];
  }
  function pathItems(): MenuAction[] {
    return [
      {
        label: t("git.filterPathAll"),
        checked: !filter.path,
        onSelect: () => onfilter({ ...filter, path: null, follow: false }),
      },
      { label: filter.path ?? `${t("git.filterPath")}…`, checked: !!filter.path, onSelect: askPath },
    ];
  }
  function askPath() {
    pathDraft = filter.path ?? "";
    pathOpen = true;
  }
  function applyPath() {
    const path = pathDraft.trim();
    pathOpen = false;
    onfilter({ ...filter, path: path || null, follow: false });
  }

  function openAt(e: MouseEvent, items: MenuItem[]) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = { x: r.left, y: r.bottom + 2, items };
  }

  function allFiltersMenu(): MenuItem[] {
    const items: MenuItem[] = [
      { kind: "submenu", key: "branch", icon: "gitBranch", label: filterLabel("branch"), items: branchItems() },
      { kind: "submenu", key: "author", icon: "users", label: filterLabel("author"), items: authorItems() },
      { kind: "submenu", key: "date", icon: "clock", label: filterLabel("date"), items: dateItems() },
      { kind: "submenu", key: "path", icon: "folder", label: filterLabel("path"), items: pathItems() },
      { kind: "separator" },
      { label: t("git.searchRegex"), checked: filter.regex, onSelect: () => onfilter({ ...filter, regex: !filter.regex }) },
      { label: t("git.searchCase"), checked: filter.matchCase, onSelect: () => onfilter({ ...filter, matchCase: !filter.matchCase }) },
    ];
    if (isFiltered(filter)) {
      items.push({ kind: "separator" }, { icon: "close", label: t("git.filterReset"), onSelect: reset });
    }
    return items;
  }
  function viewMenu(): MenuItem[] {
    return [
      { label: t("git.viewTags"), checked: settings.gitShowTags, onSelect: () => (settings.gitShowTags = !settings.gitShowTags) },
      {
        label: t("git.viewCurrent"),
        checked: settings.gitHighlightCurrent,
        // Every commit of the current branch's history is on it: nothing to stand out from.
        disabled: filter.branch === CURRENT_BRANCH,
        onSelect: () => (settings.gitHighlightCurrent = !settings.gitHighlightCurrent),
      },
    ];
  }
  let searchField: FilterField | undefined;
  export function contextItems(): MenuItem[] {
    return [
      { kind: "submenu", key: "history-view", icon: "eye", label: t("list.view"), items: viewMenu() },
      { kind: "submenu", key: "history-filters", icon: "filter", label: t("list.filters"), items: [
        { icon: "search", label: t("list.find"), onSelect: () => searchField?.focus() },
        ...allFiltersMenu(),
      ] },
    ];
  }
  function reset() {
    clearTimeout(timer);
    draft = "";
    onfilter(scopeFilter(settings.gitLogScope));
  }

  /** A filter's button says what it is set to. */
  function filterLabel(which: "branch" | "author" | "date" | "path"): string {
    if (which === "branch") {
      if (filter.branch === CURRENT_BRANCH) return t("git.filterBranchCurrent");
      return filter.branch ? refName(filter.branch) : t("git.filterBranch");
    }
    if (which === "author") return filter.author ?? t("git.filterAuthor");
    if (which === "date") return filter.since ? SINCE_LABEL(filter.since) : t("git.filterDate");
    return filter.path ?? t("git.filterPath");
  }
  const active = (which: "branch" | "author" | "date" | "path"): boolean =>
    which === "branch" ? named(filter.branch) : which === "author" ? !!filter.author : which === "date" ? !!filter.since : !!filter.path;
  const FILTERS = ["branch", "author", "date", "path"] as const;
  const itemsOf = (which: (typeof FILTERS)[number]): MenuItem[] =>
    which === "branch" ? branchItems() : which === "author" ? authorItems() : which === "date" ? dateItems() : pathItems();
  const anyHidden = $derived(!full && (active("branch") || active("author") || active("date") || active("path")));
</script>

<div class="flex min-w-0 shrink-0 items-center gap-1 border-b border-edge px-2 py-1 text-meta text-muted" data-testid="git-log-filter">
  <FilterField
    bind:this={searchField}
    value={draft}
    oninput={(v) => {
      draft = v;
      if (v === "") clearText();
      else typed();
    }}
    onkeydown={(e) => {
      if (e.key === "Enter") commitText();
    }}
    placeholder={t("git.search")}
    class="flex-1 {full ? 'max-w-72' : ''}"
    testid="git-search"
  >
    {#if full}
      <button
        type="button"
        class="shrink-0 rounded px-0.5 font-mono text-caption {filter.regex ? 'bg-edge text-accent' : 'hover:text-text'}"
        aria-label={t("git.searchRegex")}
        aria-pressed={filter.regex}
        use:tooltip={t("git.searchRegex")}
        onclick={() => onfilter({ ...filter, regex: !filter.regex })}
      >.*</button>
      <button
        type="button"
        class="shrink-0 rounded px-0.5 font-mono text-caption {filter.matchCase ? 'bg-edge text-accent' : 'hover:text-text'}"
        aria-label={t("git.searchCase")}
        aria-pressed={filter.matchCase}
        use:tooltip={t("git.searchCase")}
        onclick={() => onfilter({ ...filter, matchCase: !filter.matchCase })}
      >Aa</button>
    {/if}
  </FilterField>

  {#if full}
    {#each FILTERS as which (which)}
      <button
        type="button"
        class="flex min-w-0 max-w-32 shrink items-center gap-0.5 rounded px-1 py-0.5 hover:bg-edge hover:text-text {active(which) ? 'text-accent' : ''}"
        data-testid="git-filter-{which}"
        onclick={(e) => openAt(e, itemsOf(which))}
      >
        <span class="min-w-0 truncate">{filterLabel(which)}</span>
        <Icon name="chevronDown" size={10} />
      </button>
    {/each}
    {#if isFiltered(filter)}
      <button type="button" class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text" aria-label={t("git.filterReset")} use:tooltip={t("git.filterReset")} data-testid="git-filter-reset" onclick={reset}>
        <Icon name="close" size={12} />
      </button>
    {/if}
    <span class="flex-1"></span>
  {:else}
    <button
      type="button"
      class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text {anyHidden ? 'text-accent' : ''}"
      aria-label={t("git.filterMenu")}
      use:tooltip={t("git.filterMenu")}
      data-testid="git-filter-menu"
      onclick={(e) => openAt(e, allFiltersMenu())}
    >
      <Icon name="filter" size={13} />
    </button>
  {/if}
  <button
    type="button"
    class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text"
    aria-label={t("git.viewMenu")}
    use:tooltip={t("git.viewMenu")}
    data-testid="git-view-menu"
    onclick={(e) => openAt(e, viewMenu())}
  >
    <Icon name="eye" size={13} />
  </button>
</div>

<ContextMenu {menu} onclose={() => (menu = null)} />

<Modal open={pathOpen} title={t("git.filterPathTitle")} onclose={() => (pathOpen = false)}>
  <!-- svelte-ignore a11y_autofocus -->
  <!-- eslint-disable-next-line vterm/filter-field -- the path of the history's path filter, typed in its dialog, not a search field -->
  <input
    bind:value={pathDraft}
    autofocus
    placeholder={t("git.filterPathHint")}
    class="w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
    onkeydown={(e) => {
      if (e.key === "Enter") applyPath();
      if (e.key === "Escape") pathOpen = false;
    }}
  />
  <div class="mt-3 flex justify-end gap-2">
    <button class="rounded px-3 py-1 text-sm text-muted hover:text-text" onclick={() => (pathOpen = false)}>{t("common.cancel")}</button>
    <button class="rounded bg-accent px-3 py-1 text-sm text-panel-alt hover:bg-accent-hover" onclick={applyPath}>{t("common.ok")}</button>
  </div>
</Modal>
