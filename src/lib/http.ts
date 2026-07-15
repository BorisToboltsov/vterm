// HTTP client (Postman-lite) — pure logic (Phase 34). Builds a `curl` argv and
// parses its response (status, headers, body) plus timing metrics emitted via
// `-w`. Runs on the session host, so it exercises an API/webhook from that
// server's network position — the debugging value of "does prod reach this
// endpoint, and how fast?".
import { shellQuote } from "./probe";

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

/** Build `curl -sS -i [-L] [-X M] [-H …] [--data-raw …] -w <metrics> URL`. */
export function httpArgs(req: HttpRequest, timeoutSecs = 20): string[] {
  const args = ["curl", "-sS", "-i", "--max-time", String(timeoutSecs)];
  if (req.followRedirects) args.push("-L");
  if (req.method !== "GET") args.push("-X", req.method);
  for (const h of req.headers) {
    if (h.name.trim()) args.push("-H", `${h.name.trim()}: ${h.value}`);
  }
  if (req.body) args.push("--data-raw", req.body);
  args.push("-w", WRITEOUT, shellQuote(req.url.trim()));
  return args;
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
