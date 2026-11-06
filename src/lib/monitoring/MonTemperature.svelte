<script lang="ts">
  // The Temperature section (v1.33): the hottest reading over the window against
  // the user's threshold, cores as a heat grid, every sensor against its own
  // high and crit marks, and disks and GPUs. Without readings it says why —
  // Windows has no unprivileged source, lm-sensors may be missing, a VM may
  // expose nothing — because "no data" and "impossible here" are different
  // answers.
  import Chart from "./Chart.svelte";
  import MonCard from "./MonCard.svelte";
  import MonHeader from "./MonHeader.svelte";
  import TweenNumber from "./TweenNumber.svelte";
  import Icon from "../ui/Icon.svelte";
  import { series } from "./monhistory";
  import { hottest, type MonActions, type MonView } from "./monsections";
  import { sensorLevel } from "./monhealth";
  import { levelFill } from "./monpalette";
  import { supportsSensorsInstall, supportsTemperature } from "./hostcaps";
  import { thresholdLevel, levelTextClass } from "./thresholds";
  import { tooltip } from "../actions/tooltip";
  import { t } from "../i18n";

  let { v, a }: { v: MonView; a: MonActions } = $props();

  const m = $derived(v.metrics);
  const d = $derived(v.detail);
  const sensors = $derived(d?.sensors ?? []);
  const hot = $derived(hottest(m, d));
  const cores = $derived(sensors.filter((s) => /^core\s*\d+/i.test(s.label)));
  const pkg = $derived(sensors.find((s) => /^package/i.test(s.label)) ?? null);
  const warnAt = $derived(v.th.cpuTemp.warn);
  const hotKey = $derived(hot ? (sensors.length ? `temp.${hot.label}` : "cpuTemp") : "");
  const others = $derived([
    ...(v.extras?.smart ?? []).filter((s) => s.temp != null).map((s) => ({ label: s.device, temp: s.temp! })),
    ...(v.live?.gpus ?? v.extras?.gpus ?? []).map((g) => ({ label: g.name, temp: g.temp })),
  ]);
  const heat = (temp: number, level: string) =>
    level === "ok" ? `color-mix(in srgb, var(--color-bad) ${Math.round(Math.max(8, Math.min(70, temp - 30)))}%, transparent)` : levelFill(level as "warn" | "crit");
</script>

<MonHeader
  section="temperature"
  {v}
  {a}
  title={t("mon.temperature")}
  sub={sensors.length ? t("mon.sensorsN", { n: sensors.length }) : ""}
  onask={a.ask && hot ? () => a.ask?.({ kind: "section", section: "temperature" }) : undefined}
/>

{#if !hot}
  {#if !supportsTemperature(m.os)}
    <div class="flex items-start gap-2 rounded-lg border border-edge bg-panel p-3" data-testid="sensors-unsupported">
      <Icon name="info" size={15} class="mt-0.5 shrink-0 text-muted" />
      <p class="text-xs text-text">{t("mon.sensorsUnsupported")}</p>
    </div>
  {:else if d?.sensorsInstalled || !supportsSensorsInstall(m.os)}
    <div class="flex items-start gap-2 rounded-lg border border-edge bg-panel p-3" data-testid="sensors-none">
      <Icon name="info" size={15} class="mt-0.5 shrink-0 text-muted" />
      <div>
        <p class="text-xs text-text">{t("mon.sensorsNone")}</p>
        <p class="mt-0.5 text-meta text-muted">{t("mon.sensorsNoneHint")}</p>
      </div>
    </div>
  {:else}
    <div class="flex items-start gap-2 rounded-lg border border-edge bg-panel p-3" data-testid="sensors-install">
      <Icon name="info" size={15} class="mt-0.5 shrink-0 text-warn" />
      <div>
        <p class="text-xs text-text">{t("mon.sensorsUnavailable")}</p>
        <p class="mt-0.5 text-meta text-muted">{t("mon.sensorsHint")}</p>
        {#if a.installTool}
          <button
            type="button"
            class="mt-2 rounded bg-edge px-3 py-1 text-xs font-medium hover:bg-accent hover:text-panel-alt"
            onclick={() => a.installTool?.("sensors")}>{t("mon.installSensors")}</button
          >
        {/if}
      </div>
    </div>
  {/if}
{:else}
  <div class="mb-1 flex flex-wrap items-baseline gap-x-3">
    <TweenNumber value={hot.temp} format={(n) => `${Math.round(n)}°C`} class="text-2xl font-semibold {levelTextClass(thresholdLevel(hot.temp, v.th.cpuTemp))}" />
    <span class="text-xs text-muted">
      {t("mon.hottestIs", { label: hot.label })}{#if warnAt != null} · {t("mon.thresholdAt", { v: `${warnAt}°C` })}{/if}
    </span>
  </div>
  <Chart
    lines={[
      ...(pkg && pkg.label !== hot.label ? [{ samples: series(v.hist, `temp.${pkg.label}`), color: "var(--color-rail-3)" }] : []),
      { samples: series(v.hist, hotKey), color: "var(--color-rail-5)" },
    ]}
    seq={v.seq}
    max={100}
    ticks
    format={(n) => `${Math.round(n)}°`}
    threshold={warnAt}
    thresholdLabel={warnAt != null ? `${warnAt}°` : ""}
    marks
    interval={v.interval}
    height={110}
    testid="temp-history"
  />

  <div class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
    <div class="space-y-2">
      {#if cores.length >= 2}
        <MonCard title={t("mon.coreTemps")} testid="core-temps">
          <div class="grid grid-cols-4 gap-1">
            {#each cores as c (c.label)}
              {@const lv = sensorLevel(c, v.th.cpuTemp)}
              <div class="rounded px-1 py-1 text-center text-meta" style="background-color: {heat(c.temp, lv)}" use:tooltip={c.label}>
                <div class="truncate text-caption text-muted">{c.label.replace(/^core\s*/i, "C")}</div>
                <div class="tabular-nums text-text">{Math.round(c.temp)}°</div>
              </div>
            {/each}
          </div>
        </MonCard>
      {/if}
      {#if others.length}
        <MonCard title={t("mon.disksAndGpu")}>
          <dl class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
            {#each others as o, i (i)}
              <dt class="truncate font-mono text-text">{o.label}</dt>
              <dd class="text-right tabular-nums">{Math.round(o.temp)}°C</dd>
            {/each}
          </dl>
        </MonCard>
      {/if}
    </div>
    {#if sensors.length}
      <MonCard title={t("mon.sensorsToCrit")} testid="sensors-table">
        <ul class="space-y-1.5">
          {#each sensors as s, i (i)}
            {@const lv = sensorLevel(s, v.th.cpuTemp)}
            <li class="grid grid-cols-[7rem_minmax(0,1fr)_2.5rem] items-center gap-2 text-meta">
              <span class="truncate text-text" use:tooltip={s.label}>{s.label}</span>
              {#if s.crit}
                <span class="relative h-1.5 rounded-full bg-edge">
                  <span
                    class="absolute inset-0 origin-left rounded-full transition-transform duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                    style="transform: scaleX({Math.min(1, s.temp / s.crit)}); background-color: {levelFill(lv)}"
                  ></span>
                  {#if s.high}
                    <span class="absolute -top-0.5 -bottom-0.5 w-px bg-warn" style="left: {Math.min(100, (s.high / s.crit) * 100)}%"></span>
                  {/if}
                </span>
              {:else}
                <span class="text-muted">{t("mon.noCrit")}</span>
              {/if}
              <span class="text-right tabular-nums {levelTextClass(lv)}">{Math.round(s.temp)}°</span>
            </li>
          {/each}
        </ul>
      </MonCard>
    {/if}
  </div>
{/if}
