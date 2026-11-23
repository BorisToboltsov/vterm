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

// ── Away card layout ─────────────────────────────────────────────────────────
// The card is drawn over the terminal area, and that area is whatever the docks
// leave: a raised bottom dock makes it a low strip, two wide side docks a narrow
// column. A card laid out by fixed offsets cannot shrink — its numbers left the
// card and its chart landed on its header — so the layout is picked from the
// room there is (v1.14.1).

/**
 * How the card lays itself out — one look at every size (ADR 0075, ADR 0082):
 * - `standby` — a large area: the server's clock, the host and its verdict, the
 *   pulse with one sentence about the time away, four numbers, a transfer under
 *   way, each with room for its details (standby.ts, `pulseLayout`);
 * - `compact` — the same screen for a middling area, in short form;
 * - `small`  — the same screen in its small form (`smallLayout`): the clock and
 *   the host with its verdict share the top row, and what has no room leaves in
 *   one order — the axis, the hint, the heading, the numbers' own row, the
 *   date, the pulse;
 * - `narrow` — a narrow, tall area: the same in a column, the numbers two by two;
 * - `line`   — the host and its verdict alone.
 */
export type CardTier = "standby" | "compact" | "small" | "narrow" | "line";

/** The room each layout needs, px. */
export const CARD_ROOM = {
  /** The clock, the pulse with its details and a transfer at full size. */
  standbyW: 1100,
  standbyH: 780,
  /** The same in short form: the clock beside the host, the pulse under them. */
  compactW: 600,
  compactH: 400,
  /** Narrower than this, a tall area stands in a column. */
  columnW: 480,
  /** A column: the clock, the host and its verdict over the numbers. */
  narrowH: 300,
  /** The small form at its least: the clock beside the host, a line of numbers. */
  smallW: 200,
  smallH: 100,
} as const;

/**
 * The layout a `w × h` px area has room for. An area not measured yet, or junk,
 * gets the smallest one: it draws nothing it could not fit.
 */
export function cardTier(w: number, h: number): CardTier {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return "line";
  const R = CARD_ROOM;
  if (w >= R.standbyW && h >= R.standbyH) return "standby";
  if (w >= R.compactW && h >= R.compactH) return "compact";
  if (w < R.smallW || h < R.smallH) return "line";
  return w < R.columnW && h >= R.narrowH ? "narrow" : "small";
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
