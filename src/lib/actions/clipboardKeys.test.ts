import { afterEach, describe, expect, it, vi } from "vitest";

// The handler talks to the clipboard only through these helpers; mock them so the
// tests stay free of Tauri `invoke` / navigator.clipboard wiring.
const readClipboard = vi.fn<() => Promise<string>>();
const writeClipboard = vi.fn<(t: string) => Promise<void>>();
vi.mock("../clipboard", () => ({
  readClipboard: () => readClipboard(),
  writeClipboard: (t: string) => writeClipboard(t),
}));

import {
  handleClipboardShortcut,
  isEditable,
  replaceSelection,
  selectedText,
} from "./clipboardKeys";

function makeInput(value = "", start = value.length, end = start, type = "text") {
  const node = document.createElement("input");
  node.type = type;
  node.value = value;
  document.body.appendChild(node);
  try {
    node.setSelectionRange(start, end);
  } catch {
    /* type without selection support (e.g. number) */
  }
  return node;
}

function keyEvent(node: EventTarget, key: string, mods: Partial<KeyboardEvent> = {}) {
  const ev = new KeyboardEvent("keydown", { key, cancelable: true, ...mods });
  Object.defineProperty(ev, "target", { value: node, configurable: true });
  return ev;
}

afterEach(() => {
  document.body.innerHTML = "";
  readClipboard.mockReset();
  writeClipboard.mockReset();
});

describe("isEditable", () => {
  it("accepts text-like inputs and textareas", () => {
    expect(isEditable(makeInput("", 0, 0, "text"))).toBe(true);
    expect(isEditable(makeInput("", 0, 0, "number"))).toBe(true);
    expect(isEditable(makeInput("", 0, 0, "password"))).toBe(true);
    expect(isEditable(document.createElement("textarea"))).toBe(true);
  });
  it("rejects non-text inputs and non-inputs", () => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    expect(isEditable(cb)).toBe(false);
    expect(isEditable(document.createElement("div"))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
  it("rejects readonly/disabled inputs", () => {
    const ro = makeInput("x");
    ro.readOnly = true;
    expect(isEditable(ro)).toBe(false);
    const dis = makeInput("x");
    dis.disabled = true;
    expect(isEditable(dis)).toBe(false);
  });
  it("rejects xterm's internal helper textarea", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    expect(isEditable(ta)).toBe(false);
  });
});

describe("selectedText / replaceSelection", () => {
  it("returns the highlighted slice", () => {
    expect(selectedText(makeInput("hello", 1, 4))).toBe("ell");
  });
  it("inserts at the caret and fires input", () => {
    const node = makeInput("ac", 1, 1);
    const input = vi.fn();
    node.addEventListener("input", input);
    replaceSelection(node, "b");
    expect(node.value).toBe("abc");
    expect(input).toHaveBeenCalledOnce();
  });
  it("replaces the whole value when no selection range (number input)", () => {
    const node = makeInput("80", 0, 0, "number");
    replaceSelection(node, "8080");
    expect(node.value).toBe("8080");
  });
});

describe("handleClipboardShortcut", () => {
  it("pastes into a focused text input on Cmd+V", async () => {
    readClipboard.mockResolvedValue("pw");
    const node = makeInput("");
    await handleClipboardShortcut(keyEvent(node, "v", { metaKey: true }));
    expect(node.value).toBe("pw");
  });

  it("pastes on Ctrl+V too (and into a number field)", async () => {
    readClipboard.mockResolvedValue("8080");
    const node = makeInput("", 0, 0, "number");
    await handleClipboardShortcut(keyEvent(node, "v", { ctrlKey: true }));
    expect(node.value).toBe("8080");
  });

  it("copies the selection on Cmd+C", async () => {
    const node = makeInput("hello", 0, 3);
    await handleClipboardShortcut(keyEvent(node, "c", { metaKey: true }));
    expect(writeClipboard).toHaveBeenCalledWith("hel");
  });

  it("cuts the selection on Cmd+X", async () => {
    const node = makeInput("hello", 0, 3);
    await handleClipboardShortcut(keyEvent(node, "x", { metaKey: true }));
    expect(writeClipboard).toHaveBeenCalledWith("hel");
    expect(node.value).toBe("lo");
  });

  it("selects all on Cmd+A", async () => {
    const node = makeInput("hello", 5, 5);
    await handleClipboardShortcut(keyEvent(node, "a", { metaKey: true }));
    expect(node.selectionStart).toBe(0);
    expect(node.selectionEnd).toBe(5);
  });

  it("ignores non-editable targets (e.g. the terminal)", async () => {
    readClipboard.mockResolvedValue("nope");
    const div = document.createElement("div");
    await handleClipboardShortcut(keyEvent(div, "v", { metaKey: true }));
    expect(readClipboard).not.toHaveBeenCalled();
  });

  it("ignores plain keys and Alt/Shift-modified chords", async () => {
    readClipboard.mockResolvedValue("nope");
    const node = makeInput("x");
    await handleClipboardShortcut(keyEvent(node, "v"));
    await handleClipboardShortcut(keyEvent(node, "v", { metaKey: true, altKey: true }));
    await handleClipboardShortcut(keyEvent(node, "v", { metaKey: true, shiftKey: true }));
    expect(readClipboard).not.toHaveBeenCalled();
    expect(node.value).toBe("x");
  });
});
