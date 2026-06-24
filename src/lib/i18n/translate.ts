// Pure translation core — no Svelte, no settings, no DOM. Kept separate from the
// reactive layer (index.ts) so it can be unit-tested in isolation (ADR 0003:
// pure logic lives in plain `.ts`).

import { DEFAULT_LOCALE, type Locale } from "./locales";
import { messages, type MessageKey, type MessageParams } from "./messages";

/** Replace `{name}` placeholders in `template` with values from `params`. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  );
}

/**
 * Resolve `key` for `locale`, interpolating `params`. Falls back to the default
 * locale for an unknown locale and to the key itself for an unknown key, so the
 * UI degrades gracefully (never throws, never shows blank).
 */
export function resolve(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const dict = messages[locale] ?? messages[DEFAULT_LOCALE];
  const template = dict[key] ?? messages[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, params);
}
