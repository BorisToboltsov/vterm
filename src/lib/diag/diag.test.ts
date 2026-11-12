import { describe, expect, it } from "vitest";
import {
  codeParams,
  DEFAULT_DIAG_SIZE_MB,
  DIAG_SIZES_MB,
  DIAG_SOURCES,
  diagText,
  errorText,
  isDiagSource,
  mayTellInternalError,
  mbBytes,
  passes,
  queryOf,
  rejectionLevel,
  sanitizeDiagSize,
  sanitizeThreshold,
  sizeOf,
} from "./diag";
import { JOURNAL_SOURCES } from "../notifications/journal";

describe("diagnostics, the pure part", () => {
  it("writes an event at its threshold and above, never below", () => {
    expect(passes("error", "error")).toBe(true);
    expect(passes("warn", "error")).toBe(false);
    expect(passes("warn", "info")).toBe(true);
    expect(passes("debug", "info")).toBe(false);
    expect(passes("debug", "debug")).toBe(true);
    expect(passes("trace", "debug")).toBe(false);
  });

  it("takes a stored threshold only when it is one the settings offer", () => {
    expect(sanitizeThreshold("warn")).toBe("warn");
    expect(sanitizeThreshold("trace")).toBe("info");
    expect(sanitizeThreshold(undefined)).toBe("info");
  });

  it("knows the journal's sources and storage", () => {
    for (const s of JOURNAL_SOURCES) expect(isDiagSource(s)).toBe(true);
    expect(DIAG_SOURCES).toContain("storage");
    expect(isDiagSource("nope")).toBe(false);
  });

  it("grades a rejected command: an ordinary outcome is information", () => {
    expect(rejectionLevel("auth-rejected: wrong password")).toBe("info");
    expect(rejectionLevel("dest-exists: /tmp/x")).toBe("info");
    expect(rejectionLevel("exec channel failed")).toBe("warn");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
  });

  it("asks the backend for what the filter row says", () => {
    const q = queryOf({ text: " refused ", facets: { level: ["warn", "error"], server: ["prod-db"] } }, 1234);
    expect(q).toEqual({ levels: ["warn", "error"], sources: [], servers: ["prod-db"], text: "refused", before: 1234, limit: 200 });
  });

  it("copies events as text: time, level, where, count, text and fields", () => {
    const at = new Date(2026, 10, 12, 14, 32, 5).getTime();
    const text = diagText(
      [{ at, level: "warn", source: "docker", server: "prod-db", text: "poll failed", count: 3, fields: { failures: 3 } }],
      { source: (s) => s.toUpperCase() },
    );
    expect(text).toBe("2026-11-12 14:32:05  WARN  prod-db · DOCKER  ×3\n  poll failed\n  failures=3");
  });

  it("says sizes plainly, the cap among them", () => {
    expect(sizeOf(mbBytes(DEFAULT_DIAG_SIZE_MB))).toBe("25 MB");
    expect(sizeOf(3.25 * 1024 * 1024)).toBe("3.3 MB");
    expect(sizeOf(2048)).toBe("2 KB");
    expect(sizeOf(10)).toBe("10 B");
  });

  it("takes a stored size only when it is one the settings offer", () => {
    expect(DIAG_SIZES_MB).toContain(DEFAULT_DIAG_SIZE_MB);
    expect(sanitizeDiagSize(100)).toBe(100);
    expect(sanitizeDiagSize(30)).toBe(DEFAULT_DIAG_SIZE_MB);
    expect(sanitizeDiagSize("250")).toBe(DEFAULT_DIAG_SIZE_MB);
  });

  it("says «internal error» once a minute at most", () => {
    expect(mayTellInternalError(null, 1000)).toBe(true);
    expect(mayTellInternalError(1000, 60_999)).toBe(false);
    expect(mayTellInternalError(1000, 61_000)).toBe(true);
  });

  it("fills a coded event's title from its fields, a threshold's levels by name", () => {
    const levelName = (l: string) => ({ info: "Information", warn: "Warnings" })[l] ?? l;
    expect(
      codeParams({ at: 1, level: "info", text: "x", code: "threshold", fields: { from: "info", to: "warn" } }, levelName),
    ).toEqual({ from: "Information", to: "Warnings" });
    expect(codeParams({ at: 1, level: "info", text: "x", code: "connected", fields: { ms: 120, ok: true } }, levelName)).toEqual({
      ms: "120",
      ok: "true",
    });
  });

  it("copies a coded event with its title over its text", () => {
    const at = new Date(2026, 10, 12, 14, 32, 5).getTime();
    const text = diagText([{ at, level: "info", source: "settings", text: "diagnostics threshold changed", code: "threshold" }], {
      source: (s) => s,
      title: () => "Threshold changed",
    });
    expect(text).toBe("2026-11-12 14:32:05  INFO  settings\n  Threshold changed\n  diagnostics threshold changed");
  });
});
