// Pure secret-redaction for AI context (Phase 17.3, opt-in assistant).
//
// Before any terminal text is offered to the consent dialog and the LLM broker,
// it passes through here so obvious secrets never leave the machine. The marker
// matches the one the recorder writes (recording.rs `REDACTED`) so masked text
// reads the same whether it came from a live buffer or a saved recording.
//
// DOM/network-free → unit-tested directly. Redaction is best-effort and biased
// toward over-masking: a false positive hides a harmless value, a false negative
// leaks a secret, so when in doubt we mask. The consent dialog still shows the
// user exactly what will be sent (post-redaction) before anything is transmitted.

/** Marker written in place of a redacted value — same glyphs as recording.rs. */
export const REDACTED = "‹redacted›"; // ‹redacted›

export interface RedactResult {
  /** The text with secrets replaced by {@link REDACTED}. */
  text: string;
  /** How many distinct secrets were masked (for the consent summary). */
  count: number;
}

interface Rule {
  /** Global regex; the listed capture groups are replaced by the marker. */
  re: RegExp;
  /** 1-based capture group indices whose content is masked. */
  groups: number[];
}

// Key names that mark a sensitive assignment (`PGPASSWORD=…`, `api_key: …`,
// `--token=…`). Bare `auth`/`authorization` is intentionally absent — the header
// scheme (`Bearer …`) is handled by its own rule so we don't clobber it.
const SENSITIVE_KEY =
  "(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|client[_-]?secret|credential|passphrase|private[_-]?key)";

const RULES: Rule[] = [
  // KEY=value / KEY: value / --key value, optionally quoted. The key may carry a
  // prefix/suffix (GITHUB_TOKEN, PGPASSWORD). Value runs to the next quote/space.
  {
    re: new RegExp(
      `([A-Za-z0-9_.\\-]*${SENSITIVE_KEY}[A-Za-z0-9_.\\-]*\\s*[:=]\\s*)(["']?)([^\\s"']+)\\2`,
      "gi",
    ),
    groups: [3],
  },
  // Authorization / bearer-style tokens: keep the scheme, mask the credential.
  { re: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._\-+/=]{8,})/gi, groups: [2] },
  // Credentials embedded in a URL: scheme://user:password@host → mask password.
  { re: /\b([a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:)([^\s:@/]+)(@)/gi, groups: [2] },
  // AWS access key IDs are self-identifying.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, groups: [0] },
  // PEM private-key blocks: keep the BEGIN/END fence, mask the body.
  {
    re: /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    groups: [2],
  },
  // Inline password prompt that did echo a value, e.g. "Password: hunter2".
  { re: /\b((?:password|passphrase)\s*:\s+)(\S+)/gi, groups: [2] },
];

/** Replace recognised secrets in `text` with {@link REDACTED}; report the count. */
export function redactSecrets(text: string): RedactResult {
  if (!text) return { text: "", count: 0 };
  let out = text;
  let count = 0;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      // args: full match, ...groups, offset, string (+ named groups object)
      const m = args.slice(0, -2) as string[];
      const full = m[0];
      // Skip values already redacted (idempotent across overlapping rules).
      if (rule.groups.every((g) => (m[g] ?? "") === REDACTED)) return full;
      count++;
      let result = full;
      for (const g of rule.groups) {
        const captured = m[g];
        if (captured) result = result.replace(captured, REDACTED);
      }
      return result;
    });
  }
  return { text: out, count };
}
