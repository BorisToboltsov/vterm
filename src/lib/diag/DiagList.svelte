<script lang="ts">
  // The diagnostics as a list (ADR 0063): what the app did, newest first and by
  // day, in Settings → Journal next to the messages. The backend narrows and
  // counts (`diag_query`) — the list on hand is a page, never the whole file — so the
  // filter row asks it again, and «Earlier» asks for the page under this one.
  // Above the list stands what is written now: an empty list at «Only errors»
  // means «no errors», not «nothing happened».
  import { onMount } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import ListHeader from "../ui/ListHeader.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import type { OpenMenu } from "../ui/ctxmenu";
  import { applyView, filterSummary, NO_FILTER, type ListFilter } from "../ui/listview";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import { tooltip } from "../actions/tooltip";
  import { settings } from "../settings/settings.svelte";
  import { t } from "../i18n";
  import type { DiagEvent, DiagLevel } from "../types";
  import { diagState, loadDiag, loadOlderDiag } from "../stores/diag.svelte";
  import { clockOf, dayKind, isJournalSource, JOURNAL_ICON, windowOf } from "../notifications/journal";
  import { DIAG_ORDER, DIAG_SCHEMA, diagText, fieldsLine, isDiagSource } from "./diag";

  let { here, testid = "diag" }: { here: string; testid?: string } = $props();

  const ICON: Record<DiagLevel, IconName> = { error: "alert", warn: "alert", info: "info", debug: "code", trace: "code" };
  const TONE: Record<DiagLevel, string> = {
    error: "text-bad",
    warn: "text-warn",
    info: "text-accent",
    debug: "text-muted",
    trace: "text-muted",
  };

  const sourceName = (s: string): string =>
    isJournalSource(s) || isDiagSource(s) ? t(`journal.source.${s}`) : s;
  const levelName = (l: string): string => t(`diag.levelName.${l as DiagLevel}`);

  const labels: ListLabels = {
    facet: (id) => t(id === "level" ? "diag.facet.level" : id === "server" ? "diag.facet.server" : "diag.facet.source"),
    value: (facet, value) => (facet === "level" ? levelName(value) : facet === "source" ? sourceName(value) : value),
  };

  // The backend has filtered the page: here it is only laid out by day.
  const view = $derived(applyView(diagState.events, DIAG_SCHEMA, NO_FILTER, DIAG_ORDER));
  const filtered = $derived(
    diagState.filter.text.trim() !== "" || Object.values(diagState.filter.facets).some((v) => v.length > 0),
  );
  const copyText = $derived(diagText(diagState.events, { source: sourceName }));

  let collapsed = $state<string[]>([]);
  let expanded = $state<string[]>([]);
  let menu = $state<OpenMenu | null>(null);
  let typing: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    void loadDiag();
    return () => {
      if (typing !== null) clearTimeout(typing);
    };
  });

  /** A new filter: the facets ask at once, the text when typing pauses. */
  function onfilter(next: ListFilter) {
    const sameText = next.text === diagState.filter.text;
    diagState.filter = next;
    if (typing !== null) clearTimeout(typing);
    typing = setTimeout(() => void loadDiag(next), sameText ? 0 : 250);
  }

  const keyOf = (e: DiagEvent, i: number): string => `${e.at}-${i}`;

  function dayLabel(key: string): string {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    switch (dayKind(key, Date.now())) {
      case "today":
        return t("journal.today");
      case "yesterday":
        return t("journal.yesterday", { date: date.toLocaleDateString(settings.language, { day: "numeric", month: "long" }) });
      default:
        return date.toLocaleDateString(settings.language, { weekday: "short", day: "numeric", month: "long" });
    }
  }

  function aboutOf(e: DiagEvent): string {
    const win = windowOf(e.win ?? null, here);
    return [
      e.server,
      e.source ? sourceName(e.source) : null,
      win === "main" ? t("journal.mainWindow") : win !== null ? t("journal.window", { n: win }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const toggleIn = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid={testid}>
  <div class="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-meta text-muted">
    <span class="min-w-0 flex-1 truncate" data-testid="{testid}-writes">{t(`diag.writes.${diagState.level}`)}</span>
    <button
      type="button"
      class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text disabled:opacity-40"
      aria-label={t("diag.refresh")}
      use:tooltip={t("diag.refresh")}
      disabled={diagState.loading}
      data-testid="{testid}-refresh"
      onclick={() => void loadDiag()}
    >
      <Icon name="refresh" size={13} />
    </button>
  </div>

  {#if diagState.failed}
    <p class="shrink-0 border-b border-edge px-3 py-1.5 text-meta text-bad" data-testid="{testid}-failed">
      {t("diag.readFailed", { error: diagState.failed })}
    </p>
  {/if}

  {#if diagState.total === 0 && !diagState.loading && !diagState.failed}
    <div class="min-h-0 flex-1" data-testid="{testid}-empty">
      <EmptyState icon={JOURNAL_ICON} title={t("diag.emptyTitle")} hint={t("diag.emptyHint")} />
    </div>
  {:else}
    <ListHeader
      items={diagState.events}
      schema={DIAG_SCHEMA}
      filter={diagState.filter}
      {onfilter}
      shown={diagState.events.length}
      total={diagState.total}
      counts={diagState.counts}
      {labels}
      placeholder={t("diag.filter")}
      wide={true}
      onmenu={(m) => (menu = m)}
      testid="{testid}-header"
    />
    {#if diagState.events.length === 0 && filtered && !diagState.loading}
      <div class="min-h-0 flex-1">
        <FilteredEmpty
          summary={filterSummary(DIAG_SCHEMA, diagState.filter, listMenuText(labels))}
          onreset={() => onfilter(NO_FILTER)}
        />
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto" data-testid="{testid}-list">
        {#each view.groups as group (group.key)}
          <GroupHeader
            label={dayLabel(group.key)}
            count={group.items.length}
            collapsed={collapsed.includes(group.key)}
            ontoggle={() => (collapsed = toggleIn(collapsed, group.key))}
            testid="{testid}-day"
          />
          {#if !collapsed.includes(group.key)}
            {#each group.items as e, i (keyOf(e, i))}
              {@const key = keyOf(e, i)}
              {@const about = aboutOf(e)}
              {@const open = expanded.includes(key)}
              {@const fields = fieldsLine(e)}
              <div class="flex items-start gap-2 border-b border-edge px-3 py-1.5" data-testid="{testid}-row" data-level={e.level}>
                <span class="mt-0.5 shrink-0" use:tooltip={levelName(e.level)}>
                  <Icon name={ICON[e.level]} size={14} class={TONE[e.level]} />
                </span>
                <button
                  type="button"
                  class="min-w-0 flex-1 text-left"
                  aria-expanded={open}
                  onclick={() => (expanded = toggleIn(expanded, key))}
                >
                  <span class="block break-words font-mono {open ? 'whitespace-pre-wrap' : 'line-clamp-2'}">{e.text}</span>
                  {#if open && fields}<span class="block break-all font-mono text-meta text-muted">{fields}</span>{/if}
                  {#if about}<span class="block truncate text-meta text-muted">{about}</span>{/if}
                </button>
                <span class="flex shrink-0 flex-col items-end gap-0.5 text-meta text-muted">
                  <span class="tabular-nums">{clockOf(e.at)}</span>
                  <span class="flex items-center gap-1">
                    {#if e.shown}
                      <span class="flex" use:tooltip={t("diag.shown")} data-testid="{testid}-shown"><Icon name="eye" size={12} /></span>
                    {/if}
                    {#if (e.count ?? 1) > 1}
                      <span class="rounded border border-edge px-1 tabular-nums" data-testid="{testid}-count">×{e.count}</span>
                    {/if}
                  </span>
                </span>
              </div>
            {/each}
          {/if}
        {/each}
        {#if diagState.more}
          <button
            type="button"
            class="w-full px-3 py-1.5 text-center text-meta text-accent hover:bg-edge disabled:opacity-40"
            disabled={diagState.loading}
            data-testid="{testid}-more"
            onclick={() => void loadOlderDiag()}>{t("diag.more")}</button
          >
        {/if}
      </div>
    {/if}
  {/if}

  <div class="flex shrink-0 items-center gap-2 border-t border-edge px-3 py-1.5 text-meta text-muted">
    <span class="min-w-0 flex-1 truncate" data-testid="{testid}-count-line"
      >{t("diag.shownOf", { n: diagState.events.length, total: diagState.total })}{diagState.unreadable > 0
        ? ` · ${t("diag.unreadable", { n: diagState.unreadable })}`
        : ""}</span
    >
    {#if diagState.events.length > 0}
      <CopyButton text={copyText} label={t("diag.copyShown")} testid="{testid}-copy" />
    {/if}
  </div>

  <ContextMenu {menu} onclose={() => (menu = null)} />
</div>
