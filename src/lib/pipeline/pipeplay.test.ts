import { beforeAll, describe, expect, it } from "vitest";
import { buildGitlab } from "./gitlabci";
import type { Pipeline } from "./pipeline";
import { finishJobs, nextWave, openGate, planStates, playbackPhase, startPlayback, type Playback } from "./pipeplay";
import { planFor, type Plan } from "./pipesim";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const gl = (text: string): Pipeline =>
  buildGitlab({ file: "/r/.gitlab-ci.yml", config: parseYaml(Y, text).value as Obj, spans: new Map(), files: [], problems: [] });
const push = { kind: "push" as const, ref: "main", defaultBranch: "main" };

/** Play to the end (or to a gate): the jobs of each wave. */
function play(p: Pipeline, plan: Plan, from?: Playback): { waves: string[][]; pb: Playback } {
  let pb = from ?? startPlayback(plan);
  const waves: string[][] = [];
  for (let guard = 0; guard < 50; guard++) {
    const next = nextWave(p, plan, pb);
    pb = next.pb;
    if (!next.started.length) break;
    waves.push(next.started);
    pb = finishJobs(plan, pb, next.started);
  }
  return { waves, pb };
}

describe("playback", () => {
  const cfg = `stages: [build, test, deploy]
a:
  stage: build
  script: [x]
b:
  stage: build
  script: [x]
fast:
  stage: test
  needs: [a]
  script: [x]
slow:
  stage: test
  allow_failure: true
  script: [x]
deploy:
  stage: deploy
  when: manual
  script: [x]
after:
  stage: deploy
  needs: [deploy]
  script: [x]
skipped:
  stage: deploy
  rules: [{ if: $CI_COMMIT_TAG }]
  script: [x]
maybe:
  stage: test
  rules: [{ changes: [x] }]
  script: [x]
`;

  it("starts what the plan says before anything runs", () => {
    const plan = planFor(gl(cfg), push);
    expect(planStates(plan)).toMatchObject({ a: "idle", skipped: "skip", maybe: "unknown" });
    expect(startPlayback(plan).states).toMatchObject({ a: "wait", skipped: "skip", maybe: "unknown" });
  });

  it("starts a wave of every job whose dependencies are done", () => {
    const p = gl(cfg);
    const plan = planFor(p, push);
    const { waves, pb } = play(p, plan);
    expect(waves).toEqual([["a", "b"], ["fast", "slow"]]);
    expect(pb.states).toMatchObject({ slow: "warn", fast: "ok", deploy: "gate", after: "wait" });
    expect(pb.wave).toBe(2);
    expect(playbackPhase(pb)).toBe("waiting");
  });

  it("goes on once the person lets the gate go", () => {
    const p = gl(cfg);
    const plan = planFor(p, push);
    let { pb } = play(p, plan);
    pb = openGate(pb, "deploy");
    expect(pb.states.deploy).toBe("run");
    expect(playbackPhase(pb)).toBe("running");
    pb = finishJobs(plan, pb, ["deploy"]);
    const rest = play(p, plan, pb);
    expect(rest.waves).toEqual([["after"]]);
    expect(playbackPhase(rest.pb)).toBe("done");
    expect(openGate(rest.pb, "after")).toBe(rest.pb);
  });

  it("lets the stages after a manual job go on when it may be skipped past", () => {
    const p = gl(`stages: [a, b]
m:
  stage: a
  when: manual
  script: [x]
n:
  stage: b
  script: [x]
`);
    const plan = planFor(p, push);
    const { waves, pb } = play(p, plan);
    expect(waves).toEqual([["n"]]);
    expect(pb.states.m).toBe("gate");
  });

  it("holds the stages after a manual job a rule made blocking", () => {
    const p = gl(`stages: [a, b]
m:
  stage: a
  rules: [{ when: manual }]
  script: [x]
n:
  stage: b
  script: [x]
`);
    const { waves, pb } = play(p, planFor(p, push));
    expect(waves).toEqual([]);
    expect(pb.states).toMatchObject({ m: "gate", n: "wait" });
  });

  it("finishes nothing that is not running", () => {
    const plan = planFor(gl(cfg), push);
    const pb = startPlayback(plan);
    expect(finishJobs(plan, pb, ["a"]).states.a).toBe("wait");
  });
});
