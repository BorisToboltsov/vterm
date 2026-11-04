// The Git history's lines belong to the theme and to the layout model (v1.27).
//
// `gitlanes.test.ts` holds the model: a line keeps its lane and its colour. This
// holds the wiring around it, which no test of the model can see: a colour fixed in
// code is unreadable on a light theme (it was: 1.59:1 on Gruvbox Light); a colour
// taken from a lane's number paints every branch on that lane alike; a path built
// beside `edgePath` gives the list a second shape of turn.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), "src", rel), "utf8");

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

const code = (src: string): string =>
  stripHtmlComments(src)
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** What lets a line of the history take a colour or a shape from anywhere but the model. */
export function railViolations(component: string): string[] {
  const c = code(component);
  const out: string[] = [];
  if (/(stroke|fill)=["'{]\s*["'`]?#/.test(c) || /railColor\(/.test(c)) {
    out.push("a line's colour is fixed in the component");
  }
  if (!/`var\(--color-rail-\$\{color\}\)`/.test(c)) {
    out.push("a line's colour does not come from the theme's --color-rail-*");
  }
  if (/stroke=\{rail\((?:row\.col|edge\.(?:from|to))\)\}/.test(c)) {
    out.push("a line's colour is read off its lane");
  }
  if (!/d=\{edgePath\(edge,/.test(c)) {
    out.push("the edges are not drawn by edgePath");
  }
  return out;
}

/** What puts a hard-coded palette or a lane-numbered colour back into the model. */
export function modelViolations(model: string): string[] {
  const c = code(model);
  const out: string[] = [];
  if (/#[0-9a-f]{6}\b/i.test(c)) out.push("the model holds a colour value");
  if (/color:\s*\w*[cC]ol\b/.test(c) || /colou?r\w*\s*=\s*(?:my)?[cC]ol\b/.test(c)) {
    out.push("a colour is taken from a lane's number");
  }
  return out;
}

describe("the history's lines", () => {
  const graph = read("lib/git/GitGraph.svelte");
  const model = read("lib/git/gitlanes.ts");

  it("take their colour from the theme and their shape from the model", () => {
    expect(railViolations(graph)).toEqual([]);
    expect(modelViolations(model)).toEqual([]);
  });

  it("the old palette and lane colouring are gone from the argument builders too", () => {
    const git = code(read("lib/git/git.ts"));
    expect(git).not.toMatch(/RAIL_COLORS|railColor|buildGraph/);
  });

  it("every theme colour the list can ask for is declared for the first paint", () => {
    const css = read("app.css");
    for (let i = 0; i < 7; i++) expect(css).toMatch(new RegExp(`--color-rail-${i}:\\s*#`));
  });
});

describe("the guard catches what it exists for", () => {
  const graph = read("lib/git/GitGraph.svelte");
  const model = read("lib/git/gitlanes.ts");
  const mutate = (src: string, from: string, to: string): string => {
    expect(src, `the mutation no longer applies: ${from}`).toContain(from);
    return src.replace(from, to);
  };

  it("a colour written into the component", () => {
    expect(railViolations(mutate(graph, "stroke={rail(edge.color)}", 'stroke="#4aa3ff"'))).toEqual([
      "a line's colour is fixed in the component",
    ]);
  });
  it("the theme's variable replaced", () => {
    expect(railViolations(mutate(graph, "`var(--color-rail-${color})`", "`var(--color-accent)`"))).toEqual([
      "a line's colour does not come from the theme's --color-rail-*",
    ]);
  });
  it("a colour read off the lane", () => {
    expect(railViolations(mutate(graph, "stroke={rail(edge.color)}", "stroke={rail(edge.to)}"))).toEqual([
      "a line's colour is read off its lane",
    ]);
  });
  it("a path built beside the model", () => {
    expect(railViolations(mutate(graph, "d={edgePath(edge, cy, cy + H, x)}", "d={`M0 ${cy}L0 ${cy + H}`}"))).toEqual([
      "the edges are not drawn by edgePath",
    ]);
  });
  it("a palette put back into the model", () => {
    expect(modelViolations(`${model}\nconst RAILS = ["#4aa3ff"];`)).toEqual(["the model holds a colour value"]);
  });
  it("a colour derived from the lane in the model", () => {
    expect(modelViolations(mutate(model, "color = slots[col]!.color;", "color = col;"))).toEqual([
      "a colour is taken from a lane's number",
    ]);
  });
});
