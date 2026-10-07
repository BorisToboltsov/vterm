// Drag-selection guard (v1.4): nothing on the page gets selected while
// something is dragged, and there is one mechanism for it — `holdSelection()`
// in actions/drag.ts, called on the press that may become a drag.
//
// Five drags used to defend themselves five ways: an unselectable overlay, a
// `select-none` on their own list, a `removeAllRanges()` once the drag was
// recognised — or nothing at all (a table column's border). None of it holds in
// WebKit, where a selection may begin inside an unselectable element and then
// runs over whatever text the pointer crosses: a terminal tab dragged across a
// panel selected the panel. The defect is invisible on a drag that happens to
// stay over its own strip, so a new drag written without the call looks fine.
//
//  1. Every file that tracks a pointer drag — it captures the pointer, or
//     follows `pointermove` on the window — holds the selection.
//  2. Nobody cleans a selection up after the fact (`removeAllRanges`): it is
//     refused where it starts instead. A cleanup is the mark of a drag that lets
//     the selection begin.
//  3. The stylesheet makes the page unselectable for the class the hold sets.
//
// Sources are read with comments stripped — the comments name the anti-patterns.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DRAGGING_CLASS } from "./actions/drag";

const SRC = join(process.cwd(), "src");
const DRAG = "lib/actions/drag.ts";

/** Drop `<!-- … -->` blocks (a scan: one regex pass leaves a nested opener behind). */
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

/** Source with comments removed — HTML, block and line (`://` is not a comment). */
function code(src: string): string {
  return stripHtmlComments(src)
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const raw = (rel: string): string => readFileSync(join(SRC, ...rel.split("/")), "utf8");

/** Every non-test source file under `src/`, as a path relative to it. */
function sources(dir = SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      acc.push(relative(SRC, full).split(sep).join("/"));
    }
  }
  return acc;
}

/** The file follows a pointer through a drag of its own. */
const TRACKS_DRAG = /setPointerCapture\(|addEventListener\(\s*["']pointermove["']/;

export function dragViolations(rel: string, source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  if (TRACKS_DRAG.test(c) && !/(?<![.\w])holdSelection\(\)/.test(c)) {
    out.push(`${rel} tracks a pointer drag without holdSelection() — it selects the page in WebKit`);
  }
  if (/removeAllRanges\(/.test(c)) {
    out.push(`${rel} cleans a selection up after the fact instead of refusing it`);
  }
  return out;
}

/** The resize handle — the drag most components get for free — holds it on the press. */
export function handleViolations(drag: string): string[] {
  const c = code(drag);
  const down = c.slice(c.indexOf("function down("), c.indexOf("function move("));
  const hold = down.indexOf("holdSelection();");
  const capture = down.indexOf("setPointerCapture(");
  return hold < 0 || capture < 0 || hold > capture
    ? ["resizableHandle does not hold the selection on the press"]
    : [];
}

export function styleViolations(css: string): string[] {
  const c = css.replace(/\/\*[^]*?\*\//g, "");
  const rule = new RegExp(
    `html\\.${DRAGGING_CLASS},\\s*html\\.${DRAGGING_CLASS} \\* \\{([^}]*)\\}`,
  ).exec(c)?.[1];
  if (rule === undefined) return ["app.css has no rule for a page that is being dragged over"];
  return /-webkit-user-select:\s*none;/.test(rule) && /(?<!-)user-select:\s*none;/.test(rule)
    ? []
    : ["the page stays selectable while something is dragged"];
}

describe("drag-selection guard", () => {
  it("every pointer drag holds the selection, and none cleans up after it", () => {
    const tracked = sources().filter((rel) => TRACKS_DRAG.test(code(raw(rel))));
    // The five drags there are: resize handles, terminal tabs, dock tabs, the
    // server tree, the file list. Fewer means the pattern above stopped matching.
    expect(tracked.length).toBeGreaterThanOrEqual(5);
    expect(sources().flatMap((rel) => dragViolations(rel, raw(rel)))).toEqual([]);
  });

  it("the resize handle holds it before it captures the pointer", () => {
    expect(handleViolations(raw(DRAG))).toEqual([]);
  });

  it("the stylesheet makes a dragged-over page unselectable", () => {
    expect(styleViolations(readFileSync(join(SRC, "app.css"), "utf8"))).toEqual([]);
  });
});

describe("drag-selection guard — catches what it exists for", () => {
  const TABDRAG = "lib/stores/tabdrag.svelte.ts";
  const tabdrag = raw(TABDRAG);
  const drag = raw(DRAG);
  const css = readFileSync(join(SRC, "app.css"), "utf8");

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a drag that does not hold the selection", () => {
    // (Every call of it: the store holds it on the press and again as it moves.)
    expect(tabdrag.includes("  holdSelection();\n")).toBe(true);
    expect(dragViolations(TABDRAG, tabdrag.replaceAll("  holdSelection();\n", ""))).toEqual([
      `${TABDRAG} tracks a pointer drag without holdSelection() — it selects the page in WebKit`,
    ]);
    // Importing it, or naming it in a comment, is not calling it.
    expect(
      dragViolations(TABDRAG, tabdrag.replaceAll("  holdSelection();\n", "  // holdSelection();\n")),
    ).toHaveLength(1);
  });

  it("a drag that lets the selection start and wipes it afterwards", () => {
    expect(
      dragViolations(
        TABDRAG,
        mutate(tabdrag, "  tabDrag.x = e.clientX;", "  window.getSelection()?.removeAllRanges();\n  tabDrag.x = e.clientX;"),
      ),
    ).toEqual([`${TABDRAG} cleans a selection up after the fact instead of refusing it`]);
  });

  it("a file with no drag of its own is not asked for anything", () => {
    expect(dragViolations("lib/x.ts", "export const a = 1;")).toEqual([]);
    expect(dragViolations("lib/x.svelte", '<div onpointerdown={() => go()}></div>')).toEqual([]);
  });

  it("a resize handle that no longer holds it, or holds it too late", () => {
    expect(handleViolations(mutate(drag, "    holdSelection();\n    node.setPointerCapture", "    node.setPointerCapture"))).toEqual([
      "resizableHandle does not hold the selection on the press",
    ]);
    expect(
      handleViolations(
        mutate(
          drag,
          "    holdSelection();\n    node.setPointerCapture(e.pointerId);\n",
          "    node.setPointerCapture(e.pointerId);\n    holdSelection();\n",
        ),
      ),
    ).toHaveLength(1);
  });

  it("a stylesheet that leaves the page selectable", () => {
    expect(styleViolations(mutate(css, "html.dragging,\nhtml.dragging * {", "html.other,\nhtml.other * {"))).toEqual([
      "app.css has no rule for a page that is being dragged over",
    ]);
    expect(
      styleViolations(mutate(css, "  -webkit-user-select: none;\n  user-select: none;\n", "  user-select: none;\n")),
    ).toEqual(["the page stays selectable while something is dragged"]);
  });
});
