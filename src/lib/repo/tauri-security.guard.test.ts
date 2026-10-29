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

  it("allows no inline script by name, only by the hashes the build adds", () => {
    // v1.25.1: the build hashes every inline <script> of the page into
    // script-src (tauri-codegen), and a hash cancels 'unsafe-inline' — the
    // keyword only claimed a permission the build revoked. Dev keeps it (Vite).
    expect(csp).toMatch(/script-src[^;]*'self'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  });

  it("names no image source the app does not serve", () => {
    // The asset protocol is off (no `protocol-asset` feature): `asset:` and
    // http://asset.localhost in img-src were sources nothing answers.
    expect(csp).not.toMatch(/img-src[^;]*asset/);
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

  it("grants no default set at all — core included — only named permissions", () => {
    // v1.25.1: `core:default` gave the WebView the menu, tray, path, image and
    // webview APIs and every window getter, none of which the page calls. The
    // core permissions are the ones the frontend uses, named one by one; a new
    // one is added here with the call that needs it.
    expect(stringPerms.filter((p) => /:default$/.test(p))).toEqual([]);
    expect(stringPerms.filter((p) => p.startsWith("core:")).sort()).toEqual(
      [
        "core:app:allow-name",
        "core:app:allow-tauri-version",
        "core:app:allow-version",
        "core:event:allow-emit",
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-close",
        "core:window:allow-internal-toggle-maximize",
        "core:window:allow-is-maximized",
        "core:window:allow-minimize",
        "core:window:allow-start-dragging",
        "core:window:allow-start-resize-dragging",
        "core:window:allow-toggle-maximize",
      ].sort(),
    );
  });

  it("grants only the dialog open/save it actually uses", () => {
    expect(stringPerms).toContain("dialog:allow-open");
    expect(stringPerms).toContain("dialog:allow-save");
  });

  it("covers exactly the app's own windows, which only the backend creates", () => {
    // v1.3.0 (ADR 0017): a tab moved out gets a window labelled `win-N`. The
    // capability names that pattern — never `*` — and the WebView is not given a
    // way to open windows itself: every window comes from `appwin.rs`.
    expect(cap.windows).toEqual(["main", "win-*"]);
    expect(stringPerms.filter((p) => /allow-create/.test(p))).toEqual([]);
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

// v1.25.0: an accepted advisory is a decision about ONE dependency tree. An
// ignore left behind after its advisory cleared (an upstream bump, a withdrawal)
// would silently re-accept it if a later bump regressed the tree back into the
// affected versions — ten withdrawn gtk-rs ids and five cleared unic-* ids sat in
// the list unnoticed. cargo-deny fails on such leftovers only when told to, so
// the gate holds the strict keys in deny.toml. cargo-audit, which never fails on
// one, is gone since 1.25.5 together with its mirror list (ci.guard.test.ts).

/** Lines of a TOML file without `#` comments (no `#` inside our strings). */
function tomlCode(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/#.*$/gm, "");
}

/** The body of one `[section]`, up to the next header. */
function tomlSection(text: string, name: string): string {
  const code = tomlCode(text);
  const start = code.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = code.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** What is wrong with deny.toml's handling of stale exceptions, if anything. */
function staleExceptionProblems(deny: string): string[] {
  const problems: string[] = [];
  if (!/^\s*unused-ignored-advisory\s*=\s*"deny"\s*$/m.test(tomlSection(deny, "advisories")))
    problems.push('[advisories] must set unused-ignored-advisory = "deny"');
  if (!/^\s*unused-allowed-license\s*=\s*"deny"\s*$/m.test(tomlSection(deny, "licenses")))
    problems.push('[licenses] must set unused-allowed-license = "deny"');
  return problems;
}

describe("dependency policy: an exception lives only as long as its advisory", () => {
  const deny = readFileSync(join(ROOT, "src-tauri/deny.toml"), "utf8");

  it("cargo-deny fails on an ignore or a license that matches nothing", () => {
    expect(staleExceptionProblems(deny)).toEqual([]);
  });

  it("catches its own violations", () => {
    // A key commented out or relaxed does not count.
    const relaxed = deny.replace(/unused-ignored-advisory\s*=\s*"deny"/, 'unused-ignored-advisory = "warn"');
    expect(staleExceptionProblems(relaxed)).toHaveLength(1);
    const commented = deny.replace(/^(\s*)unused-allowed-license/m, "$1# unused-allowed-license");
    expect(staleExceptionProblems(commented)).toHaveLength(1);
  });
});
