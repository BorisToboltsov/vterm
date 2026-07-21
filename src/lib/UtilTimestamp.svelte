<script lang="ts">
  // Utilities → Unix timestamp ↔ date (Phase 33). Conversion + formatting is pure
  // logic in timeconv.ts; this component is a single flexible input (epoch or date
  // string) and a table of representations, plus a time-zone picker. Offline.
  import CopyButton from "./CopyButton.svelte";
  import { t, currentLocale, type MessageKey } from "./i18n";
  import {
    parseFlexible,
    toEpochSeconds,
    toEpochMillis,
    formatInZone,
    relativeParts,
    type EpochUnit,
  } from "./timeconv";

  // A small curated zone list plus the machine's own zone (dev tools rarely need
  // the full IANA database in a dropdown).
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ZONES = [
    localZone,
    "UTC",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Moscow",
    "Asia/Kolkata",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Australia/Sydney",
  ].filter((z, i, a) => a.indexOf(z) === i);

  let input = $state(String(Math.floor(Date.now() / 1000)));
  let unit = $state<EpochUnit>("auto");
  let zone = $state(localZone);

  const date = $derived(parseFlexible(input, unit));

  const relative = $derived.by(() => {
    if (!date) return "";
    const { value, unit: u } = relativeParts(date);
    return new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" }).format(value, u);
  });

  const rows = $derived.by(() => {
    if (!date) return [] as [MessageKey, string][];
    return [
      ["util.timestamp.epochS", String(toEpochSeconds(date))],
      ["util.timestamp.epochMs", String(toEpochMillis(date))],
      ["util.timestamp.isoUtc", date.toISOString()],
      ["util.timestamp.relative", relative],
      ["util.timestamp.timezone", formatInZone(date, zone)],
    ] satisfies [MessageKey, string][];
  });

  function setNow() {
    input = new Date().toISOString();
  }
</script>

<div class="space-y-3 text-xs text-muted">
  <div class="flex flex-wrap items-end gap-3">
    <label class="block flex-1 min-w-[16rem]">
      {t("util.timestamp.input")}
      <input
        data-testid="ts-input"
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 font-mono text-sm text-text outline-none focus:border-accent"
        bind:value={input}
      />
    </label>
    <label class="block">
      {t("util.timestamp.unit")}
      <select
        data-testid="ts-unit"
        class="mt-1 block rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
        bind:value={unit}
      >
        <option value="auto">{t("util.timestamp.unitAuto")}</option>
        <option value="s">{t("util.timestamp.unitS")}</option>
        <option value="ms">{t("util.timestamp.unitMs")}</option>
      </select>
    </label>
    <button
      type="button"
      data-testid="ts-now"
      class="rounded bg-edge px-3 py-1.5 text-sm hover:bg-accent hover:text-panel-alt"
      onclick={setNow}>{t("util.timestamp.now")}</button
    >
  </div>

  {#if !date}
    <p class="text-meta text-danger" data-testid="ts-error">{t("util.timestamp.invalid")}</p>
  {:else}
    <div class="flex items-center gap-2">
      <span class="text-muted">{t("util.timestamp.timezone")}</span>
      <select
        data-testid="ts-zone"
        class="rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
        bind:value={zone}
      >
        {#each ZONES as z (z)}
          <option value={z}>{z}</option>
        {/each}
      </select>
    </div>

    <table class="w-full max-w-lg">
      <tbody>
        {#each rows as [key, value] (key)}
          <tr class="border-b border-edge/50">
            <td class="py-1 pr-3 text-muted">{t(key)}</td>
            <td class="py-1 font-mono text-text">{value}</td>
            <td class="py-1 pl-2 text-right"><CopyButton text={value} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
