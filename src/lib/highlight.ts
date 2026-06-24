// Pure helpers for regex log highlighting (ADR 0003 — testable without DOM).
//
// Approach: the terminal output stream is intercepted before `term.write` and
// matched tokens are wrapped in ANSI SGR colour codes (the grc/ccze trick). The
// colour is a basic ANSI foreground, so xterm renders it in the *active theme's*
// palette — a "red" rule shows the theme's red, staying in-theme automatically.
//
// Matches inside existing escape sequences are skipped so we never corrupt the
// stream, and rules are applied only to the normal screen buffer (the caller
// checks that) so full-screen TUIs (vim/htop) are left untouched.

import type { HighlightRule, HighlightColor } from "./settings.svelte";

/** A rule compiled to a ready-to-use RegExp + SGR foreground code. */
export interface CompiledRule {
  re: RegExp;
  sgr: string;
}

const COLOR_SGR: Record<HighlightColor, string> = {
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
};

/** Map a named highlight colour to its ANSI SGR foreground code. */
export function colorToSgr(color: HighlightColor): string {
  return COLOR_SGR[color] ?? "39";
}

/**
 * Compile enabled rules with valid regexes into matchers. Invalid regexes and
 * disabled rules are dropped. The global flag is always added (we scan the whole
 * line); the ignore-case flag is added unless the rule is case-sensitive.
 */
export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules) {
    if (!r.enabled || !r.pattern) continue;
    try {
      out.push({ re: new RegExp(r.pattern, r.caseSensitive ? "g" : "gi"), sgr: colorToSgr(r.color) });
    } catch {
      /* malformed user regex — skip */
    }
  }
  return out;
}

// CSI (e.g. "\x1b[31m") and OSC (e.g. "\x1b]0;title\x07") escape sequences.
const ESC_SEQ = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

interface Span {
  start: number;
  end: number;
  sgr: string;
}

/** Ranges occupied by escape sequences, so matches never land inside them. */
function escapeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  ESC_SEQ.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC_SEQ.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inEscape(start: number, end: number, ranges: [number, number][]): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/**
 * Wrap every rule match in `text` with its SGR colour, resetting to the default
 * foreground (`39`) after each. Earlier rules win on overlap; zero-length and
 * escape-sequence-overlapping matches are skipped. Returns `text` unchanged when
 * there are no rules or no matches.
 */
export function applyHighlight(text: string, rules: CompiledRule[]): string {
  if (rules.length === 0 || !text) return text;
  const ranges = escapeRanges(text);
  const spans: Span[] = [];
  for (const { re, sgr } of rules) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        re.lastIndex++; // avoid an infinite loop on zero-length matches
        continue;
      }
      if (!inEscape(start, end, ranges)) spans.push({ start, end, sgr });
    }
  }
  if (spans.length === 0) return text;
  // Earliest start wins; ties keep earlier-listed rules (stable by push order).
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start < cursor) continue; // overlaps an already-emitted span — skip
    out += text.slice(cursor, sp.start);
    out += `\x1b[${sp.sgr}m${text.slice(sp.start, sp.end)}\x1b[39m`;
    cursor = sp.end;
  }
  out += text.slice(cursor);
  return out;
}
