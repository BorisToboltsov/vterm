// Reactive translation entry point. `t()` reads `settings.language` (a Svelte 5
// rune), so any `{t("…")}` in markup re-renders automatically when the user
// switches language in Settings — no per-component subscription needed.
//
// Components import from here: `import { t } from "$lib/i18n";` (or "./i18n").

import { settings } from "../settings.svelte";
import { resolve } from "./translate";
import type { MessageKey, MessageParams } from "./messages";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_IDS,
  LOCALES,
  type Locale,
  type LocaleInfo,
} from "./locales";

/** Translate `key` into the current UI language, filling `{…}` placeholders. */
export function t(key: MessageKey, params?: MessageParams): string {
  const locale = isLocale(settings.language) ? settings.language : DEFAULT_LOCALE;
  return resolve(locale, key, params);
}

/** The currently selected (and validated) UI language. */
export function currentLocale(): Locale {
  return isLocale(settings.language) ? settings.language : DEFAULT_LOCALE;
}

/** Switch the UI language (persisted via the settings store). */
export function setLocale(locale: Locale): void {
  settings.language = locale;
}

/** Locales for building a picker: `[{ id, nativeName }, …]` in declaration order. */
export const availableLocales: (LocaleInfo & { id: Locale })[] = LOCALE_IDS.map((id) => ({
  id,
  ...LOCALES[id],
}));

export { interpolate, resolve } from "./translate";
export { DEFAULT_LOCALE, isLocale, LOCALE_IDS, LOCALES } from "./locales";
export type { Locale, LocaleInfo } from "./locales";
export type { MessageKey, MessageParams } from "./messages";
