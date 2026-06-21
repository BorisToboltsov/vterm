// Small framework-agnostic utilities.

/** True when the document is hidden (tab/window not visible). Safe in SSR/tests. */
export function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
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
