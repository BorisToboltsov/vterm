// Ordered terminal input.
//
// Every keystroke becomes its own `invoke("write_to_terminal")`, and Tauri runs
// async commands as independent tasks on a multi-threaded runtime: two writes
// in flight at once can reach the PTY/SSH channel in either order. A human
// rarely types fast enough to lose that race, but auto-type (password
// managers), barcode scanners and key repeat do — "echo vterm" arrived as
// "echo vtemr" in the nightly E2E.
//
// So writes to one session are strictly sequential: the next one is sent only
// after the previous resolved. Bytes that arrive meanwhile are not queued as
// separate calls but coalesced into the next single write, so a burst costs one
// extra round-trip instead of one per key. Sessions are independent lanes, and
// a lane is dropped as soon as it drains (nothing to clean up on tab close).

export type SendBytes = (sessionId: string, data: Uint8Array) => Promise<void>;

type Waiter = { resolve: () => void; reject: (e: unknown) => void };
type Lane = { pending: Uint8Array[]; waiters: Waiter[]; busy: boolean };

/** Concatenate chunks into one buffer (order preserved). */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Wrap `send` so that writes to the same session are delivered in call order.
 * Each returned promise settles with the outcome of the write that carried its
 * bytes; a failed write rejects only its own batch and does not stall the lane.
 */
export function createOrderedWriter(send: SendBytes): SendBytes {
  const lanes = new Map<string, Lane>();

  const pump = (sessionId: string, lane: Lane): void => {
    if (lane.pending.length === 0) {
      lanes.delete(sessionId);
      return;
    }
    const data = concatBytes(lane.pending);
    const waiters = lane.waiters;
    lane.pending = [];
    lane.waiters = [];
    lane.busy = true;
    let sent: Promise<void>;
    try {
      sent = send(sessionId, data);
    } catch (e) {
      sent = Promise.reject(e);
    }
    sent.then(
      () => waiters.forEach((w) => w.resolve()),
      (e) => waiters.forEach((w) => w.reject(e)),
    ).finally(() => {
      lane.busy = false;
      pump(sessionId, lane);
    });
  };

  return (sessionId, data) =>
    new Promise<void>((resolve, reject) => {
      let lane = lanes.get(sessionId);
      if (!lane) {
        lane = { pending: [], waiters: [], busy: false };
        lanes.set(sessionId, lane);
      }
      lane.pending.push(data);
      lane.waiters.push({ resolve, reject });
      if (!lane.busy) pump(sessionId, lane);
    });
}
