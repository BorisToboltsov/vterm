import { describe, it, expect } from "vitest";
import { compactAge } from "./age";

const now = Date.parse("2026-07-17T12:00:00Z");
const ago = (sec: number) => compactAge(now - sec * 1000, now);
const DAY = 86400;

describe("compactAge", () => {
  it("formats seconds, minutes and hours", () => {
    expect(ago(0)).toBe("0s");
    expect(ago(30)).toBe("30s");
    expect(ago(45 * 60)).toBe("45m");
    expect(ago(3 * 3600)).toBe("3h");
    expect(ago(2 * 3600 + 20 * 60)).toBe("2h20m");
  });

  it("keeps the hours only under a week", () => {
    expect(ago(DAY + 4 * 3600)).toBe("1d4h");
    expect(ago(3 * DAY)).toBe("3d");
    expect(ago(6 * DAY + 23 * 3600)).toBe("6d23h");
    expect(ago(7 * DAY + 5 * 3600)).toBe("7d");
    expect(ago(13 * DAY)).toBe("13d");
  });

  it("switches to weeks, months and years", () => {
    expect(ago(14 * DAY)).toBe("2w");
    expect(ago(16 * DAY)).toBe("2w");
    expect(ago(59 * DAY)).toBe("8w");
    expect(ago(60 * DAY)).toBe("2mo");
    expect(ago(412 * DAY)).toBe("13mo");
    expect(ago(729 * DAY)).toBe("24mo");
    expect(ago(730 * DAY)).toBe("2y");
    expect(ago(3650 * DAY)).toBe("10y");
  });

  it("never exceeds five characters", () => {
    for (let sec = 0; sec < 40 * 365 * DAY; sec += 7919 * 61) {
      expect(ago(sec).length).toBeLessThanOrEqual(5);
    }
  });

  it("clamps a future instant and rejects a non-finite one", () => {
    expect(ago(-120)).toBe("0s");
    expect(compactAge(NaN, now)).toBe("");
    expect(compactAge(now, Infinity)).toBe("");
  });
});
