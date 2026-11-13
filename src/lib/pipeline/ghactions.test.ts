import { beforeAll, describe, expect, it } from "vitest";
import { compositeSteps, expandMatrix, needsCycle, parseTriggers, parseWorkflow, stepLine } from "./ghactions";
import { loadYaml, parseYaml, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const FILE = "/r/.github/workflows/ci.yml";
const wf = (text: string) => parseWorkflow(FILE, parseYaml(Y, text));

describe("parseTriggers", () => {
  it("reads a name, a list and a map of events", () => {
    expect(parseTriggers("push").map((t) => t.event)).toEqual(["push"]);
    expect(parseTriggers(["push", "pull_request"]).map((t) => t.event)).toEqual(["push", "pull_request"]);
    expect(parseTriggers(42)).toEqual([]);
    const [push, pr, cron, dispatch, run] = parseTriggers({
      push: { branches: ["main"], tags: "v*", "paths-ignore": ["docs/**"] },
      pull_request: { "branches-ignore": ["wip/**"], types: ["opened"] },
      schedule: [{ cron: "0 3 * * 1" }, { nope: 1 }],
      workflow_dispatch: { inputs: { env: { default: "staging" }, other: {} } },
      workflow_run: { workflows: ["CI"], types: ["completed"] },
    });
    expect(push).toMatchObject({ branches: ["main"], tags: ["v*"], paths: true, branchesIgnore: null });
    expect(pr).toMatchObject({ branchesIgnore: ["wip/**"], types: ["opened"], paths: false });
    expect(cron.crons).toEqual(["0 3 * * 1"]);
    expect(dispatch.inputs).toEqual({ env: "staging" });
    expect(run.workflows).toEqual(["CI"]);
  });

  it("keeps an event with no filters as one that fires on anything", () => {
    expect(parseTriggers({ push: null })[0]).toMatchObject({ event: "push", branches: null, tags: null });
  });
});

describe("expandMatrix", () => {
  it("makes the product of the axes", () => {
    expect(expandMatrix({ os: ["ubuntu", "macos"], node: [20, 22] })).toEqual({
      items: ["ubuntu · 20", "ubuntu · 22", "macos · 20", "macos · 22"],
      axes: "os × node",
    });
  });

  it("drops what `exclude` matches and adds or extends with `include`", () => {
    const m = expandMatrix({
      os: ["ubuntu", "windows"],
      node: [20, 22],
      exclude: [{ os: "windows", node: 20 }],
      include: [{ os: "ubuntu", experimental: true }, { os: "macos", node: 22 }],
    });
    expect(m?.items).toEqual(["ubuntu · 20", "ubuntu · 22", "windows · 22", "macos · 22"]);
    expect(m?.axes).toBe("os × node + include");
  });

  it("takes a matrix of only `include` entries as they are", () => {
    expect(expandMatrix({ include: [{ a: 1 }, { a: 2, b: "x" }] })?.items).toEqual(["1", "2 · x"]);
  });

  it("gives no copies for a matrix from an expression", () => {
    expect(expandMatrix("${{ fromJSON(needs.plan.outputs.m) }}")).toEqual({ items: null, axes: "${{ fromJSON(needs.plan.outputs.m) }}" });
    expect(expandMatrix({ os: "${{ fromJSON(x) }}" })?.items).toBeNull();
    expect(expandMatrix({ os: ["a"], include: "${{ x }}" })?.items).toBeNull();
    expect(expandMatrix(undefined)).toBeNull();
  });
});

describe("stepLine", () => {
  it("prefers the name, then what the step runs or uses", () => {
    expect(stepLine({ name: "Build it", run: "make" })).toBe("Build it");
    expect(stepLine({ uses: "actions/checkout@v4" })).toBe("uses: actions/checkout@v4");
    expect(stepLine({ run: "\nmake\nmake test" })).toBe("make");
    expect(stepLine({})).toBe("—");
    expect(stepLine("x")).toBe("—");
  });
});

describe("parseWorkflow", () => {
  const text = `name: CI
on:
  push: { branches: [main] }
  pull_request:
env: { MODE: fast }
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm lint
  test:
    name: Test \${{ matrix.os }}
    strategy:
      matrix: { os: [a, b] }
    continue-on-error: true
    env: { CI: "1" }
    steps: [{ run: pnpm test }]
  e2e:
    needs: [lint, test]
    uses: ./.github/workflows/e2e.yml
  deploy:
    name: Deploy
    needs: e2e
    if: github.ref == 'refs/heads/main'
    environment: { name: production, url: https://x }
    uses: org/infra/.github/workflows/deploy.yml@v1
`;

  it("reads jobs with their needs, matrix, calls and lines", () => {
    const p = wf(text);
    expect(p.name).toBe("CI");
    expect(p.kind).toBe("github");
    expect(p.variables).toEqual({ MODE: "fast" });
    expect(p.jobs.map((j) => j.id)).toEqual(["lint", "test", "e2e", "deploy"]);
    const [lint, test, e2e, deploy] = p.jobs;
    expect(lint.steps).toEqual(["uses: actions/checkout@v4", "pnpm lint"]);
    expect(lint.needs).toBeNull();
    expect(lint.span).toEqual({ file: FILE, line: 7, endLine: 11 });
    expect(test.name).toBe("test");
    expect(test.matrix?.items).toEqual(["a", "b"]);
    expect(test.allowFailure).toBe(true);
    expect(test.vars).toEqual({ CI: "1" });
    expect(e2e.needs).toEqual([{ job: "lint", optional: false }, { job: "test", optional: false }]);
    expect(e2e.call).toEqual({ file: "./.github/workflows/e2e.yml", pipeline: null, missing: null });
    expect(deploy.name).toBe("Deploy");
    expect(deploy.condition).toBe("github.ref == 'refs/heads/main'");
    expect(deploy.environment).toBe("production");
    expect(deploy.call?.missing).toBe("external");
    expect(wf("on: push\njobs:\n  v: { uses: $/.github/workflows/ci.yml }\n").jobs[0].call?.missing).toBeNull();
    expect(p.problems.map((x) => x.code)).toEqual(["callExternal"]);
    expect(p.files.map((f) => f.state)).toEqual(["read", "external"]);
    expect(p.callable).toBe(false);
  });

  it("reports needs that name nothing and needs that close a loop", () => {
    const p = wf("on: push\njobs:\n  a: { needs: b, steps: [] }\n  b: { needs: a, steps: [] }\n  c: { needs: zz, steps: [] }\n");
    const codes = p.problems.map((x) => `${x.code}:${x.params.job}`);
    expect(codes).toContain("needsUnknown:c");
    expect(codes).toContain("needsCycle:a");
    expect(codes).toContain("needsCycle:b");
  });

  it("reports a matrix from an expression, a file that is not a map, and one with no jobs", () => {
    expect(wf("on: push\njobs:\n  t: { strategy: { matrix: '${{ x }}' }, steps: [] }\n").problems[0].code).toBe("matrixExpr");
    expect(wf("- a\n- b\n").problems[0].code).toBe("notMap");
    expect(wf("on: push\n").problems[0].code).toBe("noJobs");
    const bad = wf("on: [push\n");
    expect(bad.problems[0].code).toBe("yaml");
    expect(bad.jobs).toEqual([]);
  });

  it("calls a workflow reusable when `workflow_call` is all that starts it", () => {
    expect(wf("on: { workflow_call: { inputs: { a: { default: x } } } }\njobs:\n  a: { steps: [] }\n").callable).toBe(true);
    expect(wf("on: [workflow_call, push]\njobs:\n  a: { steps: [] }\n").callable).toBe(false);
  });
});

describe("needsCycle", () => {
  it("names only the jobs on the loop", () => {
    const jobs = [
      { id: "a", needs: [{ job: "b", optional: false }] },
      { id: "b", needs: [{ job: "c", optional: false }] },
      { id: "c", needs: [{ job: "b", optional: false }] },
      { id: "d", needs: null },
    ];
    expect(needsCycle(jobs).sort()).toEqual(["b", "c"]);
  });
});

describe("compositeSteps", () => {
  it("reads a composite action's steps", () => {
    expect(compositeSteps(parseYaml(Y, "runs:\n  using: composite\n  steps:\n    - name: Setup\n    - run: echo\n"))).toEqual(["Setup", "echo"]);
    expect(compositeSteps(parseYaml(Y, "runs:\n  using: composite\n"))).toEqual([]);
    expect(compositeSteps(parseYaml(Y, "runs:\n  using: node20\n  main: x.js\n"))).toBeNull();
  });
});
