// Pure password / passphrase generation (Phase 33). Randomness comes from the
// Web Crypto CSPRNG (crypto.getRandomValues) — available in the browser and the
// vitest environment. DOM-free and offline; the component only renders results.

import { WORDS } from "./wordlist";

export const LOWER = "abcdefghijklmnopqrstuvwxyz";
export const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DIGITS = "0123456789";
export const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/";
/** Visually confusable characters removed when "exclude ambiguous" is on. */
export const AMBIGUOUS = "O0oIl1|`'\"";

/** Uniform integer in [0, maxExclusive) via rejection sampling (no modulo bias). */
export function randInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error("maxExclusive must be > 0");
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % maxExclusive;
}

/** Pick a uniformly random element of a non-empty string/array. */
function pick<T>(items: ArrayLike<T>): T {
  return items[randInt(items.length)];
}

export interface PwOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  /** Drop visually ambiguous characters (O/0, l/1, …). */
  excludeAmbiguous: boolean;
  /** Extra characters to exclude (e.g. quotes/backticks that clash with shells). */
  exclude: string;
  /** Require at least one character from every selected class. */
  requireEach: boolean;
  /** Forbid identical or sequential adjacent characters (aa, ab, 12, 21). */
  noRepeats: boolean;
}

export type PwError = "noClass" | "emptyPool" | "lengthTooSmall" | "unsatisfiable";
export type PwResult = { ok: true; password: string; entropyBits: number } | { ok: false; error: PwError };

/** The selected character classes after ambiguous/custom exclusions (empty ones dropped). */
export function buildClasses(opts: PwOptions): string[] {
  const excluded = new Set([
    ...(opts.excludeAmbiguous ? AMBIGUOUS : ""),
    ...opts.exclude,
  ]);
  const filter = (s: string) => [...s].filter((c) => !excluded.has(c)).join("");
  const classes: string[] = [];
  if (opts.lower) classes.push(filter(LOWER));
  if (opts.upper) classes.push(filter(UPPER));
  if (opts.digits) classes.push(filter(DIGITS));
  if (opts.symbols) classes.push(filter(SYMBOLS));
  return classes.filter((c) => c.length > 0);
}

/** Would placing `ch` after `prev` violate the no-repeats/no-sequence rule? */
function adjacencyBad(prev: string | undefined, ch: string): boolean {
  if (prev === undefined) return false;
  if (prev === ch) return true;
  return Math.abs(prev.charCodeAt(0) - ch.charCodeAt(0)) === 1;
}

/** Shannon entropy estimate for a uniformly random password of `length` from `poolSize`. */
export function entropyBits(poolSize: number, length: number): number {
  return poolSize <= 1 ? 0 : Math.round(length * Math.log2(poolSize) * 10) / 10;
}

export function generatePassword(opts: PwOptions): PwResult {
  const classes = buildClasses(opts);
  if (!opts.lower && !opts.upper && !opts.digits && !opts.symbols) return { ok: false, error: "noClass" };
  if (classes.length === 0) return { ok: false, error: "emptyPool" };
  if (opts.requireEach && opts.length < classes.length) return { ok: false, error: "lengthTooSmall" };

  const pool = classes.join("");
  const bits = entropyBits(pool.length, opts.length);

  // Retry the whole password until the (verified) constraints hold. Converges
  // quickly for reasonable settings; bails out to an error for impossible ones.
  for (let attempt = 0; attempt < 4000; attempt++) {
    const chars: string[] = [];
    let stuck = false;
    for (let i = 0; i < opts.length; i++) {
      let ch = "";
      let ok = false;
      for (let tries = 0; tries < 40; tries++) {
        ch = pick(pool);
        if (!opts.noRepeats || !adjacencyBad(chars[i - 1], ch)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        stuck = true;
        break;
      }
      chars.push(ch);
    }
    if (stuck) continue;

    const password = chars.join("");
    if (opts.requireEach && !classes.every((cls) => [...password].some((c) => cls.includes(c)))) {
      continue;
    }
    return { ok: true, password, entropyBits: bits };
  }
  return { ok: false, error: "unsatisfiable" };
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  /** Append a random digit to one random word. */
  includeNumber: boolean;
}

export interface PassphraseResult {
  phrase: string;
  entropyBits: number;
}

export function generatePassphrase(
  opts: PassphraseOptions,
  words: readonly string[] = WORDS,
): PassphraseResult {
  const n = Math.max(1, opts.words);
  const chosen: string[] = [];
  for (let i = 0; i < n; i++) {
    let w = pick(words);
    if (opts.capitalize) w = w[0].toUpperCase() + w.slice(1);
    chosen.push(w);
  }
  if (opts.includeNumber) {
    const idx = randInt(chosen.length);
    chosen[idx] += String(randInt(10));
  }
  // Base entropy from word choice; the appended digit adds a little more.
  let bits = n * Math.log2(words.length);
  if (opts.includeNumber) bits += Math.log2(10 * n);
  return { phrase: chosen.join(opts.separator), entropyBits: Math.round(bits * 10) / 10 };
}
