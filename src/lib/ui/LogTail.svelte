<script lang="ts">
  // A container's or a pod's log in its details (v1.33): the last N lines the
  // panel fetched, with what reading a log takes — follow it or hold it still,
  // narrow it by text and by severity, show or hide the timestamps, wrap long
  // lines, ask for more lines, follow it live in a terminal, copy what is shown.
  // Presentational: the caller fetches (a snapshot re-asked while `live`, never a
  // stream) and hands the text in; the reading is pure (`loglines.ts`).
  //
  // It stands beside a list inside the panel's query container, so it owns no
  // dialog and no menu (`panelcontainer.guard`): the choices are native selects.
  import { untrack, type Snippet } from "svelte";
  import CopyButton from "./CopyButton.svelte";
  import FilterField from "./FilterField.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import {
    filterLines,
    linesText,
    logLines,
    LOG_TAILS,
    freshLogView,
    shortStamp,
    type LogTailSize,
    type LogView,
  } from "./loglines";

  let {
    text = "",
    live = $bindable(true),
    tail = $bindable(200),
    fill = false,
    empty,
    testid = "log",
    onterminal = undefined,
    view = undefined,
    children,
  }: {
    text?: string;
    /** Re-asked on every poll; off — the snapshot stands still to be read. */
    live?: boolean;
    /** How many last lines are asked for. */
    tail?: LogTailSize;
    /** Take the height of the place it stands in; without it a dialog bounds it. */
    fill?: boolean;
    /** What an empty log says. */
    empty: string;
    /** Prefix of the test ids (`docker` → `docker-text`, `docker-copy-text`). */
    testid?: string;
    /** Follow the log live in a terminal tab (`logs -f`); absent — no button. */
    onterminal?: () => void;
    /**
     * How the log is read, kept by the caller (v1.34): the filter, the level, the
     * stamps, the wrap and the scroll are read from it and written to it in place,
     * so a rebuilt log reads on where it was. Absent — the log keeps its own.
     */
    view?: LogView;
    /** Before the controls: what picks the log (a pod's container). */
    children?: Snippet;
  } = $props();

  const own = $state(freshLogView());
  const r = $derived(view ?? own);

  const lines = $derived(logLines(text));
  const shown = $derived(filterLines(lines, r.query, r.level));
  const narrowed = $derived(r.query.trim() !== "" || r.level !== "all");

  // Read from the end, as a log is: the view starts at the bottom and stays
  // there while new lines come — unless the user scrolled up to read. A log
  // rebuilt mid-read goes back to where it was, once its lines are here.
  let scroller = $state<HTMLElement | null>(null);
  let restore: number | null = untrack(() => r.top);
  let atBottom = restore === null;
  function onscroll() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    r.top = atBottom ? null : Math.round(scroller.scrollTop);
  }
  $effect(() => {
    void shown;
    void r.wrap;
    if (!scroller) return;
    if (restore !== null) {
      if (shown.length === 0) return;
      scroller.scrollTop = restore;
      restore = null;
      return;
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  });

  const LEVEL_TEXT: Record<string, string> = { error: "text-bad", warn: "text-warn" };
  const TOGGLE = "flex shrink-0 items-center rounded p-1 hover:bg-edge hover:text-text";
  const SELECT =
    "shrink-0 rounded border border-edge bg-panel px-1 py-0.5 text-meta text-text outline-none focus:border-accent";
</script>

<div class="mb-1.5 flex flex-wrap items-center gap-1 text-meta text-muted" data-testid="{testid}-log-tools">
  {@render children?.()}
  <button
    type="button"
    class="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-edge hover:text-text {live ? 'text-text/85' : ''}"
    aria-pressed={live}
    use:tooltip={t(live ? "logs.pauseHint" : "logs.followHint")}
    data-testid="{testid}-log-live"
    onclick={() => (live = !live)}
  >
    {#if live}
      <span class="lt-pulse inline-block h-1.5 w-1.5 rounded-full bg-ok"></span>
      {t("logs.following")}
    {:else}
      <Icon name="pause" size={11} />
      {t("logs.paused")}
    {/if}
  </button>
  <FilterField
    value={r.query}
    oninput={(v) => (r.query = v)}
    placeholder={t("logs.filter")}
    shown={narrowed ? shown.length : null}
    total={narrowed ? lines.length : null}
    class="min-w-32 flex-1"
    testid="{testid}-log-filter"
  />
  <select class={SELECT} aria-label={t("logs.level")} bind:value={r.level} data-testid="{testid}-log-level">
    <option value="all">{t("logs.levelAll")}</option>
    <option value="warn">{t("logs.levelWarn")}</option>
    <option value="error">{t("logs.levelError")}</option>
  </select>
  <select class={SELECT} aria-label={t("logs.tail")} bind:value={tail} data-testid="{testid}-log-tail">
    {#each LOG_TAILS as n (n)}
      <option value={n}>{t("logs.tailLines", { n })}</option>
    {/each}
  </select>
  <button
    type="button"
    class="{TOGGLE} {r.stamps ? 'text-accent' : ''}"
    aria-pressed={r.stamps}
    aria-label={t("logs.stamps")}
    use:tooltip={t("logs.stamps")}
    data-testid="{testid}-log-stamps"
    onclick={() => (r.stamps = !r.stamps)}
  >
    <Icon name="clock" size={13} />
  </button>
  <button
    type="button"
    class="{TOGGLE} {r.wrap ? 'text-accent' : ''}"
    aria-pressed={r.wrap}
    aria-label={t("logs.wrap")}
    use:tooltip={t("logs.wrap")}
    data-testid="{testid}-log-wrap"
    onclick={() => (r.wrap = !r.wrap)}
  >
    <Icon name="wrap" size={13} />
  </button>
  {#if onterminal}
    <button
      type="button"
      class={TOGGLE}
      aria-label={t("logs.inTerminal")}
      use:tooltip={t("logs.inTerminal")}
      data-testid="{testid}-log-terminal"
      onclick={() => onterminal?.()}
    >
      <Icon name="terminal" size={13} />
    </button>
  {/if}
  <CopyButton text={linesText(shown, r.stamps)} label={t("util.copy")} testid="{testid}-copy-text" />
</div>
<div
  bind:this={scroller}
  {onscroll}
  data-testid="{testid}-text"
  class="{fill ? 'min-h-0 flex-1' : 'max-h-[60vh]'} overflow-auto rounded border border-edge bg-panel p-2 font-mono text-meta leading-relaxed text-text/85 select-text {r.wrap
    ? 'whitespace-pre-wrap break-all'
    : 'whitespace-pre'}"
>
  {#if lines.length === 0}
    <span class="text-muted">{empty}</span>
  {:else if shown.length === 0}
    <span class="text-muted">{t("logs.nothingMatches")}</span>
  {:else}
    {#each shown as line (line.n)}
      <div class={line.level ? LEVEL_TEXT[line.level] : ''}>{#if r.stamps && line.ts}<span class="mr-2 text-muted" use:tooltip={line.ts}>{shortStamp(line.ts)}</span>{/if}{line.text}</div>
    {/each}
  {/if}
</div>

<style>
  .lt-pulse {
    animation: lt-pulse-kf 1.4s ease-in-out infinite;
  }
  @keyframes lt-pulse-kf {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  :global(:root[data-motion="reduce"]) .lt-pulse {
    animation: none;
  }
</style>
