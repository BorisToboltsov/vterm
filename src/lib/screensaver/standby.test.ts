import { describe, expect, it } from "vitest";
import {
  AWAY_EVENTS,
  awayPush,
  clockLabel,
  DRIFT_PERIOD_X,
  DRIFT_PERIOD_Y,
  DRIFT_X,
  DRIFT_Y,
  driftOffset,
  emptyAway,
  gapReading,
  mergePoints,
  notableEvents,
  placeLabels,
  readingLevels,
  ringFraction,
  serverOffset,
  serverZone,
  shifted,
  SHIFT_PATH_STEP,
  shiftOffset,
  standbyTransfer,
  timeRuns,
  timeTicks,
  timeX,
  type AwayEvent,
  type AwayHistory,
  type AwayReading,
  type AwayThresholds,
} from "./standby";
import type { TransferRow } from "../files/transfer";

const TH: AwayThresholds = {
  cpu: { warn: 80, crit: 95 },
  ram: { warn: 85, crit: 95 },
  load: { warn: null, crit: null },
};
const T0 = new Date(2026, 10, 4, 13, 18, 0).getTime();
const MIN = 60_000;

function reading(over: Partial<AwayReading> = {}): AwayReading {
  return { at: T0, cpuPct: 20, memPct: 60, load1: 1, cpuCount: 8, topProc: "postgres 12%", ...over };
}
/** Push `readings` one by one, a minute apart unless they say otherwise. */
function run(readings: Partial<AwayReading>[], cap?: number): AwayHistory {
  return readings.reduce<AwayHistory>(
    (h, r, i) => awayPush(h, reading({ at: T0 + i * MIN, ...r }), TH, cap),
    emptyAway(),
  );
}

describe("history of the time away", () => {
  it("keeps each reading as fractions of its ceiling; load against the cores", () => {
    const h = run([{ cpuPct: 25, memPct: 50, load1: 4, cpuCount: 8 }]);
    expect(h.points).toEqual([{ at: T0, cpu: 0.25, mem: 0.5, load: 0.5 }]);
    // A load above the cores is the top of the chart, not past it.
    expect(run([{ load1: 20 }]).points[0].load).toBe(1);
  });

  it("draws what it could not read as a gap, not a value", () => {
    const h = awayPush(emptyAway(), gapReading(T0), TH);
    expect(h.points).toEqual([{ at: T0, cpu: null, mem: null, load: null }]);
    expect(h.events).toEqual([]);
    // No load average (Windows) or no core count: load is unknown, the rest is not.
    expect(run([{ load1: null }]).points[0]).toMatchObject({ cpu: 0.2, load: null });
    expect(run([{ cpuCount: null }]).points[0].load).toBeNull();
  });

  it("merges neighbours into their peak, so a spike survives the merge", () => {
    const pts = [
      { at: 1, cpu: 0.1, mem: null, load: 0.2 },
      { at: 2, cpu: 0.9, mem: 0.5, load: null },
      { at: 3, cpu: null, mem: null, load: null },
      { at: 4, cpu: null, mem: null, load: null },
      { at: 5, cpu: 0.3, mem: 0.3, load: 0.3 },
    ];
    expect(mergePoints(pts)).toEqual([
      { at: 1, cpu: 0.9, mem: 0.5, load: 0.2 },
      { at: 3, cpu: null, mem: null, load: null },
      { at: 5, cpu: 0.3, mem: 0.3, load: 0.3 },
    ]);
  });

  it("never holds more points than the cap, and keeps the peak", () => {
    const readings = Array.from({ length: 100 }, (_, i) => ({ cpuPct: i === 57 ? 99 : 10 }));
    const h = run(readings, 16);
    expect(h.points.length).toBeLessThanOrEqual(16);
    expect(Math.max(...h.points.map((p) => p.cpu ?? 0))).toBe(0.99);
    // Still in time order, first sample first.
    expect(h.points[0].at).toBe(T0);
    expect(h.points.map((p) => p.at)).toEqual([...h.points.map((p) => p.at)].sort((a, b) => a - b));
  });
});

describe("events of the time away", () => {
  it("opens an event at the status bar's threshold and grows it while it lasts", () => {
    const h = run([
      { cpuPct: 50 },
      { cpuPct: 85, topProc: "make 80%" },
      { cpuPct: 97, topProc: "postgres 93%" },
      { cpuPct: 90, topProc: "postgres 88%" },
    ]);
    expect(h.events).toEqual([
      {
        key: "cpu",
        level: "crit",
        start: T0 + MIN,
        end: T0 + 3 * MIN,
        peak: 97,
        peakAt: T0 + 2 * MIN,
        top: "postgres 93%",
        cores: null,
        open: true,
      },
    ]);
  });

  it("closes it when the metric is back to normal — or not reported", () => {
    const back = run([{ cpuPct: 90 }, { cpuPct: 40 }, { cpuPct: 91 }]);
    expect(back.events.map((e) => [e.start, e.open])).toEqual([
      [T0, false],
      [T0 + 2 * MIN, true],
    ]);
    // A stretch vterm did not see is not claimed to have gone on.
    const blind = [{ cpuPct: 90 }, { cpuPct: null }, { cpuPct: 92 }].reduce<AwayHistory>(
      (h, r, i) => awayPush(h, reading({ at: T0 + i * MIN, ...r }), TH),
      emptyAway(),
    );
    expect(blind.events).toHaveLength(2);
    expect(blind.events[0].open).toBe(false);
  });

  it("measures load against the cores and remembers how many there were", () => {
    const h = run([{ load1: 6, cpuCount: 8 }, { load1: 9.6, cpuCount: 8, topProc: "make 340%" }]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ key: "load", level: "crit", peak: 9.6, cores: 8, top: "make 340%" });
    // Below 0.7 of the cores, with no threshold of its own set: nothing to say.
    expect(run([{ load1: 5, cpuCount: 8 }]).events).toEqual([]);
  });

  it("does not pin the busiest CPU process on memory", () => {
    const h = run([{ memPct: 90, topProc: "postgres 80%" }]);
    expect(h.events[0]).toMatchObject({ key: "mem", level: "warn", top: "" });
  });

  it("keeps the newest events when there are too many", () => {
    const readings = Array.from({ length: (AWAY_EVENTS + 5) * 2 }, (_, i) => ({ cpuPct: i % 2 ? 10 : 90 }));
    const h = run(readings);
    expect(h.events).toHaveLength(AWAY_EVENTS);
    expect(h.events.at(-1)?.start).toBe(T0 + (readings.length - 2) * MIN);
  });

  it("says nothing of a metric that was not reported", () => {
    expect(readingLevels(reading({ cpuPct: null, memPct: null, load1: null }), TH)).toEqual({
      cpu: null,
      mem: null,
      load: null,
    });
    expect(readingLevels(reading({ cpuPct: 96, memPct: 86, load1: 8 }), TH)).toEqual({
      cpu: "crit",
      mem: "warn",
      load: "crit",
    });
  });

  it("labels the most telling events first, and only those that fit", () => {
    const ev = (over: Partial<AwayEvent>): AwayEvent => ({
      key: "cpu",
      level: "warn",
      start: T0,
      end: T0,
      peak: 80,
      peakAt: T0,
      top: "",
      cores: null,
      open: false,
      ...over,
    });
    const a = ev({ peak: 82 });
    const b = ev({ level: "crit", peak: 96 });
    const c = ev({ key: "load", level: "crit", peak: 16, cores: 8 });
    const d = ev({ key: "mem", peak: 88 });
    expect(notableEvents([a, b, c, d], 3)).toEqual([c, b, d]);
    expect(notableEvents([a], 0)).toEqual([]);
    expect(placeLabels([[0, 100], [50, 150], [110, 200], [300, 400]])).toEqual([0, 2, 3]);
    expect(placeLabels([[0, 100], [104, 150]], 8)).toEqual([0]);
  });
});

describe("the chart's time axis", () => {
  it("places points by time, breaking the line at a gap", () => {
    const pts = [
      { at: T0, cpu: 0, mem: null, load: null },
      { at: T0 + MIN, cpu: 1, mem: null, load: null },
      { at: T0 + 2 * MIN, cpu: null, mem: null, load: null },
      { at: T0 + 4 * MIN, cpu: 0.5, mem: null, load: null },
    ];
    expect(timeRuns(pts, "cpu", T0, T0 + 4 * MIN, 10, 0, 400, 100)).toEqual([
      [
        { x: 10, y: 100 },
        { x: 110, y: 0 },
      ],
      [{ x: 410, y: 50 }],
    ]);
    expect(timeRuns(pts, "mem", T0, T0 + 4 * MIN, 0, 0, 1, 1)).toEqual([]);
    // One sample so far: the axis has no span yet — it stands at the start.
    expect(timeRuns(pts.slice(0, 1), "cpu", T0, T0, 7, 0, 100, 10)).toEqual([[{ x: 7, y: 10 }]]);
    expect(timeX(T0 + MIN, T0, T0 + 2 * MIN, 0, 200)).toBe(100);
    expect(timeX(T0, T0, T0, 5, 200)).toBe(5);
  });

  it("ticks at round minutes of the server's clock, no more than asked", () => {
    for (const offset of [0, -180, 330, 45]) {
      const from = T0 + 17_000;
      const to = from + 47 * MIN;
      const ticks = timeTicks(from, to, offset, 6);
      expect(ticks.length).toBeGreaterThanOrEqual(4);
      expect(ticks.length).toBeLessThanOrEqual(6);
      for (const at of ticks) {
        expect(at).toBeGreaterThanOrEqual(from);
        expect(at).toBeLessThanOrEqual(to);
        const d = shifted(at, offset);
        expect(d.getMinutes() % 10, `${offset}: ${d.toString()}`).toBe(0);
        expect(d.getSeconds()).toBe(0);
      }
    }
    expect(timeTicks(T0, T0 + 3 * MIN, 0, 6)).toEqual([T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN]);
    expect(timeTicks(T0, T0, 0, 6)).toEqual([]);
    expect(timeTicks(T0, T0 + MIN, 0, 0)).toEqual([]);
  });
});

describe("the server's clock", () => {
  const local = new Date(2026, 10, 4, 17, 5, 30).getTime();

  it("reads the server's lead from its HH:MM, to the quarter hour", () => {
    expect(serverOffset("14:05 UTC", local)).toBe(-180);
    expect(serverOffset("17:06 MSK", local)).toBe(0); // a poll a minute apart is not a time zone
    expect(serverOffset("22:50 +0545", local)).toBe(345);
    expect(clockLabel(local, -180)).toBe("14:05");
    expect(clockLabel(local, 0)).toBe("17:05");
  });

  it("goes round midnight the short way", () => {
    const late = new Date(2026, 10, 4, 23, 50).getTime();
    const early = new Date(2026, 10, 5, 0, 10).getTime();
    expect(serverOffset("00:20 X", late)).toBe(30);
    expect(serverOffset("23:40 X", early)).toBe(-30);
    expect(clockLabel(late, 30)).toBe("00:20");
  });

  it("has no offset for a host that did not say", () => {
    for (const bad of ["", "—", "25:00 UTC", "12:61", "noon"]) expect(serverOffset(bad, local)).toBeNull();
    expect(serverZone("14:05 UTC")).toBe("UTC");
    expect(serverZone("14:05")).toBe("");
    expect(serverZone("")).toBe("");
  });
});

describe("a transfer under way", () => {
  const row = (id: string, over: Partial<TransferRow> = {}): TransferRow => ({
    id,
    name: `${id}.tar`,
    direction: "upload",
    transferred: 43,
    total: 100,
    done: false,
    ...over,
  });

  it("shows the first one still running, and counts the rest", () => {
    const s = standbyTransfer([row("a", { done: true }), row("b"), row("c")], { b: 10 });
    expect(s).toMatchObject({ pct: 43, rate: 10, more: 1 });
    expect(s?.row.id).toBe("b");
    expect(s?.eta).toBeCloseTo(5.7, 5);
  });

  it("does not guess a speed it has not measured", () => {
    expect(standbyTransfer([row("a")], {})).toMatchObject({ rate: null, eta: null, more: 0 });
  });

  it("has nothing to show when nothing runs", () => {
    expect(standbyTransfer([], {})).toBeNull();
    expect(standbyTransfer([row("a", { done: true })], { a: 5 })).toBeNull();
  });
});

describe("rings", () => {
  it("fill to a value's share of its ceiling, or not at all when either is unknown", () => {
    expect(ringFraction(23, 100)).toBe(0.23);
    expect(ringFraction(1.42, 8)).toBeCloseTo(0.1775);
    expect(ringFraction(9.6, 8)).toBe(1);
    expect(ringFraction(null, 100)).toBeNull();
    expect(ringFraction(5, null)).toBeNull();
    expect(ringFraction(5, 0)).toBeNull();
    expect(ringFraction(NaN, 10)).toBeNull();
  });
});

describe("shift against burn-in", () => {
  it("follows a path that starts in place and never strays past its bounds", () => {
    expect(driftOffset(0)).toEqual({ dx: 0, dy: 0 });
    for (let s = 0; s < 3600; s += 7) {
      const { dx, dy } = driftOffset(s * 1000);
      expect(Math.abs(dx)).toBeLessThanOrEqual(DRIFT_X);
      expect(Math.abs(dy)).toBeLessThanOrEqual(DRIFT_Y);
    }
    expect(driftOffset((DRIFT_PERIOD_X / 4) * 1000).dx).toBeCloseTo(DRIFT_X);
    expect(driftOffset((DRIFT_PERIOD_Y / 4) * 1000).dy).toBeCloseTo(DRIFT_Y);
    expect(driftOffset(NaN)).toEqual({ dx: 0, dy: 0 });
  });

  it("never moves when switched off", () => {
    for (const s of [0, 30, 600, 3600, 86_400]) expect(shiftOffset(s * 1000, null)).toEqual({ dx: 0, dy: 0 });
    expect(shiftOffset(600_000, 0)).toEqual({ dx: 0, dy: 0 });
    expect(shiftOffset(NaN, 60)).toEqual({ dx: 0, dy: 0 });
    expect(shiftOffset(-5, 60)).toEqual({ dx: 0, dy: 0 });
  });

  it("stays in place until the first shift, then holds each position for the whole interval", () => {
    expect(shiftOffset(0, 60)).toEqual({ dx: 0, dy: 0 });
    expect(shiftOffset(59_999, 60)).toEqual({ dx: 0, dy: 0 });
    expect(shiftOffset(60_000, 60)).not.toEqual({ dx: 0, dy: 0 });
    expect(shiftOffset(60_000, 60)).toEqual(shiftOffset(119_999, 60));
    // A longer interval walks the same path, only slower.
    expect(shiftOffset(5 * 300_000, 300)).toEqual(shiftOffset(5 * 60_000, 60));
  });

  it("steps by whole pixels, a couple at a time, within its bounds", () => {
    let last = shiftOffset(0, 60);
    const seen = new Set<string>();
    for (let k = 1; k <= 500; k++) {
      const at = shiftOffset(k * 60_000, 60);
      expect(Number.isInteger(at.dx) && Number.isInteger(at.dy)).toBe(true);
      expect(Math.abs(at.dx)).toBeLessThanOrEqual(DRIFT_X);
      expect(Math.abs(at.dy)).toBeLessThanOrEqual(DRIFT_Y);
      expect(Math.hypot(at.dx - last.dx, at.dy - last.dy), `step ${k}`).toBeLessThanOrEqual(4);
      seen.add(`${at.dx},${at.dy}`);
      last = at;
    }
    // It covers the area instead of pacing between a few spots.
    expect(seen.size).toBeGreaterThan(60);
    expect(SHIFT_PATH_STEP).toBeGreaterThan(0);
  });
});
