import { describe, expect, it } from "vitest";
import {
  MIN_SPAN_MS,
  RATE_WINDOW_MS,
  etaSeconds,
  fmtEta,
  pushSample,
  sampleRate,
  transferPct,
  type RateSample,
} from "./transfer";

/** Builds a sample series at a fixed cadence with a constant rate. */
function series(count: number, stepMs: number, perStep: number): RateSample[] {
  let samples: RateSample[] = [];
  for (let i = 0; i < count; i++) samples = pushSample(samples, i * stepMs, i * perStep);
  return samples;
}

describe("pushSample", () => {
  it("keeps samples inside the window", () => {
    const s = series(5, 1000, 1000);
    expect(s.length).toBe(5);
  });

  it("drops samples that fell out of the window", () => {
    const s = series(20, 1000, 1000);
    const span = s[s.length - 1].at - s[0].at;
    expect(span).toBeLessThanOrEqual(RATE_WINDOW_MS + 1000);
    expect(s.length).toBeLessThan(20);
  });

  it("keeps one sample before the cutoff so a slow transfer still has two points", () => {
    // One update every 30s — both samples are older than the window apart.
    let s: RateSample[] = [];
    s = pushSample(s, 0, 0);
    s = pushSample(s, 30_000, 300);
    expect(s.length).toBe(2);
    expect(sampleRate(s)).toBeCloseTo(10);
  });

  it("does not mutate the input array", () => {
    const original: RateSample[] = [{ at: 0, transferred: 0 }];
    pushSample(original, 1000, 500);
    expect(original).toEqual([{ at: 0, transferred: 0 }]);
  });
});

describe("sampleRate", () => {
  it("is null before there are two samples", () => {
    expect(sampleRate([])).toBeNull();
    expect(sampleRate([{ at: 0, transferred: 0 }])).toBeNull();
  });

  it("is null while the span is too short to be meaningful", () => {
    const s: RateSample[] = [
      { at: 0, transferred: 0 },
      { at: MIN_SPAN_MS - 1, transferred: 9_000_000 },
    ];
    expect(sampleRate(s)).toBeNull();
  });

  it("measures units per second across the window", () => {
    expect(sampleRate(series(5, 1000, 2048))).toBeCloseTo(2048);
  });

  it("follows a slowdown instead of averaging the whole transfer", () => {
    // 10 MB/s for 3s, then 1 MB/s for 3s. A whole-transfer average would say
    // ~5.5 MB/s; the window must report the recent, honest number.
    let s: RateSample[] = [];
    let bytes = 0;
    for (let i = 0; i <= 3; i++) s = pushSample(s, i * 1000, (bytes = i * 10e6));
    for (let i = 1; i <= 3; i++) s = pushSample(s, 3000 + i * 1000, bytes + i * 1e6);
    expect(sampleRate(s)! / 1e6).toBeLessThan(5);
  });

  it("is null when the counter goes backwards (folder transfer moved to a new file)", () => {
    const s: RateSample[] = [
      { at: 0, transferred: 900 },
      { at: 2000, transferred: 100 },
    ];
    expect(sampleRate(s)).toBeNull();
  });
});

describe("etaSeconds", () => {
  it("divides the remainder by the rate", () => {
    expect(etaSeconds(2000, 10_000, 1000)).toBe(8);
  });

  it("is null while the rate is unknown", () => {
    expect(etaSeconds(0, 1000, null)).toBeNull();
  });

  it("treats a stalled transfer as unknown, not as finishing now", () => {
    expect(etaSeconds(10, 1000, 0)).toBeNull();
    expect(etaSeconds(10, 1000, -5)).toBeNull();
  });

  it("is null when the total is unknown", () => {
    expect(etaSeconds(500, 0, 1000)).toBeNull();
  });

  it("is zero once everything has arrived", () => {
    expect(etaSeconds(1000, 1000, 500)).toBe(0);
  });
});

describe("fmtEta", () => {
  it("formats sub-minute, minute and hour spans", () => {
    expect(fmtEta(42)).toBe("0:42");
    expect(fmtEta(200)).toBe("3:20");
    expect(fmtEta(3900)).toBe("1:05:00");
  });

  it("renders unknown as an em dash rather than a fabricated zero", () => {
    expect(fmtEta(null)).toBe("—");
    expect(fmtEta(Number.NaN)).toBe("—");
    expect(fmtEta(Number.POSITIVE_INFINITY)).toBe("—");
    expect(fmtEta(-1)).toBe("—");
  });
});

describe("transferPct", () => {
  it("rounds and clamps", () => {
    expect(transferPct(0, 100)).toBe(0);
    expect(transferPct(37, 100)).toBe(37);
    expect(transferPct(150, 100)).toBe(100);
    expect(transferPct(5, 0)).toBe(0);
  });
});
