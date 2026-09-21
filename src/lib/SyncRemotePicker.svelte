<script lang="ts">
  // Remote-folder picker for the sync dialog (v1.0.25): its own window over the
  // sync dialog, with a lazily loaded folder tree from `/` opened down to the
  // current folder. It only picks a path — it never moves the SFTP panel, the
  // dock's shared directory or the terminal. Row logic is pure (remotetree.ts);
  // this file loads children over the existing `sftpList` and draws the rows.
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { sftpList, sftpHome } from "./api";
  import { normalizeInputPath } from "./fspath";
  import { pickerDirs } from "./sync";
  import {
    ancestorChain,
    flattenTree,
    treeKey,
    type TreeChildren,
  } from "./remotetree";
  import { t } from "./i18n";
  import { onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";

  let {
    sessionId,
    start,
    onpick,
    oncancel,
  }: {
    sessionId: string;
    /** Folder to open at — the dialog's current remote folder. */
    start: string;
    onpick: (path: string) => void;
    oncancel: () => void;
  } = $props();

  let children = $state<TreeChildren>({});
  const expanded = new SvelteSet<string>();
  let selected = $state("/");
  let draft = $state("");
  let home = $state("");
  let treeEl = $state<HTMLElement | null>(null);

  const rows = $derived(flattenTree(children, expanded));

  /** List `path`'s subfolders once; a failure is kept on the row, not thrown. */
  async function load(path: string): Promise<boolean> {
    const have = children[path];
    if (Array.isArray(have) || have === "loading") return Array.isArray(have);
    children[path] = "loading";
    try {
      const entries = pickerDirs(await sftpList(sessionId, path));
      children[path] = entries.map((e) => ({ name: e.name, path: e.path }));
      return true;
    } catch (e) {
      children[path] = { error: String(e) };
      return false;
    }
  }

  async function expand(path: string) {
    expanded.add(path);
    await load(path);
  }

  /**
   * Open the tree down to `path`, select it and show its subfolders; stops at the
   * first level that can't be listed (selecting the last one that could).
   */
  async function reveal(path: string) {
    for (const p of ancestorChain(path)) {
      selected = p;
      expanded.add(p);
      if (!(await load(p))) break;
    }
    draft = selected;
    await tick();
    treeEl?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  onMount(async () => {
    home = await sftpHome(sessionId).catch(() => "");
    // A relative start (`.` before the panel listed anything) means home.
    await reveal(start.startsWith("/") ? start : home || "/");
  });

  function select(path: string) {
    selected = path;
    draft = path;
  }

  function toggle(path: string) {
    if (expanded.has(path)) expanded.delete(path);
    else void expand(path);
  }

  function onTreeKey(e: KeyboardEvent) {
    const action = treeKey(rows, selected, e.key);
    if (!action) return;
    e.preventDefault();
    if ("select" in action) select(action.select);
    else if ("expand" in action) void expand(action.expand);
    else if ("collapse" in action) expanded.delete(action.collapse);
    else onpick(action.pick);
    void tick().then(() =>
      treeEl?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  }

  function submitDraft() {
    const next = normalizeInputPath(draft, home);
    if (next && next.startsWith("/") && next !== selected) void reveal(next);
    else draft = selected;
  }
</script>

<Modal open title={t("sync.pickerTitle")} width="w-[90vw] max-w-lg" showClose onclose={oncancel}>
  <div class="space-y-2 text-xs" data-testid="sync-remote-picker">
    <!-- Path bar: type or paste a path and press Enter to open the tree there. -->
    <div class="flex items-center gap-1">
      <input
        class="min-w-0 flex-1 rounded border border-edge bg-panel px-2 py-1 text-text outline-none focus:border-accent"
        aria-label={t("sync.pickerPath")}
        bind:value={draft}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitDraft();
          }
        }}
      />
      {#if home}
        <button
          type="button"
          class="rounded p-1.5 text-muted hover:bg-edge hover:text-text"
          aria-label={t("sync.pickerHome")}
          use:tooltip={t("sync.pickerHome")}
          onclick={() => reveal(home)}
        >
          <Icon name="server" size={14} />
        </button>
      {/if}
    </div>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- Roving selection: the tree container holds focus, keys move `selected`. -->
    <div
      bind:this={treeEl}
      role="tree"
      tabindex="0"
      aria-label={t("sync.pickerTitle")}
      class="h-72 overflow-auto rounded border border-edge bg-panel py-1 outline-none focus:border-accent"
      onkeydown={onTreeKey}
    >
      {#each rows as row (row.path)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          role="treeitem"
          aria-selected={selected === row.path}
          aria-expanded={row.leaf ? undefined : row.expanded}
          tabindex="-1"
          style="padding-left: {row.depth * 16}px"
          class="relative flex h-7 cursor-pointer items-center gap-1 border-l-2 pr-2 text-sm transition duration-150 {selected ===
          row.path
            ? 'border-accent bg-edge outline outline-1 -outline-offset-1 outline-accent/70'
            : 'border-transparent hover:bg-edge'}"
          onclick={() => {
            select(row.path);
            treeEl?.focus();
          }}
          ondblclick={() => onpick(row.path)}
        >
          {#each Array.from({ length: row.depth }) as _, i (i)}
            <span
              class="pointer-events-none absolute bottom-0 top-0 border-l border-muted/30"
              style="left: {i * 16 + 8}px"
            ></span>
          {/each}
          {#if row.leaf}
            <span class="h-4 w-4 shrink-0"></span>
          {:else}
            <button
              type="button"
              tabindex="-1"
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:text-text"
              aria-label={row.expanded ? t("tree.collapse") : t("tree.expand")}
              onclick={(e) => {
                e.stopPropagation();
                toggle(row.path);
              }}
            >
              <Icon name={row.expanded ? "chevronDown" : "chevronRight"} size={14} />
            </button>
          {/if}
          <Icon
            name="folder"
            size={15}
            class={selected === row.path || row.expanded ? "text-accent" : "text-muted"}
          />
          <span class="min-w-0 flex-1 truncate {selected === row.path ? 'text-text' : 'text-text/90'}"
            >{row.name}</span
          >
          {#if row.loading}
            <Icon name="refresh" size={12} class="shrink-0 animate-spin text-muted" />
          {:else if row.error}
            <span class="shrink-0 text-bad" use:tooltip={row.error}>
              <Icon name="alert" size={12} />
            </span>
          {/if}
        </div>
      {/each}
    </div>

    <!-- The pick, spelled out — a highlighted row alone is easy to misread. -->
    <div class="flex items-center gap-2">
      <span class="shrink-0 text-muted">{t("sync.pickerSelected")}</span>
      <span class="min-w-0 flex-1 truncate text-text" title={selected}>{selected}</span>
    </div>

    <div class="flex justify-end gap-2">
      <button type="button" class="rounded px-3 py-1 text-muted hover:text-text" onclick={oncancel}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        class="rounded bg-accent px-3 py-1 font-medium text-panel-alt hover:bg-accent-hover"
        onclick={() => onpick(selected)}
      >
        {t("sync.pickerUse")}
      </button>
    </div>
  </div>
</Modal>
