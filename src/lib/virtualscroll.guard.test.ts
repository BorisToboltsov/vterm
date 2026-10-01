// Virtual-list scroll guard: every component that windows a list with
// `windowRange` turns Chromium's scroll anchoring off on its scroller.
// The window swaps the rows above the view as it scrolls; WebView2 (Chromium)
// then "keeps the anchor row in place" by adjusting scrollTop itself, and a
// touchpad fling on Windows jerked back and forth. WebKit (macOS) has no scroll
// anchoring, so the defect is invisible where it is developed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function svelteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(full);
  }
  return acc;
}

/** Drop `<!-- … -->` blocks by scanning — a one-pass regex replace can leave a
 *  `<!--` behind (`<!--<!-- -->`); an unclosed comment drops the rest. */
function stripHtmlComments(src: string): string {
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

const code = (s: string) => stripHtmlComments(s).replace(/^\s*\/\/.*$/gm, "");

/** A windowed list without `overflow-anchor: none` anywhere in its markup. */
export function missesAnchorOff(src: string): boolean {
  const c = code(src);
  return /\bwindowRange\s*\(/.test(c) && !/overflow-anchor:\s*none/.test(c);
}

describe("virtual-list scroll guard", () => {
  it("every windowed list disables scroll anchoring", () => {
    const users = svelteFiles(SRC).filter((f) => /\bwindowRange\s*\(/.test(readFileSync(f, "utf8")));
    expect(users.length).toBeGreaterThan(0);
    const offenders = users
      .filter((f) => missesAnchorOff(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders, `add [overflow-anchor:none] to the scroller:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("a comment mentioning it does not count", () => {
    const bad = `<script>const w = windowRange(0, 1, 1, 1);</script>\n<!-- overflow-anchor: none -->\n<div class="overflow-auto"></div>`;
    expect(missesAnchorOff(bad)).toBe(true);
    expect(missesAnchorOff(bad.replace('class="overflow-auto"', 'class="overflow-auto [overflow-anchor:none]"'))).toBe(false);
  });
});
