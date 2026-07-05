<script lang="ts">
  // Status-bar settings section: visibility + poll interval, the shown-metrics
  // checklist, and the warn/crit thresholds editor. Extracted from
  // SettingsPanel.svelte in Phase 18.5; reads/writes the settings store directly.
  import { settings, type StatusBarItems, type ThresholdKey } from "./settings.svelte";
  import Icon from "./Icon.svelte";
  import InfoHint from "./InfoHint.svelte";
  import DisclosureRow from "./DisclosureRow.svelte";
  import { t, type MessageKey } from "./i18n";
  import { slide } from "svelte/transition";

  let metricsOpen = $state(false);
  const STATUS_ITEMS: { key: keyof StatusBarItems; labelKey: MessageKey }[] = [
    { key: "os", labelKey: "settings.metric.os" },
    { key: "host", labelKey: "settings.metric.host" },
    { key: "cpu", labelKey: "settings.metric.cpu" },
    { key: "load", labelKey: "settings.metric.load" },
    { key: "ram", labelKey: "settings.metric.ram" },
    { key: "swap", labelKey: "settings.metric.swap" },
    { key: "disk", labelKey: "settings.metric.disk" },
    { key: "diskio", labelKey: "settings.metric.diskio" },
    { key: "net", labelKey: "settings.metric.net" },
    { key: "netConns", labelKey: "settings.metric.netConns" },
    { key: "uptime", labelKey: "settings.metric.uptime" },
    { key: "users", labelKey: "settings.metric.users" },
    { key: "ip", labelKey: "settings.metric.ip" },
    { key: "topProc", labelKey: "settings.metric.topProc" },
    { key: "cpuTemp", labelKey: "settings.metric.cpuTemp" },
    { key: "kernel", labelKey: "settings.metric.kernel" },
    { key: "serverTime", labelKey: "settings.metric.serverTime" },
  ];

  // Status-bar thresholds (collapsible sub-section). Each numeric metric gets an
  // average (amber) and a limit (red); `unit` is shown next to the inputs.
  let thresholdsOpen = $state(false);
  const THRESHOLD_ITEMS: { key: ThresholdKey; labelKey: MessageKey; unit: string }[] = [
    { key: "cpu", labelKey: "settings.metric.cpu", unit: "%" },
    { key: "ram", labelKey: "settings.metric.ram", unit: "%" },
    { key: "swap", labelKey: "settings.metric.swap", unit: "%" },
    { key: "disk", labelKey: "settings.metric.disk", unit: "%" },
    { key: "inodes", labelKey: "settings.thresholdInodes", unit: "%" },
    { key: "fd", labelKey: "settings.thresholdFd", unit: "%" },
    { key: "load", labelKey: "settings.thresholdLoad", unit: "" },
    { key: "cpuTemp", labelKey: "settings.metric.cpuTemp", unit: "°C" },
  ];
</script>

<!-- Status bar -->
<section>
  <h3 class="mb-2 text-xs uppercase tracking-wider text-muted">{t("settings.sectionStatusBar")}</h3>
  <label class="flex items-center gap-2 text-xs text-muted">
    <input type="checkbox" bind:checked={settings.showStatusBar} />
    {t("settings.showStatusBar")}
  </label>
  <label class="mt-2 flex items-center gap-2 text-xs text-muted">
    <input type="checkbox" bind:checked={settings.statusBarExpanded} />
    {t("settings.expandedByDefault")}
  </label>
  <label class="mt-2 block text-xs text-muted">
    {t("settings.pollInterval")}
    <input
      type="number"
      min="1"
      max="120"
      class="mt-1 w-32 rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      bind:value={settings.statusPollInterval}
    />
  </label>

  <div class="mt-2">
    <DisclosureRow bind:open={metricsOpen} testid="metrics-toggle" label={t("settings.shownMetrics")} />
    {#if metricsOpen}
      <div transition:slide={{ duration: 200 }} class="mt-2 grid grid-cols-2 gap-1.5">
        {#each STATUS_ITEMS as it (it.key)}
          <label class="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={settings.statusBarItems[it.key]} />
            {t(it.labelKey)}
          </label>
        {/each}
      </div>
    {/if}
  </div>

  <div class="mt-2">
    <button
      type="button"
      data-testid="thresholds-toggle"
      aria-expanded={thresholdsOpen}
      onclick={() => (thresholdsOpen = !thresholdsOpen)}
      class="flex w-full items-center justify-between rounded text-xs text-muted hover:text-white"
    >
      <span>{t("settings.thresholdsPre")}<span class="text-warn">{t("settings.thresholdsAmber")}</span>{t("settings.thresholdsMid")}<span class="text-danger">{t("settings.thresholdsRed")}</span>{t("settings.thresholdsPost")}</span>
      <Icon name={thresholdsOpen ? "chevronDown" : "chevronRight"} size={14} class="shrink-0" />
    </button>
    {#if thresholdsOpen}
      <div transition:slide={{ duration: 200 }} class="mt-2 space-y-1.5">
        <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
          <span class="flex items-center gap-1"
            >{t("settings.thresholdMetric")}<InfoHint text={t("settings.thresholdNote")} /></span
          >
          <span class="w-20 text-center text-warn">{t("settings.thresholdAverage")}</span>
          <span class="w-20 text-center text-danger">{t("settings.thresholdLimit")}</span>
        </div>
        {#each THRESHOLD_ITEMS as it (it.key)}
          <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-xs text-muted">
            <span>{t(it.labelKey)}{it.unit ? ` (${it.unit})` : ""}</span>
            <input
              type="number"
              min="0"
              aria-label={t("settings.thresholdAverageAria", { label: t(it.labelKey) })}
              class="w-20 rounded border border-edge bg-panel px-2 py-1 text-right text-sm text-white outline-none focus:border-accent"
              bind:value={settings.statusBarThresholds[it.key].warn}
            />
            <input
              type="number"
              min="0"
              aria-label={t("settings.thresholdLimitAria", { label: t(it.labelKey) })}
              class="w-20 rounded border border-edge bg-panel px-2 py-1 text-right text-sm text-white outline-none focus:border-accent"
              bind:value={settings.statusBarThresholds[it.key].crit}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
