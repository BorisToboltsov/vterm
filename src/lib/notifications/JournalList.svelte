<script lang="ts">
  // The journal of notifications as a list (ADR 0062): every message the app
  // showed, in every window, newest first and by day — narrowed by the list's
  // filter row (ADR 0050), cleared from its «⋯». Drawn under the bell
  // (`JournalPanel`) and in Settings → Journal; while it is on screen it watches
  // the journal (`watchJournal`): read, kept fresh, what was unread marked seen.
  import { writtenByCall } from "../api/call";
  import { onMount } from "svelte";
  import Icon from "../ui/Icon.svelte";
  import type { IconName } from "../ui/icons";
  import ListHeader from "../ui/ListHeader.svelte";
  import GroupHeader from "../ui/GroupHeader.svelte";
  import EmptyState from "../ui/EmptyState.svelte";
  import FilteredEmpty from "../ui/FilteredEmpty.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import ContextMenu from "../ui/ContextMenu.svelte";
  import ConfirmDialog from "../ui/ConfirmDialog.svelte";
  import type { MenuItem, OpenMenu } from "../ui/ctxmenu";
  import { applyView, filterSummary, NO_FILTER } from "../ui/listview";
  import { listMenuText, type ListLabels } from "../ui/listtext";
  import { tooltip } from "../actions/tooltip";
  import { writeClipboard } from "../app/clipboard";
  import { settings } from "../settings/settings.svelte";
  import { t } from "../i18n";
  import type { JournalEntry, JournalKind } from "../types";
  import {
    clearJournal,
    journalState,
    removeFromJournal,
    setJournalFilter,
    watchJournal,
  } from "../stores/journal.svelte";
  import {
    clockOf,
    dayKind,
    isJournalSource,
    JOURNAL_ICON,
    JOURNAL_ORDER,
    JOURNAL_SCHEMA,
    journalText,
    windowOf,
  } from "./journal";

  let {
    here,
    onbusy,
    floor = "min-h-0",
    testid = "journal",
  }: {
    /** This window's label — a message said here does not name its window. */
    here: string;
    /** Told whether a menu or a question of the list is up: Esc and a press elsewhere are theirs then. */
    onbusy?: (busy: boolean) => void;
    /** How short the list may get: a box of its own lets it to nothing, a popover keeps room for the empty state. */
    floor?: string;
    testid?: string;
  } = $props();

  /** Rows drawn at first; the rest a click away (the journal keeps up to 1000). */
  const PAGE = 200;

  const ICON: Record<JournalKind, IconName> = { error: "alert", success: "check", info: "info" };
  const TONE: Record<JournalKind, string> = { error: "text-danger", success: "text-ok", info: "text-accent" };

  const kindName = (k: JournalKind): string => t(`journal.kind.${k}`);
  const sourceName = (s: string): string => (isJournalSource(s) ? t(`journal.source.${s}`) : s);

  const labels: ListLabels = {
    facet: (id) => t(id === "kind" ? "journal.facet.kind" : id === "server" ? "journal.facet.server" : "journal.facet.source"),
    value: (facet, value) => (facet === "kind" ? kindName(value as JournalKind) : facet === "source" ? sourceName(value) : value),
  };

  const view = $derived(applyView(journalState.entries, JOURNAL_SCHEMA, journalState.filter, JOURNAL_ORDER));
  const shownEntries = $derived(view.groups.flatMap((g) => g.items));
  const readIds = $derived(journalState.entries.filter((e) => e.read && !journalState.fresh.includes(e.id)).map((e) => e.id));
  const copyText = $derived(journalText(shownEntries, { kind: kindName, source: sourceName }));

  let limit = $state(PAGE);
  let collapsed = $state<string[]>([]);
  let expanded = $state<string[]>([]);
  let copiedId = $state<string | null>(null);
  let menu = $state<OpenMenu | null>(null);
  let confirm = $state<{ ids: string[] | null; text: string } | null>(null);

  $effect(() => {
    onbusy?.(menu !== null || confirm !== null);
  });

  onMount(() => watchJournal());

  /** The day a group stands for, as a header names it. */
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

  function aboutOf(e: JournalEntry): string {
    const win = windowOf(e.window, here);
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

  async function copyEntry(e: JournalEntry) {
    await writeClipboard(e.text);
    copiedId = e.id;
    setTimeout(() => {
      if (copiedId === e.id) copiedId = null;
    }, 1500);
  }

  function openMenu(ev: MouseEvent) {
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [];
    if (view.filtered && view.shown > 0) {
      items.push({
        icon: "filter",
        label: t("journal.clearShown"),
        hint: String(view.shown),
        onSelect: () => (confirm = { ids: shownEntries.map((e) => e.id), text: t("journal.confirmShown", { n: view.shown }) }),
      });
    }
    items.push(
      {
        icon: "check",
        label: t("journal.clearRead"),
        hint: String(readIds.length),
        disabled: readIds.length === 0,
        onSelect: () => (confirm = { ids: [...readIds], text: t("journal.confirmRead", { n: readIds.length }) }),
      },
      {
        icon: "trash",
        label: t("journal.clearAll"),
        danger: true,
        disabled: journalState.entries.length === 0,
        onSelect: () => (confirm = { ids: null, text: t("journal.confirmAll", { n: journalState.entries.length }) }),
      },
    );
    menu = { x: box.right - 208, y: box.bottom + 2, items };
  }

  async function doClear() {
    const what = confirm;
    confirm = null;
    if (!what) return;
    try {
      if (what.ids === null) await clearJournal();
      else await removeFromJournal(what.ids);
    } catch {
      /* the list stays as it is: nothing was removed */
      writtenByCall();
    }
  }
</script>

<div class="flex flex-1 flex-col {floor}" data-testid={testid}>
  {#if journalState.entries.length === 0}
    <div class="min-h-0 flex-1" data-testid="{testid}-empty">
      <EmptyState icon={JOURNAL_ICON} title={t("journal.emptyTitle")} hint={t("journal.emptyHint")} />
    </div>
  {:else}
    <ListHeader
      items={journalState.entries}
      schema={JOURNAL_SCHEMA}
      filter={journalState.filter}
      onfilter={(f) => {
        setJournalFilter(f);
        limit = PAGE;
      }}
      shown={view.shown}
      total={view.total}
      {labels}
      placeholder={t("journal.filter")}
      wide={true}
      onmenu={(m) => (menu = m)}
      testid="{testid}-header"
    >
      <button
        type="button"
        class="flex shrink-0 rounded p-1 hover:bg-edge hover:text-text"
        aria-label={t("journal.actions")}
        aria-haspopup="menu"
        use:tooltip={t("journal.actions")}
        data-testid="{testid}-menu"
        onclick={openMenu}
      >
        <Icon name="dots" size={13} strokeWidth={3} />
      </button>
    </ListHeader>
    {#if view.shown === 0}
      <div class="min-h-0 flex-1">
        <FilteredEmpty
          summary={filterSummary(JOURNAL_SCHEMA, journalState.filter, listMenuText(labels))}
          onreset={() => setJournalFilter(NO_FILTER)}
        />
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto" data-testid="{testid}-list">
        {#each view.groups as group (group.key)}
          {@const before = view.groups.slice(0, view.groups.indexOf(group)).reduce((n, g) => n + g.items.length, 0)}
          {#if before < limit}
            <GroupHeader
              label={dayLabel(group.key)}
              count={group.items.length}
              collapsed={collapsed.includes(group.key)}
              ontoggle={() => (collapsed = toggleIn(collapsed, group.key))}
              testid="{testid}-day"
            />
            {#if !collapsed.includes(group.key)}
              {#each group.items.slice(0, Math.max(0, limit - before)) as e (e.id)}
                {@const about = aboutOf(e)}
                {@const open = expanded.includes(e.id)}
                <div
                  class="group flex items-start gap-2 border-b border-edge px-3 py-1.5 {journalState.fresh.includes(e.id)
                    ? 'bg-edge/40'
                    : ''}"
                  data-testid="{testid}-row"
                  data-kind={e.kind}
                >
                  {#if journalState.fresh.includes(e.id)}
                    <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" use:tooltip={t("journal.fresh")}></span>
                  {:else}
                    <span class="w-1.5 shrink-0"></span>
                  {/if}
                  <Icon name={ICON[e.kind]} size={14} class="mt-0.5 shrink-0 {TONE[e.kind]}" />
                  <button
                    type="button"
                    class="min-w-0 flex-1 text-left"
                    aria-expanded={open}
                    onclick={() => (expanded = toggleIn(expanded, e.id))}
                  >
                    <span class="block break-words {open ? 'whitespace-pre-wrap' : 'line-clamp-3'}">{e.text}</span>
                    {#if about}<span class="block truncate text-meta text-muted">{about}</span>{/if}
                  </button>
                  <span class="flex shrink-0 flex-col items-end gap-0.5 text-meta text-muted">
                    <span class="tabular-nums">{clockOf(e.last)}</span>
                    <span class="flex items-center gap-1">
                      <button
                        type="button"
                        class="invisible flex rounded p-0.5 hover:text-accent group-focus-within:visible group-hover:visible"
                        aria-label={t("journal.copy")}
                        use:tooltip={t("journal.copy")}
                        onclick={() => void copyEntry(e)}
                      >
                        <Icon name={copiedId === e.id ? "check" : "copy"} size={12} />
                      </button>
                      {#if e.count > 1}
                        <span
                          class="rounded border px-1 tabular-nums {e.kind === 'error' ? 'border-danger text-danger' : 'border-edge'}"
                          data-testid="{testid}-count">×{e.count}</span
                        >
                      {/if}
                    </span>
                  </span>
                </div>
              {/each}
            {/if}
          {/if}
        {/each}
        {#if view.shown > limit}
          <button
            type="button"
            class="w-full px-3 py-1.5 text-center text-meta text-accent hover:bg-edge"
            data-testid="{testid}-more"
            onclick={() => (limit += PAGE)}>{t("journal.showMore", { n: Math.min(PAGE, view.shown - limit) })}</button
          >
        {/if}
      </div>
    {/if}
  {/if}

  <div class="flex shrink-0 items-center gap-2 border-t border-edge px-3 py-1.5 text-meta text-muted">
    <span class="min-w-0 flex-1 truncate" data-testid="{testid}-kept"
      >{settings.journalKeep
        ? t("journal.keptFor", { days: settings.journalDays, n: journalState.entries.length })
        : t("journal.notKept", { n: journalState.entries.length })}</span
    >
    {#if shownEntries.length > 0}
      <CopyButton text={copyText} label={t("journal.copyShown")} testid="{testid}-copy" />
    {/if}
  </div>

  <ContextMenu {menu} onclose={() => (menu = null)} />

  <ConfirmDialog
    open={confirm !== null}
    title={t("journal.confirmTitle")}
    confirmLabel={t("journal.clear")}
    onconfirm={() => void doClear()}
    oncancel={() => (confirm = null)}
  >
    {confirm?.text}
  </ConfirmDialog>
</div>
