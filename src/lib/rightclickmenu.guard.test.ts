// Right-click terminal menu guard (fix 1.0.7): the terminal context menu
// (copy/paste/clear/…) is ALWAYS available on right-click — there is no
// `rightClickMenu` opt-out setting anymore (the native WebView menu stays
// suppressed globally regardless). This guard fails if the setting creeps back
// — a re-added field/checkbox/i18n key — or if the terminal handler is re-gated
// behind an early `return` before it opens the menu.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(process.cwd(), "src", "lib");
const read = (rel: string) => readFileSync(join(LIB, rel), "utf8");

describe("right-click menu guard", () => {
  it("no shipped source references a rightClickMenu setting", () => {
    const files = [
      "settings.svelte.ts",
      "Terminal.svelte",
      "SettingsPanel.svelte",
      "i18n/messages.ts",
    ];
    const offenders = files.filter((f) => read(f).includes("rightClickMenu"));
    expect(
      offenders,
      `the removed rightClickMenu setting resurfaced in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the terminal right-click handler opens the menu unconditionally", () => {
    const src = read("Terminal.svelte");
    const sig = "function onContextMenu(e: MouseEvent) {";
    const start = src.indexOf(sig);
    expect(start, "onContextMenu handler missing").toBeGreaterThan(-1);
    const pd = src.indexOf("e.preventDefault()", start);
    expect(pd, "onContextMenu must preventDefault to open the menu").toBeGreaterThan(-1);
    // Nothing may early-return before the menu is built — that's exactly what the
    // old `if (!settings.rightClickMenu) return;` gate did.
    const between = src.slice(start + sig.length, pd);
    expect(
      between,
      "right-click must not early-return before opening the menu",
    ).not.toContain("return");
  });
});
