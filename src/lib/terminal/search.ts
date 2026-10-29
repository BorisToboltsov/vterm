// Pure helpers for full-buffer terminal search (ADR 0003 — testable without DOM).
//
// The visual side (scroll-to-match, highlight decorations) is handled by
// `@xterm/addon-search` inside Terminal.svelte. These helpers cover the parts
// that don't need xterm: locating match rows in a plain array of buffer lines
// (used for "copy match with context") and formatting the match counter.

/** Options mirroring the subset of `ISearchOptions` we expose in the UI. */
export interface SearchOpts {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/** Escape a string so it can be embedded literally into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the matcher RegExp for a query + options, or `null` when the query is
 * empty or an invalid regex (callers treat `null` as "no matches").
 */
export function buildMatcher(query: string, opts: SearchOpts = {}): RegExp | null {
  if (!query) return null;
  let source = opts.regex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch {
    return null; // malformed user-supplied regex
  }
}

/**
 * Row indices (0-based, top-to-bottom) of buffer lines that contain at least one
 * match. Ordering matches `@xterm/addon-search`'s own top-to-bottom traversal,
 * so the addon's `resultIndex`… well, the addon counts every match while this
 * counts matching *rows*; we only rely on this for the context snippet, indexed
 * by the active row, so per-row granularity is what we want.
 */
export function findMatchRows(lines: string[], query: string, opts: SearchOpts = {}): number[] {
  const re = buildMatcher(query, opts);
  if (!re) return [];
  const rows: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) rows.push(i);
  }
  return rows;
}

/**
 * The matched line plus `radius` lines of context on each side, joined by "\n".
 * Out-of-range rows are clamped; trailing blank lines are trimmed so a match
 * near the bottom of the buffer doesn't drag a block of empty rows along.
 */
export function contextSnippet(lines: string[], row: number, radius: number): string {
  if (row < 0 || row >= lines.length) return "";
  const start = Math.max(0, row - radius);
  const end = Math.min(lines.length - 1, row + radius);
  const slice = lines.slice(start, end + 1);
  while (slice.length > 0 && slice[slice.length - 1].trim() === "") slice.pop();
  return slice.join("\n");
}

/**
 * Human-readable match counter, e.g. "3/57". `index` is the active match
 * (0-based, or -1 when the highlight threshold was exceeded). Empty string when
 * there are no matches so the caller can fall back to a "no results" label.
 */
export function matchCountLabel(index: number, count: number): string {
  if (count <= 0) return "";
  if (index < 0) return `${count}+`; // addon stops tracking the active index past its limit
  return `${index + 1}/${count}`;
}
