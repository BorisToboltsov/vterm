<script lang="ts">
  // Broadcast command line (Phase 22): compose one command and send it to every
  // selected server at once. The bar is presentational — it emits `onsend(cmd)`
  // and the page does the eligibility/prod gating and the actual fan-out writes.
  //
  // ADR 0064 gave it a history and a second mode. ↑/↓ recall what the line sent
  // (with text typed first — only what starts with it), Ctrl+R (and ⌘R on macOS)
  // searches the group's history: resolved here, so every member gets one text
  // and never its own shell's idea of "the previous command". In keys mode the
  // line gives way to the terminal in focus, whose keys the page passes on; the
  // bar only says who gets them. A block of several lines is never flattened
  // into the line: it goes to "paste into all".
  import Icon from "../ui/Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import { isHistoryChord, isMacHistoryChord } from "../app/appshortcuts";
  import { hostEnv } from "../stores/hostenv.svelte";
  import CommandHistory from "./CommandHistory.svelte";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import {
    facetRows,
    HISTORY_FACETS,
    NO_RECALL,
    recall,
    CLOSED_HISTORY,
    type GroupHistoryView,
    type HistoryFacet,
    type Recall,
  } from "./grouphistory";

  let {
    disabled = false,
    prodWarn = false,
    mode = "line",
    keysTo = [],
    keysSkipped = [],
    keysHeld = [],
    recent = [],
    history = CLOSED_HISTORY,
    onsend,
    onmode,
    onhistory,
    onhistoryclose,
    onpasteall,
  }: {
    /** No live targets → input and button are inert. */
    disabled?: boolean;
    /** Group includes a prod server → show the amber caution line. */
    prodWarn?: boolean;
    /** The command line, or the keys of the terminal in focus. */
    mode?: "line" | "keys";
    /** Keys mode: the members that get the keys, and those passed over (another kind of screen). */
    keysTo?: string[];
    keysSkipped?: string[];
    /** Prod members that joined after keys mode was confirmed: no keys until it is asked again. */
    keysHeld?: string[];
    /** What the line sent, newest first — what ↑ recalls. */
    recent?: string[];
    history?: GroupHistoryView;
    onsend: (cmd: string) => void;
    onmode?: (mode: "line" | "keys") => void;
    /** Ctrl+R / ⌘R: read the group's history and open it. */
    onhistory?: () => void;
    onhistoryclose?: () => void;
    /** A block of text for every member's terminal; `text` — what was pasted into the line, if any. */
    onpasteall?: (text: string) => void;
  } = $props();

  let value = $state("");
  let inputEl = $state<HTMLInputElement>();
  let walk: Recall = NO_RECALL;
  let facet = $state<HistoryFacet>("all");

  const facetLabels = $derived<Record<HistoryFacet, string>>({
    all: t("groupHistory.all"),
    everywhere: t("groupHistory.everywhere"),
    sent: t("groupHistory.sent"),
  });
  const shown = $derived(facetRows(history.rows, facet));
  const byCmd = $derived(new Map(history.rows.map((r) => [r.cmd, r])));

  function describe(cmd: string) {
    const row = byCmd.get(cmd);
    if (!row) return null;
    return {
      badge: row.sent ? t("groupHistory.sentBadge") : undefined,
      count: row.on.length === 1 && row.of > 1 ? t("groupHistory.only", { name: row.on[0] }) : `${row.on.length}/${row.of}`,
      hint: row.on.join(", "),
    };
  }

  function send() {
    if (disabled || value.length === 0) return;
    onsend(value);
    value = "";
    walk = NO_RECALL;
    inputEl?.focus();
  }

  function step(dir: "older" | "newer") {
    const next = recall(recent, walk, value, dir);
    if (!next) return;
    walk = next.state;
    value = next.text;
    queueMicrotask(() => inputEl?.setSelectionRange(value.length, value.length));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      step(e.key === "ArrowUp" ? "older" : "newer");
    } else if (isHistoryChord(e) || isMacHistoryChord(e, hostEnv.os)) {
      e.preventDefault();
      facet = "all";
      onhistory?.();
    }
  }

  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!/[\r\n]/.test(text)) return;
    // A block would lose its line breaks in a one-line field — and be sent as one line.
    e.preventDefault();
    onpasteall?.(text);
  }

  function accept(cmd: string) {
    value = cmd;
    walk = NO_RECALL;
    onhistoryclose?.();
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.setSelectionRange(value.length, value.length);
    });
  }

  function closeHistory() {
    onhistoryclose?.();
    inputEl?.focus();
  }

  /** Focus the line — the page calls it when ⌘R is pressed in a member's terminal. */
  export function focusLine() {
    inputEl?.focus();
  }
</script>

<div class="relative shrink-0 border-t border-edge bg-panel-alt px-2 py-1.5">
  <CommandHistory
    open={history.open}
    place="above"
    items={shown.map((r) => r.cmd)}
    loading={history.loading}
    server={t("groupHistory.server", { count: history.members })}
    facets={HISTORY_FACETS.map((id) => ({ id, label: facetLabels[id] }))}
    {facet}
    onfacet={(id) => (facet = id as HistoryFacet)}
    {describe}
    note={history.unread.length > 0 ? t("groupHistory.unread", { names: history.unread.join(", ") }) : ""}
    onaccept={accept}
    onclose={closeHistory}
  />
  {#if prodWarn}
    <div class="mb-1 flex items-center gap-1.5 text-meta text-warn">
      <Icon name="shield" size={13} />
      {mode === "keys" ? t("groupKeys.prodWarn") : t("broadcast.prodWarn")}
    </div>
  {/if}
  <div class="flex items-center gap-2">
    <!-- The mode is the page's: switching to keys with prod in the group waits
         for its question, and the control shows what the page says. -->
    <span class="shrink-0" use:tooltip={mode === "line" ? t("broadcast.modeLineHint") : t("broadcast.modeKeysHint")}>
      <SegmentedControl
        bind:value={() => mode, (next) => onmode?.(next)}
        options={[
          { value: "line", label: t("broadcast.modeLine") },
          { value: "keys", label: t("broadcast.modeKeys") },
        ]}
        label={t("broadcast.mode")}
        testid="broadcast-mode"
      />
    </span>
    {#if mode === "line"}
      <input
        bind:this={inputEl}
        bind:value
        data-testid="broadcast-input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        aria-label={t("broadcast.placeholder")}
        placeholder={t("broadcast.placeholder")}
        class="min-w-0 flex-1 rounded border border-edge bg-panel px-2.5 py-1.5 font-mono text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        oninput={() => (walk = NO_RECALL)}
        onkeydown={onKey}
        onpaste={onPaste}
      />
    {:else}
      <p class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-meta text-muted" data-testid="broadcast-keys-status">
        <Icon name="keyboard" size={13} class="shrink-0 text-accent" />
        {#if keysTo.length > 0}
          {t("groupKeys.to", { names: keysTo.join(", ") })}
        {:else}
          {t("groupKeys.toNobody")}
        {/if}
        {#if keysSkipped.length > 0}
          <span class="text-warn">{t("groupKeys.skipped", { names: keysSkipped.join(", ") })}</span>
        {/if}
        {#if keysHeld.length > 0}
          <span class="text-bad">{t("groupKeys.held", { names: keysHeld.join(", ") })}</span>
        {/if}
      </p>
    {/if}
    <button
      data-testid="broadcast-paste-all"
      class="flex shrink-0 items-center rounded border border-edge p-1.5 text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled}
      onclick={() => onpasteall?.("")}
      use:tooltip={t("groupPaste.open")}
      aria-label={t("groupPaste.open")}
    >
      <Icon name="paperclip" size={15} />
    </button>
    {#if mode === "line"}
      <button
        data-testid="broadcast-send"
        class="flex shrink-0 items-center rounded bg-accent p-2 text-panel-alt hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        onclick={send}
        disabled={disabled || value.length === 0}
        use:tooltip={t("broadcast.send")}
        aria-label={t("broadcast.send")}
      >
        <Icon name="send" size={16} />
      </button>
    {/if}
  </div>
</div>
