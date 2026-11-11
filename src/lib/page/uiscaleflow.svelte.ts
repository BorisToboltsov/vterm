// The interface scale, as the page steps it (v1.28, ADR 0049): a chord or a palette
// command moves it one stop and says where it landed. At the end of the scale nothing
// moves, and that should not read as a dead key. One word, the latest: a held chord
// would otherwise stack them over the very panels it enlarges.

import { steppedUiScale } from "../appearance/uiscale";
import { t } from "../i18n";
import { settings } from "../settings/settings.svelte";
import { dismissToast, notifyInfo } from "../stores/toasts.svelte";

export function createUiScaleFlow() {
  let said: string | null = null;
  return {
    step(step: 1 | -1 | 0): void {
      settings.uiScale = steppedUiScale(settings.uiScale, step);
      if (said) dismissToast(said);
      said = notifyInfo(t("settings.uiScaleNow", { n: settings.uiScale }), { source: "settings" });
    },
  };
}
