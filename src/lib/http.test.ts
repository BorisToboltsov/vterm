import { describe, it, expect } from "vitest";
import { httpArgs, httpTerminalArgv, httpAudit, parseHttp, statusClass, type HttpRequest } from "./http";
import { renderArgv } from "./termcmd";

const base: HttpRequest = {
  method: "GET",
  url: "https://api.test/health",
  headers: [],
  body: "",
  followRedirects: false,
};

describe("httpArgs", () => {
  it("builds a minimal GET", () => {
    const a = httpArgs(base);
    expect(a.slice(0, 5)).toEqual(["curl", "-sS", "-i", "--max-time", "20"]);
    expect(a).not.toContain("-X");
    expect(a).not.toContain("-L");
    expect(a[a.length - 1]).toBe("https://api.test/health");
  });
  it("adds method, headers, body and redirects", () => {
    const a = httpArgs({
      ...base,
      method: "POST",
      headers: [{ name: "Content-Type", value: "application/json" }, { name: "", value: "skip" }],
      body: `{"a":1}`,
      followRedirects: true,
    });
    expect(a).toContain("-L");
    expect(a).toContain("-X");
    expect(a).toContain("POST");
    expect(a).toContain("-H");
    expect(a).toContain("Content-Type: application/json");
    expect(a).not.toContain("skip"); // blank header name dropped
    expect(a).toContain("--data-raw");
    expect(a).toContain(`{"a":1}`);
  });
});

describe("argv is raw (the transport quotes)", () => {
  it("does not pre-quote a URL with a query string", () => {
    // Pre-quoting it here made SSH quote it twice: curl got literal `'…'`.
    const a = httpArgs({ ...base, url: " https://api.test/x?a=1&b=2 " });
    expect(a[a.length - 1]).toBe("https://api.test/x?a=1&b=2");
  });
});

describe("httpTerminalArgv", () => {
  it("drops the -w metrics and keeps the request", () => {
    const a = httpTerminalArgv({ ...base, method: "POST", body: "x" }, "posix");
    expect(a[0]).toBe("curl");
    expect(a).not.toContain("-w");
    expect(a).toEqual(expect.arrayContaining(["-X", "POST", "--data-raw", "x"]));
    expect(a[a.length - 1]).toBe("https://api.test/health");
  });
  it("calls curl.exe outside POSIX (PowerShell aliases bare curl)", () => {
    expect(httpTerminalArgv(base, "powershell")[0]).toBe("curl.exe");
    expect(httpTerminalArgv(base, "cmd")[0]).toBe("curl.exe");
  });
  it("renders for each shell, and refuses what can't be typed", () => {
    const q = { ...base, url: "https://api.test/x?a=1&b=2" };
    expect(renderArgv(httpTerminalArgv(q, "posix"), "posix")).toContain("'https://api.test/x?a=1&b=2'");
    expect(renderArgv(httpTerminalArgv(q, "cmd"), "cmd")).toContain('"https://api.test/x?a=1&b=2"');
    expect(renderArgv(httpTerminalArgv(q, "powershell"), "powershell")).toMatch(/^curl\.exe /);
    // A multi-line body would submit half a command.
    expect(renderArgv(httpTerminalArgv({ ...base, body: "a\nb" }, "posix"), "posix")).toBeNull();
    // cmd.exe has no escape for an embedded double quote.
    expect(renderArgv(httpTerminalArgv({ ...base, body: '{"a":1}' }, "cmd"), "cmd")).toBeNull();
  });
});

describe("parseHttp", () => {
  it("parses status, headers, body and timings", () => {
    const raw =
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nServer: nginx\r\n\r\n" +
      `{"ok":true}` +
      "\n__VTERM_HTTP__\t200\t0.010\t0.020\t0.030\t0.045\t512\n";
    const r = parseHttp(raw)!;
    expect(r.httpVersion).toBe("1.1");
    expect(r.status).toBe(200);
    expect(r.statusText).toBe("OK");
    expect(r.headers).toContainEqual({ name: "Content-Type", value: "application/json" });
    expect(r.body).toBe(`{"ok":true}`);
    expect(r.timings).toEqual({ dnsMs: 10, connectMs: 20, ttfbMs: 30, totalMs: 45, sizeBytes: 512 });
  });

  it("keeps only the final response across a redirect chain", () => {
    const raw =
      "HTTP/1.1 301 Moved Permanently\r\nLocation: https://x\r\n\r\n" +
      "HTTP/2 200\r\nContent-Type: text/plain\r\n\r\nhi" +
      "\n__VTERM_HTTP__\t200\t0\t0\t0\t0\t2\n";
    const r = parseHttp(raw)!;
    expect(r.status).toBe(200);
    expect(r.body).toBe("hi");
    expect(r.headers).toContainEqual({ name: "Content-Type", value: "text/plain" });
  });

  it("returns null without a status line", () => {
    expect(parseHttp("curl: (6) Could not resolve host")).toBeNull();
  });
});

describe("statusClass", () => {
  it("buckets by status range", () => {
    expect(statusClass(204)).toBe("success");
    expect(statusClass(301)).toBe("redirect");
    expect(statusClass(404)).toBe("clientError");
    expect(statusClass(500)).toBe("serverError");
    expect(statusClass(100)).toBe("unknown");
  });
});

describe("httpAudit", () => {
  const raw =
    "HTTP/1.1 200 OK\r\nSet-Cookie: session=SECRETCOOKIE\r\n\r\n" +
    `{"token":"RESPONSESECRET"}` +
    "\n__VTERM_HTTP__\t200\t0.010\t0.020\t0.030\t0.045\t512\n";
  const req: HttpRequest = {
    ...base,
    method: "POST",
    url: "https://u:pw123456@api.test/x?token=QUERYSECRET&page=2",
    headers: [
      { name: "Authorization", value: "Bearer HEADERSECRET" },
      { name: "X-Api-Key", value: "VENDORSECRET" },
      { name: "Content-Type", value: "application/json" },
    ],
    body: `{"password":"BODYSECRET"}`,
  };

  it("records the request shape and the status, no secrets and no bodies", () => {
    const a = httpAudit(req, { stdout: raw, stderr: "", exitCode: 0 });
    const all = a.op + "\n" + a.body;
    for (const secret of ["HEADERSECRET", "VENDORSECRET", "BODYSECRET", "QUERYSECRET", "pw123456", "SECRETCOOKIE", "RESPONSESECRET"]) {
      expect(all, secret).not.toContain(secret);
    }
    // The token rule masks to the next space — over-masking `&page=2` is the safe side.
    expect(a.op).toMatch(/^http POST https:\/\/u:‹redacted›@api\.test\/x\?token=‹redacted› /);
    expect(a.op).toContain("-H 'Authorization: ‹redacted›'");
    expect(a.op).toContain("-H 'Content-Type: application/json'");
    expect(a.op).toContain(`--data (${req.body.length} B)`);
    expect(a.body).toBe("HTTP/1.1 200 OK · 45 ms · 512 B");
    expect(a.exitCode).toBe(0);
  });

  it("records a transport failure with its exit code", () => {
    const a = httpAudit(base, { stdout: "", stderr: "curl: (6) Could not resolve host", exitCode: 6 });
    expect(a).toEqual({ op: "http GET https://api.test/health", body: "curl: (6) Could not resolve host", exitCode: 6 });
  });
});
