// Pure logic for the command palette (⌘K). Kept DOM-free so the matching/ranking
// is unit-testable; the component (CommandPalette.svelte) owns focus/keyboard and
// supplies each command's `run` handler.

import type { IconName } from "./icons";

export interface CommandItem {
  id: string;
  title: string;
  /** Secondary line (e.g. user@host or a folder path). */
  subtitle?: string;
  /** Extra text folded into matching but not shown. */
  keywords?: string;
  icon: IconName;
  /** Group label shown as a chip on the row. */
  group: string;
  /** Side effect to run when the command is chosen. */
  run: () => void;
}

/** Lowercased haystack of everything a query can match against. */
function haystack(item: CommandItem): string {
  return `${item.title} ${item.subtitle ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
}

/**
 * Match `query` against a command. Every whitespace-separated term must appear
 * (substring) somewhere; the result is a *rank* where **lower is better**, or
 * `null` when it doesn't match. Empty query matches everything (rank 0). A title
 * prefix/substring match is boosted so the most relevant rows float to the top.
 */
export function matchScore(query: string, item: CommandItem): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const hay = haystack(item);
  let score = 0;
  for (const term of q.split(/\s+/)) {
    const idx = hay.indexOf(term);
    if (idx === -1) return null;
    score += idx;
  }
  const title = item.title.toLowerCase();
  if (title.startsWith(q)) score -= 100;
  else if (title.includes(q)) score -= 25;
  return score;
}

/** Filter + rank commands for `query`, preserving input order on ties. */
export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  return items
    .map((item, i) => ({ item, i, score: matchScore(query, item) }))
    .filter((x): x is { item: CommandItem; i: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.item);
}
