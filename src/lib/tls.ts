// TLS/SSL inspector — pure logic (Phase 34). Builds an `openssl` pipeline that
// fetches the leaf certificate of `host:port` and prints its fields, then parses
// that text into a structured cert. Runs on the session host (see probe.ts), so
// the cert is seen from that server's network vantage — useful for "does prod
// still trust / reach this endpoint, and when does it expire?".
import { shellQuote, auditFailure, auditExit, auditText, type AuditEntry, type StepOutput } from "./probe";
import type { CdShell } from "./cdterminal";

// What `x509` prints — the fields `parseTlsCert` reads.
const X509_FIELDS = ["-noout", "-subject", "-issuer", "-serial", "-dates", "-fingerprint", "-sha256", "-ext", "subjectAltName"];

/** A parsed leaf certificate (what `openssl x509 -noout …` prints). */
export interface TlsCert {
  subject: string;
  issuer: string;
  /** Subject Alternative Names (DNS:/IP: entries), without the type prefix. */
  sans: string[];
  serial: string;
  fingerprint: string;
  /** `notBefore` / `notAfter` as the raw openssl date strings. */
  notBefore: string;
  notAfter: string;
  /** Parsed `notAfter` epoch ms, or null if unparseable. */
  expiresAt: number | null;
  /** Whole days until expiry (negative = already expired), or null. */
  daysRemaining: number | null;
}

/**
 * Build the probe command. `echo |` closes stdin so `s_client` doesn't hang
 * waiting for input; `-servername` sends SNI (needed for virtual hosts); the
 * leaf cert is piped to `x509` which prints just the fields we parse. The whole
 * pipeline is one `sh -c` token so the remote shell runs the pipe.
 */
export function tlsArgs(host: string, port = 443): string[] {
  const h = shellQuote(host.trim());
  const p = String(port);
  const pipeline =
    `echo | openssl s_client -connect ${h}:${p} -servername ${h} 2>/dev/null` +
    ` | openssl x509 ${X509_FIELDS.join(" ")}`;
  return ["sh", "-c", pipeline];
}

/**
 * The same probe as two steps for a local tab (no shell — Windows has no `sh`):
 * `s_client` fetches the chain (stdin closed, so it doesn't wait for input),
 * then `x509` reads the leaf from it. The runner pipes step 1 into step 2.
 */
export function tlsSteps(host: string, port = 443): string[][] {
  const h = host.trim();
  return [
    ["openssl", "s_client", "-connect", `${h}:${port}`, "-servername", h],
    ["openssl", "x509", ...X509_FIELDS],
  ];
}

// A host safe to type bare into any shell — validated hosts already are; this
// is the belt to that brace, since the line is built by hand per dialect.
const BARE_HOST = /^[A-Za-z0-9.-]+$/;

/**
 * The pipeline typed into a local tab's terminal, in that shell's own syntax:
 * how stdin is closed and stderr dropped differs in each (`echo |`/`2>/dev/null`,
 * `$null |`/`2>$null`, `echo.|`/`2>NUL`). `null` when the host can't be written
 * bare — then nothing is sent.
 */
export function tlsTerminalCommand(host: string, port: number, shell: CdShell): string | null {
  const h = host.trim();
  if (!BARE_HOST.test(h) || !Number.isInteger(port)) return null;
  const x509 = `openssl x509 ${X509_FIELDS.join(" ")}`;
  const client = `openssl s_client -connect ${h}:${port} -servername ${h}`;
  switch (shell) {
    case "posix":
      return `echo | ${client} 2>/dev/null | ${x509}`;
    case "powershell":
      return `$null | ${client} 2>$null | ${x509}`;
    case "cmd":
      return `echo.| ${client} 2>NUL | ${x509}`;
  }
}

/** Parse an openssl date (`notAfter=Jun  1 12:00:00 2027 GMT`) to epoch ms. */
function parseOpensslDate(v: string): number | null {
  const t = Date.parse(v.trim());
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse the `openssl x509 -noout …` output into a {@link TlsCert}. `now` is
 * injectable so the day-count is testable. Returns null when the output has no
 * recognizable certificate fields (e.g. the connection failed).
 */
export function parseTlsCert(raw: string, now = Date.now()): TlsCert | null {
  const lines = raw.split("\n");
  const field = (prefix: string): string => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : "";
  };

  const notAfter = field("notAfter=");
  const subject = field("subject=");
  // Nothing usable — treat as no cert.
  if (!notAfter && !subject) return null;

  // SAN sits on the line AFTER the "X509v3 Subject Alternative Name:" header.
  let sans: string[] = [];
  const sanIdx = lines.findIndex((l) => /Subject Alternative Name/i.test(l));
  if (sanIdx !== -1 && lines[sanIdx + 1]) {
    sans = lines[sanIdx + 1]
      .split(",")
      .map((s) => s.trim().replace(/^(DNS|IP Address|IP|email|URI):/i, ""))
      .filter(Boolean);
  }

  const expiresAt = parseOpensslDate(notAfter);
  const daysRemaining =
    expiresAt === null ? null : Math.floor((expiresAt - now) / 86_400_000);

  // openssl prints "SHA256 Fingerprint=AA:BB:…"; fall back to any "*Fingerprint=".
  const fpLine = lines.find((l) => /Fingerprint=/.test(l)) ?? "";
  const fingerprint = fpLine.includes("=") ? fpLine.slice(fpLine.indexOf("=") + 1).trim() : "";

  return {
    subject,
    issuer: field("issuer="),
    sans,
    serial: field("serial="),
    fingerprint,
    notBefore: field("notBefore="),
    notAfter,
    expiresAt,
    daysRemaining,
  };
}

/** Expiry urgency for the badge colour. Pure — thresholds live here, not the UI. */
export type TlsExpiry = "expired" | "critical" | "warning" | "ok" | "unknown";

export function expiryLevel(daysRemaining: number | null): TlsExpiry {
  if (daysRemaining === null) return "unknown";
  if (daysRemaining < 0) return "expired";
  if (daysRemaining <= 7) return "critical";
  if (daysRemaining <= 30) return "warning";
  return "ok";
}

/**
 * The recording's line for one inspection: who answered and until when — the
 * cert's own fields, no PEM. A failed fetch records why. Pure (`now` injectable).
 */
export function tlsAudit(host: string, port: number, out: StepOutput, now = Date.now()): AuditEntry {
  const op = `tls ${host.trim()}:${port}`;
  const cert = out.exitCode === 0 ? parseTlsCert(out.stdout, now) : null;
  if (!cert) return { op, body: auditFailure(out), exitCode: auditExit(out.exitCode) };
  const days = cert.daysRemaining === null ? "" : ` (${cert.daysRemaining} d)`;
  const body = [
    cert.subject && `subject=${cert.subject}`,
    cert.issuer && `issuer=${cert.issuer}`,
    cert.notAfter && `notAfter=${cert.notAfter}${days}`,
    cert.sans.length > 0 && `SAN=${cert.sans.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { op, body: auditText(body), exitCode: 0 };
}
