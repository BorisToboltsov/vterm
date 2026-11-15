import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "./ghactions";
import { buildGitlab } from "./gitlabci";
import { DOTS, dotsOf } from "./pipedots";
import type { SourceSpan } from "./pipeline";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const wf = (file: string, text: string) => parseWorkflow(file, parseYaml(Y, text));
const repoFile = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function gitlab(text: string) {
  const FILE = "/r/.gitlab-ci.yml";
  const doc = parseYaml(Y, text);
  const spans = new Map<string, SourceSpan>();
  for (const k of doc.keys([])) spans.set(k, { file: FILE, ...doc.span([k])! });
  return buildGitlab({ file: FILE, config: doc.value as Obj, spans, files: [{ path: FILE, state: "read", detail: null }], problems: [] });
}

describe("dotsOf", () => {
  it("draws vterm's release as its schema stands: one column a level of needs", () => {
    const release = wf("/repo/.github/workflows/release.yml", repoFile(".github/workflows/release.yml"));
    const d = dotsOf(release);
    // tag → verify, deep → release → integrity: four columns, the second of two.
    const xs = [...new Set(d.dots.map((p) => p.x))];
    expect(xs).toHaveLength(4);
    expect(d.dots.filter((p) => p.x === xs[1]).map((p) => p.id).sort()).toEqual(["deep", "verify"]);
    expect(d.links.map((l) => `${l.from}>${l.to}`).sort()).toEqual([
      "deep>release",
      "release>integrity",
      "tag>deep",
      "tag>release",
      "tag>verify",
      "verify>release",
    ]);
    expect(d.hidden).toBe(0);
    expect(d.width).toBe(2 * DOTS.pad + 3 * DOTS.pitchX);
    expect(d.height).toBe(2 * DOTS.pad + DOTS.pitchY);
  });

  it("stands a shorter column in the middle of the tallest", () => {
    const p = wf("/w/a.yml", "on: push\njobs:\n  a: { steps: [] }\n  b: { steps: [] }\n  c: { steps: [] }\n  d: { needs: [a, b, c], steps: [] }\n");
    const d = dotsOf(p);
    const ys = Object.fromEntries(d.dots.map((x) => [x.id, x.y]));
    expect(ys.d).toBe(ys.b);
    expect(ys.a).toBeLessThan(ys.b);
  });

  it("gives GitLab its stages and only the needs it wrote", () => {
    const p = gitlab("stages: [build, test, deploy]\nb: { stage: build, script: [x] }\nt1: { stage: test, script: [x] }\nt2: { stage: test, needs: [b], script: [x] }\nd: { stage: deploy, script: [x] }\n");
    const d = dotsOf(p);
    expect(new Set(d.dots.map((x) => x.x)).size).toBe(3);
    expect(d.links.map((l) => `${l.from}>${l.to}`)).toEqual(["b>t2"]);
  });

  it("says how many jobs it left out instead of drawing them", () => {
    const jobs = Array.from({ length: 6 }, (_, i) => `  j${i}: { steps: [] }`).join("\n");
    const tall = dotsOf(wf("/w/t.yml", `on: push\njobs:\n${jobs}\n`));
    expect(tall.dots).toHaveLength(DOTS.rows);
    expect(tall.hidden).toBe(6 - DOTS.rows);
    const chain = Array.from({ length: 10 }, (_, i) => `  c${i}: { ${i ? `needs: [c${i - 1}], ` : ""}steps: [] }`).join("\n");
    const long = dotsOf(wf("/w/l.yml", `on: push\njobs:\n${chain}\n`));
    expect(long.dots).toHaveLength(DOTS.cols);
    expect(long.hidden).toBe(10 - DOTS.cols);
    expect(long.links).toHaveLength(DOTS.cols - 1);
  });

  it("draws nothing for a pipeline without jobs", () => {
    const d = dotsOf(wf("/w/e.yml", "on: push\njobs: {}\n"));
    expect(d.dots).toEqual([]);
    expect(d.width).toBe(2 * DOTS.pad);
  });
});
