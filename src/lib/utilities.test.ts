import { describe, it, expect } from "vitest";
import { UTILITIES, DEFAULT_UTILITY, isUtility, utilitiesMatching } from "./utilities";
import { ICONS } from "./icons";
import { en } from "./i18n/messages";

describe("utilities registry", () => {
  it("has unique ids", () => {
    const ids = UTILITIES.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("references icons that exist in the registry", () => {
    for (const u of UTILITIES) {
      expect(ICONS).toHaveProperty(u.icon);
    }
  });

  it("references title/desc keys that exist in the canonical catalogue", () => {
    for (const u of UTILITIES) {
      expect(en).toHaveProperty(u.titleKey);
      expect(en).toHaveProperty(u.descKey);
    }
  });

  it("defaults to the first (keys) utility", () => {
    expect(DEFAULT_UTILITY).toBe("keys");
    expect(isUtility(DEFAULT_UTILITY)).toBe(true);
  });

  it("isUtility rejects unknown ids", () => {
    expect(isUtility("nope")).toBe(false);
  });
});

describe("utilitiesMatching", () => {
  it("returns every utility for a blank query", () => {
    expect(utilitiesMatching("")).toHaveLength(UTILITIES.length);
    expect(utilitiesMatching("   ")).toHaveLength(UTILITIES.length);
  });

  it("matches by keyword in either language", () => {
    expect(utilitiesMatching("subnet").map((u) => u.id)).toEqual(["cidr"]);
    expect(utilitiesMatching("подсеть").map((u) => u.id)).toEqual(["cidr"]);
  });

  it("matches by id", () => {
    expect(utilitiesMatching("jwt").map((u) => u.id)).toContain("jwt");
  });

  it("returns nothing for a non-matching query", () => {
    expect(utilitiesMatching("zzzznomatch")).toEqual([]);
  });
});
