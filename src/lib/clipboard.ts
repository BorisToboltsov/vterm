// Clipboard helpers, isolated so the backing implementation can be swapped
// (e.g. for tauri-plugin-clipboard-manager) without touching the terminal code.
// In the WebView, navigator.clipboard works for the focused document; a hidden
// textarea + execCommand covers the copy path when the async API is unavailable.

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
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
