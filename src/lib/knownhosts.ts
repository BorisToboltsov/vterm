// Pure logic for the known_hosts manager utility (Phase 33). The Rust backend is
// a dumb executor (list/remove the JSON map); the display shaping — splitting
// `host:port`, filtering by query, and sorting — lives here so it is unit-tested
// without the Tauri bridge (architecture invariant). Type-only import of the
// backend entry keeps this module free of `invoke`.
import type { KnownHostEntry } from "./api";

export interface ParsedHost {
  /** Original `host:port` id (what remove_known_host takes). */
  id: string;
  host: string;
  port: string;
  fingerprint: string;
}

/** Split a `host:port` id at the last colon (leaves bracketed IPv6 hosts intact). */
export function splitHostPort(id: string): { host: string; port: string } {
  const idx = id.lastIndexOf(":");
  if (idx === -1) return { host: id, port: "" };
  return { host: id.slice(0, idx), port: id.slice(idx + 1) };
}

/** Parse, filter by `query` (id or fingerprint), and sort by host then port. */
export function prepareHosts(entries: KnownHostEntry[], query: string): ParsedHost[] {
  const parsed: ParsedHost[] = entries.map((e) => ({
    id: e.id,
    fingerprint: e.fingerprint,
    ...splitHostPort(e.id),
  }));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? parsed.filter(
        (p) => p.id.toLowerCase().includes(q) || p.fingerprint.toLowerCase().includes(q),
      )
    : parsed;

  return filtered.sort(
    (a, b) =>
      a.host.localeCompare(b.host) || a.port.localeCompare(b.port, undefined, { numeric: true }),
  );
}
