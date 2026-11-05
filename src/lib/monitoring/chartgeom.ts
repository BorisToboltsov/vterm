// Geometry of the monitoring charts (v1.33). Pure: Chart.svelte asks where to
// draw for a given moment, and the answers are tested here.
//
// Why fixed slots. A point used to stand at `i / (n − 1)` of the width, so while
// the history filled up every poll squeezed the whole line sideways, and once it
// was full the line jumped left by a step. Now a sample's place depends only on
// how far it is from the right edge: the window has HISTORY slots, the newest
// sample sits at the edge, and a fresh panel fills from the right. The edge
// itself (`axis`, a fractional sample number) runs to the newest sample, so the
// line slides in instead of snapping.
//
// Why a known scale. A chart scaled to its own maximum makes 20 → 35 % fill the
// height and, when the peak leaves the window, inflates in one frame — and with
// no label the height means nothing. Percentages are drawn against 0–100; rates
// against a round ceiling (`niceCeil`) that the chart names and eases to.
//
// Why a monotone curve. A smooth line between samples must not invent a peak or
// a dip that was never read: Fritsch–Carlson tangents keep each segment inside
// its two samples.

/** How many samples a chart's window holds: 120 intervals — 10 minutes at the default 5 s poll. */
export const HISTORY = 121;

/**
 * The window of a small chart (a tile, a row of a table): the last 40 intervals of
 * the same history. 121 samples across 160 px are a pixel each, and a fresh page
 * would show a dot at the edge for minutes.
 */
export const SPARK = 41;

/** One reading of a series at poll number `s`; `v` null — not read then (a gap). */
export interface Sample {
  s: number;
  v: number | null;
}

export interface Pt {
  x: number;
  y: number;
}

/** The round ceiling (1, 2 or 5 × 10ⁿ) at or above `v`, never below `floor`. */
export function niceCeil(v: number, floor = 1): number {
  if (!Number.isFinite(v) || v <= floor) return floor;
  const e = 10 ** Math.floor(Math.log10(v));
  const m = v / e;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * e;
}

/** x of sample `s` when the right edge stands at sample `axis`. */
export function slotX(s: number, axis: number, width: number, slots = HISTORY): number {
  const step = width / Math.max(1, slots - 1);
  return width - (axis - s) * step;
}

/** y of `v` on a scale of `max`, inside `[top, top + height]`; out-of-range values clamp. */
export function yOf(v: number, max: number, top: number, height: number): number {
  const k = max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
  return top + height - k * height;
}

export interface Frame {
  /** The right edge, a (fractional) sample number. */
  axis: number;
  width: number;
  top: number;
  height: number;
  max: number;
  slots?: number;
  /** Draw downward from `top` (the lower half of a mirrored chart). */
  down?: boolean;
}

/**
 * Consecutive known samples as runs of points. A null breaks the line — the
 * value was not read then, and a line drawn through the gap would claim it was.
 * Samples further left than one slot past the edge are dropped.
 */
export function runs(samples: readonly Sample[], f: Frame): Pt[][] {
  const slots = f.slots ?? HISTORY;
  const step = f.width / Math.max(1, slots - 1);
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (const smp of samples) {
    const x = slotX(smp.s, f.axis, f.width, slots);
    if (smp.v == null || !Number.isFinite(smp.v) || x < -step) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    const k = f.max > 0 ? Math.min(1, Math.max(0, smp.v / f.max)) : 0;
    const y = f.down ? f.top + k * f.height : yOf(smp.v, f.max, f.top, f.height);
    cur.push({ x, y });
  }
  if (cur.length) out.push(cur);
  return out;
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** A polyline through `pts`. */
export function linePath(pts: readonly Pt[]): string {
  return pts.map((p, i) => `${i ? "L" : "M"}${n2(p.x)},${n2(p.y)}`).join(" ");
}

/**
 * A smooth line through `pts` that never leaves the range of the two samples it
 * joins (monotone cubic, Fritsch–Carlson). Fewer than three points — a polyline.
 */
export function monotonePath(pts: readonly Pt[]): string {
  const n = pts.length;
  if (n < 3) return linePath(pts);
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    m.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx);
  }
  const tan: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    tan.push(m[i - 1] * m[i] <= 0 ? 0 : 2 / (1 / m[i - 1] + 1 / m[i]));
  }
  tan.push(m[n - 2]);
  let d = `M${n2(pts[0].x)},${n2(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = (b.x - a.x) / 3;
    d += ` C${n2(a.x + dx)},${n2(a.y + tan[i] * dx)} ${n2(b.x - dx)},${n2(b.y - tan[i + 1] * dx)} ${n2(b.x)},${n2(b.y)}`;
  }
  return d;
}

/** The area under a line already drawn as `d` through `pts`, closed down (or up) to `baseY`. */
export function areaPath(d: string, pts: readonly Pt[], baseY: number): string {
  if (pts.length < 2) return "";
  return `${d} L${n2(pts[pts.length - 1].x)},${n2(baseY)} L${n2(pts[0].x)},${n2(baseY)} Z`;
}

/** The band between an upper line `top` and a lower line `base` (a stacked layer), as straight segments. */
export function bandPath(top: readonly Pt[], base: readonly Pt[]): string {
  if (top.length < 2 || base.length !== top.length) return "";
  const back = [...base].reverse();
  return `${linePath(top)} ${back.map((p) => `L${n2(p.x)},${n2(p.y)}`).join(" ")} Z`;
}

/**
 * Where the newest point's marker stands: at the newest point, or — while that
 * point is still sliding in past the right edge — on the line at the edge.
 */
export function edgeDot(pts: readonly Pt[], right: number): Pt | null {
  const last = pts[pts.length - 1];
  if (!last) return null;
  if (last.x <= right) return last;
  const prev = pts[pts.length - 2];
  if (!prev || prev.x >= right) return { x: right, y: last.y };
  const k = (right - prev.x) / (last.x - prev.x);
  return { x: right, y: prev.y + (last.y - prev.y) * k };
}

/**
 * Stacked layers: each layer's top is the sum of it and the layers below, at the
 * same sample. A sample any layer did not read is a gap in every layer above it.
 */
export function stack(layers: readonly (readonly Sample[])[]): { top: Sample[]; base: Sample[] }[] {
  const seqs = [...new Set(layers.flatMap((l) => l.map((x) => x.s)))].sort((a, b) => a - b);
  let base: Sample[] = seqs.map((s) => ({ s, v: 0 }));
  return layers.map((layer) => {
    const at = new Map(layer.map((x) => [x.s, x.v]));
    const top = base.map((b) => {
      const v = at.get(b.s);
      return { s: b.s, v: b.v == null || v == null ? null : b.v + v };
    });
    const out = { top, base };
    base = top;
    return out;
  });
}

/** The largest known value among `series` within the last `slots` samples up to `seq`. */
export function windowMax(series: readonly (readonly Sample[])[], seq: number, slots = HISTORY): number {
  let max = 0;
  for (const s of series) {
    for (const x of s) {
      if (x.v != null && x.s > seq - slots && x.v > max) max = x.v;
    }
  }
  return max;
}

/** Time marks under a chart of `slots` samples `intervalSec` apart: seconds ago at 0, ⅓, ⅔ and the edge. */
export function timeMarks(slots: number, intervalSec: number): { at: number; ago: number }[] {
  const span = Math.max(0, slots - 1) * intervalSec;
  return [0, 1 / 3, 2 / 3, 1].map((at) => ({ at, ago: Math.round(span * (1 - at)) }));
}
