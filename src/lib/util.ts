// Small framework-agnostic utilities.

/** True when the document is hidden (tab/window not visible). Safe in SSR/tests. */
export function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
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
