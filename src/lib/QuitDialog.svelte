<script lang="ts">
  // Quit confirmation: always asked, and lists — one row per kind — what closing
  // would cut off. The counting is `quitRows` (quitsummary.ts); this only draws it.
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import type { QuitRow, QuitRowKey } from "./quitsummary";
  import { t, type MessageKey } from "./i18n";

  let {
    open = false,
    rows,
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    rows: QuitRow[];
    onconfirm?: () => void;
    oncancel?: () => void;
  } = $props();

  // Sessions in the accent, work in flight in `warn`, a recording in `bad` — the
  // same red its tab indicator uses.
  const LOOK: Record<QuitRowKey, { icon: IconName | null; tone: string; label: MessageKey }> = {
    ssh: { icon: "server", tone: "text-accent", label: "quit.rowSsh" },
    local: { icon: "terminal", tone: "text-accent", label: "quit.rowLocal" },
    transfers: { icon: "arrowsUpDown", tone: "text-warn", label: "quit.rowTransfers" },
    sync: { icon: "sync", tone: "text-warn", label: "quit.rowSync" },
    recording: { icon: null, tone: "text-bad", label: "quit.rowRecording" },
  };
</script>

<ConfirmDialog {open} title={t("quit.title")} confirmLabel={t("quit.confirm")} {onconfirm} {oncancel}>
  {#if rows.length > 0}
    <p class="mb-2">{t("quit.lead")}</p>
    <ul class="divide-y divide-edge rounded border border-edge" data-testid="quit-rows">
      {#each rows as row (row.key)}
        {@const look = LOOK[row.key]}
        <li class="flex items-center gap-2 px-2.5 py-1.5 text-text" data-testid={`quit-row-${row.key}`}>
          {#if look.icon}
            <Icon name={look.icon} size={14} class={look.tone} />
          {:else}
            <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <span class="h-2 w-2 rounded-full bg-bad"></span>
            </span>
          {/if}
          <span class="flex-1">{t(look.label)}</span>
          <span class="tabular-nums {look.tone}">{row.count}</span>
        </li>
      {/each}
    </ul>
  {/if}
</ConfirmDialog>
