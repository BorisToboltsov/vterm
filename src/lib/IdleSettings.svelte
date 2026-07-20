<script lang="ts">
  // Idle-screensaver settings section (Phase 0.28). Picks which effect the
  // IdleOverlay shows after inactivity and after how many seconds. The heavy
  // rendering lives in IdleOverlay.svelte; the persisted fields + validation are
  // in settings.svelte.ts / idle.ts.
  import { settings } from "./settings.svelte";
  import {
    clampIdleTimeout,
    IDLE_EFFECTS,
    IDLE_TIMEOUT_MAX,
    IDLE_TIMEOUT_MIN,
    type IdleEffectId,
  } from "./idle";
  import { t } from "./i18n";
  import InfoHint from "./InfoHint.svelte";
  import { slide } from "svelte/transition";
  import { motion, MOTION_BASE } from "./motion";

  const LABELS: Record<IdleEffectId, () => string> = {
    card: () => t("settings.idleCard"),
    matrix: () => t("settings.idleMatrix"),
    parallax: () => t("settings.idleParallax"),
    signal: () => t("settings.idleSignal"),
  };

  // Repair the entered number to the valid whole-second range on commit (empty /
  // out-of-range / junk → clamped), so a half-typed value can't disable the timer.
  function commitTimeout() {
    settings.idleTimeoutSec = clampIdleTimeout(settings.idleTimeoutSec);
  }
</script>

<section data-settings-section="idle">
  <h3 class="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted">
    {t("settings.sectionIdle")}<InfoHint text={t("settings.idleNote")} />
  </h3>

  <label class="block text-xs text-muted">
    {t("settings.idleEffect")}
    <select
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
      data-testid="idle-effect-select"
      bind:value={settings.idleEffect}
    >
      <option value="off">{t("settings.idleOff")}</option>
      {#each IDLE_EFFECTS as fx (fx)}
        <option value={fx}>{LABELS[fx]()}</option>
      {/each}
    </select>
  </label>

  {#if settings.idleEffect !== "off"}
    <label class="mt-3 block text-xs text-muted" transition:slide={motion(MOTION_BASE)}>
      {t("settings.idleTimeout")}
      <span class="mt-1 flex items-center gap-2">
        <input
          type="number"
          min={IDLE_TIMEOUT_MIN}
          max={IDLE_TIMEOUT_MAX}
          step="1"
          class="w-28 rounded border border-edge bg-panel px-2 py-1 text-sm text-white outline-none focus:border-accent"
          data-testid="idle-timeout-input"
          bind:value={settings.idleTimeoutSec}
          onchange={commitTimeout}
          onblur={commitTimeout}
        />
        <span class="text-muted">{t("settings.idleTimeoutUnit")}</span>
      </span>
    </label>
  {/if}
</section>
