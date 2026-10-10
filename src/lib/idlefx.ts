// Pure helpers shared by the idle-screensaver effects (Phase 0.28). No DOM: the
// canvas rendering lives in IdleOverlay.svelte, but the data-shaping it needs —
// turning a terminal buffer snapshot into a fixed glyph grid, and into coloured
// word tokens — is decidable without a canvas and tested in idlefx.test.ts.

/**
 * Snapshot terminal text into a fixed `rows × cols` grid of single characters.
 * Uses the LAST `rows` lines (what's on screen), each padded with spaces to `cols`
 * and truncated to `cols`. Tabs become single spaces. Always returns exactly
 * `rows` arrays of exactly `cols` chars, so effects can index without bounds checks.
 */
export function bufferGrid(text: string, cols: number, rows: number): string[][] {
  const c = Math.max(0, Math.floor(cols));
  const r = Math.max(0, Math.floor(rows));
  const lines = text.replace(/\t/g, " ").split("\n");
  const tail = lines.slice(-r);
  const grid: string[][] = [];
  for (let y = 0; y < r; y++) {
    const line = tail[y] ?? "";
    const row: string[] = [];
    for (let x = 0; x < c; x++) row.push(x < line.length ? line[x] : " ");
    grid.push(row);
  }
  return grid;
}

/** Semantic class of a buffer word, used to tint parallax tokens by meaning. */
export type TokenKind = "keyword" | "ok" | "number" | "plain";

export interface WordToken {
  text: string;
  kind: TokenKind;
}

const RE_KEYWORD = /^(prod|production|deploy|error|fail|failed|denied|fatal|panic|kill)/i;
const RE_OK = /^(ok|done|active|running|ready|online|success|established|200|100%)$/i;
const RE_NUMBER = /^[\d.]+([a-z%/]+)?$/i;

/** Classify a single whitespace-delimited token by meaning (bias: plain). */
export function classifyToken(tok: string): TokenKind {
  if (RE_KEYWORD.test(tok)) return "keyword";
  if (RE_OK.test(tok)) return "ok";
  if (RE_NUMBER.test(tok)) return "number";
  return "plain";
}

/**
 * Split a buffer snapshot into de-duplicated word tokens with a semantic class.
 * Whitespace-delimited; tokens shorter than 2 chars are dropped (punctuation
 * noise). Order is first-seen; duplicates collapse so the word cloud stays varied.
 */
export function tokenizeBuffer(text: string): WordToken[] {
  const seen = new Set<string>();
  const out: WordToken[] = [];
  for (const raw of text.split(/\s+/)) {
    const tok = raw.replace(/^[^\w./%-]+|[^\w./%-]+$/g, "");
    if (tok.length < 2) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: tok, kind: classifyToken(tok) });
  }
  return out;
}

// ── Away card chart ──────────────────────────────────────────────────────────
// Three series on one chart, each a fraction of its own ceiling so they share a
// 0…1 axis whose top line is "100 %": CPU and memory of the whole machine, and
// the 1-minute load average against the logical-CPU count (load = cores means
// every core has work). A value vterm cannot know is `null`, never a guessed 0.

/** One chart sample: each series as a fraction 0…1, or null when unknown. */
export interface IdleSample {
  cpu: number | null;
  mem: number | null;
  load: number | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Load average as a share of the machine: `load1 / cpuCount`, capped at 1.
 *  Null without a load average (Windows) or without a known core count. */
export function loadFraction(load1: number | null, cpuCount: number | null): number | null {
  if (load1 == null || !Number.isFinite(load1) || cpuCount == null || cpuCount <= 0) return null;
  return clamp01(load1 / cpuCount);
}

/** Build a sample from percentages (0–100) and the load pair. */
export function idleSample(
  cpuPct: number | null,
  memPct: number | null,
  load1: number | null,
  cpuCount: number | null,
): IdleSample {
  const pct = (v: number | null) => (v == null || !Number.isFinite(v) ? null : clamp01(v / 100));
  return { cpu: pct(cpuPct), mem: pct(memPct), load: loadFraction(load1, cpuCount) };
}

/** Append a sample, keeping the newest `cap`. Returns a new array. */
export function pushSample(hist: IdleSample[], s: IdleSample, cap = 70): IdleSample[] {
  return [...hist, s].slice(-Math.max(1, cap));
}

/**
 * Canvas points for one series across a `w × h` box at (`x0`, `y0`), fraction 1
 * at the top edge. Split into runs at unknown samples, so a gap is drawn as a
 * gap instead of a dive to zero. Samples are spread over the full width by index.
 */
export function seriesRuns(
  values: (number | null)[],
  x0: number,
  y0: number,
  w: number,
  h: number,
): { x: number; y: number }[][] {
  const step = w / Math.max(1, values.length - 1);
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: x0 + i * step, y: y0 + h - clamp01(v) * h });
  });
  if (run.length) runs.push(run);
  return runs;
}

// ── Away card layout ─────────────────────────────────────────────────────────
// The card is drawn over the terminal area, and that area is whatever the docks
// leave: a raised bottom dock makes it a low strip, two wide side docks a narrow
// column. A card laid out by fixed offsets cannot shrink — its numbers left the
// card and its chart landed on its header — so the layout is picked from the
// room there is (v1.14.1).

/**
 * How the card lays itself out:
 * - `full`  — the card: header, three large numbers, the chart under them;
 * - `wide`  — low and wide: one header line carrying the numbers, the chart on
 *   everything below it;
 * - `row`   — too low for a chart: that header line alone;
 * - `stack` — narrow and tall: a column of three rows, each with its own line;
 * - `mini`  — no room for a chart: the host and the three numbers;
 * - `line`  — only the host fits.
 */
export type CardTier = "full" | "wide" | "row" | "stack" | "mini" | "line";

/** The room each layout needs, px. */
export const CARD_ROOM = {
  /** Below this width the numbers no longer stand in one row with the host. */
  wideW: 480,
  /** The card's own header, numbers and a chart worth looking at. */
  fullH: 280,
  /** A header line and a chart at least as tall as that line. */
  wideH: 110,
  /** The column: a header and three rows, each a label over a number. */
  stackW: 220,
  stackH: 270,
  /** The host over three numbers. */
  miniW: 200,
  miniH: 90,
} as const;

/**
 * The layout a `w × h` px area has room for. An area not measured yet, or junk,
 * gets the smallest one: it draws nothing it could not fit.
 */
export function cardTier(w: number, h: number): CardTier {
  if (!(w > 0) || !(h > 0)) return "line";
  const R = CARD_ROOM;
  if (w >= R.wideW) return h >= R.fullH ? "full" : h >= R.wideH ? "wide" : "row";
  if (w >= R.stackW && h >= R.stackH) return "stack";
  if (w >= R.miniW && h >= R.miniH) return "mini";
  return "line";
}

/**
 * `text` cut to `max` characters, the cut marked with an ellipsis. The card is
 * set in a monospace face, so a width in px is a count of characters.
 */
export function clipText(text: string, max: number): string {
  const n = Math.floor(max);
  if (!(n > 0)) return "";
  const chars = [...text];
  if (chars.length <= n) return text;
  return n === 1 ? "…" : `${chars.slice(0, n - 1).join("")}…`;
}
