import { describe, expect, it } from "vitest";
import {
  AWAY_EVENTS,
  awayGaps,
  awayPush,
  awayStory,
  bandRuns,
  chartFrom,
  chartHit,
  CHART_MS,
  clockLabel,
  DRIFT_PERIOD_X,
  DRIFT_PERIOD_Y,
  DRIFT_X,
  DRIFT_Y,
  driftOffset,
  emptyAway,
  eventHeight,
  gapAfter,
  gapReading,
  HOVER_SLACK,
  HOVER_STILL_MS,
  hoverShown,
  isGapReading,
  loadCeiling,
  openGap,
  procName,
  PULSE_SHARE,
  pulseLayout,
  pulseMark,
  pulseOf,
  readingLevels,
  REBOOT_SLACK_MS,
  restartedAt,
  serverOffset,
  serverZone,
  SHIFT_PATH_STEP,
  shiftOffset,
  silentSince,
  SPAN_BASE_MS,
  SPAN_MAX_MS,
  spanLabel,
  spanLength,
  spanMid,
  standbyTransfer,
  STORY_GAP_MS,
  timeAtX,
  timeRuns,
  timeX,
  verdictLine,
  windowPeak,
  type AwayEvent,
  type AwayHistory,
  type AwayReading,
  type AwaySpan,
  type AwayThresholds,
} from "./standby";
import type { TransferRow } from "../files/transfer";
import type { Problem } from "../monitoring/monproblems";

const TH: AwayThresholds = {
  cpu: { warn: 80, crit: 95 },
  ram: { warn: 85, crit: 95 },
  load: { warn: null, crit: null },
};
// A whole minute: on the clock of every time zone, a multiple of every span length below an hour.
const T0 = new Date(2026, 10, 4, 13, 18, 0).getTime();
const SEC = 1000;
const MIN = 60_000;

function reading(over: Partial<AwayReading> = {}): AwayReading {
  return {
    at: T0,
    cpuPct: 20,
    memPct: 60,
    load1: 1,
    cpuCount: 8,
    topProc: "postgres 12%",
    memUsed: 6 * 2 ** 30,
    memTotal: 10 * 2 ** 30,
    uptimeSecs: null,
    ...over,
  };
}
/** Push `readings` one by one onto a history polled every `beat`, `every` apart unless they say otherwise. */
function feed(readings: Partial<AwayReading>[], beat = 5 * SEC, every = beat): AwayHistory {
  return readings.reduce<AwayHistory>(
    (h, r, i) => awayPush(h, reading({ at: T0 + i * every, ...r }), TH),
    emptyAway(beat),
  );
}
/** A minute apart on a history polled every 30 s: a minute is not a gap there. */
const run = (readings: Partial<AwayReading>[]) => feed(readings, 30 * SEC, MIN);
/** An event as the history keeps it. */
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
/** A span as the history keeps it, for the pure views. */
function span(over: Partial<AwaySpan> = {}): AwaySpan {
  const at = over.at ?? T0;
  return {
    at,
    first: at,
    last: at,
    n: 1,
    cpu: { lo: 20, hi: 20, sum: 20, n: 1 },
    mem: { lo: 60, hi: 60, sum: 60, n: 1 },
    load: { lo: 1, hi: 1, sum: 1, n: 1 },
    level: { cpu: "ok", mem: "ok", load: "ok" },
    cores: 8,
    memUsed: 6,
    memTotal: 10,
    top: "",
    gapBefore: null,
    ...over,
  };
}

describe("the clock of the history", () => {
  it("calls a silence of three beats a gap, never under the shortest span", () => {
    expect(gapAfter(5 * SEC)).toBe(15 * SEC);
    expect(gapAfter(1 * SEC)).toBe(SPAN_BASE_MS);
    expect(gapAfter(30 * SEC)).toBe(90 * SEC);
    expect(gapAfter(NaN)).toBe(SPAN_BASE_MS);
    expect(gapAfter(-1)).toBe(SPAN_BASE_MS);
    expect(silentSince(null, T0, 15 * SEC)).toBe(false);
    expect(silentSince(T0, T0 + 15 * SEC, 15 * SEC)).toBe(false);
    expect(silentSince(T0, T0 + 15 * SEC + 1, 15 * SEC)).toBe(true);
  });

  it("measures spans in the shortest one doubled, at least a gap long", () => {
    expect(spanLength(15 * SEC)).toBe(15 * SEC);
    expect(spanLength(16 * SEC)).toBe(30 * SEC);
    expect(spanLength(90 * SEC)).toBe(120 * SEC);
    expect(spanLength(0)).toBe(SPAN_BASE_MS);
    expect(spanLength(Infinity)).toBe(SPAN_MAX_MS);
    expect(spanLength(NaN)).toBe(SPAN_BASE_MS);
    // A span is never shorter than the gap: between two readings that are not a
    // gap apart no span is skipped — a span with nothing in it is a stretch nobody read.
    for (const beat of [1, 2, 5, 10, 30, 60].map((s) => s * SEC)) {
      const h = emptyAway(beat);
      expect(h.bucketMs).toBeGreaterThanOrEqual(h.gapMs);
    }
  });
});

describe("history of the time away", () => {
  it("puts a reading in its bucket, aligned to the clock", () => {
    const h = feed([{ cpuPct: 10, topProc: "cron 9%" }, { cpuPct: 40, topProc: "make 39%" }, { cpuPct: 25 }, { cpuPct: 30 }]);
    expect(h.bucketMs).toBe(15 * SEC);
    // 0, 5 and 10 s share a bucket; 15 s begins the next one.
    expect(h.buckets.map((b) => [b.at, b.first, b.last, b.n])).toEqual([
      [T0, T0, T0 + 10 * SEC, 3],
      [T0 + 15 * SEC, T0 + 15 * SEC, T0 + 15 * SEC, 1],
    ]);
    // A bucket keeps the lowest, the highest and the sum: its band and its mean.
    expect(h.buckets[0].cpu).toEqual({ lo: 10, hi: 40, sum: 75, n: 3 });
    // What it says beside a value comes from the reading that gave the peak.
    expect(h.buckets[0].top).toBe("make 39%");
    expect([h.firstAt, h.lastAt]).toEqual([T0, T0 + 15 * SEC]);
  });

  it("keeps the worst level each metric reached in a span", () => {
    const h = feed([{ cpuPct: 50 }, { cpuPct: 97 }, { cpuPct: 40, memPct: 88 }]);
    expect(h.buckets[0].level).toEqual({ cpu: "crit", mem: "warn", load: "ok" });
    // A metric the host did not report has no level, and no band.
    const quiet = feed([{ load1: null }]);
    expect(quiet.buckets[0].level.load).toBeNull();
    expect(quiet.buckets[0].load).toBeNull();
    // No CPU reading — no process to pin on it.
    expect(feed([{ cpuPct: null }]).buckets[0].top).toBe("");
  });

  it("makes a failed poll a gap: the next reading follows it, and says why", () => {
    const h = feed([{}, {}, gapReading(0), {}, {}].map((r, i) => ({ ...r, at: T0 + i * 10 * SEC })));
    expect(isGapReading(gapReading(T0))).toBe(true);
    expect(isGapReading(reading({ load1: null }))).toBe(false);
    expect(h.buckets.map((b) => [b.at, b.n, b.gapBefore])).toEqual([
      [T0, 2, null],
      [T0 + 30 * SEC, 2, "failed"],
    ]);
    expect(h.pending).toBeNull();
    expect(awayGaps(h.buckets, h.bucketMs, h.pending, h.lastAt)).toEqual([
      { from: T0 + 10 * SEC, to: T0 + 30 * SEC, kind: "failed" },
    ]);
    // Polls that keep failing: the gap runs from the last reading to the last poll.
    const failing = awayPush(awayPush(h, gapReading(T0 + 50 * SEC), TH), gapReading(T0 + 55 * SEC), TH);
    expect(failing.pending).toBe("failed");
    expect(awayGaps(failing.buckets, failing.bucketMs, failing.pending, failing.lastAt).at(-1)).toEqual({
      from: T0 + 40 * SEC,
      to: T0 + 55 * SEC,
      kind: "failed",
    });
  });

  it("makes a silence longer than a gap a gap too — a hidden window skips its polls", () => {
    const h = feed([{ cpuPct: 97 }, { cpuPct: 97, at: T0 + 5 * SEC }, { cpuPct: 97, at: T0 + 21 * MIN }]);
    expect(h.buckets.map((b) => b.gapBefore)).toEqual([null, "silent"]);
    expect(awayGaps(h.buckets, h.bucketMs, null, h.lastAt)).toEqual([
      { from: T0 + 5 * SEC, to: T0 + 21 * MIN, kind: "silent" },
    ]);
    // A stretch vterm did not see is not claimed to have gone on: the event closed and another opened.
    expect(h.events.map((e) => [e.start, e.end, e.open])).toEqual([
      [T0, T0 + 5 * SEC, false],
      [T0 + 21 * MIN, T0 + 21 * MIN, true],
    ]);
    // Twelve seconds is no silence on a 5 s beat (a gap is 15 s): the line goes on.
    const steady = feed([{}, { at: T0 + 12 * SEC }, { at: T0 + 24 * SEC }]);
    expect(steady.buckets.map((b) => b.gapBefore)).toEqual([null, null]);
    expect(bandRuns(steady.buckets, "cpu", steady.bucketMs)).toHaveLength(1);
  });

  it("lets go of buckets the pulse no longer reaches", () => {
    // A poll every 30 s: a gap is 90 s, a span two minutes.
    const h = feed(
      Array.from({ length: 80 }, () => ({})),
      30 * SEC,
    );
    expect(h.bucketMs).toBe(2 * MIN);
    const last = T0 + 79 * 30 * SEC;
    expect(h.buckets.every((b) => b.at + 2 * h.bucketMs > last - CHART_MS)).toBe(true);
    expect(h.buckets[0].at).toBeGreaterThan(T0);
    // The whole time away is still known where the sentence needs it.
    expect([h.firstAt, h.lastReadAt]).toEqual([T0, last]);
  });

  it("never places a reading before the last one when the clock steps back", () => {
    const h = feed([{ at: T0 + MIN }, { at: T0 + 30 * SEC }]);
    expect(h.lastAt).toBe(T0 + MIN);
    expect(h.buckets).toHaveLength(1);
    expect(h.buckets[0]).toMatchObject({ first: T0 + MIN, last: T0 + MIN, n: 2 });
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
    const blind = run([{ cpuPct: 90 }, { cpuPct: null }, { cpuPct: 92 }]);
    expect(blind.events).toHaveLength(2);
    expect(blind.events[0].open).toBe(false);
    // A failed poll closes every open event.
    const failed = awayPush(run([{ cpuPct: 90, memPct: 90 }]), gapReading(T0 + MIN), TH);
    expect(failed.events.map((e) => e.open)).toEqual([false, false]);
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
});

describe("the charts", () => {
  it("look back half an hour from their right edge", () => {
    expect(chartFrom(T0)).toBe(T0 - 30 * MIN);
    expect(CHART_MS).toBe(30 * MIN);
  });

  it("draw a span's mean with its band at the middle of its readings", () => {
    const s = span({ first: T0 + 2 * SEC, last: T0 + 12 * SEC, cpu: { lo: 10, hi: 40, sum: 75, n: 3 } });
    expect(spanMid(s)).toBe(T0 + 7 * SEC);
    expect(bandRuns([s], "cpu", 15 * SEC)).toEqual([[{ at: T0 + 7 * SEC, mean: 25, lo: 10, hi: 40 }]]);
  });

  it("break where nothing was read: a span missing, a gap before one, the metric not reported", () => {
    const L = 15 * SEC;
    const spans = [
      span({ at: T0 }),
      span({ at: T0 + L }),
      span({ at: T0 + 3 * L }), // the one before it is missing
      span({ at: T0 + 4 * L, gapBefore: "failed" }),
      span({ at: T0 + 5 * L, load: null }),
      span({ at: T0 + 6 * L }),
    ];
    expect(bandRuns(spans, "cpu", L).map((r) => r.length)).toEqual([2, 1, 3]);
    expect(bandRuns(spans, "load", L).map((r) => r.length)).toEqual([2, 1, 1, 1]);
    expect(bandRuns([], "cpu", L)).toEqual([]);
  });

  it("know the highest reading in sight", () => {
    const spans = [
      span({ at: T0, cpu: { lo: 90, hi: 99, sum: 189, n: 2 } }),
      span({ at: T0 + MIN, cpu: { lo: 30, hi: 50, sum: 80, n: 2 } }),
      span({ at: T0 + 2 * MIN, cpu: null }),
    ];
    expect(windowPeak(spans, "cpu", T0 - MIN)).toBe(99);
    expect(windowPeak(spans, "cpu", T0 + 30 * SEC)).toBe(50);
    expect(windowPeak(spans, "cpu", T0 + 5 * MIN)).toBeNull();
  });

  it("put load's ceiling over the cores or the highest load, rounded, never cutting it", () => {
    expect(loadCeiling(null, 8)).toBe(10);
    expect(loadCeiling(4, 8)).toBe(10);
    expect(loadCeiling(20, 8)).toBe(25);
    expect(loadCeiling(0.3, 2)).toBe(3);
    expect(loadCeiling(null, null)).toBe(2);
    expect(loadCeiling(130, 64)).toBe(150);
    for (const [peak, cores] of [
      [11.4, 10],
      [3, 16],
      [0, 1],
    ]) {
      expect(loadCeiling(peak, cores)).toBeGreaterThan(Math.max(peak, cores));
    }
  });

  it("find what is under the pointer: the gap it falls in, else the nearest span in sight", () => {
    const spans = [0, 1, 2, 6].map((m) => span({ at: T0 + m * MIN }));
    const gaps = awayGaps(spans, MIN, null, T0 + 6 * MIN);
    expect(gaps).toEqual([{ from: T0 + 2 * MIN, to: T0 + 6 * MIN, kind: "silent" }]);
    const hit = (at: number) => chartHit(spans, gaps, at, T0, T0 + 6 * MIN);
    expect(hit(T0 + 20 * SEC)).toEqual({ span: 0 });
    expect(hit(T0 + 40 * SEC)).toEqual({ span: 1 });
    expect(hit(T0 + 4 * MIN)).toEqual({ gap: gaps[0] });
    expect(hit(T0 + 6 * MIN)).toEqual({ span: 3 });
    expect(hit(NaN)).toBeNull();
    // A span past the right edge — still on its way in — is not picked.
    expect(chartHit(spans, [], T0 + 5 * MIN, T0, T0 + 3 * MIN)).toEqual({ span: 2 });
    expect(chartHit([], [], T0, T0, T0 + MIN)).toBeNull();
  });

  it("read the time under the pointer, a little past either side too", () => {
    // 0…5 minutes over 500 px from x = 100: a minute is 100 px.
    const at = (x: number) => timeAtX(x, T0, T0 + 5 * MIN, 100, 500);
    expect(at(100)).toBe(T0);
    expect(at(350)).toBe(T0 + 2.5 * MIN);
    expect(at(100 - HOVER_SLACK)).toBe(T0);
    expect(at(600 + HOVER_SLACK)).toBe(T0 + 5 * MIN);
    expect(at(100 - HOVER_SLACK - 1)).toBeNull();
    expect(at(600 + HOVER_SLACK + 1)).toBeNull();
    expect(at(NaN)).toBeNull();
    expect(timeAtX(300, T0, T0, 100, 500)).toBeNull();
  });
});

describe("the pulse", () => {
  const p = (id: string, level: Problem["level"]): Problem => ({ id, level, section: "cpu", key: "mon.p.cpu", params: {} });

  it("draws CPU while all is well, and the metric the status bar names when it is not", () => {
    expect(pulseOf([])).toEqual({ key: "cpu", level: "ok" });
    // A problem the pulse cannot draw leaves it on CPU, at ok: the verdict tells it.
    expect(pulseOf([p("disk:/", "crit"), p("swap", "warn")])).toEqual({ key: "cpu", level: "ok" });
    expect(pulseOf([p("disk:/", "crit"), p("ram", "warn")])).toEqual({ key: "mem", level: "warn" });
    expect(pulseOf([p("load", "crit"), p("cpu", "warn")])).toEqual({ key: "load", level: "crit" });
    // The status bar's own order decides: the first it lists.
    expect(pulseOf([p("cpu", "warn"), p("load", "warn")])).toEqual({ key: "cpu", level: "warn" });
  });

  it("marks one event: the highest peak of its metric in sight", () => {
    const low = ev({ peak: 85, peakAt: T0 + 2 * MIN });
    const high = ev({ peak: 97, peakAt: T0 + 5 * MIN, level: "crit" });
    const old = ev({ peak: 99, peakAt: T0 - 40 * MIN });
    const mem = ev({ key: "mem", peak: 99, peakAt: T0 + 3 * MIN });
    const all = [low, high, old, mem];
    expect(pulseMark(all, "cpu", T0, T0 + 30 * MIN)).toBe(high);
    expect(pulseMark(all, "mem", T0, T0 + 30 * MIN)).toBe(mem);
    expect(pulseMark(all, "load", T0, T0 + 30 * MIN)).toBeNull();
    expect(pulseMark([], "cpu", T0, T0 + MIN)).toBeNull();
  });
});

describe("the sentence about the time away", () => {
  const LEFT = T0 - 5 * MIN;

  it("says nothing before the first reading, and that nothing happened after a quiet one", () => {
    expect(awayStory(emptyAway(5 * SEC), LEFT)).toEqual({ kind: "none" });
    expect(awayStory(run([{}, {}, {}]), LEFT)).toEqual({ kind: "calm" });
  });

  it("tells a restart between two readings first, counting the events beside it", () => {
    // Up 100 000 s, a minute later up 30 s: the host booted again.
    const h = run([{ uptimeSecs: 100_000, cpuPct: 97 }, { uptimeSecs: 100_060 }, { uptimeSecs: 30 }]);
    expect(h.rebootAt).toBe(T0 + 2 * MIN - 30 * SEC);
    expect(awayStory(h, LEFT)).toEqual({ kind: "reboot", at: T0 + 2 * MIN - 30 * SEC, more: 1 });
    // The uptime wobbles with the poll's latency: seconds are no restart.
    const steady = run([{ uptimeSecs: 1000 }, { uptimeSecs: 1000 + 60 - 20 }, { uptimeSecs: 1120 + 5 }]);
    expect(steady.rebootAt).toBeNull();
    expect(awayStory(steady, LEFT)).toEqual({ kind: "calm" });
    // A host that never said how long it had been up is not claimed to have restarted.
    expect(run([{}, { uptimeSecs: null }]).bootAt).toBeNull();
  });

  it("tells a restart before the first reading: the host booted after the user left", () => {
    const h = run([{ uptimeSecs: 120 }]);
    expect(h.bootAt).toBe(T0 - 2 * MIN);
    expect(restartedAt(h, LEFT)).toBe(T0 - 2 * MIN);
    // Booted long before the user left: nothing to tell.
    expect(restartedAt(run([{ uptimeSecs: 86_400 }]), LEFT)).toBeNull();
    // Within the slack of the user leaving: the clocks' wobble, not a restart.
    expect(restartedAt(run([{ uptimeSecs: 5 * 60 - REBOOT_SLACK_MS / 1000 / 2 }]), LEFT)).toBeNull();
  });

  it("tells a metric still over its threshold before a higher peak that is over", () => {
    const h = run([{ cpuPct: 99 }, { cpuPct: 40 }, { memPct: 88 }, { memPct: 90 }]);
    const story = awayStory(h, LEFT);
    expect(story).toMatchObject({ kind: "open", event: { key: "mem", open: true, start: T0 + 2 * MIN, end: T0 + 3 * MIN }, more: 1 });
  });

  it("tells the highest peak: the worse level first, then the higher, load against its cores", () => {
    const warnHigh = ev({ peak: 94 });
    const crit = ev({ key: "mem", level: "crit", peak: 96 });
    const load = ev({ key: "load", level: "crit", peak: 12, cores: 8 });
    // Load 12 on 8 cores is 150 %: higher than memory at 96 %.
    const h: AwayHistory = { ...run([{}]), events: [warnHigh, crit, load] };
    expect(awayStory(h, LEFT)).toEqual({ kind: "peak", event: load, more: 2 });
    expect(awayStory({ ...h, events: [warnHigh, crit] }, LEFT)).toEqual({ kind: "peak", event: crit, more: 1 });
    expect(eventHeight(load)).toBe(150);
    expect(eventHeight(crit)).toBe(96);
    // Load with the cores unknown is not comparable: it ranks last.
    expect(eventHeight(ev({ key: "load", peak: 12, cores: null }))).toBe(0);
  });

  it("tells the longest stretch nothing was read, once it is long enough to matter", () => {
    // A poll every 5 s; nothing for three minutes, then readings again.
    const h = feed([{}, { at: T0 + 5 * SEC }, { at: T0 + 3 * MIN }, { at: T0 + 3 * MIN + 5 * SEC }]);
    expect(h.longestGap).toEqual({ from: T0 + 5 * SEC, to: T0 + 3 * MIN, kind: "silent" });
    expect(awayStory(h, LEFT)).toEqual({ kind: "gap", gap: h.longestGap });
    // Twenty seconds without data is a gap on the line, not news.
    const brief = feed([{}, { at: T0 + 25 * SEC }]);
    expect(brief.longestGap?.to).toBe(T0 + 25 * SEC);
    expect(awayStory(brief, LEFT)).toEqual({ kind: "calm" });
    expect(STORY_GAP_MS).toBeGreaterThan(brief.gapMs);
  });

  it("counts a stretch still going: polls that keep failing", () => {
    // A poll every 5 s that fails for three minutes.
    const polls = Array.from({ length: 36 }, (_, i) => T0 + (i + 1) * 5 * SEC);
    const h = polls.reduce((acc, at) => awayPush(acc, gapReading(at), TH), feed([{}]));
    expect(openGap(h)).toEqual({ from: T0, to: T0 + 3 * MIN, kind: "failed" });
    expect(awayStory(h, LEFT)).toEqual({ kind: "gap", gap: { from: T0, to: T0 + 3 * MIN, kind: "failed" } });
    expect(openGap(feed([{}]))).toBeNull();
  });

  it("names a process by its name, not its share", () => {
    expect(procName("postgres 93%")).toBe("postgres");
    expect(procName("  node  ")).toBe("node");
    expect(procName("")).toBe("");
  });
});

describe("the verdict", () => {
  it("says the host is fine, or names its worst problem and counts the rest", () => {
    const p = (id: string, level: Problem["level"]): Problem => ({ id, level, section: "cpu", key: "mon.p.cpu", params: { pct: 97 } });
    expect(verdictLine(false, [p("cpu", "crit")])).toEqual({ kind: "none" });
    expect(verdictLine(true, [])).toEqual({ kind: "ok" });
    const warn = p("ram", "warn");
    const crit = p("cpu", "crit");
    expect(verdictLine(true, [warn])).toEqual({ kind: "problem", problem: warn, more: 0 });
    expect(verdictLine(true, [warn, crit, p("swap", "warn")])).toEqual({ kind: "problem", problem: crit, more: 2 });
  });
});

describe("the standby screen's layout", () => {
  // The smallest area each form is drawn in (`CARD_ROOM`), a common one and a large one.
  const AREAS: [number, number, boolean][] = [
    [600, 400, false],
    [960, 560, false],
    [1099, 779, false],
    [1100, 780, true],
    [1440, 900, true],
    [2560, 1440, true],
  ];
  const FLAGS = [false, true].flatMap((yourTime) => [false, true].map((transfer) => ({ yourTime, transfer })));

  it("stacks clock, pulse, numbers, transfer and hint top to bottom, inside the area", () => {
    for (const [W, H, big] of AREAS) {
      for (const o of FLAGS) {
        const l = pulseLayout(W, H, big, o);
        const at = `${W}×${H} ${JSON.stringify(o)}`;
        const topBottom = o.yourTime ? l.yourTimeY + l.smallSize : l.dateY + l.dateSize;
        expect(l.dateY, at).toBeGreaterThan(l.clockY + l.clockSize * 0.9);
        expect(l.headY, at).toBeGreaterThan(topBottom);
        expect(l.headY + l.headSize, at).toBeLessThan(l.chart.y);
        expect(l.chart.y + l.chart.h, at).toBeLessThan(l.axisY);
        expect(l.axisY + l.smallSize, at).toBeLessThan(l.labelY);
        expect(l.labelY + l.labelSize, at).toBeLessThan(l.valueY);
        const under = l.transfer ? l.transfer.y : l.hintY;
        expect(l.valueY + l.valueSize, at).toBeLessThanOrEqual(under);
        if (l.transfer) expect(l.transfer.y + l.transfer.h, at).toBeLessThan(l.hintY);
        expect(l.transfer != null, at).toBe(o.transfer);
        expect(l.hintY + 12, at).toBeLessThanOrEqual(H);
        expect(l.chart.x + l.chart.w, at).toBe(W - l.pad);
        // The host and its verdict stand beside the clock, not under it.
        expect(l.verdictY + l.verdictSize, at).toBeLessThan(l.headY);
      }
    }
  });

  it("keeps the pulse a height worth reading, with room for the mark's label", () => {
    for (const [W, H, big] of AREAS) {
      for (const o of FLAGS) {
        const l = pulseLayout(W, H, big, o);
        expect(l.chart.h - l.markRoom, `${W}×${H} ${JSON.stringify(o)}`).toBeGreaterThanOrEqual(big ? 100 : 40);
        expect(l.chart.h).toBeLessThanOrEqual(Math.round(H * PULSE_SHARE));
      }
    }
  });

  it("gives what is left to air above the pulse, not to a taller line", () => {
    const l = pulseLayout(2560, 1440, true, { yourTime: false, transfer: false });
    expect(l.chart.h).toBe(Math.round(1440 * PULSE_SHARE));
    expect(l.headY - (l.dateY + l.dateSize)).toBeGreaterThan(200);
  });
});

describe("under the pointer", () => {
  it("stops showing once the pointer rests", () => {
    expect(hoverShown(null, 1000)).toBe(false);
    expect(hoverShown(1000, 1000)).toBe(true);
    expect(hoverShown(1000, 1000 + HOVER_STILL_MS - 1)).toBe(true);
    expect(hoverShown(1000, 1000 + HOVER_STILL_MS)).toBe(false);
    // A clock that went back is no reason to show it.
    expect(hoverShown(1000, 999)).toBe(false);
  });

  it("names a stretch short: seconds under a minute, then as the uptime reads", () => {
    expect(spanLabel(0)).toBe("0s");
    expect(spanLabel(35_000)).toBe("35s");
    expect(spanLabel(59_400)).toBe("59s");
    expect(spanLabel(60_000)).toBe("1m");
    expect(spanLabel(17 * MIN)).toBe("17m");
    expect(spanLabel(160 * MIN)).toBe("2h 40m");
    expect(spanLabel(-5)).toBe("0s");
    expect(spanLabel(NaN)).toBe("0s");
  });
});

describe("the small cards' chart", () => {
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

  it("cuts the line at an edge on its way, never past the box", () => {
    const pts = [
      { at: 0, cpu: 0, mem: null, load: null },
      { at: 10, cpu: 1, mem: null, load: null },
      { at: 20, cpu: 0, mem: null, load: null },
      { at: 30, cpu: 1, mem: null, load: null },
    ];
    // The right edge halfway to the newest point: the last stretch drawn to the edge.
    expect(timeRuns(pts, "cpu", 0, 25, 0, 0, 100, 100)).toEqual([
      [
        { x: 0, y: 100 },
        { x: 40, y: 0 },
        { x: 80, y: 100 },
        { x: 100, y: 50 },
      ],
    ]);
    // The left edge past the oldest point (a small card sliding on): cut there too.
    expect(timeRuns(pts, "cpu", 5, 30, 0, 0, 100, 100)).toEqual([
      [
        { x: 0, y: 50 },
        { x: 20, y: 0 },
        { x: 60, y: 100 },
        { x: 100, y: 0 },
      ],
    ]);
    // Both edges inside one stretch.
    expect(timeRuns(pts, "cpu", 12, 18, 0, 0, 100, 100)).toEqual([
      [
        { x: 0, y: 20 },
        { x: 100, y: 80 },
      ],
    ]);
    // No line is drawn across a gap to reach an edge.
    const gapped = [
      { at: 0, cpu: 0.5, mem: null, load: null },
      { at: 10, cpu: null, mem: null, load: null },
      { at: 20, cpu: 0.5, mem: null, load: null },
    ];
    expect(timeRuns(gapped, "cpu", 5, 15, 0, 0, 100, 100)).toEqual([]);
    expect(timeRuns(gapped, "cpu", 0, 15, 0, 0, 100, 100)).toEqual([[{ x: 0, y: 50 }]]);
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
