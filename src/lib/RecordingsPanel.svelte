<script lang="ts">
  // Library of saved session recordings (asciicast .cast files). Lists them with
  // metadata and offers: play back, export an AI-friendly transcript, export the
  // raw .cast, or delete. Presentational + thin API; playback in RecordingPlayer.
  import Modal from "./Modal.svelte";
  import { tooltip } from "./actions/tooltip";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import RecordingSaveDialog from "./RecordingSaveDialog.svelte";
  import Icon from "./Icon.svelte";
  import EmptyState from "./EmptyState.svelte";
  import RecordingPlayer from "./RecordingPlayer.svelte";
  import { t } from "./i18n";
  import { fmtBytes } from "./format";
  import {
    extractTranscript,
    extractCommands,
    extractMarkdown,
    metadataComment,
    filterRecordings,
    sortRecordingsBy,
    type RecordingSortKey,
    type SortCriterion,
  } from "./recording";
  import {
    listRecordings,
    deleteRecording,
    setRecordingMeta,
    readRecording,
    exportRecording,
    pickExportSavePath,
    importRecording,
    pickRecordingFile,
    aiChat,
  } from "./api";
  import { onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { settings } from "./settings.svelte";
  import {
    aiReady,
    activeEndpoint,
    buildChatRequest,
    resolvePromptContent,
    DEFAULT_PROMPT,
    type AiPromptKind,
  } from "./ai";
  import { buildRunbookContext } from "./airunbook";
  import { extractScript, scriptFileName, type ScriptKind } from "./aiscript";
  import type { BuiltContext } from "./aicontext";
  import AiConsentDialog from "./AiConsentDialog.svelte";
  import { describeAiError } from "./aierror";
  import { renderMarkdown } from "./markdown";
  import { writeClipboard } from "./clipboard";
  import { notifyError, notifySuccess } from "./stores/toasts.svelte";
  import type { RecordingMeta } from "./types";

  let {
    open = $bindable(false),
    onOpenScript,
  }: {
    open?: boolean;
    /** Open a generated script (name + content) in the editor; omitted = no session. */
    onOpenScript?: (name: string, content: string) => void;
  } = $props();

  let items = $state<RecordingMeta[]>([]);
  let loading = $state(false);
  // When set, the modal shows the player for this recording instead of the list.
  let playing = $state<{ content: string; title: string; width: number; height: number } | null>(
    null,
  );
  let query = $state("");
  // When set, a delete-confirmation dialog is shown for this recording.
  let confirmDelete = $state<RecordingMeta | null>(null);
  // When set, the title/description edit dialog is shown for this recording.
  let editRec = $state<RecordingMeta | null>(null);
  // Ordered sort criteria (first = primary). Each column cycles asc → desc → off.
  let criteria = $state<SortCriterion[]>([{ key: "date", dir: "desc" }]);

  const SORT_KEYS: RecordingSortKey[] = ["date", "name", "size"];
  const sortLabel: Record<RecordingSortKey, string> = {
    date: t("recordings.sortDate"),
    name: t("recordings.sortName"),
    size: t("recordings.sortSize"),
  };

  const view = $derived(sortRecordingsBy(filterRecordings(items, query), criteria));

  // ── AI generation: runbook plan / shell script / Ansible playbook (17.5–17.6) ─
  /** What the AI turns the transcript into. `plan` shows in a viewer; scripts open in the editor. */
  type GenKind = "plan" | ScriptKind;

  const aiOn = $derived(aiReady(settings.ai));
  const planEndpoint = $derived(activeEndpoint(settings.ai));
  // The per-recording AI action menu (plan / sh / ansible).
  let aiMenuFor = $state<RecordingMeta | null>(null);
  // Consent gate before a transcript is sent (redacted preview + endpoint).
  let genConsent = $state<{ ctx: BuiltContext; kind: GenKind; rec: RecordingMeta } | null>(null);
  // The streaming viewer (plan output, or script progress before it opens in the editor).
  let planOpen = $state(false);
  let planTitle = $state("");
  let planText = $state("");
  let planStreaming = $state(false);
  let planError = $state<string | null>(null);
  let genKind = $state<GenKind>("plan");
  let planUnlisten: UnlistenFn[] = [];

  // Recording generators use the active prompt of the matching kind (plan→runbook).
  const systemFor = (kind: GenKind): string => {
    const pk: AiPromptKind = kind === "plan" ? "runbook" : kind;
    return resolvePromptContent(settings.ai.prompts[pk], null, DEFAULT_PROMPT[pk]);
  };

  function cleanupPlan() {
    for (const u of planUnlisten) u();
    planUnlisten = [];
  }

  /** Read a recording, redact its transcript, and open the consent dialog. */
  async function startGen(rec: RecordingMeta, kind: GenKind) {
    aiMenuFor = null;
    try {
      const transcript = extractTranscript(await readRecording(rec.path));
      const ctx = buildRunbookContext(transcript);
      if (!ctx.text) {
        notifyError(t("recordings.planEmpty"));
        return;
      }
      planTitle = rec.title || baseName(rec.path);
      genConsent = { ctx, kind, rec };
    } catch {
      notifyError(t("recordings.planFailed"));
    }
  }

  function confirmGen() {
    const g = genConsent;
    if (!g) return;
    genConsent = null;
    runGen(g.ctx.text, g.kind, g.rec);
  }

  /** Stream the artifact from the AI broker; scripts open in the editor when done. */
  async function runGen(transcript: string, kind: GenKind, rec: RecordingMeta) {
    planText = "";
    planError = null;
    planStreaming = true;
    genKind = kind;
    planOpen = true;
    const streamId = crypto.randomUUID();
    const req = buildChatRequest(
      settings.ai,
      streamId,
      [{ role: "user", content: transcript }],
      systemFor(kind),
    );
    if (!req) {
      planError = t("ai.disabledHint");
      planStreaming = false;
      return;
    }
    const finish = () => {
      planStreaming = false;
      cleanupPlan();
      // Scripts (sh/ansible) become an editor document; plans stay in the viewer.
      if (kind !== "plan" && !planError && planText.trim()) {
        onOpenScript?.(scriptFileName(rec.title || baseName(rec.path), kind), extractScript(planText, kind));
        planOpen = false;
      }
    };
    planUnlisten.push(
      await listen<string>(`ai://out/${streamId}`, (e) => (planText += e.payload)),
    );
    planUnlisten.push(await listen(`ai://done/${streamId}`, finish));
    planUnlisten.push(
      await listen<string>(`ai://error/${streamId}`, (e) => {
        planError = describeAiError(e.payload);
        finish();
      }),
    );
    try {
      await aiChat(req);
    } catch (e) {
      if (planStreaming) {
        planError = describeAiError(e);
        finish();
      }
    }
  }

  function closePlan() {
    planOpen = false;
    cleanupPlan();
  }

  onDestroy(cleanupPlan);

  /** Click a column: add (asc) → flip to desc → remove, preserving priority order. */
  function cycleSort(key: RecordingSortKey) {
    const i = criteria.findIndex((c) => c.key === key);
    if (i === -1) criteria = [...criteria, { key, dir: "asc" }];
    else if (criteria[i].dir === "asc")
      criteria = criteria.map((c, j) => (j === i ? { key, dir: "desc" } : c));
    else criteria = criteria.filter((_, j) => j !== i);
  }

  function sortState(key: RecordingSortKey): { index: number; dir: "asc" | "desc" } | null {
    const i = criteria.findIndex((c) => c.key === key);
    return i === -1 ? null : { index: i, dir: criteria[i].dir };
  }

  async function refresh() {
    loading = true;
    try {
      items = await listRecordings();
    } catch (e) {
      notifyError(String(e));
    } finally {
      loading = false;
    }
  }

  /** Upload an external .cast file into the library (only asciicast v2 replays). */
  async function upload() {
    try {
      const src = await pickRecordingFile();
      if (!src) return;
      const rec = await importRecording(src);
      // Show it immediately without a full reload.
      items = [rec, ...items.filter((r) => r.path !== rec.path)];
      notifySuccess(t("recordings.uploaded"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  // Load (and reload) the list whenever the panel opens; reset transient UI on close.
  $effect(() => {
    if (open) refresh();
    else {
      playing = null;
      confirmDelete = null;
      editRec = null;
      exportFor = null;
    }
  });

  /** Save edited title/description, updating the list in place. */
  async function saveEdit(title: string, description: string) {
    const rec = editRec;
    editRec = null;
    if (!rec) return;
    try {
      await setRecordingMeta(rec.path, title, description);
      items = items.map((r) => (r.path === rec.path ? { ...r, title, description } : r));
      notifySuccess(t("recordings.stopped"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function play(rec: RecordingMeta) {
    try {
      const content = await readRecording(rec.path);
      playing = {
        content,
        title: rec.title || baseName(rec.path),
        width: rec.width,
        height: rec.height,
      };
    } catch (e) {
      notifyError(String(e));
    }
  }

  function fmtDate(ts: number): string {
    return ts ? new Date(ts * 1000).toLocaleString() : "";
  }

  function baseName(path: string): string {
    return path.split(/[/\\]/).pop() ?? path;
  }

  type ExportKind = "markdown" | "commands" | "transcript" | "raw";
  // When set, the export-format chooser (a Modal on top of the library) is shown.
  let exportFor = $state<RecordingMeta | null>(null);
  const EXPORT_KINDS: { kind: ExportKind; label: () => string }[] = [
    { kind: "markdown", label: () => t("recordings.exportMarkdown") },
    { kind: "commands", label: () => t("recordings.exportCommands") },
    { kind: "transcript", label: () => t("recordings.exportTranscript") },
    { kind: "raw", label: () => t("recordings.exportRaw") },
  ];

  async function doExport(rec: RecordingMeta, kind: ExportKind) {
    exportFor = null;
    try {
      const raw = await readRecording(rec.path);
      const stem = baseName(rec.path).replace(/\.cast$/, "");
      let content = raw;
      let name = baseName(rec.path);
      if (kind === "markdown") {
        // Markdown already embeds the metadata as its document header.
        content = extractMarkdown(raw);
        name = `${stem}.md`;
      } else if (kind === "commands") {
        content = metadataComment(raw) + extractCommands(raw);
        name = `${stem}.commands.txt`;
      } else if (kind === "transcript") {
        content = metadataComment(raw) + extractTranscript(raw);
        name = `${stem}.txt`;
      }
      const dest = await pickExportSavePath(name);
      if (!dest) return;
      await exportRecording(dest, content);
      notifySuccess(t("recordings.exported"));
    } catch (e) {
      notifyError(String(e));
    }
  }

  async function remove(rec: RecordingMeta) {
    confirmDelete = null;
    try {
      await deleteRecording(rec.path);
      items = items.filter((r) => r.path !== rec.path);
    } catch (e) {
      notifyError(String(e));
    }
  }
</script>

<Modal
  {open}
  width={playing ? "w-[60rem]" : "w-[44rem]"}
  title={t("recordings.title")}
  onclose={() => (open = false)}
>
  {#if playing}
    {#key playing}
      <RecordingPlayer
        content={playing.content}
        title={playing.title}
        width={playing.width}
        height={playing.height}
        onback={() => (playing = null)}
      />
    {/key}
  {:else if loading}
    <p class="py-6 text-center text-xs text-muted">{t("recordings.loading")}</p>
  {:else}
    <!-- Upload an external .cast recording into the library. Always available,
         including when the library is empty. -->
    <div class="mb-2 flex justify-end">
      <button
        type="button"
        data-testid="recordings-upload"
        onclick={upload}
        class="flex items-center gap-1.5 rounded border border-edge px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
      >
        <Icon name="upload" size={14} />
        {t("recordings.upload")}
      </button>
    </div>
  {/if}

  {#if !playing && !loading && items.length === 0}
    <EmptyState icon="activity" title={t("recordings.emptyTitle")} hint={t("recordings.emptyHint")} />
  {:else if !playing && !loading}
    <!-- Search -->
    <div class="mb-2 flex min-w-0 items-center gap-1.5 rounded border border-edge bg-panel px-2 py-1">
      <Icon name="search" size={14} class="shrink-0 text-muted" />
      <input
        bind:value={query}
        type="text"
        spellcheck="false"
        placeholder={t("recordings.search")}
        aria-label={t("recordings.search")}
        class="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
      />
    </div>

    <!-- Multi-key sort: each column cycles asc → desc → off; a badge shows priority.
         The indicator slot has a fixed width so toggling a column doesn't resize
         the button or reflow the row. -->
    <div class="mb-2 flex flex-nowrap items-center gap-1.5">
      <span class="shrink-0 text-[11px] text-muted">{t("recordings.sortBy")}:</span>
      {#each SORT_KEYS as key}
        {@const st = sortState(key)}
        <button
          type="button"
          onclick={() => cycleSort(key)}
          aria-pressed={!!st}
          class="flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-xs {st
            ? 'border-accent text-accent'
            : 'border-edge text-muted hover:text-white'}"
        >
          {sortLabel[key]}
          <span class="inline-flex w-6 items-center justify-center gap-0.5">
            {#if st}
              <Icon name={st.dir === "asc" ? "chevronUp" : "chevronDown"} size={12} />
              {#if criteria.length > 1}
                <span class="text-[10px] tabular-nums opacity-70">{st.index + 1}</span>
              {/if}
            {/if}
          </span>
        </button>
      {/each}
    </div>

    {#if view.length === 0}
      <p class="px-3 py-6 text-center text-xs text-muted">{t("recordings.noMatches")}</p>
    {/if}
    <div class="max-h-[60vh] space-y-1.5 overflow-auto">
      {#each view as rec (rec.path)}
        <div class="group flex items-center gap-2 rounded border border-edge px-2 py-1.5 hover:bg-edge">
          <Icon name="activity" size={14} class="shrink-0 text-muted" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm text-text" title={baseName(rec.path)}>
              {rec.title || baseName(rec.path)}
            </div>
            {#if rec.description}
              <div class="truncate text-xs text-muted" title={rec.description}>
                {rec.description}
              </div>
            {/if}
            <div class="flex items-center gap-1 text-[11px] text-muted">
              {#if rec.server}
                <Icon name="server" size={12} class="shrink-0" />
                <span class="truncate" title={rec.server}>{rec.server}</span>
                <span aria-hidden="true">·</span>
              {/if}
              <span class="tabular-nums">{fmtDate(rec.timestamp)} · {fmtBytes(rec.size)}</span>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            {#if aiOn}
              <button
                type="button"
                data-testid="rec-ai"
                onclick={() => (aiMenuFor = rec)}
                use:tooltip={t("recordings.ai")}
                aria-label={t("recordings.ai")}
                class="rounded p-0.5 text-muted hover:text-accent"
              >
                <Icon name="sparkles" size={14} />
              </button>
            {/if}
            <button
              type="button"
              onclick={() => play(rec)}
              use:tooltip={t("recordings.play")}
              aria-label={t("recordings.play")}
              class="rounded p-0.5 text-muted hover:text-accent"
            >
              <Icon name="play" size={14} />
            </button>
            <button
              type="button"
              onclick={() => (editRec = rec)}
              use:tooltip={t("recordings.edit")}
              aria-label={t("recordings.edit")}
              class="rounded p-0.5 text-muted hover:text-accent"
            >
              <Icon name="pencil" size={13} />
            </button>
            <button
              type="button"
              onclick={() => (exportFor = rec)}
              use:tooltip={t("recordings.export")}
              aria-label={t("recordings.export")}
              class="rounded p-0.5 text-muted hover:text-accent"
            >
              <Icon name="download" size={14} />
            </button>
            <button
              type="button"
              onclick={() => (confirmDelete = rec)}
              use:tooltip={t("recordings.delete")}
              aria-label={t("recordings.delete")}
              class="rounded p-0.5 text-muted hover:text-danger"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</Modal>

<ConfirmDialog
  open={confirmDelete !== null}
  title={t("recordings.deleteConfirmTitle")}
  confirmLabel={t("recordings.delete")}
  onconfirm={() => confirmDelete && remove(confirmDelete)}
  oncancel={() => (confirmDelete = null)}
>
  {#if confirmDelete}
    {t("recordings.deleteConfirmBody", {
      name: confirmDelete.title || baseName(confirmDelete.path),
    })}
  {/if}
</ConfirmDialog>

<!-- AI action chooser for a recording: plan / shell script / Ansible playbook.
     Same look as the export-format chooser below. -->
<Modal
  open={aiMenuFor !== null}
  width="w-80"
  title={t("recordings.ai")}
  onclose={() => (aiMenuFor = null)}
>
  <div class="flex flex-col gap-1">
    <button
      type="button"
      data-testid="rec-gen-plan"
      onclick={() => aiMenuFor && startGen(aiMenuFor, "plan")}
      class="block w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-edge hover:text-white"
    >
      {t("recordings.genPlan")}
    </button>
    <button
      type="button"
      data-testid="rec-gen-sh"
      onclick={() => aiMenuFor && startGen(aiMenuFor, "sh")}
      class="block w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-edge hover:text-white"
    >
      {t("recordings.genSh")}
    </button>
    <button
      type="button"
      data-testid="rec-gen-ansible"
      onclick={() => aiMenuFor && startGen(aiMenuFor, "ansible")}
      class="block w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-edge hover:text-white"
    >
      {t("recordings.genAnsible")}
    </button>
  </div>
</Modal>

{#if genConsent && planEndpoint}
  <AiConsentDialog
    open
    context={genConsent.ctx}
    endpointName={planEndpoint.name}
    endpointUrl={planEndpoint.baseUrl}
    onconfirm={confirmGen}
    oncancel={() => (genConsent = null)}
  />
{/if}

<Modal open={planOpen} title={t("recordings.planTitle")} width="w-[42rem]" onclose={closePlan}>
  <div class="flex items-center justify-between gap-2 border-b border-edge pb-2">
    <span class="truncate text-xs text-muted" title={planTitle}>{planTitle}</span>
    <div class="flex items-center gap-2">
      {#if planStreaming}
        <span class="text-[11px] text-muted">{t("recordings.planStreaming")}</span>
      {/if}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-white disabled:opacity-50"
        disabled={!planText}
        onclick={() => {
          writeClipboard(planText);
          notifySuccess(t("ai.exec.copied"));
        }}
      >
        <Icon name="copy" size={12} />
        {t("ai.exec.copy")}
      </button>
    </div>
  </div>
  <div class="mt-2 max-h-[60vh] overflow-auto text-sm" data-testid="rec-plan-view">
    {#if planError}
      <p class="text-[12px] text-danger">{planError}</p>
    {:else if !planText && planStreaming}
      <p class="py-6 text-center text-[11px] text-muted">{t("recordings.planStreaming")}</p>
    {:else}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="markdown-preview">{@html renderMarkdown(planText)}</div>
    {/if}
  </div>
</Modal>

<RecordingSaveDialog
  open={editRec !== null}
  heading={t("recordings.editTitle")}
  defaultTitle={editRec?.title ?? ""}
  defaultDescription={editRec?.description ?? ""}
  onsave={saveEdit}
  onclose={() => (editRec = null)}
/>

<!-- Export-format chooser — a Modal so it sits on top of the (possibly narrow)
     library window instead of being clipped inside it. -->
<Modal
  open={exportFor !== null}
  width="w-80"
  title={t("recordings.export")}
  onclose={() => (exportFor = null)}
>
  <div class="flex flex-col gap-1">
    {#each EXPORT_KINDS as opt}
      <button
        type="button"
        onclick={() => exportFor && doExport(exportFor, opt.kind)}
        class="block w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-edge hover:text-white"
      >
        {opt.label()}
      </button>
    {/each}
  </div>
</Modal>
