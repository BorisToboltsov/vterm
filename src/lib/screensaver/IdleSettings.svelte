<script lang="ts">
  // Idle-screensaver settings section (Phase 0.28). Picks which effect the
  // IdleOverlay shows after inactivity and after how many seconds — and, for the
  // server card, whether and how often it shifts against burn-in (v1.31). The heavy
  // rendering lives in IdleOverlay.svelte; the persisted fields + validation are
  // in settings.svelte.ts / idle.ts.
  import { settings } from "../settings/settings.svelte";
  import {
    clampIdleTimeout,
    IDLE_SHIFT_INTERVALS,
    IDLE_EFFECTS,
    IDLE_TIMEOUT_MAX,
    IDLE_TIMEOUT_MIN,
    RECOMMENDED_IDLE_SHIFT,
    type IdleEffectId,
  } from "./idle";
  import { t } from "../i18n";
  import InfoHint from "../ui/InfoHint.svelte";
  import { slide } from "svelte/transition";
  import { motion, MOTION_BASE } from "../ui/motion";

  const LABELS: Record<IdleEffectId, () => string> = {
    card: () => t("settings.idleCard"),
    matrix: () => t("settings.idleMatrix"),
    parallax: () => t("settings.idleParallax"),
    signal: () => t("settings.idleSignal"),
  };

  // "every 1 min (recommended)": seconds under a minute, minutes from there on;
  // the recommended interval marked.
  function shiftLabel(sec: number): string {
    const label =
      sec < 60 ? t("settings.idleShiftEverySec", { n: sec }) : t("settings.idleShiftEveryMin", { n: Math.round(sec / 60) });
    return sec === RECOMMENDED_IDLE_SHIFT ? t("settings.idleShiftRecommended", { option: label }) : label;
  }

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
      class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
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
          class="w-28 rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
          data-testid="idle-timeout-input"
          bind:value={settings.idleTimeoutSec}
          onchange={commitTimeout}
          onblur={commitTimeout}
        />
        <span class="text-muted">{t("settings.idleTimeoutUnit")}</span>
      </span>
    </label>
  {/if}

  <!-- The other effects move by themselves; only the card stands still for hours. -->
  {#if settings.idleEffect === "card"}
    <label class="mt-3 block text-xs text-muted" transition:slide={motion(MOTION_BASE)}>
      <span class="flex items-center gap-1">{t("settings.idleShift")}<InfoHint text={t("settings.idleShiftHint")} /></span>
      <select
        class="mt-1 w-full rounded border border-edge bg-panel px-2 py-1 text-sm text-text outline-none focus:border-accent"
        data-testid="idle-shift-select"
        bind:value={settings.idleShiftEverySec}
      >
        <option value={null}>{t("settings.idleShiftOff")}</option>
        {#each IDLE_SHIFT_INTERVALS as sec (sec)}
          <option value={sec}>{shiftLabel(sec)}</option>
        {/each}
      </select>
    </label>
  {/if}
</section>
