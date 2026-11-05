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
//
// And the card is laid out for the room it has (v1.14.1). It is drawn over the
// terminal area, which a raised bottom dock turns into a low strip: laid out by
// fixed offsets there, the numbers left the card and the chart landed on the
// header. `drawCard` asks `cardTier` and draws the card itself only where it
// fits; the smaller layouts carry no "press any key" hint — it has nowhere to
// stand in them.
//
// And it need not hold its pixels still (v1.31). The standby screen fills a
// large area and may stay up for hours: every layout is drawn moved by the
// shift the user set (`shiftOffset` over `settings.idleShiftEverySec`, off by
// default), and the prod frame — the edge of the area — is drawn after, in place. The history of the time away does not draw a line through a poll
// that failed: that moment is a gap.
//
// And the history carries no marks of its own (v1.33). A dashed line and a dot
// per event turned a busy stretch into a fence nobody could read; what happened
// at a moment is told by a tooltip over the point under the pointer. A move does
// not dismiss the screensaver, so the tooltip may follow it — read against the
// burn-in shift the frame was drawn with, and gone once the pointer rests (a
// tooltip left up for hours would hold its pixels lit), with or without the
// animation loop.
//
// And a reading does not land in one frame (v1.33): rings, numbers and the
// transfer bar run to it from where they stand, a number counting on the way,
// and the right edge of each chart moves to the newest point instead of
// jumping there. Every duration goes through `motionMs`, so reduced motion
// keeps each change instant.
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
const src = bare(read("lib", "screensaver", "IdleOverlay.svelte"));

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

/** Body of `function name(…) { … }` in `text`, up to the next function of the component. */
function bodyOf(text: string, name: string): string {
  const at = text.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const next = text.indexOf("\n  function ", at + 1);
  return text.slice(at, next < 0 ? undefined : next);
}

/**
 * What lets the card be drawn by fixed offsets in an area they do not fit —
 * in the overlay's own source. Empty when the rule holds.
 */
export function cardLayoutViolations(overlay: string): string[] {
  const o = bare(overlay);
  const out: string[] = [];
  if (!/const tier = cardTier\(W, H\);/.test(bodyOf(o, "drawCard"))) {
    out.push("drawCard does not ask what layout the area has room for");
  }
  // `drawCardFull(ctx,` is a call; the definition reads `drawCardFull(ctx:`.
  const calls = o.match(/\bdrawCardFull\(ctx,/g)?.length ?? 0;
  const guarded = o.match(/if \(tier === "full"\) drawCardFull\(ctx,/g)?.length ?? 0;
  if (calls !== 1 || guarded !== 1) {
    out.push("the card itself is drawn outside the layout that fits it");
  }
  const standby = o.match(/\bdrawStandby\(ctx,/g)?.length ?? 0;
  const standbyGuarded =
    o.match(/if \(tier === "standby" \|\| tier === "compact"\) drawStandby\(ctx,/g)?.length ?? 0;
  if (standby !== 1 || standbyGuarded !== 1) {
    out.push("the standby screen is drawn outside the layouts that fit it");
  }
  for (const small of ["drawCardWide", "drawCardStack", "drawCardSmall"]) {
    const body = bodyOf(o, small);
    if (!body) out.push(`${small} is gone`);
    else if (/\bhint\(/.test(body)) out.push(`${small} draws the hint it has no room for`);
  }
  return out;
}

/**
 * What holds the card's pixels still, or moves the prod frame with it — in the
 * overlay's own source. Empty when the rule holds.
 */
export function driftViolations(overlay: string): string[] {
  const body = bodyOf(bare(overlay), "drawCard");
  const out: string[] = [];
  const offset = body.indexOf("const { dx, dy } = shiftOffset(now, settings.idleShiftEverySec);");
  const moved = body.indexOf("ctx.translate(dx, dy);");
  const first = body.search(/drawStandby\(ctx,|drawCardFull\(ctx,/);
  if (offset < 0 || moved < offset || first < 0 || moved > first) out.push("the card is drawn without drifting");
  const restore = body.lastIndexOf("ctx.restore();");
  const frame = body.indexOf("prodFrame(ctx,");
  if (frame < 0) out.push("a production session's card has no red frame");
  else if (restore < 0 || frame < restore) out.push("the prod frame drifts with the card");
  return out;
}

/**
 * What lets the history of the time away draw a line through a poll that
 * failed — in the overlay's own source. Empty when the rule holds.
 */
export function gapViolations(overlay: string): string[] {
  const o = bare(overlay);
  const body = bodyOf(o, "onReading");
  const caught = /\}\s*else\s*\{([\s\S]*?)\n {4}\}/.exec(body)?.[1] ?? "";
  const kept = /\baway = awayPush\(away, r, awayThresholds\(\)\);/.test(bodyOf(o, "remember"));
  return /\bremember\(gapReading\(/.test(caught) && kept ? [] : ["a failed poll leaves no gap in the history"];
}

/**
 * What lets a ring, a number or a chart's edge jump to a reading, or move with
 * reduced motion on — in the overlay's own source. Empty when the rule holds.
 */
export function smoothViolations(overlay: string): string[] {
  const o = bare(overlay);
  const out: string[] = [];
  const drawn = bodyOf(o, "cardMetrics") + bodyOf(o, "drawStandby");
  if (/\bfmtPct\((?:cpu|mem|diskPct)\)|\bringFraction\((?:cpu|mem|load1|diskUsed),|\bload1 != null \? load1\.toFixed/.test(drawn)) {
    out.push("a ring or a number jumps to the reading");
  }
  const poll = bodyOf(o, "onReading");
  if (!["cpu", "mem", "load", "disk"].every((k) => new RegExp(`\\b${k}: retarget\\(shownTw\\.${k},`).test(poll))) {
    out.push("what is shown does not follow the readings");
  }
  if (!/const to = tweenAt\(axisTw, frameAt, ms\(LINE_MS\)\)/.test(bodyOf(o, "drawAway"))) {
    out.push("the history's edge jumps to the newest point");
  }
  if (!/const end = tweenAt\(histTw, frameAt, ms\(LINE_MS\)\);/.test(bodyOf(o, "drawSeries"))) {
    out.push("the small chart jumps to the newest sample");
  }
  const reduced = /const ms = \(base: number\) => motionMs\(base, reduce\);/.test(o);
  const raw = /\b(?:tweenAt|retarget|progress)\([^;]*?,\s*(?:RING_MS|LINE_MS|BAR_MS|MERGE_MS)\b/.test(o);
  if (!reduced || raw) out.push("a change moves with reduced motion on");
  return out;
}

/**
 * What draws marks over the history, lets its tooltip outstay a resting pointer
 * or miss the point under it, or lets the pointer dismiss the screensaver — in
 * the overlay's own source. Empty when the rule holds.
 */
export function hoverViolations(overlay: string): string[] {
  const o = bare(overlay);
  const out: string[] = [];
  if (/\baway\.events\b/.test(bodyOf(o, "drawAway"))) out.push("the history draws marks for its events");
  const hovered = bodyOf(o, "hovered");
  const shown = hovered.indexOf("if (!pointer || !hoverShown(movedAt, performance.now())) return null;");
  const picks = hovered.indexOf("pointAt(away.points,");
  if (picks < 0) out.push("the tooltip does not ask which point is under the pointer");
  else if (shown < 0 || shown > picks) out.push("the tooltip outstays a resting pointer");
  const shifted =
    /const x = pointer\.x - drift\.dx;/.test(hovered) &&
    /const y = pointer\.y - drift\.dy;/.test(hovered) &&
    /shiftOffset\(now, settings\.idleShiftEverySec\);\s*drift = \{ dx, dy \};/.test(bodyOf(o, "drawCard"));
  if (!shifted) out.push("the pointer is read without the burn-in shift");
  const move = bodyOf(o, "onPointerMove");
  if (!/stillTimer = setTimeout\(\(\) => \{\s*if \(active\) draw\(performance\.now\(\) - started\);\s*\}, HOVER_STILL_MS\b/.test(move)) {
    out.push("without the animation loop the tooltip stays up for good");
  }
  if (/\bdeactivate\(/.test(move + bodyOf(o, "onPointerLeave"))) out.push("the pointer dismisses the screensaver");
  if (!/onpointermove=\{onPointerMove\}/.test(o) || !/onpointerleave=\{onPointerLeave\}/.test(o)) {
    out.push("the canvas does not follow the pointer");
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
    expect(fn("onReading")).toMatch(/if\s*\(\s*active\s*&&\s*reduce\s*\)\s*draw\(/);
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
    for (const v of [
      "cpu",
      "mem",
      "uptimeSecs",
      "load1",
      "cpuCount",
      "load5",
      "memUsed",
      "diskUsed",
      "cpuTemp",
      "offsetMin",
    ]) {
      expect(body, `${v} is reset on activation`).toMatch(
        new RegExp(`\\b${v}\\s*=[^;]*\\bnull\\s*;`),
      );
    }
    // …and the previous time away: its history and its events.
    expect(body).toMatch(/\baway = emptyAway\(\);/);
  });

  it("never starts in a window with no tab, and does not outlive the last one", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
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

  it("lays the card out for the room the terminal area has", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
    expect(cardLayoutViolations(overlay)).toEqual([]);
    // The check catches its own violations: a card that never asks…
    const fixed = overlay.replace("const tier = cardTier(W, H);", 'const tier = "full";');
    expect(fixed).not.toBe(overlay);
    expect(cardLayoutViolations(fixed)).toEqual([
      "drawCard does not ask what layout the area has room for",
    ]);
    // …a rule that is only named in a comment…
    const commented = overlay.replace("const tier = cardTier(W, H);", "// const tier = cardTier(W, H);");
    expect(cardLayoutViolations(commented)).toEqual([
      "drawCard does not ask what layout the area has room for",
    ]);
    // …the card drawn whatever the answer…
    const always = overlay.replace('if (tier === "full") drawCardFull(ctx,', "drawCardFull(ctx,");
    expect(always).not.toBe(overlay);
    expect(cardLayoutViolations(always)).toEqual([
      "the card itself is drawn outside the layout that fits it",
    ]);
    // …a second place that draws it, past the question…
    const twice = overlay.replace(
      "else drawCard(ctx, W, H, now, p);",
      "else drawCardFull(ctx, W, H, now, p);",
    );
    expect(twice).not.toBe(overlay);
    expect(cardLayoutViolations(twice)).toEqual([
      "the card itself is drawn outside the layout that fits it",
    ]);
    // …and a small layout that brings the hint back.
    const hinted = overlay.replace(
      "    sharedChart(ctx, 16, 46, W - 32, H - 46 - 14, p);\n  }",
      "    sharedChart(ctx, 16, 46, W - 32, H - 46 - 14, p);\n    hint(ctx, W, H, p);\n  }",
    );
    expect(hinted).not.toBe(overlay);
    expect(cardLayoutViolations(hinted)).toEqual([
      "drawCardWide draws the hint it has no room for",
    ]);
  });

  it("draws the standby screen only where it fits", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
    const loose = overlay.replace(
      'if (tier === "standby" || tier === "compact") drawStandby(ctx,',
      'if (tier !== "line") drawStandby(ctx,',
    );
    expect(loose).not.toBe(overlay);
    expect(cardLayoutViolations(loose)).toEqual(["the standby screen is drawn outside the layouts that fit it"]);
  });

  it("drifts every layout against burn-in, and keeps the prod frame in place", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
    expect(driftViolations(overlay)).toEqual([]);
    // The check catches its own violations: a shift that ignores the setting…
    const unasked = overlay.replace(
      "const { dx, dy } = shiftOffset(now, settings.idleShiftEverySec);",
      "const { dx, dy } = shiftOffset(now, 0);",
    );
    expect(unasked).not.toBe(overlay);
    expect(driftViolations(unasked)).toEqual(["the card is drawn without drifting"]);
    // …a card that never moves…
    const still = overlay.replace("    ctx.translate(dx, dy);\n", "");
    expect(still).not.toBe(overlay);
    expect(driftViolations(still)).toEqual(["the card is drawn without drifting"]);
    // …one that moves only after the layout is drawn…
    const late = overlay
      .replace("    ctx.translate(dx, dy);\n", "")
      .replace("    ctx.restore();\n    if (prod", "    ctx.translate(dx, dy);\n    ctx.restore();\n    if (prod");
    expect(late).not.toBe(still);
    expect(driftViolations(late)).toEqual(["the card is drawn without drifting"]);
    // …a frame drawn inside the moved layout…
    const moving = overlay
      .replace("    if (prod && sessionId) prodFrame(ctx, W, H, p);\n", "")
      .replace("    ctx.translate(dx, dy);\n", "    ctx.translate(dx, dy);\n    if (prod && sessionId) prodFrame(ctx, W, H, p);\n");
    expect(moving).not.toBe(overlay);
    expect(driftViolations(moving)).toEqual(["the prod frame drifts with the card"]);
    // …and no frame at all.
    const frameless = overlay.replace("    if (prod && sessionId) prodFrame(ctx, W, H, p);\n", "");
    expect(frameless).not.toBe(overlay);
    expect(driftViolations(frameless)).toEqual(["a production session's card has no red frame"]);
  });

  it("leaves a gap in the history where a poll failed", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
    expect(gapViolations(overlay)).toEqual([]);
    // The check catches its own violation: a failure that only keeps the numbers.
    const silent = overlay.replace("      remember(gapReading(at));\n", "");
    expect(silent).not.toBe(overlay);
    expect(gapViolations(silent)).toEqual(["a failed poll leaves no gap in the history"]);
    // …or one that is passed on to a step that no longer keeps it.
    const dropped = overlay.replace("    away = awayPush(away, r, awayThresholds());\n", "");
    expect(dropped).not.toBe(overlay);
    expect(gapViolations(dropped)).toEqual(["a failed poll leaves no gap in the history"]);
  });

  it("runs rings, numbers and charts to each reading instead of jumping", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
    expect(smoothViolations(overlay)).toEqual([]);
    const caught = (from: string, to: string) => {
      const changed = overlay.replace(from, to);
      expect(changed, from).not.toBe(overlay);
      return smoothViolations(changed);
    };
    // The check catches its own violations: a ring drawn from the raw reading…
    expect(caught("ringFraction(sCpu, 100),", "ringFraction(cpu, 100),")).toEqual(["a ring or a number jumps to the reading"]);
    // …a small card's number that jumps…
    expect(caught('["CPU", fmtPct(shown(shownTw.cpu)), p.green, "cpu"],', '["CPU", fmtPct(cpu), p.green, "cpu"],')).toEqual([
      "a ring or a number jumps to the reading",
    ]);
    // …a value that no reading sends on…
    expect(caught("      cpu: retarget(shownTw.cpu, cpu, t, ms(RING_MS)),\n", "")).toEqual(["what is shown does not follow the readings"]);
    // …a history whose edge jumps to the newest point…
    expect(
      caught("const to = tweenAt(axisTw, frameAt, ms(LINE_MS)) ?? pts[pts.length - 1].at;", "const to = pts[pts.length - 1].at;"),
    ).toEqual(["the history's edge jumps to the newest point"]);
    // …a small chart that jumps…
    expect(caught("const end = tweenAt(histTw, frameAt, ms(LINE_MS));", "const end = histSeq;")).toEqual([
      "the small chart jumps to the newest sample",
    ]);
    // …and movement that ignores reduced motion: a raw duration, or none of the setting.
    expect(caught("tweenAt(tw, frameAt, ms(RING_MS));", "tweenAt(tw, frameAt, RING_MS);")).toEqual(["a change moves with reduced motion on"]);
    expect(caught("motionMs(base, reduce);", "motionMs(base, false);")).toEqual(["a change moves with reduced motion on"]);
  });

  it("tells a moment of the history in a tooltip, not in marks", () => {
    const overlay = read("lib", "screensaver", "IdleOverlay.svelte");
    expect(hoverViolations(overlay)).toEqual([]);
    // The check catches its own violations: the event marks back on the chart…
    const marked = overlay.replace(
      "    lines(pts);\n",
      "    lines(pts);\n    for (const e of away.events) ctx.fillRect(timeX(e.peakAt, from, to, gx, gw), gy, 1, gh);\n",
    );
    expect(marked).not.toBe(overlay);
    expect(hoverViolations(marked)).toEqual(["the history draws marks for its events"]);
    // …a tooltip that ignores how long the pointer has rested…
    const resting = overlay.replace(
      "if (!pointer || !hoverShown(movedAt, performance.now())) return null;",
      "if (!pointer) return null;",
    );
    expect(resting).not.toBe(overlay);
    expect(hoverViolations(resting)).toEqual(["the tooltip outstays a resting pointer"]);
    // …a pointer read where the layout stood before it drifted…
    const unshifted = overlay.replace("const x = pointer.x - drift.dx;", "const x = pointer.x;");
    expect(unshifted).not.toBe(overlay);
    expect(hoverViolations(unshifted)).toEqual(["the pointer is read without the burn-in shift"]);
    const unrecorded = overlay.replace("    drift = { dx, dy };\n", "");
    expect(unrecorded).not.toBe(overlay);
    expect(hoverViolations(unrecorded)).toEqual(["the pointer is read without the burn-in shift"]);
    // …no repaint once the pointer rests, when nothing else repaints…
    const stuck = overlay.replace(
      "    stillTimer = setTimeout(() => {\n      if (active) draw(performance.now() - started);\n    }, HOVER_STILL_MS + 50);\n",
      "",
    );
    expect(stuck).not.toBe(overlay);
    expect(hoverViolations(stuck)).toEqual(["without the animation loop the tooltip stays up for good"]);
    // …a move that takes the screensaver down…
    const dismissing = overlay.replace(
      "    movedAt = performance.now();\n    if (!reduce || !active) return;",
      "    movedAt = performance.now();\n    deactivate();\n    if (!reduce || !active) return;",
    );
    expect(dismissing).not.toBe(overlay);
    expect(hoverViolations(dismissing)).toEqual(["the pointer dismisses the screensaver"]);
    // …and a canvas that never hears the pointer.
    const deaf = overlay.replace("    onpointermove={onPointerMove}\n", "");
    expect(deaf).not.toBe(overlay);
    expect(hoverViolations(deaf)).toEqual(["the canvas does not follow the pointer"]);
  });

  it("leaves the pointer visible over the screensaver", () => {
    // Hiding it made sense while a mouse move dismissed the screensaver. Now only
    // a click or a key does, so `cursor: none` reads as a pointer that vanished
    // over a window that is still waiting for a click.
    expect(src).not.toMatch(/cursor\s*:\s*none/);
  });
});
