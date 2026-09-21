// Right-click terminal menu guard (fix 1.0.7, reworked 1.0.26): the terminal
// context menu (copy/paste/select all/…) must stay reachable. 1.0.7 removed a
// `rightClickMenu` opt-out that could switch it off entirely; 1.0.26 made plain
// right-click paste by default (`settings.rightClick`), and Shift+right-click
// always gives the other action — so under every setting one of the two gestures
// opens the menu. This guard fails if the old opt-out creeps back, if the handler
// stops asking `rightClickEffect`, or if some setting leaves no gesture for it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RIGHT_CLICK_ACTIONS, rightClickEffect } from "./termmouse";

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
    const offenders = files.filter((f) => /\brightClickMenu\b/.test(read(f)));
    expect(
      offenders,
      `the removed rightClickMenu setting resurfaced in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every setting leaves a gesture that opens the menu", () => {
    for (const setting of RIGHT_CLICK_ACTIONS) {
      const reachable = [false, true].some(
        (shift) =>
          rightClickEffect({ setting, shift, hasSelection: true, copyOnSelect: false }) === "menu",
      );
      expect(reachable, `no gesture opens the menu with rightClick="${setting}"`).toBe(true);
    }
  });

  it("the terminal right-click handler decides through rightClickEffect", () => {
    const src = read("Terminal.svelte");
    const sig = "function onContextMenu(e: MouseEvent) {";
    const start = src.indexOf(sig);
    expect(start, "onContextMenu handler missing").toBeGreaterThan(-1);
    const menu = src.indexOf("ctxMenu = {", start);
    expect(menu, "onContextMenu must still open the menu").toBeGreaterThan(-1);
    const body = src.slice(start + sig.length, menu);
    expect(body).toContain("e.preventDefault()");
    expect(body).toContain("rightClickEffect(");
    expect(body).toContain("shift: e.shiftKey");
    // The only early exit is the non-menu branch — the old opt-out was a bare
    // `if (!settings.rightClickMenu) return;` at the top.
    expect(body.split("return").length - 1, "one early return, in the paste/copy branch").toBe(1);
    expect(body).toMatch(/if \(effect !== "menu"\) \{[\s\S]*?return;/);
  });
});
