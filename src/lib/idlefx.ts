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
