// Clipboard keyboard shortcuts for text fields: Cmd/Ctrl + V / C / X / A.
//
// The app ships without a native Edit menu on purpose (so the terminal keeps
// ⌘C/⌘V for itself — see build_app_menu in src-tauri/src/lib.rs). The side effect
// is that WKWebView on macOS provides no Paste/Copy accelerators for ordinary
// HTML inputs, so ⌘V etc. do nothing in any <input>/<textarea>. Rather than wire
// every field individually (and forget new ones), a single global handler —
// installed once on the document — covers them all. Reads go through the native
// backend clipboard, so no WebKit "Paste" permission prompt appears (clipboard.ts).

import { readClipboard, writeClipboard } from "../clipboard";

type Editable = HTMLInputElement | HTMLTextAreaElement;

// <input> types that behave as editable text and benefit from these shortcuts
// (covers the server form's host/port/username, folder names, search, etc.).
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "",
]);

/** Is the event target a writable text input/textarea we should handle? */
export function isEditable(target: EventTarget | null): target is Editable {
  // Leave xterm.js's internal helper textarea alone — the terminal handles its
  // own clipboard shortcuts (and pasting into it would break that).
  if ((target as Element | null)?.closest?.(".xterm")) return false;
  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLInputElement) {
    return !target.readOnly && !target.disabled && TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

/** Current [start, end] selection, or null when the field doesn't expose one
 *  (e.g. `<input type="number">`, whose selection API is unavailable). */
function selectionRange(node: Editable): [number, number] | null {
  try {
    const start = node.selectionStart;
    const end = node.selectionEnd;
    if (start == null || end == null) return null;
    return [start, end];
  } catch {
    return null;
  }
}

/** Text currently selected inside the field (empty when none/unsupported). */
export function selectedText(node: Editable): string {
  const range = selectionRange(node);
  return range ? node.value.slice(range[0], range[1]) : "";
}

/** Replace the current selection — or the whole value, when no selection range
 *  is available — with `text`, then fire `input` so `bind:value` updates. */
export function replaceSelection(node: Editable, text: string): void {
  const range = selectionRange(node);
  if (range) {
    const [start, end] = range;
    node.value = node.value.slice(0, start) + text + node.value.slice(end);
    const caret = start + text.length;
    try {
      node.setSelectionRange(caret, caret);
    } catch {
      /* selection not supported (e.g. number input) — value is still set */
    }
  } else {
    node.value = text;
  }
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Element the current DOM selection is anchored in, or null when nothing is
 *  selected (collapsed range). Used to route a plain-text Cmd/Ctrl+C. */
function selectionHost(): Element | null {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const node = sel.focusNode ?? sel.anchorNode;
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

/**
 * Copy a plain page-text selection that lives outside any `<input>`/`<textarea>`
 * — the rendered markdown preview, help text, etc. Without a native Edit menu
 * WKWebView gives these no Copy accelerator, so Cmd/Ctrl+C is dead otherwise.
 * CodeMirror and xterm own their own clipboard shortcuts, so selections inside
 * them are left alone. Returns true when it handled the copy.
 */
export function copyDocumentSelection(): boolean {
  const host = selectionHost();
  if (!host || host.closest(".xterm") || host.closest(".cm-editor")) return false;
  const text = window.getSelection?.()?.toString() ?? "";
  if (!text) return false;
  void writeClipboard(text);
  return true;
}

/**
 * Global keydown handler implementing Cmd/Ctrl + V / C / X / A for any focused
 * text input. Install once on the document (capture phase recommended). It is a
 * no-op for non-editable targets — except Cmd/Ctrl+C over a plain-text selection
 * (e.g. the markdown preview), which is copied via the native backend clipboard.
 * The terminal, tabs and page shortcuts are otherwise untouched. Plain combos
 * only — Alt/Shift-modified chords keep their meaning.
 */
export async function handleClipboardShortcut(ev: KeyboardEvent): Promise<void> {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
  const node = ev.target;
  if (!isEditable(node)) {
    if (ev.key.toLowerCase() === "c" && copyDocumentSelection()) ev.preventDefault();
    return;
  }
  switch (ev.key.toLowerCase()) {
    case "v": {
      ev.preventDefault();
      const text = await readClipboard();
      if (text) replaceSelection(node, text);
      break;
    }
    case "c": {
      const sel = selectedText(node);
      if (sel) {
        ev.preventDefault();
        writeClipboard(sel);
      }
      break;
    }
    case "x": {
      const sel = selectedText(node);
      if (sel) {
        ev.preventDefault();
        writeClipboard(sel);
        replaceSelection(node, "");
      }
      break;
    }
    case "a": {
      ev.preventDefault();
      node.select();
      break;
    }
  }
}
