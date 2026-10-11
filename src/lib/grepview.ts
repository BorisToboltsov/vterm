// How the results of a content search are shown (v1.17): grouped by file, each
// line with what was searched for marked in it. Pure — the search itself is
// `grep` on the host (`sync.rs`); this only lays its answer out.

import type { GrepMatch } from "./sync";

/** The matches of one file. */
export interface GrepGroup {
  path: string;
  matches: GrepMatch[];
}

/** The matches grouped by file — files, and lines within a file, in the order grep gave them. */
export function groupMatches(matches: readonly GrepMatch[]): GrepGroup[] {
  const groups = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const list = groups.get(m.path);
    if (list) list.push(m);
    else groups.set(m.path, [m]);
  }
  return [...groups].map(([path, list]) => ({ path, matches: list }));
}

/** A stretch of a line: what the query matched, or what lies between. */
export interface TextSpan {
  text: string;
  hit: boolean;
}

export interface MatchOptions {
  caseSensitive: boolean;
  /** The query is an expression (`grep -E`), not a fixed string. */
  regex: boolean;
}

/** A line is marked up to this many times; past it the rest stays plain. */
const MAX_HITS = 40;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` cut into the stretches the query matches and those between them.
 *
 * A hint for the eye, not the search: which lines match was decided by `grep`
 * on the host, and its expressions are not JavaScript's. Where the two read a
 * query differently, or JavaScript cannot read it at all, nothing is marked —
 * the line is still shown, because grep said it matched.
 */
export function matchSpans(text: string, query: string, opts: MatchOptions): TextSpan[] {
  const plain: TextSpan[] = text ? [{ text, hit: false }] : [];
  if (!query) return plain;
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : escapeRegExp(query), opts.caseSensitive ? "g" : "gi");
  } catch {
    return plain;
  }
  const spans: TextSpan[] = [];
  let at = 0;
  let hits = 0;
  for (const m of text.matchAll(re)) {
    // An expression that matches nothing (`x*`) would mark every gap.
    if (m[0].length === 0) continue;
    const start = m.index ?? 0;
    if (start > at) spans.push({ text: text.slice(at, start), hit: false });
    spans.push({ text: m[0], hit: true });
    at = start + m[0].length;
    if (++hits >= MAX_HITS) break;
  }
  if (hits === 0) return plain;
  if (at < text.length) spans.push({ text: text.slice(at), hit: false });
  return spans;
}

/** How much of a line is kept before its first match when the match is far to the right. */
const LEAD = 24;

/**
 * A matching line as it is shown: its indentation dropped, and — when the match
 * stands so far to the right that a narrow pane would cut it off — the start
 * of the line replaced by an ellipsis, so the match is what is seen.
 */
export function lineSpans(text: string, query: string, opts: MatchOptions): TextSpan[] {
  const spans = matchSpans(text.replace(/^\s+/, ""), query, opts);
  const first = spans.findIndex((s) => s.hit);
  if (first !== 1) return spans;
  const before = spans[0].text;
  if (before.length <= LEAD * 2) return spans;
  return [{ text: `…${before.slice(before.length - LEAD)}`, hit: false }, ...spans.slice(1)];
}
