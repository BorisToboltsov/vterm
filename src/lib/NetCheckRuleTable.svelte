<script lang="ts">
  // Utilities → access check, the rules (v1.21, ADR 0032): a box to paste a
  // request into as it came, and the table it becomes — a row per rule, four
  // cells and, under each, which server will check it (with no source: the
  // picked ones, ADR 0033). "From" is a list — all picked, one picked server, or
  // an address typed — not a box to type into. Reading the
  // paste is netcheckpaste.ts, a row's rules are netcheckform.ts, routing is
  // netroute.ts; this binds them to inputs. The rows live in the store, per home
  // host.
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import { tooltip } from "./actions/tooltip";
  import { t, type MessageKey } from "./i18n";
  import { historyLabel } from "./netcheck";
  import { markedPieces, pasteSummary, recognize, type PasteNote } from "./netcheckpaste";
  import {
    asProto,
    isBlankRow,
    newRow,
    sourceChoice,
    sourceOptions,
    splitHostPort,
    textRows,
    withSource,
    type RowError,
    type RuleRow,
    type SourceChoice,
  } from "./netcheckform";
  import type { NetHost, RowRoute } from "./netroute";
  import type { MenuItem, OpenMenu } from "./ctxmenu";
  import { netcheckState, rowsOf, setRows } from "./stores/netcheck.svelte";

  let {
    homeKey,
    hosts,
    picked,
    errors,
    routes,
    hostName,
  }: {
    homeKey: string;
    hosts: NetHost[];
    /** Host keys picked under "Check from" — what the From list offers. */
    picked: string[];
    /** Per row: why it can't run, or null. */
    errors: (RowError | null)[];
    /** Per row: where it runs (null for a row with an error). */
    routes: (RowRoute | null)[];
    /** A host's name as the tool shows it. */
    hostName: (key: string) => string;
  } = $props();

  const rows = $derived(rowsOf(homeKey));
  const history = $derived(netcheckState.history[homeKey] ?? []);

  // ── The paste box ────────────────────────────────────────────────────────
  let inbox = $state("");
  let showParse = $state(false);
  const pasted = $derived(inbox.trim() ? recognize(inbox) : null);
  const summary = $derived(pasted ? pasteSummary(pasted) : null);

  function addPasted() {
    if (!pasted || pasted.rules.length === 0) return;
    setRows(homeKey, [...rows.filter((r) => !isBlankRow(r)), ...pasted.rules.map((d) => newRow(d))]);
    inbox = "";
    showParse = false;
  }

  function onInboxKey(e: KeyboardEvent) {
    // ⌘/Ctrl+Enter adds, like a query editor runs.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addPasted();
    }
  }

  const NOTE_KEY: Record<PasteNote, MessageKey> = {
    sourceByOrder: "util.netcheck.note.sourceByOrder",
    portByName: "util.netcheck.note.portByName",
    noPorts: "util.netcheck.note.noPorts",
    noTarget: "util.netcheck.note.noTarget",
    nothing: "util.netcheck.note.nothing",
    udpOnly: "util.netcheck.note.udpOnly",
  };
  const MARK_CLASS = { addr: "bg-accent/15 text-accent", port: "bg-ok/15 text-ok", proto: "bg-ok/15 text-ok" };

  // ── Rows ─────────────────────────────────────────────────────────────────
  // What the last delete took, and what "Clear" or a history entry replaced —
  // a draft isn't stored data, so no dialog, but it comes back with one click.
  let removed = $state<{ row: RuleRow; index: number } | null>(null);
  let clearedRows = $state<RuleRow[] | null>(null);
  let menu = $state<OpenMenu | null>(null);
  let rowEls: Record<string, HTMLInputElement> = {};

  function addRow() {
    const row = newRow();
    setRows(homeKey, [...rows, row]);
    removed = null;
    queueMicrotask(() => rowEls[row.id]?.focus());
  }

  /** Delete a row (undone by `undoRemove`). */
  function removeRow(id: string) {
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) return;
    removed = { row: rows[index], index };
    setRows(homeKey, rows.filter((r) => r.id !== id));
  }

  function undoRemove() {
    if (!removed) return;
    const next = [...rows];
    next.splice(Math.min(removed.index, next.length), 0, removed.row);
    setRows(homeKey, next);
    removed = null;
  }

  function clearRows() {
    if (rows.length === 0) return;
    removed = null;
    clearedRows = rows;
    setRows(homeKey, []);
  }
  function undoClear() {
    if (clearedRows) setRows(homeKey, clearedRows);
    clearedRows = null;
  }

  function onTargetInput(row: RuleRow) {
    // `10.70.39.10:22` typed or pasted whole → spread over the two cells.
    if (row.ports.trim()) return;
    const split = splitHostPort(row.targets);
    if (!split) return;
    row.targets = split.target;
    row.ports = split.ports;
  }

  function openRowMenu(e: MouseEvent, row: RuleRow) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const via: MenuItem = {
      kind: "submenu",
      key: "via",
      icon: "server",
      label: t("util.netcheck.checkFrom"),
      items: [
        { label: t("util.netcheck.viaAuto"), checked: row.via === null, onSelect: () => (row.via = null) },
        ...hosts.map((h) => ({
          label: hostName(h.key),
          checked: row.via === h.key,
          onSelect: () => (row.via = h.key),
        })),
      ],
    };
    menu = {
      x: r.right - 200,
      y: r.bottom + 4,
      items: [
        via,
        { kind: "separator" },
        { label: t("util.netcheck.deleteRule"), icon: "trash", danger: true, onSelect: () => removeRow(row.id) },
      ],
    };
  }

  function openHistory(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: r.left,
      y: r.bottom + 4,
      items: history.map((entry) => ({
        label: historyLabel(entry),
        icon: "history" as const,
        onSelect: () => {
          clearedRows = rows.length ? rows : null;
          setRows(homeKey, textRows(entry));
        },
      })),
    };
  }

  const ERR_KEY: Record<string, MessageKey> = {
    syntax: "util.netcheck.err.syntax",
    host: "util.netcheck.err.host",
    unspecified: "util.netcheck.err.unspecified",
    port: "util.netcheck.err.port",
    range: "util.netcheck.err.range",
    empty: "util.netcheck.err.empty",
    tooMany: "util.netcheck.err.tooMany",
    noTarget: "util.netcheck.err.noTarget",
    noPorts: "util.netcheck.err.noPorts",
  };
  const errorText = (e: RowError) => t(ERR_KEY[e.code], { token: "token" in e ? e.token : "" });

  // ── The From cell ────────────────────────────────────────────────────────
  const hostKeys = $derived(hosts.map((h) => h.key));
  // The row whose From cell is a text box right now, and what's typed in it.
  let typingId = $state<string | null>(null);
  let typed = $state("");
  let sourceEls: Record<string, HTMLInputElement> = {};

  function setSource(row: RuleRow, choice: SourceChoice) {
    const next = withSource(choice);
    row.source = next.source;
    row.via = next.via;
  }

  /** A server as the list names it: its name, and the address beside it. */
  function hostLabel(key: string): string {
    const h = hostOf(key);
    const name = hostName(key);
    return h?.address && h.address !== name ? `${name} · ${h.address}` : name;
  }

  function startTyping(row: RuleRow) {
    typed = row.via ? "" : row.source;
    typingId = row.id;
    queueMicrotask(() => sourceEls[row.id]?.focus());
  }

  /** Take what was typed: an address, or — nothing typed — all picked. */
  function commitTyping(row: RuleRow) {
    if (typingId !== row.id) return;
    typingId = null;
    setSource(row, typed.trim() ? { kind: "text", text: typed } : { kind: "all" });
  }

  function onTypingKey(e: KeyboardEvent, row: RuleRow) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitTyping(row);
    } else if (e.key === "Escape") {
      // Cancels the typing only: the Utilities window closes on an Escape that
      // reaches the window.
      e.preventDefault();
      e.stopPropagation();
      typingId = null;
    }
  }

  function openSourceMenu(e: MouseEvent, row: RuleRow) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const choice = sourceChoice(row, hostKeys);
    const items: MenuItem[] = [
      {
        label: t("util.netcheck.sourceAll"),
        checked: choice.kind === "all",
        onSelect: () => setSource(row, { kind: "all" }),
      },
      ...sourceOptions(picked, hostKeys, choice).map((key) => ({
        label: hostLabel(key),
        checked: choice.kind === "host" && choice.key === key,
        onSelect: () => setSource(row, { kind: "host", key }),
      })),
    ];
    // The address the cell shows is in the list too; picking it edits it.
    if (choice.kind === "text") items.push({ label: choice.text, checked: true, onSelect: () => startTyping(row) });
    items.push(
      { kind: "separator" },
      { label: t("util.netcheck.sourceType"), icon: "pencil", onSelect: () => startTyping(row) },
    );
    menu = { x: r.left, y: r.bottom + 4, items };
  }

  const hostOf = (key: string) => hosts.find((h) => h.key === key);
  const cell =
    "w-full min-w-0 rounded border border-edge bg-panel px-1.5 py-1 font-mono text-text outline-none placeholder:text-muted focus:border-accent";
</script>

<div data-testid="netcheck-rules-block">
  <div class="mb-1 flex items-center gap-1.5">
    <span>{t("util.netcheck.rules")}</span>
    <InfoHint text={t("util.netcheck.rulesHint")} />
    <span class="flex-1"></span>
    {#if history.length}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
        data-testid="netcheck-history"
        onclick={openHistory}
      >
        <Icon name="history" size={12} />{t("util.netcheck.recent")}
      </button>
    {/if}
    {#if rows.length}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-muted hover:bg-edge hover:text-text"
        data-testid="netcheck-clear"
        onclick={clearRows}
      >
        <Icon name="close" size={12} />{t("util.netcheck.clearRules")}
      </button>
    {/if}
  </div>

  <!-- The paste box: anything a request arrives as. Nothing is added until
       "Add" — the summary and the marked text say what would be. -->
  <textarea
    data-testid="netcheck-inbox"
    rows={inbox.includes("\n") ? 5 : 2}
    spellcheck="false"
    class="w-full resize-y rounded border border-edge bg-panel px-2 py-1.5 font-mono text-xs leading-5 text-text outline-none placeholder:text-muted focus:border-accent"
    placeholder={t("util.netcheck.inboxPlaceholder")}
    bind:value={inbox}
    onkeydown={onInboxKey}
  ></textarea>
  {#if pasted && summary}
    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta" data-testid="netcheck-paste-summary">
      {#if summary.rules > 0}
        <span class="flex items-center gap-1 text-ok"><Icon name="check" size={12} />{t("util.netcheck.pasteRules", { n: summary.rules })}</span>
      {:else}
        <span class="flex items-center gap-1 text-warn"><Icon name="alert" size={12} />{t("util.netcheck.pasteNone")}</span>
      {/if}
      {#if summary.header}<span class="text-muted">· {t("util.netcheck.pasteHeader")}</span>{/if}
      {#if summary.skipped}<span class="text-muted">· {t("util.netcheck.pasteSkipped", { n: summary.skipped })}</span>{/if}
      {#if summary.guesses}<span class="text-warn">· {t("util.netcheck.pasteGuesses", { n: summary.guesses })}</span>{/if}
      {#if summary.noPorts}<span class="text-warn">· {t("util.netcheck.pasteNoPorts", { n: summary.noPorts })}</span>{/if}
      <span class="flex-1"></span>
      <button
        type="button"
        class="rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text"
        data-testid="netcheck-paste-show"
        aria-expanded={showParse}
        onclick={() => (showParse = !showParse)}
      >
        {showParse ? t("util.netcheck.pasteHide") : t("util.netcheck.pasteShow")}
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="netcheck-paste-add"
        disabled={summary.rules === 0}
        onclick={addPasted}
      >
        <Icon name="plus" size={12} />{t("util.netcheck.pasteAdd", { n: summary.rules })}
      </button>
    </div>
    {#if showParse}
      <!-- What was read: taken tokens marked in the original text, and per line
           what it gave or why it was left out. -->
      <div class="mt-1 max-h-56 overflow-auto rounded border border-edge bg-panel py-1 font-mono text-meta" data-testid="netcheck-paste-lines">
        {#each pasted.lines.filter((l) => l.kind !== "blank") as line (line.line)}
          <div class="flex items-start gap-2 px-2 py-0.5">
            <span class="w-6 shrink-0 text-right text-muted">{line.line}</span>
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-all {line.kind === 'skipped' ? 'text-muted line-through' : line.kind === 'header' ? 'text-muted' : 'text-text'}">
              {#each markedPieces(line) as piece, i (i)}
                {#if piece.kind}<span class="rounded-sm px-0.5 {MARK_CLASS[piece.kind]}">{piece.text}</span>{:else}{piece.text}{/if}
              {/each}
            </span>
            <span class="shrink-0 font-sans {line.notes.some((n) => n === 'sourceByOrder' || n === 'portByName' || n === 'noPorts' || n === 'udpOnly') ? 'text-warn' : 'text-muted'}">
              {#if line.kind === "header"}
                {t("util.netcheck.lineHeader")}
              {:else if line.notes.length}
                {line.notes.map((n) => t(NOTE_KEY[n])).join(" · ")}
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if rows.length}
    <div class="mt-2 rounded border border-edge" data-testid="netcheck-table">
      <div class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_4.25rem_1.75rem] gap-1.5 border-b border-edge bg-panel px-2 py-1 text-meta text-muted">
        <span>{t("util.netcheck.colFrom")}</span>
        <span>{t("util.netcheck.colTo")}</span>
        <span>{t("util.netcheck.colPorts")}</span>
        <span>{t("util.netcheck.colProto")}</span>
        <span></span>
      </div>
      {#each rows as row, i (row.id)}
        {@const err = errors[i] ?? null}
        {@const route = routes[i] ?? null}
        <div class="border-b border-edge/60 px-2 py-1.5 last:border-0" data-testid="netcheck-rule-row">
          <div class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_4.25rem_1.75rem] items-center gap-1.5">
            {#if typingId === row.id}
              <input
                bind:this={sourceEls[row.id]}
                class={cell}
                data-testid="netcheck-source-input"
                aria-label={t("util.netcheck.colFrom")}
                placeholder={t("util.netcheck.sourcePlaceholder")}
                spellcheck="false"
                bind:value={typed}
                onkeydown={(e) => onTypingKey(e, row)}
                onblur={() => commitTyping(row)}
              />
            {:else}
              {@const choice = sourceChoice(row, hostKeys)}
              <button
                type="button"
                class="{cell} flex items-center gap-1 text-left"
                data-testid="netcheck-cell-source"
                aria-haspopup="menu"
                aria-label={t("util.netcheck.colFrom")}
                onclick={(e) => openSourceMenu(e, row)}
              >
                <span class="min-w-0 flex-1 truncate {choice.kind === 'text' ? '' : 'font-sans'}">
                  {choice.kind === "all"
                    ? t("util.netcheck.sourceAll")
                    : choice.kind === "host"
                      ? hostName(choice.key)
                      : choice.text}
                </span>
                <Icon name="chevronDown" size={12} class="shrink-0 text-muted" />
              </button>
            {/if}
            <input
              bind:this={rowEls[row.id]}
              class={cell}
              data-testid="netcheck-cell-targets"
              aria-label={t("util.netcheck.colTo")}
              placeholder="10.70.39.10"
              spellcheck="false"
              bind:value={row.targets}
              oninput={() => onTargetInput(row)}
            />
            <input
              class={cell}
              data-testid="netcheck-cell-ports"
              aria-label={t("util.netcheck.colPorts")}
              placeholder="22, https"
              spellcheck="false"
              bind:value={row.ports}
            />
            <select
              class="{cell} px-1"
              data-testid="netcheck-cell-proto"
              aria-label={t("util.netcheck.colProto")}
              value={row.proto}
              onchange={(e) => (row.proto = asProto((e.currentTarget as HTMLSelectElement).value))}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
            <button
              type="button"
              class="flex h-6 items-center justify-center rounded text-muted hover:bg-edge hover:text-text"
              data-testid="netcheck-row-menu"
              aria-label={t("util.netcheck.rowMenu")}
              use:tooltip={t("util.netcheck.rowMenu")}
              onclick={(e) => openRowMenu(e, row)}
            >
              <Icon name="dots" size={14} />
            </button>
          </div>
          <!-- Where the row runs, or why it can't. -->
          <div class="mt-1 flex flex-wrap items-center gap-x-1.5 text-meta" data-testid="netcheck-route">
            {#if err}
              <span class="flex items-center gap-1 text-bad" data-testid="netcheck-row-error">
                <Icon name="alert" size={12} />{errorText(err)}
              </span>
            {:else if route && route.hosts.length === 0}
              <span class="flex items-center gap-1 text-warn" data-testid="netcheck-route-none">
                <Icon name="alert" size={12} />{t("util.netcheck.routeNone")}
              </span>
              {#if route.how === "fallback"}
                <span class="text-muted" data-testid="netcheck-source-warn">
                  · {t("util.netcheck.routeUnmatched", { source: route.unmatched.join(", ") })}
                </span>
              {/if}
            {:else if route}
              <Icon name="arrowRight" size={11} class="text-muted" />
              {#each route.hosts as key, k (key)}
                {@const h = hostOf(key)}
                <span class={h && !h.live ? "text-warn" : "text-text"}>{hostName(key)}{k < route.hosts.length - 1 ? "," : ""}</span>
                {#if h && !h.live}
                  <span class="text-warn">({h.connecting ? t("util.netcheck.hostConnecting") : t("util.netcheck.hostOffline")})</span>
                {/if}
              {/each}
              {#if route.how === "picked"}
                <span class="text-muted">· {t("util.netcheck.routePicked")}</span>
              {:else if route.how === "override"}
                <span class="text-accent">· {t("util.netcheck.routeOverride")}</span>
              {:else if route.how === "fallback"}
                <span class="text-warn" data-testid="netcheck-source-warn">
                  · {t("util.netcheck.routeFallback", { source: route.unmatched.join(", ") })}
                </span>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="mt-1.5 flex flex-wrap items-center gap-2 text-meta">
    <button
      type="button"
      class="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-edge hover:text-text"
      data-testid="netcheck-add-row"
      onclick={addRow}
    >
      <Icon name="plus" size={12} />{t("util.netcheck.addRule")}
    </button>
    {#if removed}
      <span class="text-muted" data-testid="netcheck-removed">
        {t("util.netcheck.ruleRemoved")}
        <button type="button" class="text-accent hover:underline" data-testid="netcheck-undo" onclick={undoRemove}>{t("util.netcheck.undo")}</button>
      </span>
    {:else if clearedRows}
      <span class="text-muted" data-testid="netcheck-cleared">
        {t("util.netcheck.rulesReplaced")}
        <button type="button" class="text-accent hover:underline" data-testid="netcheck-undo" onclick={undoClear}>{t("util.netcheck.undo")}</button>
      </span>
    {/if}
  </div>
</div>

<ContextMenu {menu} onclose={() => (menu = null)} />
