<script lang="ts">
  // Settings → Databases (ADR 0080): how many rows a statement brings back,
  // how often the activity is read while on screen, and where it turns into
  // "needs attention". A value is taken when the field is left, within bounds.
  import { t, type MessageKey } from "../i18n";
  import { settings, clampDbActivity, clampDbRows, sanitizeDbThresholds } from "../settings/settings.svelte";
  import InfoHint from "../ui/InfoHint.svelte";
  import type { DbThresholds } from "./dbactivity";

  const THRESHOLDS: [keyof DbThresholds, MessageKey][] = [
    ["idleTxSec", "settings.dbIdleTx"],
    ["lockWaitSec", "settings.dbLockWait"],
    ["replLagSec", "settings.dbReplLag"],
    ["connPct", "settings.dbConnPct"],
    ["cacheHitPct", "settings.dbCacheHit"],
  ];

  // The field shows what was taken, also when that is what it already was.
  function take(el: HTMLInputElement, apply: (n: number) => number) {
    el.value = String(apply(el.valueAsNumber));
  }

  const input = "mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent";
</script>

<section data-settings-section="databases">
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionDatabases")}<InfoHint text={t("settings.dbNote")} />
  </h3>

  <div class="flex flex-wrap gap-3">
    <label class="block w-40 text-xs text-muted">
      <span class="flex items-center gap-1">{t("settings.dbRows")}<InfoHint text={t("settings.dbRowsHint")} /></span>
      <input
        type="number"
        min="100"
        max="10000"
        step="100"
        class={input}
        value={settings.dbMaxRows}
        onchange={(e) => take(e.currentTarget, (n) => (settings.dbMaxRows = clampDbRows(n)))}
        data-testid="settings-db-rows"
      />
    </label>
    <label class="block w-40 text-xs text-muted">
      <span class="flex items-center gap-1">{t("settings.dbActivity")}<InfoHint text={t("settings.dbActivityHint")} /></span>
      <input
        type="number"
        min="2"
        max="60"
        class={input}
        value={settings.dbActivitySec}
        onchange={(e) => take(e.currentTarget, (n) => (settings.dbActivitySec = clampDbActivity(n)))}
        data-testid="settings-db-activity"
      />
    </label>
  </div>

  <p class="mt-3 flex items-center gap-1 text-xs text-muted">{t("settings.dbAttention")}<InfoHint text={t("settings.dbAttentionHint")} /></p>
  <div class="mt-1 flex flex-wrap gap-3">
    {#each THRESHOLDS as [key, label] (key)}
      <label class="block w-40 text-xs text-muted">
        {t(label)}
        <input
          type="number"
          class={input}
          value={settings.dbThresholds[key]}
          onchange={(e) =>
            take(e.currentTarget, (n) => (settings.dbThresholds = sanitizeDbThresholds({ ...settings.dbThresholds, [key]: n }))[key])}
          data-testid="settings-db-{key}"
        />
      </label>
    {/each}
  </div>
</section>
