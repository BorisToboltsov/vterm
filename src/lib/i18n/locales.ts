// Registry of the languages the UI supports. Adding a new language is a single
// entry here plus a matching dictionary in `messages.ts` (TypeScript enforces
// that every message key is translated — a missing key won't compile).
//
// Keep this file free of UI/runtime imports so it stays a pure data module that
// both the reactive layer (`index.ts`) and tests can use without a DOM.

/** Metadata for one supported locale. `nativeName` is shown in the picker. */
export interface LocaleInfo {
  /** Endonym shown in the language picker (always in that language itself). */
  nativeName: string;
}

/**
 * The supported locales. The keys are BCP-47-ish short codes and double as the
 * value stored in settings. Extend this object to add a language; the dictionary
 * in `messages.ts` must then provide the same keys (compile-time checked).
 */
export const LOCALES = {
  en: { nativeName: "English" },
  ru: { nativeName: "Русский" },
} satisfies Record<string, LocaleInfo>;

/** A supported locale code (e.g. `"en"`, `"ru"`). */
export type Locale = keyof typeof LOCALES;

/** All supported locale codes, in declaration order (picker order). */
export const LOCALE_IDS = Object.keys(LOCALES) as Locale[];

/** Locale used before the user picks one, and as the fallback for missing keys. */
export const DEFAULT_LOCALE: Locale = "en";

/** Narrowing guard: is `v` one of the supported locale codes? */
export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && v in LOCALES;
}

/**
 * Pick the first supported locale from an ordered list of BCP-47 language tags
 * (e.g. `navigator.languages`), matching on the primary subtag so `"ru-RU"` maps
 * to `"ru"`. Falls back to {@link DEFAULT_LOCALE} when none is one we ship — pure,
 * so the caller reads `navigator` and passes the tags in (keeps this module DOM-free).
 */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
