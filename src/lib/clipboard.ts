// Clipboard helpers, isolated so the terminal/UI never touch a clipboard API
// directly. Reads go through the Rust backend (NSPasteboard on macOS) so we
// avoid `navigator.clipboard.readText()`, which pops WebKit's "Paste" permission
// button in WKWebView; the web API stays only as a fallback for platforms /
// environments where the native command isn't available. Writes use the async
// API (writing never prompts) with a hidden-textarea + execCommand fallback.

import { readClipboardText } from "./api";

export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    /* clipboard unavailable — give up silently */
  }
}

export async function readClipboard(): Promise<string> {
  // Native read first: no webview involvement, so no WebKit "Paste" prompt.
  try {
    return await readClipboardText();
  } catch {
    /* no native reader (non-macOS / non-Tauri) — fall back to the web API */
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
