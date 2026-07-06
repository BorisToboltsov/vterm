// Small framework-agnostic utilities.

/** True when the document is hidden (tab/window not visible). Safe in SSR/tests. */
export function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Drop dotfiles from a directory listing unless `showHidden` is set. A hidden
 * entry is one whose name starts with a dot (Unix convention). Pure and
 * order-preserving; the parent-nav (`..`) is not part of `entries` here.
 */
export function filterHiddenFiles<T extends { name: string }>(
  entries: readonly T[],
  showHidden: boolean,
): T[] {
  return showHidden ? entries.slice() : entries.filter((e) => !e.name.startsWith("."));
}

/**
 * Case-insensitive AND-substring match: every whitespace-separated term in
 * `query` must appear somewhere in `haystack`. An empty query matches anything
 * (used for settings search / list filtering).
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = haystack.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/**
 * Order-insensitive line change stat between two texts: how many distinct lines
 * were added and removed (multiset difference). Good enough for an audit note
 * ("3 added, 1 removed") without a full LCS diff; identical text → 0/0.
 */
export function lineDiffStat(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const counts = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of text.split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = counts(oldText);
  const b = counts(newText);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Cancel a pending trailing call. */
  cancel(): void;
}

/**
 * Trailing debounce: coalesce bursts of calls into one, `ms` after the last one.
 * Used to avoid thrashing on rapid ResizeObserver / resize events.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
