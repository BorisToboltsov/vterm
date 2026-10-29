import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, nextRuns, type CronFields } from "./cron";

function fields(expr: string): CronFields {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.fields;
}

describe("parseCron", () => {
  it("parses a simple every-minute expression", () => {
    const r = parseCron("* * * * *");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.minute.size).toBe(60);
      expect(r.fields.domStar).toBe(true);
      expect(r.fields.dowStar).toBe(true);
    }
  });

  it("parses lists, ranges and steps", () => {
    const f = fields("0,30 9-17 * * *");
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...f.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    const step = fields("*/15 * * * *");
    expect([...step.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it("expands @macros", () => {
    const r = parseCron("@daily");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.fields.minute]).toEqual([0]);
      expect([...r.fields.hour]).toEqual([0]);
    }
  });

  it("accepts month and weekday names, and 7 = Sunday", () => {
    const f = fields("0 0 * jan mon-fri");
    expect([...f.month]).toEqual([1]);
    expect([...f.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const sun = fields("0 0 * * 7");
    expect([...sun.dow]).toEqual([0]);
  });

  it("reports errors", () => {
    expect(parseCron("")).toEqual({ ok: false, error: "empty" });
    expect(parseCron("* * * *")).toEqual({ ok: false, error: "fieldCount" });
    expect(parseCron("60 * * * *")).toEqual({ ok: false, error: "invalidField" });
    expect(parseCron("* 24 * * *")).toEqual({ ok: false, error: "invalidField" });
    expect(parseCron("*/0 * * * *")).toEqual({ ok: false, error: "invalidField" });
  });
});

describe("cronMatches (local time)", () => {
  it("matches an every-15-minutes schedule", () => {
    const f = fields("*/15 * * * *");
    expect(cronMatches(f, new Date(2020, 0, 1, 10, 15))).toBe(true);
    expect(cronMatches(f, new Date(2020, 0, 1, 10, 16))).toBe(false);
  });

  it("unions day-of-month and day-of-week when both restricted", () => {
    // "on the 1st OR on a Monday"
    const f = fields("0 0 1 * mon");
    expect(cronMatches(f, new Date(2021, 0, 1, 0, 0))).toBe(true); // Jan 1 2021 = Friday, but 1st
    expect(cronMatches(f, new Date(2021, 0, 4, 0, 0))).toBe(true); // Jan 4 2021 = Monday
    expect(cronMatches(f, new Date(2021, 0, 5, 0, 0))).toBe(false); // Tue, not 1st
  });
});

describe("nextRuns", () => {
  it("lists the next quarter-hours", () => {
    const f = fields("*/15 * * * *");
    const runs = nextRuns(f, new Date(2020, 0, 1, 10, 5), 3);
    expect(runs).toEqual([
      new Date(2020, 0, 1, 10, 15),
      new Date(2020, 0, 1, 10, 30),
      new Date(2020, 0, 1, 10, 45),
    ]);
  });

  it("finds a weekday 9am schedule", () => {
    const f = fields("0 9 * * 1-5");
    // Start Friday 2021-01-01 10:00 → next is Monday 2021-01-04 09:00.
    const runs = nextRuns(f, new Date(2021, 0, 1, 10, 0), 1);
    expect(runs[0]).toEqual(new Date(2021, 0, 4, 9, 0));
  });

  it("returns fewer than requested when the schedule rarely fires", () => {
    // Feb 30 never exists → no runs at all.
    const f = fields("0 0 30 2 *");
    expect(nextRuns(f, new Date(2020, 0, 1), 5)).toEqual([]);
  });
});
