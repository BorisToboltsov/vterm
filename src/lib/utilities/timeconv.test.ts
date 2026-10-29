import { describe, it, expect } from "vitest";
import {
  detectUnit,
  epochToDate,
  parseEpoch,
  parseDateString,
  parseFlexible,
  toEpochSeconds,
  toEpochMillis,
  isValidTimeZone,
  formatInZone,
  relativeParts,
} from "./timeconv";

describe("unit detection & epoch parsing", () => {
  it("detects seconds vs milliseconds by magnitude", () => {
    expect(detectUnit(1_700_000_000)).toBe("s");
    expect(detectUnit(1_700_000_000_000)).toBe("ms");
  });

  it("converts epoch to date honouring the unit", () => {
    expect(epochToDate(0, "s").toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(epochToDate(1_000, "ms").toISOString()).toBe("1970-01-01T00:00:01.000Z");
    expect(epochToDate(1_000, "auto").toISOString()).toBe("1970-01-01T00:16:40.000Z");
  });

  it("parseEpoch rejects non-integers", () => {
    expect(parseEpoch("abc", "s")).toBeNull();
    expect(parseEpoch("1.5", "s")).toBeNull();
    expect(parseEpoch("42", "s")?.getTime()).toBe(42_000);
  });
});

describe("date string parsing & epoch output", () => {
  it("parses ISO 8601", () => {
    const d = parseDateString("2021-01-01T00:00:00Z");
    expect(d?.getTime()).toBe(1_609_459_200_000);
    expect(toEpochSeconds(d!)).toBe(1_609_459_200);
    expect(toEpochMillis(d!)).toBe(1_609_459_200_000);
  });

  it("rejects garbage and empty", () => {
    expect(parseDateString("not a date")).toBeNull();
    expect(parseDateString("")).toBeNull();
  });

  it("parseFlexible picks epoch vs date automatically", () => {
    expect(parseFlexible("1609459200", "s")?.getTime()).toBe(1_609_459_200_000);
    expect(parseFlexible("2021-01-01T00:00:00Z", "auto")?.getTime()).toBe(1_609_459_200_000);
  });
});

describe("time zones", () => {
  it("validates zone names", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
  });

  it("formats the epoch in UTC", () => {
    const out = formatInZone(new Date(0), "UTC");
    expect(out).toContain("1970-01-01");
    expect(out).toContain("00:00:00");
    expect(out).toContain("UTC");
  });

  it("shifts to a positive-offset zone", () => {
    // Moscow is UTC+3 → the epoch shows as 03:00:00 on the same day.
    const out = formatInZone(new Date(0), "Europe/Moscow");
    expect(out).toContain("1970-01-01");
    expect(out).toContain("03:00:00");
  });
});

describe("relativeParts", () => {
  const now = new Date("2020-06-15T12:00:00Z");

  it("reports future as a positive value", () => {
    const future = new Date(now.getTime() + 2 * 3600 * 1000);
    expect(relativeParts(future, now)).toEqual({ value: 2, unit: "hour" });
  });

  it("reports past as a negative value", () => {
    const past = new Date(now.getTime() - 3 * 86400 * 1000);
    expect(relativeParts(past, now)).toEqual({ value: -3, unit: "day" });
  });

  it("uses seconds for sub-minute differences", () => {
    const soon = new Date(now.getTime() + 30 * 1000);
    expect(relativeParts(soon, now)).toEqual({ value: 30, unit: "second" });
  });

  it("uses years for large differences", () => {
    const old = new Date(now.getTime() - 3 * 365 * 86400 * 1000);
    expect(relativeParts(old, now).unit).toBe("year");
    expect(relativeParts(old, now).value).toBe(-3);
  });
});
