// Status-bar guard (v1.34): one feed of metrics per session, a bar that is not
// rebuilt on a tab switch, short motion, and no row scrolled out of view.
//
// Why each:
// • The backend takes CPU% and every rate as the difference from the previous
//   `fetch_metrics` of the session. The bar, the monitoring page and the
//   screensaver polled it each on a timer of its own, so two calls a moment apart
//   read the load over a fraction of a second — the numbers jittered. The lint
//   rule `vterm/owned-imports` keeps the call in stores/metricsfeed; this guard
//   keeps the page and the screensaver riding the feed rather than a timer.
// • `{#key tabsState.activeId}` rebuilt the bar on every switch: "loading", the
//   row collapsing, the CPU history gone. The feed outlives a switch; the bar
//   must not be keyed by the tab.
// • The bar is in view all day, at the edge of sight: its changes run for
//   STATUS_MS, its chart moves as the bar's, and nothing flashes.
// • A row that scrolls sideways without a scrollbar hid CPU and memory past the
//   edge. What does not fit leaves for «⋯» (fitBar).
//
// Each check is a function over the source text, and each is shown catching
// its own violation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");

/** Drop `<!-- … -->` blocks by scanning, not by a regex replace: a replace can leave an
 *  `<!--` behind (`<!<!-- x -->--`), and an unclosed comment drops the rest. */
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

/** Source without `<!-- … -->` and `//` line comments: prose may name what code may not do. */
export function bare(src: string): string {
  return stripHtmlComments(src)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** What rebuilds the status bar on a tab switch — in the page's source. */
export function keyedViolations(page: string): string[] {
  const p = bare(page);
  const at = p.indexOf("<StatusBar");
  if (at < 0) return ["the page draws no status bar"];
  const before = p.slice(0, at);
  const opened = before.lastIndexOf("{#key");
  const closed = before.lastIndexOf("{/key}");
  return opened > closed ? ["the status bar is rebuilt on every tab switch"] : [];
}

/** What polls the basic metrics on a timer of its own — in a consumer's source. */
export function feedViolations(src: string, name: string): string[] {
  const s = bare(src);
  const out: string[] = [];
  if (!/\bwatchMetrics\s*(?:<[^>]*>)?\(/.test(s)) out.push(`${name} does not ride the session's metrics feed`);
  if (/\bfetchMetrics\b/.test(s)) out.push(`${name} asks for the basic metrics itself`);
  if (/setInterval\(\s*poll/.test(s)) out.push(`${name} polls on a timer of its own`);
  return out;
}

/** What makes the bar move long, flash, or scroll its row sideways — in its source. */
export function barViolations(bar: string): string[] {
  const b = bare(bar);
  const out: string[] = [];
  const tweens = [...b.matchAll(/<TweenNumber\b[\s\S]*?\/>/g)].map((m) => m[0]);
  if (tweens.length === 0 || tweens.some((tw) => !/duration=\{STATUS_MS\}/.test(tw))) {
    out.push("a number on the bar counts for longer than STATUS_MS");
  }
  const charts = [...b.matchAll(/<Chart\b[\s\S]*?\/>/g)].map((m) => m[0]);
  // The row's chart is the bar's; the tile's (with time marks) is the page's, shown on hover.
  if (charts.filter((c) => !/\bmarks\b/.test(c)).some((c) => !/\sbar\b/.test(c))) {
    out.push("the row's chart moves as the page's, not the bar's");
  }
  if (/\banimate-|@keyframes|\bpulse\b/.test(b)) out.push("something on the bar flashes");
  if (/overflow-x-auto|overflow-x-scroll/.test(b)) out.push("the row scrolls sideways instead of fitting");
  if (!/\bfitBar\(/.test(b)) out.push("the row is not fitted by fitBar");
  return out;
}

describe("status bar guard", () => {
  it("reads the source without its comments, an unclosed one included", () => {
    expect(stripHtmlComments("a<!-- x -->b<!-- y -->c")).toBe("abc");
    expect(stripHtmlComments("a<!--<!-- x -->-->b")).toBe("a-->b");
    expect(stripHtmlComments("a<!-- open")).toBe("a");
    expect(bare("x\n  // the bar used {#key}\ny")).toBe("x\ny");
  });

  it("the bar is not rebuilt on a tab switch", () => {
    const page = read("routes", "+page.svelte");
    expect(keyedViolations(page)).toEqual([]);
    // The check catches its own violation: the bar keyed by the tab, as it was.
    const keyed = page.replace(/(\s*)<StatusBar\b([^>]*)\/>/, "$1{#key tabsState.activeId}<StatusBar$2/>{/key}");
    expect(keyed).not.toBe(page);
    expect(keyedViolations(keyed)).toEqual(["the status bar is rebuilt on every tab switch"]);
  });

  it("the monitoring page and the screensaver ride the feed", () => {
    const overlay = read("lib", "monitoring", "MonitoringOverlay.svelte");
    const idle = read("lib", "screensaver", "IdleOverlay.svelte");
    const bar = read("lib", "monitoring", "StatusBar.svelte");
    expect(feedViolations(overlay, "the monitoring page")).toEqual([]);
    expect(feedViolations(idle, "the screensaver")).toEqual([]);
    expect(feedViolations(bar, "the status bar")).toEqual([]);
    // The check catches its own violations: the page polling on its own again…
    const own = overlay.replace(
      /return watchMetrics<Companion>\([^;]*\);/,
      "timer = setInterval(poll, 5000); void fetchMetrics; return () => {};",
    );
    expect(own).not.toBe(overlay);
    expect(feedViolations(own, "the monitoring page")).toEqual([
      "the monitoring page does not ride the session's metrics feed",
      "the monitoring page asks for the basic metrics itself",
      "the monitoring page polls on a timer of its own",
    ]);
  });

  it("the bar moves short, flashes nothing and fits its row", () => {
    const bar = read("lib", "monitoring", "StatusBar.svelte");
    expect(barViolations(bar)).toEqual([]);
    // The check catches its own violations: a number counting for the page's 700 ms…
    const long = bar.replace("duration={STATUS_MS}", "duration={RING_MS}");
    expect(long).not.toBe(bar);
    expect(barViolations(long)).toEqual(["a number on the bar counts for longer than STATUS_MS"]);
    // …the row's chart sliding as the page's…
    const slow = bar.replace(/(\s+)bar\n(\s+testid="cpu-chart")/, "$1\n$2");
    expect(slow).not.toBe(bar);
    expect(barViolations(slow)).toEqual(["the row's chart moves as the page's, not the bar's"]);
    // …a pulse on a threshold…
    const flash = bar.replace('class="h-2 w-2 rounded-full', 'class="h-2 w-2 animate-ping rounded-full');
    expect(flash).not.toBe(bar);
    expect(barViolations(flash)).toEqual(["something on the bar flashes"]);
    // …and the old row that scrolled CPU out of view.
    const scroll = bar.replace("relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden", "relative flex min-w-0 flex-1 items-center gap-2 overflow-x-auto");
    expect(scroll).not.toBe(bar);
    expect(barViolations(scroll)).toEqual(["the row scrolls sideways instead of fitting"]);
  });
});
