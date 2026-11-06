// Motion-on-resize guard: what changes its layout as the room changes moves to the
// new one instead of jumping, and through the one place such motion lives
// (`actions/fluidglide.ts`, which `connfit.guard` keeps to `transform` and
// `opacity`, timed by `motionMs`).
//
//  1. The top bar's buttons go into «⋯» and come out of it (`viaMore`); the
//     status bar's groups and the file panel's folded tools fly the same way
//     (`createRowGlide`, snapshot before the change, play after).
//  2. The connection's address in the top bar gives way before its name, fading.
//  3. A part beside a list slides aside (`aside`) both ways, out of the flow.
//  4. A panel crossing its width threshold shows up anew, its lasting blocks
//     gliding (`wideWhen` → `createPanelMorph`); the filter's row is one of them.
//  5. The monitoring page's grids glide when their columns change (`gridGlide`).
//  6. The idle card's layouts give way to each other (`TIER_MS`).
//
// Sources are read with comments stripped — the comments name what is checked.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src", "lib");
const raw = (rel: string): string => readFileSync(join(SRC, ...rel.split("/")), "utf8");

/**
 * Drop every `open … close` block by scanning. One regex pass is not enough: it
 * leaves a nested opener behind (`<!--<!-- -->` → `<!--`), and what is left would
 * be read as markup (CodeQL: `js/incomplete-multi-character-sanitization`). An
 * opener with no closer takes the rest with it.
 */
function stripBlocks(src: string, open: string, close: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(open, i)) {
      const end = src.indexOf(close, i + open.length);
      i = end < 0 ? src.length : end + close.length;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** Source with comments removed — markup, block and line (`://` is not a comment). */
function code(src: string): string {
  return stripBlocks(src, "<!--", "-->")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A wiring: in `file`, everything `needs` must be found; `why` names what is missing. */
interface Wiring {
  file: string;
  needs: [RegExp, string][];
}

const SNAP_PLAY = (dep: string, glide: string): [RegExp, string][] => [
  [
    new RegExp(`\\$effect\\.pre\\(\\(\\) => \\{\\s*void ${dep};\\s*untrack\\(\\(\\) => ${glide}\\.snapshot\\(\\)\\);`),
    `\`${glide}\` is not snapshot before \`${dep}\` changes the row`,
  ],
  [
    new RegExp(`\\$effect\\(\\(\\) => \\{\\s*void ${dep};\\s*untrack\\(\\(\\) => ${glide}\\.play\\(\\)\\);`),
    `\`${glide}\` does not play after \`${dep}\` changed the row`,
  ],
];

const ASIDE = /in:aside=\{motion\(MOTION_BASE\)\} out:aside=\{motion\(MOTION_BASE\)\}/;

export const WIRINGS: Record<string, Wiring> = {
  topbar: {
    file: "topbar/TopBar.svelte",
    needs: [
      [/in:viaMore=\{\{ \.\.\.motion\(\), more: "\[data-topbar-more\]" \}\}/, "a button does not come out of «⋯»"],
      [/out:viaMore=\{\{ \.\.\.motion\(\), more: "\[data-topbar-more\]" \}\}/, "a button does not go into «⋯»"],
      [/\bdata-topbar-more\b/, "«⋯» is not marked for the buttons to find"],
      [/class="min-w-0 shrink-\[0\.001\] truncate[^"]*"/, "the connection's name does not give way last"],
      [/data-testid="topbar-crumb-tail"\s+use:fadeAsCut/, "the connection's address does not fade as it is cut"],
    ],
  },
  statusbar: {
    file: "monitoring/StatusBar.svelte",
    needs: [
      [/createRowGlide\(\(\) => groupsEl, \{ more: "more", base: STATUS_MS \}\)/, "the bar's groups do not glide at the bar's pace"],
      ...SNAP_PLAY("hidden", "rowGlide"),
      [/data-group=\{g\}\s+data-row-key=\{g\}/, "a group is not a row item"],
      [/data-more\s+data-row-key="more"/, "«⋯ +N» is not the row's «⋯»"],
    ],
  },
  toolbar: {
    file: "files/FileBrowser.svelte",
    needs: [
      [/createRowGlide\(\(\) => toolbarEl, \{ more: "more" \}\)/, "the file panel's tools do not glide"],
      ...SNAP_PLAY("compactToolbar", "toolbarGlide"),
      ...["newFolder", "newFile", "sync", "more"].map(
        (key): [RegExp, string] => [new RegExp(`data-row-key="${key}"`), `the \`${key}\` tool is not a row item`],
      ),
      [ASIDE, "the search beside the listing does not slide aside"],
    ],
  },
  docker: { file: "docker/DockerPanel.svelte", needs: [[ASIDE, "a container's details do not slide aside"]] },
  k8s: { file: "k8s/K8sPanel.svelte", needs: [[ASIDE, "a pod's details do not slide aside"]] },
  git: { file: "git/GitGraph.svelte", needs: [[ASIDE, "a commit beside the history does not slide aside"]] },
  wide: {
    file: "actions/panelwide.svelte.ts",
    needs: [
      [/const morph = createPanelMorph\(node\);/, "a panel crossing its threshold does not morph"],
      [/queueMicrotask\(crossed \? morph\.play : morph\.record\);/, "the morph does not play after the panel redraws"],
    ],
  },
  header: { file: "ui/ListHeader.svelte", needs: [[/data-testid=\{testid\}\s+data-morph/, "the filter's row does not glide across the threshold"]] },
  monitoring: {
    file: "monitoring/MonitoringOverlay.svelte",
    needs: [[/data-testid="mon-section-\{current\}" use:gridGlide/, "the monitoring page's grids do not glide"]],
  },
  idle: {
    file: "screensaver/IdleOverlay.svelte",
    needs: [
      [/easeOut\(progress\(tierAt, now, ms\(TIER_MS\)\)\)/, "the idle card's layouts do not give way to each other"],
      [/ctx\.globalAlpha = 1 - k;\s*drawTier\(tierWas,/, "the old layout is not drawn fading"],
      [/const base = ctx\.globalAlpha;/, "the history chart does not fade within the card"],
    ],
  },
};

/** What a wiring lacks in `source`. */
export function wiringViolations(wiring: Wiring, source: string): string[] {
  const text = code(source);
  return wiring.needs.filter(([re]) => !re.test(text)).map(([, why]) => `${wiring.file}: ${why}`);
}

/** Sides that slide aside without a positioned parent to be taken out of the flow in. */
export function asideParentViolations(file: string, source: string): string[] {
  const text = code(source);
  const i = text.search(ASIDE);
  if (i < 0) return [];
  // The row holding the list and the part beside it: the last `bind:clientWidth={rowWidth}` before it.
  const before = text.slice(0, i);
  const row = [...before.matchAll(/<div\s+class="([^"]*)"[^>]*bind:clientWidth=\{rowWidth\}/g)].at(-1);
  return row && /(^|\s)relative(\s|$)/.test(row[1]) ? [] : [`${file}: the row a part slides aside from is not positioned`];
}

describe("motion-on-resize guard", () => {
  for (const [name, wiring] of Object.entries(WIRINGS)) {
    it(`${name}: moves instead of jumping`, () => {
      expect(wiringViolations(wiring, raw(wiring.file))).toEqual([]);
    });
  }

  it("every part that slides aside has a positioned row to leave from", () => {
    for (const file of ["docker/DockerPanel.svelte", "k8s/K8sPanel.svelte", "git/GitGraph.svelte", "files/FileBrowser.svelte"]) {
      expect(asideParentViolations(file, raw(file))).toEqual([]);
    }
  });
});

describe("motion-on-resize guard — catches what it exists for", () => {
  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };
  const broken = (name: string, from: string, to = ""): string[] =>
    wiringViolations(WIRINGS[name], mutate(raw(WIRINGS[name].file), from, to));

  it("a top-bar button that vanishes, a name cut before its address", () => {
    expect(broken("topbar", 'out:viaMore={{ ...motion(), more: "[data-topbar-more]" }}')).toEqual([
      "topbar/TopBar.svelte: a button does not go into «⋯»",
    ]);
    expect(broken("topbar", "min-w-0 shrink-[0.001] truncate", "shrink-0 truncate")).toEqual([
      "topbar/TopBar.svelte: the connection's name does not give way last",
    ]);
  });

  it("a row that changes without its snapshot, or with a group it cannot follow", () => {
    expect(broken("statusbar", "untrack(() => rowGlide.snapshot());", "")).toEqual([
      "monitoring/StatusBar.svelte: `rowGlide` is not snapshot before `hidden` changes the row",
    ]);
    expect(broken("statusbar", "data-row-key={g}", "")).toEqual(["monitoring/StatusBar.svelte: a group is not a row item"]);
    expect(broken("toolbar", 'data-row-key="newFile"', "")).toEqual([
      "files/FileBrowser.svelte: the `newFile` tool is not a row item",
    ]);
  });

  it("a part beside a list that pops, or slides from a row it cannot leave", () => {
    expect(broken("git", " in:aside={motion(MOTION_BASE)} out:aside={motion(MOTION_BASE)}")).toEqual([
      "git/GitGraph.svelte: a commit beside the history does not slide aside",
    ]);
    const file = "docker/DockerPanel.svelte";
    expect(asideParentViolations(file, mutate(raw(file), '<div class="relative flex min-h-0 flex-1" bind:clientWidth={rowWidth}>', '<div class="flex min-h-0 flex-1" bind:clientWidth={rowWidth}>'))).toEqual([
      `${file}: the row a part slides aside from is not positioned`,
    ]);
  });

  it("a panel, a grid and the idle card that jump", () => {
    expect(broken("wide", "queueMicrotask(crossed ? morph.play : morph.record);")).toEqual([
      "actions/panelwide.svelte.ts: the morph does not play after the panel redraws",
    ]);
    expect(broken("monitoring", " use:gridGlide")).toEqual([
      "monitoring/MonitoringOverlay.svelte: the monitoring page's grids do not glide",
    ]);
    expect(broken("idle", "ctx.globalAlpha = 1 - k;\n      drawTier(tierWas,", "drawTier(tierWas,")).toEqual([
      "screensaver/IdleOverlay.svelte: the old layout is not drawn fading",
    ]);
  });
});
