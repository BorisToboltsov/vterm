import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "./ghactions";
import { buildGitlab } from "./gitlabci";
import type { Pipeline } from "./pipeline";
import {
  EVENT,
  groupFinish,
  groupOpenGate,
  groupRun,
  groupStep,
  laneProgress,
  currentWave,
  startGroup,
  type GroupPlayback,
  type GroupRun,
} from "./pipelanes";
import { playbackPhase } from "./pipeplay";
import { buildMap, startedBy } from "./pipemap";
import type { PipeEvent } from "./pipesim";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const wf = (file: string, text: string) => parseWorkflow(file, parseYaml(Y, text));
const gl = (file: string, text: string): Pipeline =>
  buildGitlab({ file, config: parseYaml(Y, text).value as Obj, spans: new Map(), files: [], problems: [] });
const tag: PipeEvent = { kind: "tag", ref: "v1.0.0", defaultBranch: "main" };
const push: PipeEvent = { kind: "push", ref: "main", defaultBranch: "main" };

/** vterm's own workflows, cut down: a tag runs Release, which calls CI and the deep checks. */
function vterm() {
  const ci = wf("/w/ci.yml", "name: CI\non: { push: { branches: [main] }, workflow_call: }\njobs:\n  web: { steps: [] }\n  rust: { steps: [] }\n  deps: { steps: [] }\n");
  const deep = wf("/w/deep.yml", "name: Deep\non: workflow_call\njobs:\n  fuzz: { steps: [] }\n  e2e: { steps: [] }\n");
  const release = wf(
    "/w/release.yml",
    `name: Release
on: { push: { tags: [v*] } }
jobs:
  tag: { steps: [] }
  verify: { needs: tag, uses: ./ci.yml }
  deep: { needs: tag, uses: ./deep.yml }
  release: { needs: [verify, deep], steps: [] }
  integrity: { needs: release, steps: [] }
`,
  );
  release.jobs[1].call!.pipeline = ci;
  release.jobs[2].call!.pipeline = deep;
  const train = wf("/w/train.yml", "name: Train\non: { push: { branches: [main] } }\njobs:\n  check: { steps: [] }\n  cut: { needs: check, environment: release, steps: [] }\n");
  return buildMap([ci, deep, release, train]);
}

const run = (map: ReturnType<typeof buildMap>, e: PipeEvent) => groupRun(map, e, startedBy(map, e));
const at = (r: GroupRun) => Object.fromEntries(r.nodes.map((n) => [n.key, n.wave]));
const kinds = (r: GroupRun) => r.links.map((l) => `${l.from} → ${l.to} ${l.kind}`);

/** Play to the end or to a gate: the jobs of each step. */
function playAll(r: GroupRun, from?: GroupPlayback): { steps: string[][]; pb: GroupPlayback } {
  let pb = from ?? startGroup(r);
  const steps: string[][] = [];
  for (let guard = 0; guard < 50; guard++) {
    const next = groupStep(r, pb);
    pb = next.pb;
    if (!next.started.length) break;
    steps.push(next.started);
    pb = groupFinish(r, pb, next.started);
  }
  return { steps, pb };
}

describe("groupRun", () => {
  it("lays a tag's run out by wave: the called pipelines in the middle of the caller", () => {
    const r = run(vterm(), tag);
    expect(r.lanes.map((l) => `${l.key} ${l.depth}`)).toEqual(["/w/release.yml 0", "/w/release.yml>verify 1", "/w/release.yml>deep 1"]);
    expect(r.lanes[1].start).toEqual({ kind: "call", lane: "/w/release.yml", job: "verify", waits: true });
    expect(at(r)).toEqual({
      "/w/release.yml#tag": 1,
      "/w/release.yml>verify#web": 2,
      "/w/release.yml>verify#rust": 2,
      "/w/release.yml>verify#deps": 2,
      "/w/release.yml>deep#fuzz": 2,
      "/w/release.yml>deep#e2e": 2,
      "/w/release.yml#release": 3,
      "/w/release.yml#integrity": 4,
    });
    expect(r.waves).toBe(4);
    // The call jobs are the lanes under them, not boxes of their own.
    expect(r.nodes.some((n) => n.job.id === "verify")).toBe(false);
    // CI and Deep run as Release's calls; only Train is left on the shelf.
    expect(r.idle).toEqual(["/w/train.yml"]);
    // Rows: three jobs of CI in one column, one under another.
    expect(r.nodes.filter((n) => n.lane === "/w/release.yml>verify").map((n) => n.row)).toEqual([0, 1, 2]);
  });

  it("links the event in, a call into its lane and back out of it", () => {
    const r = run(vterm(), tag);
    const k = kinds(r);
    expect(k).toContain(`${EVENT} → /w/release.yml#tag event`);
    expect(k).toContain("/w/release.yml#tag → /w/release.yml>verify#web call");
    expect(k).toContain("/w/release.yml#tag → /w/release.yml>deep#e2e call");
    expect(k).toContain("/w/release.yml>verify#deps → /w/release.yml#release return");
    expect(k).toContain("/w/release.yml>deep#fuzz → /w/release.yml#release return");
    expect(k).toContain("/w/release.yml#release → /w/release.yml#integrity need");
    expect(k.filter((l) => l.endsWith("#release return"))).toHaveLength(5);
  });

  it("runs pipelines side by side, each from the first wave", () => {
    const r = run(vterm(), push);
    expect(r.lanes.map((l) => l.key)).toEqual(["/w/ci.yml", "/w/train.yml"]);
    expect(at(r)["/w/train.yml#cut"]).toBe(2);
    expect(r.idle).toEqual(["/w/deep.yml", "/w/release.yml"]);
  });

  it("gives a pipeline called from two places a lane under each", () => {
    const lint = wf("/w/lint.yml", "on: workflow_call\njobs:\n  l: { steps: [] }\n");
    const ci = wf("/w/ci.yml", "on: push\njobs:\n  a: { uses: ./lint.yml }\n  b: { steps: [] }\n  c: { needs: b, uses: ./lint.yml }\n");
    ci.jobs[0].call!.pipeline = lint;
    ci.jobs[2].call!.pipeline = lint;
    const r = run(buildMap([ci]), push);
    expect(r.lanes.map((l) => l.key)).toEqual(["/w/ci.yml", "/w/ci.yml>a", "/w/ci.yml>c"]);
    expect(at(r)).toEqual({ "/w/ci.yml>a#l": 1, "/w/ci.yml#b": 1, "/w/ci.yml>c#l": 2 });
    // A call with nothing before it starts with the event.
    expect(kinds(r)).toContain(`${EVENT} → /w/ci.yml>a#l event`);
  });

  it("puts a workflow_run pipeline under the one whose end starts it", () => {
    const ci = wf("/w/ci.yml", "name: CI\non: push\njobs:\n  a: { steps: [] }\n  b: { needs: a, steps: [] }\n");
    const docs = wf("/w/docs.yml", "name: Docs\non: { workflow_run: { workflows: [CI] } }\njobs:\n  site: { steps: [] }\n");
    const r = run(buildMap([ci, docs]), push);
    expect(r.lanes.map((l) => `${l.key} ${l.start.kind}`)).toEqual(["/w/ci.yml event", "/w/ci.yml~/w/docs.yml after"]);
    expect(at(r)["/w/ci.yml~/w/docs.yml#site"]).toBe(3);
    expect(kinds(r)).toContain("/w/ci.yml#b → /w/ci.yml~/w/docs.yml#site after");
  });

  it("keeps a GitLab trigger job the parent does not wait for, and waits only with a strategy", () => {
    const child = gl("/r/ci/child.yml", "c1:\n  script: [x]\nc2:\n  needs: [c1]\n  script: [x]\n");
    const src = (strategy: string) => `stages: [build, deploy]
kick:
  stage: build
  trigger: { include: ci/child.yml${strategy} }
after:
  stage: deploy
  script: [x]
`;
    const loose = gl("/r/.gitlab-ci.yml", src(""));
    loose.jobs[0].call!.pipeline = child;
    const r = run(buildMap([loose]), push);
    expect(at(r)).toEqual({ "/r/.gitlab-ci.yml#kick": 1, "/r/.gitlab-ci.yml>kick#c1": 2, "/r/.gitlab-ci.yml>kick#c2": 3, "/r/.gitlab-ci.yml#after": 2 });
    expect(r.lanes[1].start).toMatchObject({ kind: "call", waits: false });
    expect(kinds(r)).toContain("/r/.gitlab-ci.yml#kick → /r/.gitlab-ci.yml>kick#c1 call");

    const strict = gl("/r/.gitlab-ci.yml", src(", strategy: depend"));
    strict.jobs[0].call!.pipeline = child;
    const s = run(buildMap([strict]), push);
    expect(at(s)).toEqual({ "/r/.gitlab-ci.yml>kick#c1": 1, "/r/.gitlab-ci.yml>kick#c2": 2, "/r/.gitlab-ci.yml#after": 3 });
  });

  it("keeps the gate of a waited-for call, and its lane after it", () => {
    const child = gl("/r/ci/child.yml", "c1:\n  script: [x]\n");
    const parent = gl("/r/.gitlab-ci.yml", "kick:\n  when: manual\n  allow_failure: false\n  trigger: { include: ci/child.yml, strategy: depend }\n");
    parent.jobs[0].call!.pipeline = child;
    const r = run(buildMap([parent]), push);
    expect(at(r)).toEqual({ "/r/.gitlab-ci.yml#kick": 1, "/r/.gitlab-ci.yml>kick#c1": 2 });
    expect(r.nodes[0].verdict.gate).toBe("manual");
  });

  it("names the jobs left out, shows the unknown without waiting for it", () => {
    const ci = wf(
      "/w/ci.yml",
      "on: push\njobs:\n  a: { steps: [] }\n  pr: { if: \"github.event_name == 'pull_request'\", steps: [] }\n  maybe: { needs: a, if: \"secrets.X != ''\", steps: [] }\n  b: { needs: a, steps: [] }\n",
    );
    const r = run(buildMap([ci]), push);
    expect(r.lanes[0].leftOut).toEqual(["pr"]);
    const maybe = r.nodes.find((n) => n.job.id === "maybe")!;
    expect(maybe.unsure).toBe(true);
    expect(maybe.wave).toBe(2);
    expect(startGroup(r).states[maybe.key]).toBe("unknown");
    expect(playAll(r).steps).toEqual([["/w/ci.yml#a"], ["/w/ci.yml#b"]]);
  });

  it("does not let a GitLab manual job allowed to fail hold the stages after it", () => {
    const p = gl("/r/.gitlab-ci.yml", "stages: [a, b]\nm:\n  stage: a\n  when: manual\n  script: [x]\nn:\n  stage: b\n  script: [x]\n");
    const r = run(buildMap([p]), push);
    expect(at(r)).toEqual({ "/r/.gitlab-ci.yml#m": 1, "/r/.gitlab-ci.yml#n": 1 });
    expect(r.links.filter((l) => l.to === "/r/.gitlab-ci.yml#n").map((l) => l.from)).toEqual([EVENT]);
  });

  it("stops at a call that loops back to its caller", () => {
    const a = wf("/w/a.yml", "on: [push, workflow_call]\njobs:\n  x: { uses: ./b.yml }\n");
    const b = wf("/w/b.yml", "on: workflow_call\njobs:\n  y: { uses: ./a.yml }\n");
    a.jobs[0].call!.pipeline = b;
    b.jobs[0].call!.pipeline = a;
    const r = run(buildMap([a]), push);
    expect(r.lanes.map((l) => l.key)).toEqual(["/w/a.yml", "/w/a.yml>x"]);
    expect(r.nodes.map((n) => n.key)).toEqual(["/w/a.yml>x#y"]);
  });
});

describe("playing a group run", () => {
  it("runs each wave in its column: the column is the turn", () => {
    const r = run(vterm(), tag);
    const { steps, pb } = playAll(r);
    expect(steps.map((s) => s.map((k) => r.nodes.find((n) => n.key === k)!.wave))).toEqual([[1], [2, 2, 2, 2, 2], [3], [4]]);
    expect(playbackPhase(pb)).toBe("done");
    expect(laneProgress(r, pb, "/w/release.yml")).toBe("ok");
  });

  it("stops at a gate, the rest goes on, and the person lets it go", () => {
    const r = run(vterm(), push);
    let pb = startGroup(r);
    let next = groupStep(r, pb);
    expect(next.started).toEqual(["/w/ci.yml#web", "/w/ci.yml#rust", "/w/ci.yml#deps", "/w/train.yml#check"]);
    pb = next.pb;
    expect(currentWave(r, pb)).toBe(1);
    expect(laneProgress(r, pb, "/w/train.yml")).toBe("run");
    pb = groupFinish(r, pb, next.started);
    // Between steps the run stands where it got to.
    expect(currentWave(r, pb)).toBe(1);
    next = groupStep(r, pb);
    expect(next.started).toEqual([]);
    pb = next.pb;
    expect(pb.states["/w/train.yml#cut"]).toBe("gate");
    expect(playbackPhase(pb)).toBe("waiting");
    expect(laneProgress(r, pb, "/w/train.yml")).toBe("wait");
    expect(groupStep(r, pb).pb).toBe(pb);
    pb = groupOpenGate(pb, "/w/train.yml#cut");
    expect(pb.states["/w/train.yml#cut"]).toBe("run");
    expect(groupOpenGate(pb, "/w/train.yml#cut")).toBe(pb);
    pb = groupFinish(r, pb, ["/w/train.yml#cut"]);
    expect(playbackPhase(pb)).toBe("done");
    // Done: the run stands at its last column.
    expect(currentWave(r, pb)).toBe(2);
  });

  it("marks a job allowed to fail as such, and says nothing of a lane before it plays", () => {
    const p = wf("/w/ci.yml", "on: push\njobs:\n  a: { continue-on-error: true, steps: [] }\n");
    const r = run(buildMap([p]), push);
    expect(laneProgress(r, null, "/w/ci.yml")).toBe("idle");
    expect(playAll(r).pb.states["/w/ci.yml#a"]).toBe("warn");
  });
});
