import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOW_MIN_WIDTH } from "./docklayout";

// The centre column keeps its minimum beside the docks (v1.23). Squeezing the
// window used to leave the terminal ~100px wide: the side docks held their
// stored widths, and the window had no minimum. Now the docks give width back
// (`sideDockWidths`) and every window is no narrower than both docks at their
// minimum plus the centre (`WINDOW_MIN_WIDTH`). The number lives in three places
// — the model, tauri.conf.json (main window) and appwin.rs (windows a tab is
// carried into) — and this keeps them equal. Each check is a function over the
// source with comments stripped, and shows it catches its own violation.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const stripRust = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");
const stripJs = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The main window's `minWidth` in tauri.conf.json, or null without one. */
export function confMinWidth(conf: string): number | null {
  const main = JSON.parse(conf).app?.windows?.[0];
  return typeof main?.minWidth === "number" ? main.minWidth : null;
}

/** appwin.rs: the constant, and the window builder applying it. */
export function builderViolations(appwin: string, expected: number): string[] {
  const src = stripRust(appwin);
  const out: string[] = [];
  const value = src.match(/const WINDOW_MIN_WIDTH: f64 = ([\d.]+);/)?.[1];
  if (value === undefined || Number(value) !== expected) {
    out.push(`appwin.rs WINDOW_MIN_WIDTH is ${value ?? "missing"}, not ${expected}`);
  }
  const build = src.slice(src.indexOf("fn build_window("), src.indexOf("builder.build()"));
  if (!/\.min_inner_size\(WINDOW_MIN_WIDTH,/.test(build)) {
    out.push("a window carried a tab is built without the minimum width");
  }
  return out;
}

/** Dock.svelte draws a side dock at its fitted width, not its stored one, and a
 *  drag stops where the centre would get narrower than its minimum. */
export function dockViolations(dock: string): string[] {
  const src = stripJs(dock);
  const out: string[] = [];
  if (!/sideDockWidths\(sideState\("left"\), sideState\("right"\), innerWidth\)/.test(src)) {
    out.push("the side docks are not fitted to the window");
  }
  if (!/side === "bottom" \? effectiveSize\(side, dock\.size, innerHeight\) : sides\[side\]/.test(src)) {
    out.push("a side dock is drawn at its stored width");
  }
  if (!/sideDockRoom\(other, innerWidth\)/.test(src)) {
    out.push("dragging a side dock does not stop at the centre's minimum");
  }
  return out;
}

describe("window minimum width guard", () => {
  it("tauri.conf.json gives the main window the minimum width", () => {
    expect(confMinWidth(read("src-tauri/tauri.conf.json"))).toBe(WINDOW_MIN_WIDTH);
    expect(confMinWidth('{"app":{"windows":[{"width":1100}]}}')).toBeNull();
  });

  it("a window a tab is carried into gets the same minimum", () => {
    const appwin = read("src-tauri/src/appwin.rs");
    expect(builderViolations(appwin, WINDOW_MIN_WIDTH)).toEqual([]);
    const broken = appwin
      .replace(".min_inner_size(WINDOW_MIN_WIDTH, 0.0)", "")
      .replace("const WINDOW_MIN_WIDTH: f64 = 640.0;", "const WINDOW_MIN_WIDTH: f64 = 600.0;");
    expect(builderViolations(broken, WINDOW_MIN_WIDTH)).toEqual([
      `appwin.rs WINDOW_MIN_WIDTH is 600.0, not ${WINDOW_MIN_WIDTH}`,
      "a window carried a tab is built without the minimum width",
    ]);
  });

  it("the side docks give way to the centre", () => {
    const dock = read("src/lib/layout/Dock.svelte");
    expect(dockViolations(dock)).toEqual([]);
    const broken = dock
      .replace(": sides[side],", ": dock.size,")
      .replace("sideDockRoom(other, innerWidth)", "Infinity");
    expect(dockViolations(broken)).toEqual([
      "a side dock is drawn at its stored width",
      "dragging a side dock does not stop at the centre's minimum",
    ]);
  });
});
