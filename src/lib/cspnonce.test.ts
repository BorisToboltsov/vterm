// CSP-nonce fix for CodeMirror under `tauri build`. Tauri stamps a per-load nonce
// into the CSP `style-src`, which voids `'unsafe-inline'` and blocks CodeMirror's
// runtime <style> — so nothing it injects (layout, theme colours, syntax) applies.
// The fix threads Tauri's style nonce into CodeMirror via `EditorView.cspNonce`.
// This also guards that both editors keep supplying the nonce (the base style
// module is created on the first EditorView, so all of them must provide it).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { firstNonce, readStyleNonce, cspNonceExtension } from "./cspnonce";

describe("firstNonce", () => {
  it("returns the first non-empty nonce, skipping empty/nullish", () => {
    expect(firstNonce(["", null, undefined, "abc", "def"])).toBe("abc");
  });
  it("returns '' when there is no nonce", () => {
    expect(firstNonce([])).toBe("");
    expect(firstNonce(["", null, undefined])).toBe("");
  });
});

describe("readStyleNonce", () => {
  afterEach(() => {
    document.head.querySelectorAll("style").forEach((s) => s.remove());
  });

  it("reads the nonce Tauri stamped on an inline <style>", () => {
    const s = document.createElement("style");
    s.setAttribute("nonce", "tauri-nonce-123");
    document.head.appendChild(s);
    expect(readStyleNonce()).toBe("tauri-nonce-123");
  });

  it("is empty when no <style> carries a nonce (dev / Vite-served page)", () => {
    const s = document.createElement("style");
    s.textContent = ".x{color:red}";
    document.head.appendChild(s);
    expect(readStyleNonce()).toBe("");
  });
});

describe("cspNonceExtension", () => {
  it("produces a CodeMirror extension (EditorView.cspNonce facet value)", () => {
    // Truthy, non-throwing — the facet .of() result is an Extension object/array.
    expect(cspNonceExtension()).toBeTruthy();
  });
});

describe("editors thread the nonce through (regression guard)", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), "src", "lib", f), "utf8");
  for (const file of ["EditorTab.svelte", "DiffModal.svelte"]) {
    it(`${file} adds cspNonceExtension() to its CodeMirror extensions`, () => {
      const src = read(file);
      expect(src, `${file} must import cspNonceExtension`).toMatch(
        /import\s*\{[^}]*cspNonceExtension[^}]*\}\s*from\s*"\.\/cspnonce"/,
      );
      expect(src, `${file} must call cspNonceExtension() in its extensions`).toMatch(
        /cspNonceExtension\(\)/,
      );
    });
  }
});
