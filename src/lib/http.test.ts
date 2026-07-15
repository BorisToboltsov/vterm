import { describe, it, expect } from "vitest";
import { httpArgs, parseHttp, statusClass, type HttpRequest } from "./http";

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
