import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "./ghactions";
import { buildGitlab } from "./gitlabci";
import { cardLines, columnsOf, layoutMap, layoutPipeline, METRICS, roundedPath, startJobs, subLines } from "./pipelayout";
import type { Pipeline } from "./pipeline";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const gh = (text: string) => parseWorkflow("/r/.github/workflows/ci.yml", parseYaml(Y, text));
const gl = (text: string): Pipeline =>
  buildGitlab({ file: "/r/.gitlab-ci.yml", config: parseYaml(Y, text).value as Obj, spans: new Map(), files: [], problems: [] });

const CI = `on: push
jobs:
  lint: { steps: [] }
  test: { strategy: { matrix: { os: [a, b, c] } }, steps: [] }
  audit: { steps: [] }
  build: { needs: [lint, test], steps: [] }
  docker: { needs: build, steps: [] }
  e2e: { needs: build, steps: [] }
  prod: { needs: [docker, e2e], steps: [] }
  staging: { needs: [docker, e2e, audit], steps: [] }
`;

describe("roundedPath", () => {
  it("draws a straight line straight and rounds each turn by one radius", () => {
    expect(roundedPath([[0, 0], [10, 0]], 8)).toBe("M0 0 L10 0");
    expect(roundedPath([[0, 0], [20, 0], [20, 30], [40, 30]], 8)).toBe("M0 0 L12 0 A8 8 0 0 1 20 8 L20 22 A8 8 0 0 0 28 30 L40 30");
  });

  it("shrinks a turn on a short leg and drops repeated points", () => {
    expect(roundedPath([[0, 0], [20, 0], [20, 4], [40, 4]], 8)).toContain("A2 2");
    expect(roundedPath([[0, 0], [0, 0], [5, 0], [10, 0]], 8)).toBe("M0 0 L5 0 L10 0");
    expect(roundedPath([], 8)).toBe("");
  });
});

describe("columns", () => {
  it("puts a GitHub job as deep as its needs", () => {
    const { col, titles } = columnsOf(gh(CI), "links");
    expect(Object.fromEntries(col)).toEqual({ lint: 0, test: 0, audit: 0, build: 1, docker: 2, e2e: 2, prod: 3, staging: 3 });
    expect(titles).toHaveLength(4);
  });

  it("puts GitLab jobs in their stages, or by what they wait for", () => {
    const p = gl("stages: [build, test, empty, deploy]\na:\n  stage: build\n  script: [x]\nb:\n  stage: test\n  script: [x]\nc:\n  stage: deploy\n  needs: [a]\n  script: [x]\n");
    const stages = columnsOf(p, "stages");
    expect(stages.titles).toEqual(["build", "test", "deploy"]);
    expect(Object.fromEntries(stages.col)).toEqual({ a: 0, b: 1, c: 2 });
    expect(Object.fromEntries(columnsOf(p, "links").col)).toEqual({ a: 0, b: 1, c: 1 });
  });

  it("survives a loop of needs", () => {
    const { col } = columnsOf(gh("on: push\njobs:\n  a: { needs: b, steps: [] }\n  b: { needs: a, steps: [] }\n"), "links");
    expect(col.size).toBe(2);
  });
});

describe("layoutPipeline", () => {
  it("pulls a job level with what it waits on", () => {
    const l = layoutPipeline(gh(CI), { mode: "links", width: 700, open: new Set() });
    const row = (id: string) => l.nodes.get(id)!.row;
    expect([row("lint"), row("test"), row("audit")]).toEqual([0, 1, 2]);
    expect(row("build")).toBe(0);
    expect(row("docker")).toBe(0);
    expect(row("e2e")).toBe(1);
    expect(row("prod")).toBe(0);
    expect(row("staging")).toBe(1);
    expect(l.columns).toHaveLength(4);
    expect(l.width).toBe(700);
    expect(l.height).toBe(METRICS.top + 3 * METRICS.row + 6);
  });

  it("opens a matrix into more rows and pushes the rest down", () => {
    const l = layoutPipeline(gh(CI), { mode: "links", width: 700, open: new Set(["test"]) });
    const test = l.nodes.get("test")!;
    expect(test.h).toBe(METRICS.node + 3 * METRICS.sub + 6);
    expect(test.span).toBe(4);
    expect(l.nodes.get("audit")!.row).toBe(5);
  });

  it("joins a link to the next column with one turn, and runs a long one between rows", () => {
    const l = layoutPipeline(gh(CI), { mode: "links", width: 700, open: new Set() });
    const edge = (from: string, to: string) => l.edges.find((e) => e.from === from && e.to === to)!;
    expect(edge("lint", "build").d).not.toContain("A");
    expect(edge("test", "build").d.match(/A/g)).toHaveLength(2);
    const long = edge("audit", "staging").d;
    expect(long.match(/A/g)!.length).toBeGreaterThanOrEqual(3);
    // It runs in the gap between its own row and its target's, through no job.
    const gapY = METRICS.top + 2 * METRICS.row - (METRICS.row - METRICS.node) / 2 - 1;
    expect(long).toContain(` ${gapY} `);
  });

  it("widens the graph rather than squeeze its columns", () => {
    const l = layoutPipeline(gh(CI), { mode: "links", width: 200, open: new Set() });
    expect(l.width).toBe(2 * METRICS.padX + 4 * METRICS.minColumn + 3 * METRICS.gutter);
  });

  it("stacks a need within a stage under its job and draws GitLab's waits in the links view", () => {
    const p = gl(`stages: [build, deploy]
a:
  stage: build
  script: [x]
staging:
  stage: deploy
  needs: [a]
  script: [x]
review:
  stage: deploy
  script: [x]
prod:
  stage: deploy
  needs: [staging]
  script: [x]
`);
    const l = layoutPipeline(p, { mode: "stages", width: 500, open: new Set() });
    expect(l.nodes.get("prod")!.row).toBe(l.nodes.get("staging")!.row + 1);
    const down = l.edges.find((e) => e.from === "staging" && e.to === "prod")!;
    expect(down.d).toMatch(/^M\S+ \S+ L\S+ \S+$/);
    expect(l.columns.map((c) => c.title)).toEqual(["build", "deploy"]);
    const links = layoutPipeline(p, { mode: "links", width: 500, open: new Set() });
    expect(links.edges.filter((e) => e.implicit).map((e) => `${e.from}>${e.to}`)).toEqual(["a>review"]);
  });

  it("loops a same-stage need that is not right under, and draws one against the flow", () => {
    const p = gl(`stages: [build, test]
a:
  stage: test
  script: [x]
b:
  stage: test
  script: [x]
c:
  stage: test
  needs: [a]
  script: [x]
e:
  stage: test
  needs: [a]
  script: [x]
d:
  stage: build
  needs: [b]
  script: [x]
`);
    const l = layoutPipeline(p, { mode: "stages", width: 500, open: new Set() });
    expect(l.edges.find((e) => e.to === "c")!.d).not.toContain("A");
    expect(l.edges.find((e) => e.to === "e")!.d.match(/A/g)).toHaveLength(2);
    expect(l.edges.find((e) => e.to === "d")).toBeDefined();
  });

  it("shows the jobs a call runs under it", () => {
    const p = gh("on: push\njobs:\n  e2e: { uses: ./x.yml }\n");
    p.jobs[0].call!.pipeline = gh("on: workflow_call\njobs:\n  smoke: { steps: [] }\n  ui: { strategy: { matrix: { b: [1, 2] } }, steps: [] }\n");
    expect(subLines(p.jobs[0], false)).toEqual(["smoke", "ui ×2"]);
    const m = gh(CI).jobs[1];
    expect(subLines(m, false)).toEqual([]);
    expect(subLines(m, true)).toEqual(["a", "b", "c"]);
  });
});

describe("layoutMap", () => {
  it("puts events beside the pipelines they start and called ones on the right", () => {
    const l = layoutMap({
      cards: [
        { id: "ci", called: false, lines: 1 },
        { id: "release", called: false, lines: 2 },
        { id: "e2e", called: true, lines: 1 },
      ],
      events: [
        { id: "push", to: ["ci"] },
        { id: "tag", to: ["release"] },
        { id: "none", to: [] },
      ],
      calls: [
        { from: "ci", to: "e2e" },
        { from: "release", to: "ci" },
        { from: "x", to: "ci" },
      ],
      width: 300,
    });
    const ci = l.cards.get("ci")!;
    const e2e = l.cards.get("e2e")!;
    expect(e2e.x).toBeGreaterThan(ci.x);
    expect(e2e.y).toBe(ci.y);
    expect(l.events.get("push")!.y).toBeLessThan(l.events.get("tag")!.y);
    expect(l.links.map((k) => k.key)).toEqual(["ev:push|ci", "ev:tag|release", "ci|e2e", "release|ci"]);
    expect(l.links.filter((k) => k.call)).toHaveLength(2);
    expect(l.width).toBeGreaterThan(300);
    expect(l.height).toBeGreaterThan(l.cards.get("release")!.y);
  });
});

describe("the events on the left", () => {
  it("stand level with the jobs the pipeline starts with, and share one bus to them", () => {
    const p = gh(CI);
    expect(startJobs(p).map((j) => j.id)).toEqual(["lint", "test", "audit"]);
    const l = layoutPipeline(p, { mode: "links", width: 900, open: new Set(), events: ["0", "1"] });
    const [a, b] = [l.events.get("0")!, l.events.get("1")!];
    expect(a.x).toBe(METRICS.padX);
    expect(b.y - a.y).toBe(METRICS.eventH + METRICS.eventGap);
    // The jobs move right to make room.
    expect(l.nodes.get("lint")!.x).toBe(METRICS.padX + METRICS.event + METRICS.gutter);
    expect(l.triggers.map((x) => `${x.event}>${x.to}`)).toEqual(["0>lint", "0>test", "0>audit", "1>lint", "1>test", "1>audit"]);
    const bus = METRICS.padX + METRICS.event + METRICS.gutter / 2;
    for (const tr of l.triggers) expect(tr.d).toContain(`L${bus} `);
  });

  it("reach a job that starts in a later stage between the rows", () => {
    const p = gl("stages: [a, b]\nx:\n  stage: a\n  script: [x]\ny:\n  stage: b\n  needs: []\n  script: [x]\n");
    const l = layoutPipeline(p, { mode: "stages", width: 600, open: new Set(), events: ["e"] });
    expect(l.triggers.map((x) => x.to)).toEqual(["x", "y"]);
    expect(l.triggers[1].d.match(/A/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("make the graph tall enough for themselves", () => {
    const p = gh("on: push\njobs:\n  a: { steps: [] }\n");
    const l = layoutPipeline(p, { mode: "links", width: 600, open: new Set(), events: ["0", "1", "2", "3"] });
    const last = l.events.get("3")!;
    expect(l.height).toBeGreaterThanOrEqual(last.y + last.h);
  });
});

describe("column width", () => {
  it("stops at a card's width however wide the window is", () => {
    const l = layoutPipeline(gh("on: push\njobs:\n  a: { steps: [] }\n  b: { steps: [] }\n"), { mode: "links", width: 1600, open: new Set() });
    expect(l.nodes.get("a")!.w).toBe(METRICS.maxColumn);
    expect(l.width).toBe(1600);
  });
});

describe("cardLines", () => {
  it("wraps job names as the card does, a long name on a line of its own", () => {
    expect(cardLines(["lint", "test", "build"], false)).toBe(1);
    expect(cardLines(["Фронтенд (типы, тесты, сборка)", "rust", "Зависимости (cargo deny, pnpm audit)"], false)).toBe(3);
    expect(cardLines([], false)).toBe(1);
    expect(cardLines(["a".repeat(30), "b".repeat(30)], true)).toBe(2);
  });
});

describe("the map at the interface scale", () => {
  const input = {
    cards: [
      { id: "ci", called: false, lines: 3 },
      { id: "e2e", called: true, lines: 1 },
    ],
    events: [{ id: "push", to: ["ci"] }],
    calls: [{ from: "ci", to: "e2e" }],
    width: 100,
  };

  it("grows its cards with the text they hold: a header and 18 px a line at 100 %", () => {
    const plain = layoutMap(input);
    expect(plain.cards.get("ci")!.h).toBe(32 + 3 * 18);
    const big = layoutMap({ ...input, scale: 1.25 });
    for (const key of ["x", "y", "w", "h"] as const) {
      expect(big.cards.get("ci")![key]).toBeCloseTo(plain.cards.get("ci")![key] * 1.25);
      expect(big.events.get("push")![key]).toBeCloseTo(plain.events.get("push")![key] * 1.25);
    }
    expect(big.height).toBeGreaterThan(plain.height);
  });
});
