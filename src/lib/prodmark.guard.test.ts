// Production-marking guard: a tab whose server is prod must be marked on the tab
// strip AND around its terminal (a red ring; in the broadcast grid, the tile's
// border), and the frame must stay an inert overlay.
//
// Why a source guard: +page.svelte is the orchestrator and has no component test.
// The failure modes are silent — the mark vanishes from one of the two places (you
// type into prod without the frame), the frame starts swallowing clicks, or it is
// moved onto the terminal element as a real border/padding, which FitAddon would
// measure and the grid would overflow (see termfit.guard). The set of prod tabs
// must come from `prodMembers`, the same predicate the broadcast confirmation uses.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = join(process.cwd(), "src/routes/+page.svelte");

/** Drop `<!-- … -->` blocks by scanning (an unclosed comment drops the rest). */
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

/** Markup/script with HTML and line comments removed, so a comment that merely
 *  names a marker can't satisfy the guard. */
function code(src: string): string {
  return stripHtmlComments(src)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** Check the page source; returns the list of violated rules. */
export function prodMarkViolations(src: string): string[] {
  const c = code(src);
  const out: string[] = [];
  if (!/const prodTabIds = \$derived\([\s\S]{0,200}?prodMembers\(/.test(c)) {
    out.push("prodTabIds must be derived from prodMembers");
  }
  const tab = /<div\s+data-tab[\s\S]*?<\/div>\s*\{\/each\}/.exec(c)?.[0] ?? "";
  if (!/data-prod=\{prodTabIds\.has\(tab\.sessionId\)/.test(tab)) {
    out.push("tab carries no data-prod marker");
  }
  if (!/prodTabIds\.has\(tab\.sessionId\)[\s\S]{0,80}?var\(--color-bad\)/.test(tab)) {
    out.push("tab has no red top strip for prod");
  }
  if (!/\{#if prodTabIds\.has\(tab\.sessionId\)\}\s*<span[^>]*text-bad[^>]*>prod<\/span>/.test(tab)) {
    out.push("tab has no prod chip");
  }
  const frame = /\{#if !bcTile && prodTabIds\.has\(tab\.sessionId\)\}\s*<div([^>]*)>/.exec(c);
  if (!frame) {
    out.push("terminal has no prod frame");
  } else {
    if (!frame[1].includes("pointer-events-none")) out.push("prod frame must not take clicks");
    if (!/ring-bad/.test(frame[1])) out.push("prod frame must be a bad-token ring");
    if (!/\bz-\d/.test(frame[1])) out.push("prod frame needs an explicit z-index");
  }
  if (!/prodTabIds\.has\(tab\.sessionId\) \? "border-bad\/60" : "border-edge"/.test(c)) {
    out.push("broadcast tile border is not red for prod");
  }
  return out;
}

describe("production marking guard", () => {
  const src = readFileSync(PAGE, "utf8");

  it("marks prod tabs on the strip and around the terminal", () => {
    expect(prodMarkViolations(src)).toEqual([]);
  });

  it("catches a dropped frame, a clickable frame and a missing chip", () => {
    expect(
      prodMarkViolations(src.replace("{#if !bcTile && prodTabIds.has(tab.sessionId)}", "{#if false}")),
    ).toContain("terminal has no prod frame");
    expect(
      prodMarkViolations(src.replace("pointer-events-none absolute inset-0 z-20 ring-1", "absolute inset-0 z-20 ring-1")),
    ).toContain("prod frame must not take clicks");
    expect(
      prodMarkViolations(src.replace('text-caption text-bad">prod</span>', 'text-caption text-bad">x</span>')),
    ).toContain("tab has no prod chip");
  });

  it("is not satisfied by a comment that only names the markers", () => {
    const gutted = src.replace(/data-prod=\{prodTabIds\.has\(tab\.sessionId\) \|\| undefined\}/, "<!-- data-prod={prodTabIds.has(tab.sessionId)} -->");
    expect(prodMarkViolations(gutted)).toContain("tab carries no data-prod marker");
  });
});
