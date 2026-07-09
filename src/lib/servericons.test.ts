import { describe, it, expect } from "vitest";
import {
  SERVER_ICONS,
  SERVER_COLORS,
  DEFAULT_SERVER_ICON,
  resolveServerIcon,
  resolveServerColorClass,
} from "./servericons";
import { ICONS } from "./icons";

describe("SERVER_ICONS", () => {
  it("has unique keys and the generic default", () => {
    const keys = SERVER_ICONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(DEFAULT_SERVER_ICON);
  });

  it("references only glyphs that exist in the icon registry", () => {
    for (const d of SERVER_ICONS) {
      expect(ICONS, `${d.key} → ${d.icon}`).toHaveProperty(d.icon);
    }
  });
});

describe("resolveServerIcon", () => {
  it("maps a known key to its glyph", () => {
    expect(resolveServerIcon("database")).toBe("database");
    expect(resolveServerIcon("web")).toBe("globe");
  });

  it("falls back to the generic server glyph for empty / unknown / null", () => {
    expect(resolveServerIcon("")).toBe("server");
    expect(resolveServerIcon("nope")).toBe("server");
    expect(resolveServerIcon(null)).toBe("server");
    expect(resolveServerIcon(undefined)).toBe("server");
  });
});

describe("SERVER_COLORS", () => {
  it("has unique keys and Tailwind text/swatch classes", () => {
    const keys = SERVER_COLORS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of SERVER_COLORS) {
      expect(c.text).toMatch(/^text-/);
      expect(c.swatch).toMatch(/^bg-/);
    }
  });
});

describe("resolveServerColorClass", () => {
  it("maps a known colour to its text class", () => {
    expect(resolveServerColorClass("green")).toBe("text-emerald-400");
  });

  it("falls back to muted for empty / unknown / null", () => {
    expect(resolveServerColorClass("")).toBe("text-muted");
    expect(resolveServerColorClass("chartreuse")).toBe("text-muted");
    expect(resolveServerColorClass(null)).toBe("text-muted");
    expect(resolveServerColorClass(undefined)).toBe("text-muted");
  });
});
