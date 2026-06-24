import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../settings.svelte";
import { en, messages, type MessageKey } from "./messages";
import { LOCALE_IDS, isLocale, DEFAULT_LOCALE } from "./locales";
import { interpolate, resolve } from "./translate";
import { t, currentLocale, setLocale, availableLocales } from "./index";

beforeEach(() => {
  localStorage.clear();
  settings.language = "en";
});

describe("locale registry", () => {
  it("exposes at least English and Russian, English as default", () => {
    expect(LOCALE_IDS).toContain("en");
    expect(LOCALE_IDS).toContain("ru");
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("guards locale codes", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ru")).toBe(true);
    expect(isLocale("xx")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });

  it("builds a picker list with native names", () => {
    const ids = availableLocales.map((l) => l.id);
    expect(ids).toEqual(LOCALE_IDS);
    expect(availableLocales.find((l) => l.id === "ru")?.nativeName).toBe("Русский");
  });
});

describe("dictionary completeness", () => {
  // Every locale must translate every key (the canonical set is `en`).
  const keys = Object.keys(en) as MessageKey[];
  for (const locale of LOCALE_IDS) {
    it(`${locale} provides every message key`, () => {
      for (const key of keys) {
        expect(messages[locale][key], `${locale} missing ${key}`).toBeTypeOf("string");
        expect(messages[locale][key].length).toBeGreaterThan(0);
      }
    });
  }

  it("has no extra keys in non-default locales", () => {
    const canonical = new Set(keys);
    for (const locale of LOCALE_IDS) {
      for (const key of Object.keys(messages[locale])) {
        expect(canonical.has(key as MessageKey), `${locale} has stray key ${key}`).toBe(true);
      }
    }
  });

  it("keeps technical terms identical across languages", () => {
    // Domain terms must not be "translated" (project rule in CONTEXT.md).
    const technical: MessageKey[] = [
      "settings.metric.cpu",
      "settings.metric.ram",
      "settings.metric.swap",
      "settings.metric.load",
      "settings.metric.diskio",
      "mon.cpu",
    ];
    for (const key of technical) {
      expect(messages.ru[key]).toBe(messages.en[key]);
    }
  });
});

describe("interpolate", () => {
  it("replaces named placeholders", () => {
    expect(interpolate("Hello, {name}!", { name: "world" })).toBe("Hello, world!");
  });

  it("coerces numbers and leaves unknown placeholders untouched", () => {
    expect(interpolate("{a} of {b}", { a: 1, b: 2 })).toBe("1 of 2");
    expect(interpolate("Hi {missing}", { name: "x" })).toBe("Hi {missing}");
  });

  it("returns the template verbatim with no params", () => {
    expect(interpolate("plain")).toBe("plain");
  });
});

describe("resolve (pure)", () => {
  it("resolves a key for a locale", () => {
    expect(resolve("en", "common.cancel")).toBe("Cancel");
    expect(resolve("ru", "common.cancel")).toBe("Отмена");
  });

  it("interpolates params", () => {
    expect(resolve("en", "status.error", { detail: "boom" })).toBe("Error: boom");
    expect(resolve("ru", "status.error", { detail: "boom" })).toBe("Ошибка: boom");
  });

  it("falls back to the default locale for an unknown locale", () => {
    // @ts-expect-error — exercising the runtime fallback path.
    expect(resolve("xx", "common.done")).toBe("Done");
  });
});

describe("t (reactive)", () => {
  it("translates in the current language", () => {
    settings.language = "en";
    expect(t("settings.title")).toBe("Settings");
    setLocale("ru");
    expect(currentLocale()).toBe("ru");
    expect(t("settings.title")).toBe("Настройки");
  });

  it("falls back to the default locale when the setting is junk", () => {
    // @ts-expect-error — simulate corrupted persisted value.
    settings.language = "klingon";
    expect(currentLocale()).toBe("en");
    expect(t("common.ok")).toBe("OK");
  });
});
