// Security regression guard (Phase 6.1): locks in the Tauri hardening so a future
// change can't silently re-open the CSP or widen capabilities. Reads the actual
// config files and asserts the least-privilege posture.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const conf = JSON.parse(
  readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
);
const cap = JSON.parse(
  readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"),
);

describe("Tauri Content-Security-Policy", () => {
  const csp: string | null = conf.app?.security?.csp ?? null;

  it("is set (not null) and restricts the default origin to self", () => {
    expect(typeof csp).toBe("string");
    expect(csp).toContain("default-src 'self'");
  });

  it("blocks remote connections and objects/plugins", () => {
    expect(csp).toMatch(/connect-src[^;]*'self'/);
    // Must not allow arbitrary remote origins.
    expect(csp).not.toContain("default-src *");
    expect(csp).not.toContain("connect-src *");
    expect(csp).toContain("object-src 'none'");
  });

  it("has no dangerous security escape hatches enabled", () => {
    const security = JSON.stringify(conf.app?.security ?? {});
    expect(security.toLowerCase()).not.toContain("dangerous");
  });
});

describe("capabilities are least-privilege", () => {
  const perms: unknown[] = cap.permissions ?? [];
  const stringPerms = perms.filter((p): p is string => typeof p === "string");

  it("does not grant the broad opener/dialog default sets", () => {
    expect(stringPerms).not.toContain("opener:default");
    expect(stringPerms).not.toContain("dialog:default");
    expect(stringPerms).not.toContain("fs:default");
  });

  it("grants only the dialog open/save it actually uses", () => {
    expect(stringPerms).toContain("dialog:allow-open");
    expect(stringPerms).toContain("dialog:allow-save");
  });

  it("restricts the opener to https URLs", () => {
    const opener = perms.find(
      (p): p is { identifier: string; allow?: { url?: string }[] } =>
        typeof p === "object" &&
        p !== null &&
        (p as { identifier?: string }).identifier === "opener:allow-open-url",
    );
    expect(opener, "opener:allow-open-url must be scoped").toBeTruthy();
    const urls = (opener!.allow ?? []).map((a) => a.url);
    expect(urls.every((u) => u?.startsWith("https://"))).toBe(true);
  });
});
