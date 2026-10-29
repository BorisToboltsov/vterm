// Type-scale guard (Phase 44): font sizes come from the scale
// (`text-caption`/`text-meta`/`text-xs`/`text-sm`/…), never an arbitrary
// `text-[Npx]` literal. The class checks are lint rules now (`vterm/type-scale`,
// `vterm/micro-label` in lint/vterm.js); this file keeps the scale itself.
//
// The reason it is a guard and not a convention: before this phase the UI carried
// 328 hand-written literals across 62 files, and 10px vs 11px was decided fresh at
// every new label — a coin-flip nobody could review, because either value looks
// right on its own. The drift only shows up when two of them sit next to each
// other, which is exactly what happened to the uppercase section rubrics (18 at
// 10px, 11 at 11px, in adjacent panels of the same dock).
//
// The scale deliberately carries no `--text-*--line-height` companions — see the
// note in app.css. That is what let the migration be a pure rename; a guard that
// tempted someone to add leading later would undo it silently.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_CSS = join(process.cwd(), "src", "app.css");

describe("type scale guard", () => {
  it("defines the scale steps the codebase actually uses", () => {
    const css = readFileSync(APP_CSS, "utf8");
    expect(css).toMatch(/--text-caption:\s*10px/);
    expect(css).toMatch(/--text-meta:\s*11px/);
  });

  it("keeps the scale free of line-height companions (the pure-rename property)", () => {
    const css = readFileSync(APP_CSS, "utf8").replace(/\/\*[^]*?\*\//g, "");
    expect(css).not.toMatch(/--text-caption--line-height\s*:/);
    expect(css).not.toMatch(/--text-meta--line-height\s*:/);
  });
});
