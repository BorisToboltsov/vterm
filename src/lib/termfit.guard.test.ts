// Terminal-fit guard: the element xterm is opened into (FitAddon measures it as
// `parentElement`) must carry no padding.
//
// The bug: `px-2 pt-1` sat on that element. FitAddon reads the parent's
// `getComputedStyle(...).height/width`, which under Tailwind's `box-sizing:
// border-box` is the border-box size — padding included. The grid came out up to
// 4px taller than the space it had, and xterm's absolutely positioned canvas
// painted over the status bar's top border (seen on Windows while enlarging the
// window, where fractional scaling makes the remainder land there more often).
// The padding belongs on an outer wrapper.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TERMINAL = join(process.cwd(), "src/lib/Terminal.svelte");

/** Drop `<!-- … -->` blocks by scanning, not by regex replace (an unclosed
 *  comment drops the rest — nothing after it is markup the guard should read). */
export function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("<!--", i);
    if (open < 0) return out + src.slice(i);
    out += src.slice(i, open);
    const close = src.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
  return out;
}

/** The opening tag of the element bound to `container`, or null. */
export function containerTag(src: string): string | null {
  const noComments = stripHtmlComments(src);
  const m = /<div\b[^>]*bind:this=\{container\}[^>]*>/.exec(noComments);
  return m ? m[0] : null;
}

/** Tailwind padding utilities (p-2, px-2, pt-1, py-[3px], …) in a tag's class. */
export function paddingClasses(tag: string): string[] {
  const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
  return cls.split(/\s+/).filter((c) => /^p[xytrbl]?-/.test(c));
}

describe("terminal fit guard", () => {
  it("strips HTML comments, including an unclosed one", () => {
    expect(stripHtmlComments("a<!-- x -->b<!-- y -->c")).toBe("abc");
    expect(stripHtmlComments("a<!--<!-- x -->-->b")).toBe("a-->b");
    expect(stripHtmlComments("a<!-- open")).toBe("a");
  });

  it("detects padding on the measured element", () => {
    expect(paddingClasses(`<div bind:this={container} class="h-full w-full px-2 pt-1">`)).toEqual([
      "px-2",
      "pt-1",
    ]);
    expect(paddingClasses(`<div class="h-full w-full">`)).toEqual([]);
  });

  it("the element FitAddon measures has no padding", () => {
    const tag = containerTag(readFileSync(TERMINAL, "utf8"));
    expect(tag, "Terminal.svelte no longer binds `container` — update this guard").not.toBeNull();
    expect(tag).not.toMatch(/style="[^"]*padding/);
    expect(
      paddingClasses(tag!),
      "padding on xterm's parent is counted as usable space by FitAddon — move it to a wrapper",
    ).toEqual([]);
  });
});
