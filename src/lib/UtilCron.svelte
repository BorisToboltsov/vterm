<script lang="ts">
  // Utilities → Cron (Phase 33). Parsing + next-run math is pure logic in cron.ts;
  // this component renders a per-field breakdown (with localized month/weekday
  // names via Intl) and the next fire times. No natural-language generation — the
  // breakdown table is language-light on purpose. Offline.
  import { t, currentLocale, type MessageKey } from "./i18n";
  import { parseCron, nextRuns, type CronError, type CronFields } from "./cron";

  const ERR: Record<CronError, MessageKey> = {
    empty: "util.cron.errEmpty",
    fieldCount: "util.cron.errFieldCount",
    invalidField: "util.cron.errInvalid",
  };

  let input = $state("*/15 * * * *");
  const result = $derived(parseCron(input));

  const monthName = (n: number) =>
    new Intl.DateTimeFormat(currentLocale(), { month: "long" }).format(new Date(2020, n - 1, 1));
  const dowName = (n: number) =>
    // 2020-01-05 is a Sunday (getDay 0); add n days to land on weekday n.
    new Intl.DateTimeFormat(currentLocale(), { weekday: "long" }).format(new Date(2020, 0, 5 + n));

  function fieldValue(set: Set<number>, star: boolean, name?: (n: number) => string): string {
    if (star) return t("util.cron.every");
    const vals = [...set].sort((a, b) => a - b);
    return vals.map((v) => (name ? name(v) : String(v))).join(", ");
  }

  const rows = $derived.by(() => {
    if (!result.ok) return [] as [MessageKey, string][];
    const f: CronFields = result.fields;
    return [
      ["util.cron.minute", fieldValue(f.minute, f.minute.size === 60)],
      ["util.cron.hour", fieldValue(f.hour, f.hour.size === 24)],
      ["util.cron.dom", fieldValue(f.dom, f.domStar)],
      ["util.cron.month", fieldValue(f.month, f.month.size === 12, monthName)],
      ["util.cron.dowLabel", fieldValue(f.dow, f.dowStar, dowName)],
    ] satisfies [MessageKey, string][];
  });

  const runs = $derived(result.ok ? nextRuns(result.fields, new Date(), 5) : []);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "short" }).format(d);
</script>

<div class="space-y-3 text-xs text-muted">
  <label class="block">
    {t("util.cron.input")}
    <input
      data-testid="cron-input"
      class="mt-1 w-full max-w-sm rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-white outline-none focus:border-accent"
      placeholder="*/15 * * * *"
      bind:value={input}
    />
  </label>

  {#if !result.ok}
    <p class="text-meta text-danger" data-testid="cron-error">{t(ERR[result.error])}</p>
  {:else}
    <table class="w-full max-w-md">
      <tbody>
        {#each rows as [key, value] (key)}
          <tr class="border-b border-edge/50">
            <td class="w-32 py-1 pr-3 text-muted">{t(key)}</td>
            <td class="py-1 text-white">{value}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div>
      <p class="mb-1 font-medium text-white">{t("util.cron.nextRuns")}</p>
      {#if runs.length === 0}
        <p class="text-meta text-muted" data-testid="cron-noruns">{t("util.cron.noRuns")}</p>
      {:else}
        <ul class="space-y-0.5 font-mono text-white" data-testid="cron-runs">
          {#each runs as r (r.getTime())}
            <li>{fmt(r)}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
