import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UI_SCALE_KEY } from "./uiscale";

// The interface scale reaches everything (ADR 0049). It is the root font size, so
// whatever is in rem follows by itself; this keeps the rest from falling behind:
// a type step in px, an icon in px, a number a component draws or counts with, the
// terminal's font. A row left at 28 px while its `h-7` grows breaks a virtual list
// without one failing test, and it only shows at a scale nobody ran it at. Each check
// is a function over the source with comments stripped, and shows it catches its own
// violation.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/**
 * Drop `<!-- … -->` blocks. A scan rather than a non-greedy regex: one pass of
 * `/<!--[^]*?-->/` leaves the opener behind on a nested comment (`<!--<!-- -->` →
 * `<!--`), which CodeQL reports as `js/incomplete-multi-character-sanitization`.
 */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i++];
  }
  return out;
}

const strip = (src: string) =>
  stripHtmlComments(src.replace(/\/\*[\s\S]*?\*\//g, "")).replace(/^\s*\/\/.*$/gm, "");

/** app.css: no font size in px, neither in the type scale nor in a global class. */
export function cssViolations(css: string): string[] {
  const src = strip(css);
  const out: string[] = [];
  if (/--text-(?:caption|meta):\s*[\d.]+px/.test(src)) out.push("a type step is in px");
  if (/font-size:\s*[\d.]+px/.test(src)) out.push("a global class sets its font in px");
  return out;
}

/** app.html: the first frame already has the size. */
export function bootViolations(html: string): string[] {
  const src = strip(html);
  return src.includes(`localStorage.getItem("${UI_SCALE_KEY}")`) &&
    /documentElement\.style\.fontSize/.test(src)
    ? []
    : ["the first frame does not take the scale"];
}

/** The settings store puts the scale on the document whenever it changes. */
export function storeViolations(store: string): string[] {
  const src = strip(store);
  const out: string[] = [];
  if (!/\$effect\(\(\) => \{\s*applyUiScale\(\);/.test(src)) out.push("the scale is not applied on change");
  if (!/style\.fontSize = rootFontSize\(/.test(src)) out.push("the scale does not reach the root font");
  return out;
}

/** `Icon` draws in rem: its attributes alone would stay at 100 %. */
export function iconViolations(icon: string): string[] {
  const src = strip(icon);
  return /style:width="\{size \/ REM_PX\}rem"/.test(src) && /style:height="\{size \/ REM_PX\}rem"/.test(src)
    ? []
    : ["an icon keeps its size in px"];
}

/**
 * What a component draws or counts by a number of its own goes through `uiPx`. The
 * patterns are the places, each with the row or rail whose classes grow beside it.
 */
const THROUGH_THE_SCALE: Record<string, [RegExp, string][]> = {
  "src/lib/files/FileBrowser.svelte": [[/const ROW_H = \$derived\(uiPx\(28\)\)/, "file rows"]],
  "src/lib/sync/SyncModal.svelte": [[/const ROW_H = \$derived\(uiPx\(28\)\)/, "plan rows"]],
  "src/lib/docker/DockerNetGraph.svelte": [
    [/const H = \$derived\(uiPx\(\d+\)\)/, "graph rows"],
    [/const PAD = \$derived\(uiPx\(\d+\)\)/, "graph padding"],
    // The boxes of the topology (v1.33) are drawn in the same units as the rows.
    [/const BOX = \$derived\(uiPx\(\d+\)\)/, "graph boxes"],
    [/const PORT = \$derived\(uiPx\(\d+\)\)/, "graph port boxes"],
  ],
  "src/lib/git/GitGraph.svelte": [
    [/const rowPx = \$derived\(uiPx\(H\)\)/, "history rows"],
    [/windowRange\(scrollTop, viewH, rowPx,/, "the history window"],
    [/width=\{uiPx\(graphW\)\}/, "the rails' width"],
    [/viewBox="0 0 \{graphW\} \{rows\.length \* H\}"/, "the rails' own units"],
    [/isLogWide\(listWidth, uiPx\(REM_PX\)\)/, "the history's threshold"],
  ],
  "src/routes/+page.svelte": [[/const VIEW_STRIP = \$derived\(uiPx\(28\)\)/, "the strip of views"]],
  "src/lib/layout/Dock.svelte": [
    [/const BOTTOM_STRIP = \$derived\(uiPx\(24\) \+ 1\)/, "the collapsed bottom dock"],
    [/const rail = \$derived\(uiPx\(COLLAPSED_RAIL\)\)/, "the collapsed side dock"],
  ],
  "src/lib/topbar/TopBar.svelte": [[/topbarRoom\(barWidth \/ uiPx\(1\)\)/, "the top bar's room"]],
  "src/lib/ui/ColumnHead.svelte": [[/resizedWidth\(startWidth, dx \/ uiPx\(1\)\)/, "a column drag"]],
  "src/lib/terminal/JsonLogView.svelte": [
    [/resizedWidth\(resizeStartW, dx \/ uiPx\(1\)\)/, "a log column drag"],
    [/style="width:\{uiPx\(totalWidth\)\}px"/, "the log table"],
  ],
  "src/lib/actions/panelwide.svelte.ts": [
    [/isWide\(node\.clientWidth, uiPx\(REM_PX\)\)/, "the wide threshold"],
    [/\$effect\(check\)/, "the wide threshold on a change of scale"],
  ],
};

export function scaleViolations(rel: string, source: string): string[] {
  const src = strip(source);
  return (THROUGH_THE_SCALE[rel] ?? []).filter(([re]) => !re.test(src)).map(([, what]) => `${what} ignore the scale`);
}

/** The terminal and the recording player take the font on screen, not its base. */
export function terminalViolations(source: string): string[] {
  const src = strip(source);
  return /fontSize(?::| =)\s*settings\.fontSize/.test(src) || !src.includes("activeFontSize()")
    ? ["the terminal's font ignores the scale"]
    : [];
}

describe("interface scale guard", () => {
  it("the type scale and global classes are not in px", () => {
    const css = read("src/app.css");
    expect(cssViolations(css)).toEqual([]);
    expect(
      cssViolations(
        css
          .replace("--text-caption: 0.625rem", "--text-caption: 10px")
          .replace("font-size: 0.6875rem", "font-size: 11px"),
      ),
    ).toEqual(["a type step is in px", "a global class sets its font in px"]);
  });

  it("the first frame takes the scale from the key the store writes", () => {
    const html = read("src/app.html");
    expect(bootViolations(html)).toEqual([]);
    expect(bootViolations(html.replace(UI_SCALE_KEY, "vterm.scale"))).toEqual([
      "the first frame does not take the scale",
    ]);
  });

  it("the store applies the scale to the root font", () => {
    const store = read("src/lib/settings/settings.svelte.ts");
    expect(storeViolations(store)).toEqual([]);
    expect(
      storeViolations(
        store.replace("    applyUiScale();\n", "").replace("style.fontSize = rootFontSize(", "style.zoom = String("),
      ),
    ).toEqual(["the scale is not applied on change", "the scale does not reach the root font"]);
  });

  it("an icon is drawn in rem", () => {
    const icon = read("src/lib/ui/Icon.svelte");
    expect(iconViolations(icon)).toEqual([]);
    expect(iconViolations(icon.replace('style:width="{size / REM_PX}rem"', ""))).toEqual([
      "an icon keeps its size in px",
    ]);
  });

  it("every number drawn or counted by goes through the scale", () => {
    for (const rel of Object.keys(THROUGH_THE_SCALE)) {
      expect(scaleViolations(rel, read(rel)), rel).toEqual([]);
    }
  });

  it("catches a row left at its old height", () => {
    const rel = "src/lib/files/FileBrowser.svelte";
    expect(scaleViolations(rel, read(rel).replace("$derived(uiPx(28))", "28"))).toEqual([
      "file rows ignore the scale",
    ]);
    const graph = "src/lib/git/GitGraph.svelte";
    expect(scaleViolations(graph, read(graph).replace("viewH, rowPx,", "viewH, H,"))).toEqual([
      "the history window ignore the scale",
    ]);
  });

  it("the terminal and the player take the font on screen", () => {
    for (const rel of ["src/lib/terminal/Terminal.svelte", "src/lib/recording/RecordingPlayer.svelte"]) {
      const source = read(rel);
      expect(terminalViolations(source), rel).toEqual([]);
      expect(terminalViolations(source.replaceAll("activeFontSize()", "settings.fontSize")), rel).toEqual([
        "the terminal's font ignores the scale",
      ]);
    }
  });
});
