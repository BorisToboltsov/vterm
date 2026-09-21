<script lang="ts">
  // Remote-folder picker for the sync dialog (v1.0.24): a small directory-only
  // navigator over the existing `sftpList`, shown inline in the dialog instead of
  // a second modal. It only picks a path — hashing and applying stay in SyncModal.
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";
  import EmptyState from "./EmptyState.svelte";
  import { tooltip } from "./actions/tooltip";
  import { sftpList, sftpHome } from "./api";
  import { isRoot, parentOf, normalizeInputPath } from "./fspath";
  import { pickerDirs } from "./sync";
  import type { FileEntry } from "./types";
  import { t } from "./i18n";
  import { onMount } from "svelte";

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

  let path = $state("");
  let draft = $state("");
  let dirs = $state<FileEntry[]>([]);
  let loading = $state(true);
  let error = $state("");
  let home = "";

  /** List `next`; only a successful listing moves the picker (a bad path keeps the old one). */
  async function go(next: string) {
    loading = true;
    try {
      const entries = await sftpList(sessionId, next);
      path = next;
      draft = next;
      dirs = pickerDirs(entries);
      error = "";
    } catch (e) {
      error = String(e);
      draft = path;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    home = await sftpHome(sessionId).catch(() => "");
    // A relative start (`.` before the panel listed anything) means home.
    await go(start.startsWith("/") ? start : home || "/");
  });

  function submitDraft() {
    const next = normalizeInputPath(draft, home);
    if (next && next !== path) void go(next);
    else draft = path;
  }
</script>

<div class="rounded border border-edge bg-panel" data-testid="sync-remote-picker">
  <div class="flex items-center gap-1 border-b border-edge p-1">
    <button
      type="button"
      class="rounded p-1 text-muted hover:bg-edge hover:text-text disabled:opacity-40"
      disabled={loading || !path || isRoot(path)}
      aria-label={t("sync.pickerUp")}
      use:tooltip={t("sync.pickerUp")}
      onclick={() => go(parentOf(path))}
    >
      <Icon name="arrowUp" size={13} />
    </button>
    <input
      class="min-w-0 flex-1 rounded border border-edge bg-panel-alt px-2 py-0.5 text-text outline-none focus:border-accent"
      aria-label={t("sync.pickerPath")}
      bind:value={draft}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitDraft();
        }
      }}
      onblur={submitDraft}
    />
  </div>

  <div class="max-h-48 overflow-auto">
    {#if loading && dirs.length === 0}
      <div class="space-y-2 p-2">
        <Skeleton width="60%" />
        <Skeleton width="45%" />
        <Skeleton width="70%" />
      </div>
    {:else if dirs.length === 0}
      <EmptyState icon="folder" title={t("sync.pickerNoFolders")} />
    {:else}
      {#each dirs as d (d.path)}
        <button
          type="button"
          class="flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-edge"
          onclick={() => go(d.path)}
        >
          <Icon name="folder" size={15} class="text-muted" />
          <span class="min-w-0 flex-1 truncate text-text">{d.name}</span>
        </button>
      {/each}
    {/if}
  </div>

  {#if error}
    <p class="break-words border-t border-edge px-2 py-1 text-danger">{error}</p>
  {/if}

  <div class="flex justify-end gap-2 border-t border-edge p-1">
    <button type="button" class="rounded px-3 py-1 text-muted hover:text-text" onclick={oncancel}>
      {t("common.cancel")}
    </button>
    <button
      type="button"
      class="rounded bg-edge px-3 py-1 hover:bg-accent hover:text-panel-alt disabled:opacity-40"
      disabled={loading || !path}
      onclick={() => onpick(path)}
    >
      {t("sync.pickerUse")}
    </button>
  </div>
</div>
