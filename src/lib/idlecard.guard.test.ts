import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The screensaver card's chart has to draw WITHOUT the animation loop.
//
// Under `prefers-reduced-motion` (Windows turns it on with "Animation effects"
// off, common in VMs and RDP) the overlay paints one static frame on activation
// and no rAF loop follows. That frame predates the first metrics sample — the
// fetch is async — so unless every sample repaints, the chart stays an empty
// frame forever. A reactive `$effect` over `cpu`/`mem` looked like it did this,
// but they were plain `let`s: the effect ran once and never again. The same card
// also kept the previous activation's numbers (often another host's) until the
// first sample, so activation must reset them to "unknown" (principle 5).
// And since the canvas mounts only after `active` flips, the very first static
// frame comes from an `$effect` over `active` + the bound canvas.
//
// And it never starts in a window with no tab (v1.11.3): the card had no host to
// show and sat over the empty window, swallowing the first click meant for it.
// One rule decides — `screensaverAllowed` — fed with the window's tab count.
// Checked on the source with comments stripped.

function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    out += text[i++];
  }
  return out;
}

/** A source file with its comments removed. */
function bare(text: string): string {
  return stripHtmlComments(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (...rel: string[]) => readFileSync(join(process.cwd(), "src", ...rel), "utf8");
const src = bare(read("lib", "IdleOverlay.svelte"));

/**
 * What lets the screensaver start without a tab — in the overlay's own source
 * and in the page that mounts it. Empty when the rule holds.
 */
export function noTabViolations(overlay: string, page: string): string[] {
  const o = bare(overlay);
  const out: string[] = [];
  const tick = /setInterval\(\(\) => \{([\s\S]*?)\}, 1000\)/.exec(o)?.[1] ?? "";
  const asks = tick.indexOf("if (!screensaverAllowed(settings.idleEffect, tabs)) return;");
  const starts = tick.indexOf("activate()");
  if (starts < 0) out.push("the idle tick no longer starts the screensaver");
  else if (asks < 0 || asks > starts) out.push("the idle tick starts the screensaver without asking the rule");
  if (!/if \(tabs > 0\) return;\s*untrack\(\(\) => \{\s*if \(active && !noSignal\) deactivate\(\);/.test(o)) {
    out.push("a screensaver that is showing outlives the last tab");
  }
  // The props hold arrow functions, so the tag ends at its own `/>` line.
  const mount = /<IdleOverlay\b[\s\S]*?\n\s*\/>/.exec(bare(page))?.[0] ?? "";
  if (!/\btabs=\{tabsState\.list\.length\}/.test(mount)) {
    out.push("the page does not tell the screensaver how many tabs are open");
  }
  return out;
}

/** Body of `function name(…) { … }`, up to the next top-level function. */
function fn(name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `IdleOverlay defines ${name}()`).toBeGreaterThan(-1);
  const next = src.indexOf("\n  function ", at + 1);
  return src.slice(at, next < 0 ? undefined : next);
}

describe("idle card guard", () => {
  it("repaints after every metrics sample when there is no animation loop", () => {
    expect(fn("pollMetrics")).toMatch(/if\s*\(\s*active\s*&&\s*reduce\s*\)\s*draw\(/);
  });

  it("paints the static frame once the canvas exists", () => {
    // The canvas sits under `{#if active}`, so the `loop()` call inside
    // `activate()` runs before it mounts. Only an effect over `active` and the
    // bound canvas can draw that first frame — without it matrix/parallax and the
    // no-session card stay blank under reduced motion.
    expect(src).toMatch(
      /\$effect\(\(\) => \{\s*if \(active && reduce && canvas\) draw\(/,
    );
  });

  it("forgets the previous activation's numbers before the first sample", () => {
    const body = fn("activate");
    for (const v of ["cpu", "mem", "uptimeSecs", "load1", "cpuCount"]) {
      expect(body, `${v} is reset on activation`).toMatch(
        new RegExp(`\\b${v}\\s*=[^;]*\\bnull\\s*;`),
      );
    }
  });

  it("never starts in a window with no tab, and does not outlive the last one", () => {
    const overlay = read("lib", "IdleOverlay.svelte");
    const page = read("routes", "+page.svelte");
    expect(noTabViolations(overlay, page)).toEqual([]);
    // The check catches its own violations: the old tick, which asked only
    // whether the screensaver was switched off…
    const oldTick = overlay.replace(
      "if (!screensaverAllowed(settings.idleEffect, tabs)) return;",
      'if (settings.idleEffect === "off") return;',
    );
    expect(oldTick).not.toBe(overlay);
    expect(noTabViolations(oldTick, page)).toEqual([
      "the idle tick starts the screensaver without asking the rule",
    ]);
    // …a rule that is only named in a comment…
    const commented = overlay.replace(
      "if (!screensaverAllowed(settings.idleEffect, tabs)) return;",
      "// if (!screensaverAllowed(settings.idleEffect, tabs)) return;",
    );
    expect(noTabViolations(commented, page)).toEqual([
      "the idle tick starts the screensaver without asking the rule",
    ]);
    // …a screensaver left up when the last tab goes…
    const stays = overlay.replace("if (tabs > 0) return;", "if (tabs >= 0) return;");
    expect(stays).not.toBe(overlay);
    expect(noTabViolations(stays, page)).toEqual([
      "a screensaver that is showing outlives the last tab",
    ]);
    // …and a page that never says how many tabs there are.
    const silent = page.replace("    tabs={tabsState.list.length}\n", "");
    expect(silent).not.toBe(page);
    expect(noTabViolations(overlay, silent)).toEqual([
      "the page does not tell the screensaver how many tabs are open",
    ]);
  });

  it("leaves the pointer visible over the screensaver", () => {
    // Hiding it made sense while a mouse move dismissed the screensaver. Now only
    // a click or a key does, so `cursor: none` reads as a pointer that vanished
    // over a window that is still waiting for a click.
    expect(src).not.toMatch(/cursor\s*:\s*none/);
  });
});
