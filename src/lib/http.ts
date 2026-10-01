// HTTP client (Postman-lite) — pure logic (Phase 34). Builds a `curl` argv and
// parses its response (status, headers, body) plus timing metrics emitted via
// `-w`. Runs on the session host, so it exercises an API/webhook from that
// server's network position — the debugging value of "does prod reach this
// endpoint, and how fast?" (on a local tab: from this machine, ADR 0014).
import { curlProgram, auditFailure, auditExit, auditText, type AuditEntry, type StepOutput } from "./probe";
import { REDACTED } from "./redact";
import type { CdShell } from "./cdterminal";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: HttpHeader[];
  body: string;
  followRedirects: boolean;
}

// A tab-delimited sentinel appended by `-w` after the (possibly redirected)
// response, carrying curl's timing/size vars. Distinctive so it can't collide
// with real body content.
const METRIC_MARKER = "__VTERM_HTTP__";
const WRITEOUT = `\n${METRIC_MARKER}\t%{http_code}\t%{time_namelookup}\t%{time_connect}\t%{time_starttransfer}\t%{time_total}\t%{size_download}\n`;

/** `curl -sS -i [-L] [-X M] [-H …] [--data-raw …]` — everything but `-w` and the URL. */
function curlRequest(program: string, req: HttpRequest, timeoutSecs: number): string[] {
  const args = [program, "-sS", "-i", "--max-time", String(timeoutSecs)];
  if (req.followRedirects) args.push("-L");
  if (req.method !== "GET") args.push("-X", req.method);
  for (const h of req.headers) {
    if (h.name.trim()) args.push("-H", `${h.name.trim()}: ${h.value}`);
  }
  if (req.body) args.push("--data-raw", req.body);
  return args;
}

/**
 * Build `curl -sS -i [-L] [-X M] [-H …] [--data-raw …] -w <metrics> URL`. Every
 * token is raw: the SSH transport quotes each one, a local run passes argv
 * verbatim. (Pre-quoting the URL here quoted it twice on SSH — a URL with a
 * query string reached curl wrapped in literal `'…'`.)
 */
export function httpArgs(req: HttpRequest, timeoutSecs = 20): string[] {
  return [...curlRequest("curl", req, timeoutSecs), "-w", WRITEOUT, req.url.trim()];
}

/**
 * The argv typed into a local tab's terminal: no `-w` metrics (the output is
 * read by a person, and its newlines can't be typed into a prompt), and
 * `curl.exe` outside POSIX — PowerShell 5.1 aliases bare `curl` to
 * `Invoke-WebRequest`, which rejects every curl flag. Render with `renderArgv`.
 */
export function httpTerminalArgv(req: HttpRequest, shell: CdShell, timeoutSecs = 20): string[] {
  return [...curlRequest(curlProgram(shell), req, timeoutSecs), req.url.trim()];
}

export interface HttpTimings {
  dnsMs: number;
  connectMs: number;
  ttfbMs: number;
  totalMs: number;
  sizeBytes: number;
}

export interface HttpResponse {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: HttpHeader[];
  body: string;
  timings: HttpTimings | null;
}

function parseTimings(line: string): HttpTimings | null {
  const f = line.split("\t");
  // [marker, code, dns, connect, ttfb, total, size]
  if (f.length < 7) return null;
  const s = (i: number) => Math.round(Number(f[i]) * 1000);
  return {
    dnsMs: s(2),
    connectMs: s(3),
    ttfbMs: s(4),
    totalMs: s(5),
    sizeBytes: Number(f[6]) || 0,
  };
}

/**
 * Parse `curl -i` output plus the trailing metrics line. Handles `-L` redirect
 * chains by keeping only the FINAL response's status/headers/body. Returns null
 * when there is no HTTP status line (curl failed before a response).
 */
export function parseHttp(raw: string): HttpResponse | null {
  let head = raw;
  let timings: HttpTimings | null = null;
  const markerAt = raw.lastIndexOf(`\n${METRIC_MARKER}\t`);
  if (markerAt !== -1) {
    head = raw.slice(0, markerAt);
    timings = parseTimings(raw.slice(markerAt + 1).split("\n")[0]);
  }

  const lines = head.split("\n").map((l) => l.replace(/\r$/, ""));
  // Last status line starts the final response block (skip redirect hops).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^HTTP\/[\d.]+\s+\d+/.test(lines[i])) start = i;
  }
  if (start === -1) return null;

  const statusMatch = lines[start].match(/^HTTP\/([\d.]+)\s+(\d+)\s*(.*)$/);
  const headers: HttpHeader[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    if (lines[i] === "") {
      i++;
      break;
    }
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers.push({ name: lines[i].slice(0, colon).trim(), value: lines[i].slice(colon + 1).trim() });
    }
  }
  const body = lines.slice(i).join("\n");

  return {
    httpVersion: statusMatch?.[1] ?? "",
    status: Number(statusMatch?.[2] ?? 0),
    statusText: statusMatch?.[3] ?? "",
    headers,
    body,
    timings,
  };
}

/** Status-class colour bucket for the badge. Pure — thresholds live here. */
export function statusClass(status: number): "success" | "redirect" | "clientError" | "serverError" | "unknown" {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 400 && status < 500) return "clientError";
  if (status >= 500 && status < 600) return "serverError";
  return "unknown";
}

// Header values safe to keep in a recording; every other value is masked —
// `Authorization`, `Cookie`, `X-Api-Key` and whatever a vendor named its token.
const PLAIN_HEADERS = new Set(["accept", "accept-encoding", "accept-language", "content-type", "user-agent", "cache-control", "host"]);

/**
 * The recording's line for one request: method, URL (credentials and token-ish
 * query values masked), header NAMES (values only for a few harmless ones) and
 * the body's size — never its content; then the status line and timings, never
 * the response headers or body. Same restraint as the sftp audit's `save` (size,
 * not text).
 */
export function httpAudit(req: HttpRequest, out: StepOutput): AuditEntry {
  const parts = [`http ${req.method}`, auditText(req.url.trim())];
  for (const h of req.headers) {
    const name = h.name.trim();
    if (!name) continue;
    const value = PLAIN_HEADERS.has(name.toLowerCase()) ? auditText(h.value) : REDACTED;
    parts.push(`-H '${name}: ${value}'`);
  }
  if (req.body) parts.push(`--data (${new TextEncoder().encode(req.body).length} B)`);
  const op = parts.join(" ");
  const res = out.exitCode === 0 ? parseHttp(out.stdout) : null;
  if (!res) return { op, body: auditFailure(out), exitCode: auditExit(out.exitCode) };
  const t = res.timings;
  const line = [
    `HTTP/${res.httpVersion} ${res.status} ${res.statusText}`.trim(),
    t && `${t.totalMs} ms`,
    t && `${t.sizeBytes} B`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { op, body: auditText(line), exitCode: 0 };
}
