// Clipboard shortcuts for plain <input>/<textarea> fields.
//
// The app ships without a native Edit menu on purpose (see `build_app_menu` in
// src-tauri/src/lib.rs) so the terminal keeps ⌘C/⌘V for itself. The side effect
// is that WKWebView on macOS has no Paste accelerator for ordinary HTML inputs,
// so ⌘V / Ctrl+V do nothing in fields like the password prompt — only the
// right-click context menu works. This action restores the standard editing
// shortcuts in JS, mirroring how Terminal.svelte handles the same keys via the
// shared clipboard helper.

import { readClipboard, writeClipboard } from "../clipboard";

type Editable = HTMLInputElement | HTMLTextAreaElement;

/** Text currently selected inside the field (empty string if none). */
export function selectedText(node: Editable): string {
  const start = node.selectionStart ?? 0;
  const end = node.selectionEnd ?? 0;
  return node.value.slice(start, end);
}

/** Replace the current selection with `text` and fire `input` for `bind:value`. */
export function replaceSelection(node: Editable, text: string): void {
  const start = node.selectionStart ?? node.value.length;
  const end = node.selectionEnd ?? node.value.length;
  node.value = node.value.slice(0, start) + text + node.value.slice(end);
  const caret = start + text.length;
  node.setSelectionRange(caret, caret);
  // Notify Svelte's `bind:value` (and any input listeners) of the change.
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Svelte action: handle Cmd/Ctrl + V / C / X / A on a text field.
 *
 * Plain Ctrl/Cmd combos only — Alt-modified or Shift-modified chords are left
 * untouched so they keep their browser/OS meaning.
 */
export function clipboardKeys(node: Editable) {
  async function onKeydown(ev: Event) {
    const e = ev as KeyboardEvent;
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    switch (e.key.toLowerCase()) {
      case "v": {
        e.preventDefault();
        // readClipboard() reads natively via the Rust backend, so no WebKit
        // "Paste" prompt appears (see clipboard.ts).
        const text = await readClipboard();
        if (text) replaceSelection(node, text);
        break;
      }
      case "c": {
        const sel = selectedText(node);
        if (sel) {
          e.preventDefault();
          writeClipboard(sel);
        }
        break;
      }
      case "x": {
        const sel = selectedText(node);
        if (sel) {
          e.preventDefault();
          writeClipboard(sel);
          replaceSelection(node, "");
        }
        break;
      }
      case "a": {
        e.preventDefault();
        node.select();
        break;
      }
    }
  }

  node.addEventListener("keydown", onKeydown);
  return {
    destroy() {
      node.removeEventListener("keydown", onKeydown);
    },
  };
}
