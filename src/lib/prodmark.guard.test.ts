// Production-marking guard: a tab whose server is prod must be marked on the tab
// strip AND around its terminal (a red ring), and the frame must stay an inert
// overlay. (Until v1.9 the synchronous-input grid drew tiles of its own with a
// red border; its members stand in ordinary panes now and carry the same ring.) On the strip the mark is the
// `prod` chip; the top line belongs to the ACTIVE tab only (v1.0.42) — accent, or
// red when that tab is prod — because a red line on every prod tab read as
// "active" (tabstrip.ts).
//
// A file is shown inside its connection (v1.11, ADR 0024). A file of a prod
// server is edited on prod — saving it is an action there — so the frame goes
// around the whole connection, its files included, not around the terminal
// alone; and the view in focus inside it carries the thin strip in the same
// colour as the tab above.
//
// That strip and the frame's top edge were the same pixels in the same red: with
// a file open on prod, nobody could tell which view was in focus. So the frame
// begins under the top row of view strips whenever the connection has one
// (v1.11.3) — the views' bodies, the file's text among them, stay inside it.
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

/** The `{#…}` blocks open at `offset` in a stretch of markup, outermost first. */
function openBlocks(markup: string, offset: number): string[] {
  const stack: string[] = [];
  for (const m of markup.slice(0, offset).matchAll(/\{([#/])(\w+)([^}]*)\}/g)) {
    if (m[1] === "#") stack.push(`#${m[2]}${m[3]}`.trim());
    else stack.pop();
  }
  return stack;
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
  if (!/tabsState\.activeId ===\s*tab\.sessionId\s*\?\s*`[^`]*\$\{activeTabStrip\(prodTabIds\.has\(tab\.sessionId\), 2\)\}`/.test(tab)) {
    out.push("the active tab has no top strip (accent, red for prod)");
  }
  if (/var\(--color-bad\)/.test(tab)) {
    out.push("tab strip is drawn outside activeTabStrip — an inactive prod tab would look active");
  }
  if (!/\{#if prodTabIds\.has\(tab\.sessionId\)\}\s*<span[^>]*text-bad[^>]*>prod<\/span>/.test(tab)) {
    out.push("tab has no prod chip");
  }
  // The frame: one, around the whole connection. `prod` is this connection's.
  if (!/\{@const prod = prodTabIds\.has\(tab\.sessionId\)\}/.test(c)) {
    out.push("the connection's prod flag is not read from prodTabIds");
  }
  const frame = /\{#if prod\}\s*<div([^>]*)>/.exec(c);
  if (!frame) {
    out.push("terminal has no prod frame");
  } else {
    if (!frame[1].includes("pointer-events-none")) out.push("prod frame must not take clicks");
    if (!/ring-bad/.test(frame[1])) out.push("prod frame must be a bad-token ring");
    if (!/\bz-\d/.test(frame[1])) out.push("prod frame needs an explicit z-index");
    // Not over the strip of views: its top edge would be the line that marks
    // the view in focus.
    if (/\binset-0\b|\btop-0\b|\binset-y-0\b/.test(frame[1]) || !frame[1].includes('style="top: {hasFiles ? VIEW_STRIP : 0}px"')) {
      out.push("prod frame lies over the strip of views — the view in focus cannot be told");
    }
    // Around the files too: it is drawn after the connection's editors, as a
    // child of the connection's own box — not inside the terminal's, and not
    // only while some condition on the zones holds.
    const lastEditor = c.lastIndexOf("<EditorTab");
    const blocks = openBlocks(c.slice(c.lastIndexOf("</script>")), frame.index - c.lastIndexOf("</script>"));
    if (
      lastEditor < 0 ||
      frame.index < lastEditor ||
      blocks.join(" | ") !==
        ["#if tabsState.list.length > 0", "#each tabsState.list as tab (tab.sessionId)"].join(" | ")
    ) {
      out.push("a file of a prod server is edited outside the prod frame");
    }
  }
  // The view in focus inside a prod connection is marked in the same colour.
  if (!/\$\{activeTabStrip\(prod, 1\)\}/.test(c)) {
    out.push("the view in focus inside a connection has no strip (accent, red for prod)");
  }
  return out;
}

describe("production marking guard", () => {
  const src = readFileSync(PAGE, "utf8");

  it("marks prod tabs on the strip and around the terminal", () => {
    expect(prodMarkViolations(src)).toEqual([]);
  });

  it("catches a dropped frame, a clickable frame and a missing chip", () => {
    expect(prodMarkViolations(src.replace(/\{#if prod\}(\s*<!-- Prod frame)/, "{#if false}$1"))).toContain(
      "terminal has no prod frame",
    );
    expect(
      prodMarkViolations(src.replace("pointer-events-none absolute inset-x-0 bottom-0 z-20 ring-1", "absolute inset-x-0 bottom-0 z-20 ring-1")),
    ).toContain("prod frame must not take clicks");
    expect(
      prodMarkViolations(src.replace('text-caption text-bad">prod</span>', 'text-caption text-bad">x</span>')),
    ).toContain("tab has no prod chip");
    // The old always-on red line on every prod tab, put back.
    const always = src
      .replace(
        "? `bg-panel text-text ${activeTabStrip(prodTabIds.has(tab.sessionId), 2)}`",
        "? 'bg-panel text-text'",
      )
      .replace(
        "data-tab={tab.sessionId}\n",
        "data-tab={tab.sessionId}\n            class:shadow-[inset_0_2px_0_0_var(--color-bad)]={prodTabIds.has(tab.sessionId)}\n",
      );
    expect(always).not.toBe(src);
    expect(prodMarkViolations(always)).toEqual(
      expect.arrayContaining([
        "the active tab has no top strip (accent, red for prod)",
        "tab strip is drawn outside activeTabStrip — an inactive prod tab would look active",
      ]),
    );
  });

  it("catches a frame that leaves the files of a prod server outside it", () => {
    // Moved into the terminal's own box: the editors come after it.
    const frame = /\n *\{#if prod\}\s*<!-- Prod frame[\s\S]*?\{\/if\}\n/.exec(src)?.[0] ?? "";
    expect(frame).not.toBe("");
    const inside = src
      .replace(frame, "\n")
      .replace("                <!-- The connection's files: one flat keyed list", `${frame}                <!-- The connection's files: one flat keyed list`);
    expect(inside).not.toBe(src);
    expect(prodMarkViolations(inside)).toEqual(["a file of a prod server is edited outside the prod frame"]);
    // Drawn only while the connection has files: a bare prod terminal loses it.
    const conditional = src.replace(frame, `\n{#if hasFiles}${frame}{/if}\n`);
    expect(prodMarkViolations(conditional)).toEqual([
      "a file of a prod server is edited outside the prod frame",
    ]);
    // The view in focus marked with the accent whatever the server.
    expect(
      prodMarkViolations(src.replace("${activeTabStrip(prod, 1)}", "${activeTabStrip(false, 1)}")),
    ).toEqual(["the view in focus inside a connection has no strip (accent, red for prod)"]);
  });

  it("catches a frame laid back over the strip of views", () => {
    // As it was until v1.11.3: the whole connection, strips included.
    const whole = src
      .replace("absolute inset-x-0 bottom-0 z-20 ring-1", "absolute inset-0 z-20 ring-1")
      .replace('                    style="top: {hasFiles ? VIEW_STRIP : 0}px"\n', "");
    expect(whole).not.toBe(src);
    expect(prodMarkViolations(whole)).toEqual([
      "prod frame lies over the strip of views — the view in focus cannot be told",
    ]);
    // The offset dropped, the classes kept: the frame starts at the top again.
    const noOffset = src.replace('                    style="top: {hasFiles ? VIEW_STRIP : 0}px"\n', "");
    expect(noOffset).not.toBe(src);
    expect(prodMarkViolations(noOffset)).toEqual([
      "prod frame lies over the strip of views — the view in focus cannot be told",
    ]);
    // An offset that is always there would cut the frame of a bare terminal.
    const always = src.replace("top: {hasFiles ? VIEW_STRIP : 0}px", "top: {VIEW_STRIP}px");
    expect(prodMarkViolations(always)).toEqual([
      "prod frame lies over the strip of views — the view in focus cannot be told",
    ]);
  });

  it("is not satisfied by a comment that only names the markers", () => {
    const gutted = src.replace(/data-prod=\{prodTabIds\.has\(tab\.sessionId\) \|\| undefined\}/, "<!-- data-prod={prodTabIds.has(tab.sessionId)} -->");
    expect(prodMarkViolations(gutted)).toContain("tab carries no data-prod marker");
  });
});
