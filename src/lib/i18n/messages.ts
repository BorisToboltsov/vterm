// Message catalogues, one file per locale: `en` (en.ts) is the canonical set —
// its keys define `MessageKey` — and every other locale is typed as
// `Record<MessageKey, string>`, so a missing translation is a compile error.
// Adding a language = a new entry in `LOCALES` (locales.ts) + its own file here.
//
// Placeholders use `{name}` syntax and are filled by `interpolate` (translate.ts).

import type { Locale } from "./locales";
import { en, type MessageKey } from "./en";
import { ru } from "./ru";

export { en, ru, type MessageKey };

export type MessageParams = Record<string, string | number>;

/** All catalogues, keyed by locale code. New locale = new entry here + LOCALES. */
export const messages: Record<Locale, Record<MessageKey, string>> = { en, ru };
