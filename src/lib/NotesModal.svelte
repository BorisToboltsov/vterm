<script lang="ts">
  // Per-server notes editor (Phase 21). A large window opened from the top bar for
  // the currently selected server. Simple Markdown notes: an Edit/Preview toggle,
  // a big textarea, debounced autosave plus an explicit "Save & close". The pure
  // bits (counts, dirty check) live in notes.ts; Markdown rendering reuses
  // markdown.ts. Saving goes through the dedicated `setServerNotes` command (wired
  // by the parent via `onsave`) so it never clobbers a concurrent profile edit.
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./actions/tooltip";
  import { renderMarkdown } from "./markdown";
  import { noteStats } from "./notes";
  import { t } from "./i18n";
  import type { ServerProfile } from "./types";

  let {
    server,
    onsave,
    onclose,
  }: {
    server: ServerProfile;
    /** Persist the notes; rejects on failure. */
    onsave: (notes: string) => Promise<void>;
    onclose: () => void;
  } = $props();

  // Draft/saved snapshots are seeded once from the server the window opened for;
  // later prop changes (e.g. the parent refreshing its list after our own save)
  // must not stomp what the user is typing.
  let draft = $state(untrack(() => server.notes));
  let saved = $state(untrack(() => server.notes));
  let mode = $state<"edit" | "preview">("edit");
  let saving = $state(false);
  let justSaved = $state(false);
  let error = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stats = $derived(noteStats(draft));
  const dirty = $derived(draft !== saved);
  const AUTOSAVE_MS = 800;

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (draft === saved || saving) return;
    const snapshot = draft;
    saving = true;
    error = false;
    try {
      await onsave(snapshot);
      saved = snapshot;
      justSaved = true;
    } catch {
      error = true;
    } finally {
      saving = false;
    }
  }

  function onInput() {
    error = false;
    justSaved = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), AUTOSAVE_MS);
  }

  // Both the × / backdrop / Escape (Modal's onclose) and the footer button flush
  // any pending edit before closing so nothing is lost.
  async function closeNow(): Promise<void> {
    await flush();
    onclose();
  }
</script>

<Modal open title={server.alias} width="w-[min(90vw,860px)]" showClose onclose={() => void closeNow()}>
  <div class="flex flex-col">
    <!-- Header: subtitle + Edit/Preview toggle. -->
    <div class="mb-2 flex items-center gap-2">
      <Icon name="note" size={15} class="shrink-0 text-muted" />
      <span class="min-w-0 truncate text-xs text-muted">
        {server.username}@{server.host}:{server.port}
      </span>
      <div class="ml-auto flex items-center gap-1 rounded border border-edge p-0.5">
        <button
          class="rounded px-2 py-0.5 text-meta {mode === 'edit'
            ? 'bg-edge text-white'
            : 'text-muted hover:text-white'}"
          data-testid="notes-mode-edit"
          onclick={() => (mode = "edit")}>{t("notes.edit")}</button
        >
        <button
          class="rounded px-2 py-0.5 text-meta {mode === 'preview'
            ? 'bg-edge text-white'
            : 'text-muted hover:text-white'}"
          data-testid="notes-mode-preview"
          onclick={() => (mode = "preview")}>{t("notes.preview")}</button
        >
      </div>
    </div>

    <!-- Body: editor or rendered preview, fixed tall area. -->
    {#if mode === "edit"}
      <textarea
        data-testid="notes-textarea"
        class="h-[60vh] w-full resize-none rounded border border-edge bg-panel px-3 py-2 font-mono text-sm leading-relaxed text-white outline-none focus:border-accent"
        placeholder={t("notes.placeholder")}
        bind:value={draft}
        oninput={onInput}
      ></textarea>
    {:else if stats.empty}
      <div
        class="flex h-[60vh] items-center justify-center rounded border border-edge bg-panel text-sm text-muted"
      >
        {t("notes.empty")}
      </div>
    {:else}
      <div
        data-testid="notes-preview"
        class="markdown-preview h-[60vh] overflow-auto rounded border border-edge bg-panel px-3 py-2 text-sm leading-relaxed"
      >
        {@html renderMarkdown(draft)}
      </div>
    {/if}

    <!-- Footer: status + counts + save/close. -->
    <div class="mt-2 flex items-center gap-3 text-meta">
      <span class="min-w-0 truncate">
        {#if error}
          <span class="text-danger">{t("notes.saveError")}</span>
        {:else if saving}
          <span class="text-muted">{t("notes.saving")}</span>
        {:else if dirty}
          <span class="text-muted">{t("notes.unsaved")}</span>
        {:else if justSaved}
          <span class="flex items-center gap-1 text-ok"
            ><Icon name="check" size={12} />{t("notes.saved")}</span
          >
        {/if}
      </span>
      <span class="ml-auto shrink-0 text-muted" use:tooltip={t("notes.countHint")}>
        {t("notes.count", { chars: String(stats.chars), lines: String(stats.lines) })}
      </span>
      <button
        class="shrink-0 rounded bg-edge px-3 py-1 font-medium hover:bg-accent hover:text-panel-alt"
        data-testid="notes-save-close"
        onclick={() => void closeNow()}>{t("notes.saveClose")}</button
      >
    </div>
  </div>
</Modal>
