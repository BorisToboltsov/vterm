// Connecting-screen guard: the screen fits the room it is given, and its ring
// stays a circle.
//
// The ring was a flex item of a centred column as tall as the pane. Short of room
// the browser took the height from it — the one block that could give any — and a
// 64 px ring became a 64×35 oval; shorter still, the screen spilled out of the pane
// both ways. Now one number sizes the ring, the gaps and the padding together
// (`connfit.ts`, `actions/connfit.ts`); this keeps the pieces of that together:
//
//  1. The root clips and is fitted by `use:connFit`; the column is centred by
//     `my-auto` — it gives way at the top when there is no room — not by
//     `justify-center`, which overflows upward. The root's first mode is an
//     expression: as a literal, Svelte would drop the CSS of the other modes.
//  2. The ring is the block the action knows (`data-conn-ring`), never shrinks,
//     and is as wide as it is tall — both `var(--conn-ring)`.
//  3. The markup draws by the action's properties and nothing else; its defaults
//     are the model's full screen; it reads only the model's modes. What it hides
//     between modes comes back by `visibility: inherit`, never `visible`: a tab in
//     the background is hidden by `visibility` on an ancestor, and `visible` on a
//     child showed another tab's red cross and step over the one in front.
//  4. A jump glides by `transform` and a block that comes back fades in by
//     `opacity` — neither lays anything out — for a time that reduced motion can
//     take away.
//
// Sources are read with comments stripped — the comments name the anti-patterns.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONN_VARS, cssValue } from "../actions/connfit";
import { CONN_MODES, layoutFor, type ConnLayout } from "./connfit";

const SRC = join(process.cwd(), "src", "lib");
const OVERLAY = "connect/ConnectingOverlay.svelte";
const GLIDE = "actions/fluidglide.ts";
const raw = (rel: string): string => readFileSync(join(SRC, ...rel.split("/")), "utf8");

/** Source with comments removed — markup, block and line (`://` is not a comment). */
function code(src: string): string {
  return src
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The markup the component itself lays out — without its script, style and the snippets it renders inside. */
const markupOf = (src: string): string =>
  code(
    src
      .replace(/<script[^]*?<\/script>/, "")
      .replace(/<style[^]*?<\/style>/, "")
      .replace(/\{#snippet\b[^]*?\{\/snippet\}/g, ""),
  );
const styleOf = (src: string): string => code(/<style[^>]*>([^]*?)<\/style>/.exec(src)?.[1] ?? "");
const openDivs = (markup: string): string[] => [...markup.matchAll(/<div\b[^>]*>/g)].map((m) => m[0]);
const classes = (tag: string): string[] => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string =>
  new RegExp(`(^|\\})\\s*${selector.replace(/[.[\]()]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";
const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body)?.[2].trim();

/** What is wrong with the screen's root, column and ring. */
export function overlayViolations(source: string): string[] {
  const out: string[] = [];
  const [root = "", column = ""] = openDivs(markupOf(source));
  if (!root.includes("use:connFit")) out.push("the root is not fitted by `use:connFit`");
  if (!classes(root).includes("overflow-hidden")) out.push("the root lacks `overflow-hidden`");
  if (classes(root).includes("justify-center")) out.push("the root centres with `justify-center`");
  if (/\bdata-mode="/.test(root)) out.push("the root names its first mode with a literal");
  else if (!/\bdata-mode=\{/.test(root)) out.push("the root has no `data-mode`");
  if (!classes(column).includes("my-auto")) out.push("the column is not centred by `my-auto`");

  const ringTag = openDivs(markupOf(source)).find((tag) => /\bdata-conn-ring\b/.test(tag));
  if (!ringTag) out.push("no block is marked `data-conn-ring`");
  const ringClass = ringTag ? classes(ringTag).find((c) => c.startsWith("orbit")) : undefined;
  const ring = ringClass ? rule(styleOf(source), `.${ringClass}`) : "";
  if (decl(ring, "flex-shrink") !== "0" && !(ringTag && classes(ringTag).includes("shrink-0"))) {
    out.push("the ring may shrink");
  }
  for (const side of ["width", "height"]) {
    if (decl(ring, side) !== `var(${CONN_VARS.ring})`) out.push(`the ring's ${side} is not \`var(${CONN_VARS.ring})\``);
  }
  return out;
}

/** Properties the style reads that the action never sets, defaults that are not the model's full screen, modes it does not have. */
export function styleViolations(source: string): string[] {
  const out: string[] = [];
  const css = styleOf(source);
  const known = new Set(Object.values(CONN_VARS));
  for (const [, name] of css.matchAll(/var\((--conn-[\w-]+)\)/g)) {
    if (!known.has(name)) out.push(`the style reads \`${name}\`, the action never sets it`);
  }
  const defaults = rule(css, ".conn-root");
  const full = layoutFor("ring", 1);
  for (const key of Object.keys(CONN_VARS) as (keyof ConnLayout)[]) {
    const want = cssValue(key, full[key]);
    const got = decl(defaults, CONN_VARS[key]);
    if (got !== want) out.push(`\`${CONN_VARS[key]}\` defaults to \`${got}\`, the full screen is \`${want}\``);
  }
  const modes = new Set<string>(CONN_MODES);
  for (const [, mode] of css.matchAll(/\[data-mode="([^"]*)"\]/g)) {
    if (!modes.has(mode)) out.push(`the style reads mode \`${mode}\`, the model has none`);
  }
  if (/\bvisibility\s*:\s*visible\b/.test(css)) {
    out.push("the style sets `visibility: visible` — it shows through a hidden tab");
  }
  return out;
}

/** Glides that animate more than `transform` and `opacity`, or for a time of their own. */
export function glideViolations(source: string): string[] {
  const out: string[] = [];
  const text = code(source);
  const allowed = new Set(["transform", "opacity"]);
  if (!/\.animate\(/.test(text)) out.push("the action never glides");
  // Every keyframe list — passed to `animate` or to the helper that calls it.
  for (const [, frames] of text.matchAll(/\[\s*\{([^]*?)\}\s*,?\s*\]/g)) {
    for (const [, prop] of frames.matchAll(/(?:^|[{,])\s*(\w+)\s*:/g)) {
      if (!allowed.has(prop)) out.push(`a glide animates \`${prop}\` — only \`transform\` and \`opacity\` lay nothing out`);
    }
  }
  // Every Svelte transition's CSS.
  for (const [, css] of text.matchAll(/\bcss:[^`]*`([^`]*)`/g)) {
    for (const [, prop] of css.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)) {
      if (!allowed.has(prop)) out.push(`a transition draws \`${prop}\` — only \`transform\` and \`opacity\` lay nothing out`);
    }
  }
  for (const [, duration] of text.matchAll(/\bduration:\s*([^,}\s]+)/g)) {
    if (/^\d/.test(duration)) out.push("a glide's duration does not come from `motionMs`");
  }
  if (!/\bmotionMs\(/.test(text)) out.push("the action does not ask `motionMs` how long to glide");
  return out;
}

describe("connecting-screen guard", () => {
  it("the root clips and is fitted, the column centres by my-auto, the ring is a circle that never shrinks", () => {
    expect(overlayViolations(raw(OVERLAY))).toEqual([]);
  });

  it("the style draws by the action's properties, defaults to the full screen, reads the model's modes", () => {
    expect(styleViolations(raw(OVERLAY))).toEqual([]);
  });

  it("a jump glides by transform and fades by opacity, timed by motion", () => {
    expect(glideViolations(raw(GLIDE))).toEqual([]);
  });
});

describe("connecting-screen guard — catches what it exists for", () => {
  const overlay = raw(OVERLAY);
  const glide = raw(GLIDE);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("the old screen: a centred column whose ring the browser squeezed", () => {
    const old = mutate(
      mutate(
        mutate(overlay, "flex flex-col items-center overflow-hidden bg-panel", "flex flex-col items-center justify-center gap-5 bg-panel p-6"),
        "    flex-shrink: 0;\n    width: var(--conn-ring);\n    height: var(--conn-ring);",
        "    width: 64px;\n    height: 64px;",
      ),
      'class="conn-column my-auto ',
      'class="conn-column ',
    );
    expect(overlayViolations(old)).toEqual([
      "the root lacks `overflow-hidden`",
      "the root centres with `justify-center`",
      "the column is not centred by `my-auto`",
      "the ring may shrink",
      "the ring's width is not `var(--conn-ring)`",
      "the ring's height is not `var(--conn-ring)`",
    ]);
  });

  it("a root nobody fits, a literal first mode, a ring the action cannot find", () => {
    expect(overlayViolations(mutate(overlay, "use:connFit={[heading, detail, failed, showSteps, proxy, via, children]}", ""))).toEqual([
      "the root is not fitted by `use:connFit`",
    ]);
    expect(overlayViolations(mutate(overlay, "data-mode={firstMode}", 'data-mode="ring"'))).toEqual([
      "the root names its first mode with a literal",
    ]);
    const lost = overlayViolations(mutate(overlay, "data-conn-ring>", ">"));
    expect(lost[0]).toBe("no block is marked `data-conn-ring`");
  });

  it("an oval: the ring as tall as one size and as wide as another", () => {
    expect(
      overlayViolations(mutate(overlay, "    height: var(--conn-ring);", "    height: var(--conn-gap);")),
    ).toEqual(["the ring's height is not `var(--conn-ring)`"]);
  });

  it("a property nobody sets, a default that is not the full screen, a mode the model lacks", () => {
    expect(styleViolations(mutate(overlay, "gap: var(--conn-gap);", "gap: var(--conn-space);"))).toEqual([
      "the style reads `--conn-space`, the action never sets it",
    ]);
    expect(styleViolations(mutate(overlay, "--conn-ring: 4rem;", "--conn-ring: 3rem;"))).toEqual([
      "`--conn-ring` defaults to `3rem`, the full screen is `4rem`",
    ]);
    expect(styleViolations(mutate(overlay, '[data-mode="title"] .conn-steps', '[data-mode="tight"] .conn-steps'))).toEqual([
      "the style reads mode `tight`, the model has none",
    ]);
  });

  it("a part shown back by `visible`, which shows through another tab", () => {
    expect(styleViolations(mutate(overlay, "visibility: inherit;", "visibility: visible;"))).toEqual([
      "the style sets `visibility: visible` — it shows through a hidden tab",
    ]);
  });

  it("a glide that lays out, or runs for a time of its own", () => {
    expect(
      glideViolations(mutate(glide, '[{ transform: `translateY(${move.dy}px) scale(${move.scale})` }, { transform: "none" }]', '[{ top: `${move.dy}px` }, { top: "0" }]')),
    ).toEqual([
      "a glide animates `top` — only `transform` and `opacity` lay nothing out",
      "a glide animates `top` — only `transform` and `opacity` lay nothing out",
    ]);
    expect(glideViolations(mutate(glide, "[{ opacity: 0 }, { opacity: 1 }]", '[{ height: "0" }, { height: "auto" }]'))).toEqual([
      "a glide animates `height` — only `transform` and `opacity` lay nothing out",
      "a glide animates `height` — only `transform` and `opacity` lay nothing out",
    ]);
    const timed = glide.match(/\{ duration: ms, easing: GLIDE_EASING \}/g)?.length ?? 0;
    expect(timed).toBeGreaterThan(3);
    expect(
      glideViolations(glide.replaceAll("{ duration: ms, easing: GLIDE_EASING }", "{ duration: 220, easing: GLIDE_EASING }")),
    ).toEqual(Array(timed).fill("a glide's duration does not come from `motionMs`"));
    // A Svelte transition is held to the same: its CSS moves and fades, nothing else.
    expect(glideViolations(mutate(glide, "css: (t, u) => `transform: translateX(${u * 40}%); opacity: ${t}`", "css: (t, u) => `width: ${t * 100}%; opacity: ${t}`"))).toEqual([
      "a transition draws `width` — only `transform` and `opacity` lay nothing out",
    ]);
    expect(glideViolations(glide.replaceAll(".animate(", ".style.setProperty("))).toEqual(["the action never glides"]);
  });
});
