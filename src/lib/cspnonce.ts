// CodeMirror injects all of its CSS (baseTheme layout, our theme colours, syntax
// highlighting) at runtime as a single <style> element. Under `tauri build`, Tauri
// stamps a per-load nonce into the CSP `style-src` (`__TAURI_STYLE_NONCE__`), and
// per the CSP spec a nonce voids `'unsafe-inline'` — so CodeMirror's <style>, which
// carries no nonce, is blocked (its `.sheet` is null) and NONE of its styles apply:
// line numbers stack above the code, no gutter column, no syntax colours, a native
// contenteditable focus ring, and the selection collapses the content. `tauri dev`
// is served by Vite without that CSP, so it only broke in release builds.
//
// The fix: read the nonce Tauri stamped on the inline <style> it injected into
// app.html and hand it to CodeMirror via `EditorView.cspNonce` so CodeMirror's own
// <style> carries the matching nonce and is allowed. Thread this through every
// EditorView the app creates (EditorTab, DiffModal); the shared style module is
// created on the first view, so all of them must supply the nonce.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** Pure: first non-empty nonce from a list of element `.nonce` IDL values. */
export function firstNonce(nonces: readonly (string | null | undefined)[]): string {
  for (const n of nonces) if (n) return n;
  return "";
}

/** Read Tauri's style nonce from the inline <style> tags it stamped in app.html.
 *  The `nonce` *content attribute* is hidden after parsing, but the `.nonce` IDL
 *  property still returns the value to same-origin scripts. <style> tags only —
 *  Tauri uses a separate nonce for <script>, which would not match `style-src`.
 *  Empty string in dev (Vite serves the page with no nonce'd CSP) → harmless. */
export function readStyleNonce(): string {
  const styles = Array.from(document.querySelectorAll("style")) as (HTMLStyleElement & {
    nonce?: string;
  })[];
  // `.nonce` IDL is the source of truth in a browser (the attribute is hidden after
  // parsing); fall back to the attribute for environments that only expose it.
  return firstNonce(styles.map((s) => s.nonce || s.getAttribute("nonce")));
}

/** CodeMirror extension that lets its runtime <style> pass the packaged-build CSP. */
export function cspNonceExtension(): Extension {
  return EditorView.cspNonce.of(readStyleNonce());
}
