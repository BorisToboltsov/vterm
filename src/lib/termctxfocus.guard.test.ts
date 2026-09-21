import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Closing the terminal's right-click menu must hand focus back to xterm: the
// menu button took it, and a copy/paste from the menu otherwise left the next
// keystrokes going nowhere. Checked on the source with comments stripped, so a
// comment mentioning `term?.focus()` can't satisfy it.
const src = readFileSync(resolve(__dirname, "Terminal.svelte"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("terminal context menu focus", () => {
  it("refocuses the terminal when the menu closes", () => {
    const m = src.match(/<ContextMenu\b[\s\S]*?\/>/);
    expect(m, "ContextMenu not found in Terminal.svelte").not.toBeNull();
    const onclose = m![0].match(/onclose=\{([\s\S]*?)\}\s*\/>/);
    expect(onclose).not.toBeNull();
    expect(onclose![1]).toMatch(/term\??\.focus\(\)/);
  });
});
