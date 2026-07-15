import { describe, it, expect } from "vitest";
import {
  randInt,
  buildClasses,
  entropyBits,
  generatePassword,
  generatePassphrase,
  AMBIGUOUS,
  type PwOptions,
} from "./pwgen";

const base: PwOptions = {
  length: 16,
  lower: true,
  upper: true,
  digits: true,
  symbols: false,
  excludeAmbiguous: false,
  exclude: "",
  requireEach: false,
  noRepeats: false,
};

describe("randInt", () => {
  it("stays within range and covers the space", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = randInt(6);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
      seen.add(n);
    }
    expect(seen.size).toBe(6);
  });

  it("throws for non-positive bounds", () => {
    expect(() => randInt(0)).toThrow();
  });
});

describe("buildClasses", () => {
  it("includes only the selected classes", () => {
    expect(buildClasses({ ...base, upper: false, digits: false })).toEqual([
      "abcdefghijklmnopqrstuvwxyz",
    ]);
  });

  it("removes ambiguous and custom-excluded characters", () => {
    const [lower] = buildClasses({ ...base, upper: false, digits: false, excludeAmbiguous: true });
    for (const c of AMBIGUOUS) expect(lower).not.toContain(c);
    const [l2] = buildClasses({ ...base, upper: false, digits: false, exclude: "abc" });
    expect(l2).not.toMatch(/[abc]/);
  });
});

describe("generatePassword", () => {
  it("produces a password of the requested length from the pool", () => {
    const r = generatePassword(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.password).toHaveLength(16);
  });

  it("errors when no class is selected", () => {
    expect(generatePassword({ ...base, lower: false, upper: false, digits: false, symbols: false }))
      .toEqual({ ok: false, error: "noClass" });
  });

  it("errors when requireEach cannot fit in the length", () => {
    const r = generatePassword({ ...base, length: 2, symbols: true, requireEach: true });
    expect(r).toEqual({ ok: false, error: "lengthTooSmall" });
  });

  it("requireEach yields at least one of every class", () => {
    for (let i = 0; i < 20; i++) {
      const r = generatePassword({ ...base, length: 12, symbols: true, requireEach: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.password).toMatch(/[a-z]/);
        expect(r.password).toMatch(/[A-Z]/);
        expect(r.password).toMatch(/[0-9]/);
        expect(r.password).toMatch(/[!@#$%^&*()\-_=+\[\]{};:,.?/]/);
      }
    }
  });

  it("noRepeats forbids identical and sequential neighbours", () => {
    for (let i = 0; i < 20; i++) {
      const r = generatePassword({ ...base, noRepeats: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        for (let j = 1; j < r.password.length; j++) {
          const a = r.password.charCodeAt(j - 1);
          const b = r.password.charCodeAt(j);
          expect(a).not.toBe(b);
          expect(Math.abs(a - b)).not.toBe(1);
        }
      }
    }
  });

  it("reports an empty pool when every character is excluded", () => {
    const r = generatePassword({ ...base, upper: false, digits: false, symbols: false, exclude: "abcdefghijklmnopqrstuvwxyz" });
    expect(r).toEqual({ ok: false, error: "emptyPool" });
  });
});

describe("entropyBits", () => {
  it("scales with length and pool size", () => {
    expect(entropyBits(2, 8)).toBe(8); // log2(2)*8
    expect(entropyBits(1, 8)).toBe(0);
    expect(entropyBits(94, 12)).toBeGreaterThan(70);
  });
});

describe("generatePassphrase", () => {
  it("produces the requested number of words joined by the separator", () => {
    const r = generatePassphrase({ words: 4, separator: "-", capitalize: false, includeNumber: false });
    expect(r.phrase.split("-")).toHaveLength(4);
    expect(r.entropyBits).toBeGreaterThan(0);
  });

  it("capitalizes and can append a number", () => {
    const r = generatePassphrase({ words: 3, separator: ".", capitalize: true, includeNumber: true });
    const parts = r.phrase.split(".");
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p[0]).toBe(p[0].toUpperCase());
    expect(r.phrase).toMatch(/[0-9]/);
  });

  it("entropy tracks the word count and list size", () => {
    const words = ["alpha", "bravo", "charlie", "delta"]; // log2(4) = 2 bits/word
    const r = generatePassphrase({ words: 5, separator: " ", capitalize: false, includeNumber: false }, words);
    expect(r.entropyBits).toBe(10);
  });
});
