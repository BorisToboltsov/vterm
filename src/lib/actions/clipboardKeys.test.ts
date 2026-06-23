import { afterEach, describe, expect, it, vi } from "vitest";

// The action talks to the clipboard only through these helpers; mock them so the
// tests stay free of Tauri `invoke` / navigator.clipboard wiring.
const readClipboard = vi.fn<() => Promise<string>>();
const writeClipboard = vi.fn<(t: string) => Promise<void>>();
vi.mock("../clipboard", () => ({
  readClipboard: () => readClipboard(),
  writeClipboard: (t: string) => writeClipboard(t),
}));

import { clipboardKeys, replaceSelection, selectedText } from "./clipboardKeys";

function makeInput(value = "", start = value.length, end = start): HTMLInputElement {
  const node = document.createElement("input");
  node.value = value;
  document.body.appendChild(node);
  node.setSelectionRange(start, end);
  return node;
}

function press(node: HTMLElement, key: string, mods: Partial<KeyboardEvent> = {}) {
  node.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...mods }));
}

afterEach(() => {
  document.body.innerHTML = "";
  readClipboard.mockReset();
  writeClipboard.mockReset();
});

describe("selectedText", () => {
  it("returns the highlighted slice", () => {
    expect(selectedText(makeInput("hello", 1, 4))).toBe("ell");
  });
  it("is empty with no selection", () => {
    expect(selectedText(makeInput("hello"))).toBe("");
  });
});

describe("replaceSelection", () => {
  it("inserts at the caret and fires input", () => {
    const node = makeInput("ac", 1, 1);
    const input = vi.fn();
    node.addEventListener("input", input);
    replaceSelection(node, "b");
    expect(node.value).toBe("abc");
    expect(node.selectionStart).toBe(2);
    expect(input).toHaveBeenCalledOnce();
  });
  it("replaces the current selection", () => {
    const node = makeInput("abc", 1, 2);
    replaceSelection(node, "XY");
    expect(node.value).toBe("aXYc");
    expect(node.selectionStart).toBe(3);
  });
});

describe("clipboardKeys action", () => {
  it("pastes clipboard text on Cmd+V", async () => {
    readClipboard.mockResolvedValue("secret");
    const node = makeInput("");
    clipboardKeys(node);
    press(node, "v", { metaKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(node.value).toBe("secret");
  });

  it("pastes on Ctrl+V too", async () => {
    readClipboard.mockResolvedValue("pw");
    const node = makeInput("");
    clipboardKeys(node);
    press(node, "v", { ctrlKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(node.value).toBe("pw");
  });

  it("copies the selection on Cmd+C", () => {
    const node = makeInput("hello", 0, 3);
    clipboardKeys(node);
    press(node, "c", { metaKey: true });
    expect(writeClipboard).toHaveBeenCalledWith("hel");
  });

  it("cuts the selection on Cmd+X", () => {
    const node = makeInput("hello", 0, 3);
    clipboardKeys(node);
    press(node, "x", { metaKey: true });
    expect(writeClipboard).toHaveBeenCalledWith("hel");
    expect(node.value).toBe("lo");
  });

  it("selects all on Cmd+A", () => {
    const node = makeInput("hello", 5, 5);
    clipboardKeys(node);
    press(node, "a", { metaKey: true });
    expect(node.selectionStart).toBe(0);
    expect(node.selectionEnd).toBe(5);
  });

  it("ignores plain keys and Alt/Shift-modified chords", async () => {
    const node = makeInput("x");
    clipboardKeys(node);
    press(node, "v"); // no modifier
    press(node, "v", { metaKey: true, altKey: true });
    press(node, "v", { metaKey: true, shiftKey: true });
    await Promise.resolve();
    expect(readClipboard).not.toHaveBeenCalled();
    expect(node.value).toBe("x");
  });

  it("stops listening after destroy", async () => {
    const node = makeInput("");
    const handle = clipboardKeys(node);
    handle.destroy();
    press(node, "v", { metaKey: true });
    await Promise.resolve();
    expect(readClipboard).not.toHaveBeenCalled();
  });
});
