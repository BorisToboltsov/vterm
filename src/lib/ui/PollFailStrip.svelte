<script lang="ts">
  // A panel's reads failing (ADR 0062): said in the panel, above what it shows
  // — what is on screen is the last answer, and since when nothing newer came.
  // Not a toast: a poll that fails fails again every few seconds, and a toast per
  // tick buried the window. The streak is the panel's (`ui/poll.ts`); the strip
  // only draws it and offers a read now.
  import Icon from "./Icon.svelte";
  import { tooltip } from "../actions/tooltip";
  import { settings } from "../settings/settings.svelte";
  import { t } from "../i18n";
  import type { PollFailure } from "./poll";

  let {
    failure,
    onretry,
    testid = "poll-fail",
  }: {
    failure: PollFailure | null;
    onretry: () => void;
    testid?: string;
  } = $props();
</script>

{#if failure}
  <div
    class="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-edge bg-bad/10 px-2 py-1 text-meta"
    role="status"
    data-testid={testid}
  >
    <Icon name="alert" size={12} class="shrink-0 text-bad" />
    <span class="shrink-0 text-bad">
      {t("poll.failed", { time: new Date(failure.since).toLocaleTimeString(settings.language) })}
    </span>
    <span class="min-w-0 flex-1 truncate text-muted" use:tooltip={failure.text}>{failure.text}</span>
    {#if failure.count > 1}
      <span class="shrink-0 tabular-nums text-muted" data-testid="{testid}-count">×{failure.count}</span>
    {/if}
    <button
      type="button"
      class="shrink-0 rounded px-1 text-accent hover:bg-edge"
      data-testid="{testid}-retry"
      onclick={onretry}>{t("poll.retry")}</button
    >
  </div>
{/if}
