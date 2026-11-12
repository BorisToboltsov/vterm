// Clipboard helpers, isolated so the terminal/UI never touch a clipboard API
// directly. Reads go through the Rust backend (NSPasteboard on macOS) so we
// avoid `navigator.clipboard.readText()`, which pops WebKit's "Paste" permission
// button in WKWebView; the web API stays only as a fallback for platforms /
// environments where the native command isn't available. Writes use the async
// API (writing never prompts) with a hidden-textarea + execCommand fallback.

import { swallowed } from "../api/diag";
import { readClipboardText } from "../api";
import { hostEnv } from "../stores/hostenv.svelte";
import { writtenByCall } from "../api/call";

export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (e) {
    /* fall through to the legacy path */
    swallowed("app", "the clipboard API did not copy: the old way is tried", e);
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
  } catch (e) {
    /* clipboard unavailable — give up silently */
    swallowed("app", "the text was not copied to the clipboard", e, "warn");
  }
}

export async function readClipboard(): Promise<string> {
  // Native read first: no webview involvement, so no WebKit "Paste" prompt. It
  // exists on macOS only — elsewhere it is not asked, so a paste is no failure.
  const os = await hostEnv.resolve();
  if (os === "" || os === "macos") {
    try {
      return await readClipboardText();
    } catch {
      // Written by call(); the web API is the fallback.
      writtenByCall();
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
