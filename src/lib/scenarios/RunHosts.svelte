<script lang="ts">
  // The servers of one recipe run (ADR 0071): each with its state, the line
  // that tells its answer, the whole output on a click, and — for a failure —
  // "ask the assistant" through the usual masking and consent.
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";
  import Icon from "../ui/Icon.svelte";
  import { hostDone, type RecipeRunRecord, type RunHost } from "../stores/scenarios.svelte";
  import { hostLook, TONE_CLASS } from "./scenariotext";

  let {
    run,
    onask,
  }: {
    run: RecipeRunRecord;
    /** A failed host's answer to the assistant; absent — the assistant is off. */
    onask?: (host: RunHost) => void;
  } = $props();

  let open = $state<string | null>(null);
</script>

<div class="divide-y divide-edge/40" data-testid="run-hosts">
  {#each run.hosts as h (h.serverId)}
    {@const look = hostLook(h.state)}
    <div class="px-1 py-1">
      <div class="flex items-center gap-2 text-xs">
        <Icon name={look.icon} size={13} class="{TONE_CLASS[look.tone]} {hostDone(h.state) ? '' : 'animate-spin'}" />
        <span class="shrink-0 text-text">{h.alias}</span>
        {#if h.prod}<span class="rounded bg-danger/15 px-1 text-caption text-danger">prod</span>{/if}
        <span class="min-w-0 flex-1 truncate {TONE_CLASS[look.tone]}" use:tooltip={h.summary || look.text}>
          {h.summary ? `${look.text} · ${h.summary}` : look.text}
        </span>
        {#if h.output}
          <button
            type="button"
            class="shrink-0 rounded px-1 text-meta text-muted hover:bg-edge hover:text-text"
            aria-expanded={open === h.serverId}
            onclick={() => (open = open === h.serverId ? null : h.serverId)}
          >
            {open === h.serverId ? t("scenarios.run.hideOutput") : t("scenarios.run.output")}
          </button>
        {/if}
        {#if h.state === "failed" && onask}
          <button
            type="button"
            class="shrink-0 rounded p-0.5 text-muted hover:bg-edge hover:text-text"
            aria-label={t("scenarios.run.askAi")}
            use:tooltip={t("scenarios.run.askAi")}
            onclick={() => onask?.(h)}
          >
            <Icon name="aiMark" size={12} />
          </button>
        {/if}
      </div>
      {#if open === h.serverId}
        <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-panel-alt px-2 py-1 font-mono text-meta text-text">{h.output}</pre>
        {#if h.exit !== null}<div class="text-caption text-muted">exit {h.exit}</div>{/if}
      {/if}
    </div>
  {/each}
</div>
