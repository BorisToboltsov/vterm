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
