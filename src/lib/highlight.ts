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

/** A rule compiled to a ready-to-use RegExp + SGR set/reset sequences. */
export interface CompiledRule {
  re: RegExp;
  sgr: string; // SGR params to set, e.g. "31" or "1;30;43"
  reset: string; // SGR params to reset with: "39" (fg only) or "0" (all)
  wholeLine: boolean;
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
 * Build the SGR set/reset params for a rule's colour + style options. Plain
 * foreground resets with `39` (preserving any other attributes the program set);
 * bold/background reset with `0` since they need a full clear. A background uses
 * black text (`30`) on the colour for legibility across themes.
 */
export function ruleSgr(rule: Pick<HighlightRule, "color" | "bold" | "background">): {
  sgr: string;
  reset: string;
} {
  const fg = colorToSgr(rule.color);
  const parts: string[] = [];
  if (rule.bold) parts.push("1");
  if (rule.background) parts.push("30", String(Number(fg) + 10));
  else parts.push(fg);
  return { sgr: parts.join(";"), reset: rule.bold || rule.background ? "0" : "39" };
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
      out.push({
        re: new RegExp(r.pattern, r.caseSensitive ? "g" : "gi"),
        ...ruleSgr(r),
        wholeLine: r.wholeLine,
      });
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
  reset: string;
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

/** Token-level highlighting within a single line (no whole-line rules). */
function highlightTokens(line: string, rules: CompiledRule[]): string {
  const ranges = escapeRanges(line);
  const spans: Span[] = [];
  for (const { re, sgr, reset, wholeLine } of rules) {
    if (wholeLine) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        re.lastIndex++; // avoid an infinite loop on zero-length matches
        continue;
      }
      if (!inEscape(start, end, ranges)) spans.push({ start, end, sgr, reset });
    }
  }
  if (spans.length === 0) return line;
  // Earliest start wins; ties keep earlier-listed rules (stable by push order).
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start < cursor) continue; // overlaps an already-emitted span — skip
    out += line.slice(cursor, sp.start);
    out += `\x1b[${sp.sgr}m${line.slice(sp.start, sp.end)}\x1b[${sp.reset}m`;
    cursor = sp.end;
  }
  return out + line.slice(cursor);
}

/**
 * Apply highlight rules to `text`, line by line (so whole-line rules can colour
 * an entire line). For each line: the first matching whole-line rule colours the
 * whole line; otherwise matched tokens are wrapped in their rule's SGR. Matches
 * inside existing escape sequences are skipped. Returns `text` unchanged when
 * there are no rules.
 */
export function applyHighlight(text: string, rules: CompiledRule[]): string {
  if (rules.length === 0 || !text) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let wholeLined = false;
    for (const r of rules) {
      if (!r.wholeLine) continue;
      r.re.lastIndex = 0;
      if (r.re.test(line)) {
        lines[i] = `\x1b[${r.sgr}m${line}\x1b[${r.reset}m`;
        wholeLined = true;
        break;
      }
    }
    if (!wholeLined) lines[i] = highlightTokens(line, rules);
  }
  return lines.join("\n");
}
