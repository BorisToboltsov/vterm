// Pure validation helpers for the add/edit server form. Kept out of the
// `.svelte` component (ADR 0003 invariant: pure logic lives in `.ts` so it is
// testable without a DOM). Used by `ServerFormModal.svelte`.

/**
 * SSH login used when the field is left empty — the same default most hosting
 * panels hand out. Applied on save, so the stored profile always carries a real
 * login and nothing downstream has to know an empty one was possible.
 */
export const DEFAULT_USERNAME = "root";

/** The login to store: the trimmed input, or `DEFAULT_USERNAME` when blank. */
export function usernameOrDefault(value: string): string {
  return value.trim() || DEFAULT_USERNAME;
}

/** A valid SSH port is an integer in 1…65535 (backend stores it as a u16). */
export function isValidPort(p: number | null): p is number {
  return p != null && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/** A dotted-quad IPv4 address, each octet 0…255, no leading zeros. */
function isIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    (p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p,
  );
}

/**
 * An IPv6 literal, including `::` zero-compression, an optional zone id
 * (`%eth0`) and an embedded IPv4 tail (`::ffff:192.168.1.1`). Best-effort:
 * biased toward accepting genuine addresses rather than perfect RFC coverage.
 */
function isIpv6(s: string): boolean {
  const pct = s.indexOf("%");
  const str = pct === -1 ? s : s.slice(0, pct);
  if (str.length === 0) return false;

  const halves = str.split("::");
  if (halves.length > 2) return false;
  const hasDouble = halves.length === 2;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = hasDouble && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...tail];

  // An embedded IPv4 in the final group counts as two 16-bit groups.
  let count = groups.length;
  let ipv4Tail = false;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes(".")) {
    if (!isIpv4(last)) return false;
    ipv4Tail = true;
    count += 1;
  }

  const hex = /^[0-9a-fA-F]{1,4}$/;
  for (let i = 0; i < groups.length; i++) {
    if (ipv4Tail && i === groups.length - 1) continue;
    if (!hex.test(groups[i])) return false;
  }

  // `::` stands in for one or more all-zero groups, so the explicit groups
  // must leave room (< 8); without it the address must be exactly 8 groups.
  return hasDouble ? count <= 7 : count === 8;
}

/**
 * An RFC 1123 host name: dot-separated labels of `[A-Za-z0-9-]`, 1…63 chars
 * each, not starting/ending with a hyphen, ≤ 253 total, optional trailing dot.
 * A multi-label name whose last label is all-numeric is rejected — that shape
 * is an IP address, not a host name (and an invalid one falls through to false).
 */
function isHostname(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  const host = s.endsWith(".") ? s.slice(0, -1) : s;
  if (host.length === 0) return false;

  const labels = host.split(".");
  const label = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  if (!labels.every((l) => label.test(l))) return false;
  if (labels.length > 1 && /^\d+$/.test(labels[labels.length - 1])) return false;
  return true;
}

/**
 * True when `value` is a usable SSH host: a valid IPv4/IPv6 literal or host
 * name. Trims surrounding whitespace; empty is invalid.
 */
export function isValidHost(value: string): boolean {
  const s = value.trim();
  if (s.length === 0) return false;
  return isIpv4(s) || isIpv6(s) || isHostname(s);
}

// ── Collapsed-section previews ───────────────────────────────────────────────
// The form folds everything optional into sections; their headers preview the
// current values so a folded section never hides that something is set.

/** Split the comma-separated tags field the way `submit` stores it. */
export function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tags shown in the "Appearance & tags" header: the first `max`, with a
 *  `+N` counter for the rest. */
export function previewTags(input: string, max = 3): string[] {
  const tags = parseTags(input);
  return tags.length > max ? [...tags.slice(0, max), `+${tags.length - max}`] : tags;
}

/** What the "Recording & AI" header says: what departs from the defaults, or
 *  "defaults" when nothing does. Keys, not strings — the component translates. */
export function recordingSummaryKeys(f: {
  autoRecord: boolean;
  noAi: boolean;
  aiPromptId: string;
  aiExecMode: string;
}): (
  | "page.sumAutoRecord"
  | "page.sumNoAi"
  | "page.sumAiCustom"
  | "page.sumDefaults"
)[] {
  const keys: ("page.sumAutoRecord" | "page.sumNoAi" | "page.sumAiCustom")[] = [];
  if (f.autoRecord) keys.push("page.sumAutoRecord");
  // `noAi` blocks the assistant outright, so its per-server prompt/mode are moot.
  if (f.noAi) keys.push("page.sumNoAi");
  else if (f.aiPromptId || f.aiExecMode) keys.push("page.sumAiCustom");
  return keys.length ? keys : ["page.sumDefaults"];
}

/** `host:port` for the proxy header; an unfilled host reads as `…`. */
export function proxyEndpoint(host: string, port: number | null): string {
  const h = host.trim() || "…";
  return isValidPort(port) ? `${h}:${port}` : h;
}
