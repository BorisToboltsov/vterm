// How a panel polls its host (ADR 0062): one read in flight at a time, and a
// failed read said in the panel, not as a toast.
//
// The Docker and k8s panels asked every few seconds whether the last answer had
// come or not. On a dead link every read waited for a channel that never opened
// — a minute's worth of them piled up, and when the link was finally given up
// they all failed at once: a burst of identical toasts over the window. Now a
// tick while a read is out only asks for one more after it (`singleFlight`), and
// a failure is a strip in the panel, noted once per streak in the journal
// (`pollFailed`). Pure.

/**
 * `run`, at most one at a time: a call while it runs is answered by the run in
 * flight and asks for one more after it — however many such calls there were.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let again = false;
  const start = (): Promise<void> => {
    current = (async () => {
      try {
        await run();
      } finally {
        current = null;
        if (again) {
          again = false;
          void start();
        }
      }
    })();
    return current;
  };
  return () => {
    if (current) {
      again = true;
      return current;
    }
    return start();
  };
}

/** A panel's reads failing in a row: since when, how many, the last error. */
export interface PollFailure {
  text: string;
  since: number;
  count: number;
}

/**
 * The streak after a read failed with `text` at `now`, and whether it is news —
 * the first failure, or a different error — and so worth a note in the journal.
 * The same error again is counted on the strip, not said again.
 */
export function pollFailed(
  prev: PollFailure | null,
  text: string,
  now: number,
): { failure: PollFailure; news: boolean } {
  if (prev && prev.text === text) return { failure: { ...prev, count: prev.count + 1 }, news: false };
  return { failure: { text, since: prev?.since ?? now, count: (prev?.count ?? 0) + 1 }, news: true };
}
