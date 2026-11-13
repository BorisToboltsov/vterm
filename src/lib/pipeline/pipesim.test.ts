import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "./ghactions";
import { buildGitlab } from "./gitlabci";
import type { Pipeline, SourceSpan } from "./pipeline";
import { eventPresets, planFor, runDeps, sampleRef, type PipeEvent } from "./pipesim";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const gh = (text: string) => parseWorkflow("/r/.github/workflows/ci.yml", parseYaml(Y, text));
function gl(text: string): Pipeline {
  const doc = parseYaml(Y, text);
  const spans = new Map<string, SourceSpan>();
  return buildGitlab({ file: "/r/.gitlab-ci.yml", config: doc.value as Obj, spans, files: [], problems: [] });
}
const ev = (kind: PipeEvent["kind"], ref = "main"): PipeEvent => ({ kind, ref, defaultBranch: "main" });
const runs = (p: Pipeline, e: PipeEvent) => Object.fromEntries([...planFor(p, e).jobs].map(([id, v]) => [id, v.run]));

describe("sampleRef and presets", () => {
  it("makes a name a filter accepts", () => {
    expect(sampleRef("main", "x")).toBe("main");
    expect(sampleRef("v*", "x")).toBe("v1.0.0");
    expect(sampleRef("release/**", "x")).toBe("release/1.0.0");
    expect(sampleRef("v[0-9]+.[0-9]+", "v9")).toBe("v1.1");
    expect(sampleRef("!wip", "main")).toBe("main");
    expect(sampleRef(undefined, "main")).toBe("main");
    expect(sampleRef("a?b", "z")).toBe("a1b");
  });

  it("offers the events a workflow names", () => {
    const p = gh(`on:
  push: { branches: [develop], tags: [v*] }
  pull_request: { branches: [main] }
  schedule: [{ cron: '0 3 * * *' }]
  workflow_dispatch:
  workflow_call:
jobs:
  a: { steps: [] }
`);
    expect(eventPresets(p).map((e) => `${e.kind}:${e.ref}`)).toEqual(["push:develop", "tag:v1.0.0", "pr:main", "schedule:main", "manual:main", "call:main"]);
    expect(eventPresets(gh("on: { push: { tags: [v*] } }\njobs:\n  a: { steps: [] }\n")).map((e) => e.kind)).toEqual(["tag"]);
    expect(eventPresets(gh("on: [issues]\njobs:\n  a: { steps: [] }\n")).map((e) => e.kind)).toEqual(["push"]);
    expect(eventPresets(gl("j:\n  script: [x]\n"), "trunk").map((e) => `${e.kind}:${e.ref}`)).toEqual([
      "push:trunk",
      "pr:trunk",
      "tag:v1.0.0",
      "schedule:trunk",
      "manual:trunk",
    ]);
  });
});

describe("GitHub", () => {
  const ci = `on:
  push: { branches: [main], tags: [v*] }
  pull_request:
  workflow_dispatch: { inputs: { target: { default: staging } } }
env: { STAGE: prod }
jobs:
  lint: { steps: [] }
  docker:
    needs: lint
    if: github.event_name == 'push'
    steps: []
  staging:
    needs: [docker]
    if: github.ref == 'refs/heads/main'
    environment: staging
    steps: []
  prod:
    needs: [docker]
    if: startsWith(github.ref, 'refs/tags/v')
    environment: production
    continue-on-error: true
    steps: []
  notify:
    needs: [staging]
    if: always()
    steps: []
  report:
    needs: [staging]
    if: \${{ always() && needs.staging.result == 'skipped' }}
    steps: []
  secret:
    if: secrets.TOKEN != ''
    steps: []
  manual:
    if: inputs.target == 'staging' && env.STAGE == 'prod'
    steps: []
`;

  it("plays a push to main", () => {
    const p = gh(ci);
    const plan = planFor(p, ev("push"));
    expect(plan.created).toBe(true);
    expect(plan.reason?.code).toBe("triggerOn");
    expect(runs(p, ev("push"))).toEqual({ lint: true, docker: true, staging: true, prod: false, notify: true, report: false, secret: "?", manual: "?" });
    expect(plan.jobs.get("staging")?.gate).toBe("approval");
    expect(plan.jobs.get("prod")?.reason).toEqual({ code: "condFalse", params: { cond: "startsWith(github.ref, 'refs/tags/v')" } });
    expect(plan.jobs.get("secret")?.reason).toEqual({ code: "condUnknown", params: { cond: "secrets.TOKEN != ''", what: "secrets.TOKEN" } });
  });

  it("skips a job whose need was skipped unless its if asks for it", () => {
    const p = gh(ci);
    const plan = planFor(p, ev("pr"));
    expect(plan.jobs.get("docker")?.run).toBe(false);
    expect(plan.jobs.get("staging")?.reason).toEqual({ code: "needSkipped", params: { need: "docker" } });
    expect(plan.jobs.get("notify")?.run).toBe(true);
    expect(plan.jobs.get("report")?.run).toBe(true);
  });

  it("reads input defaults on a manual run", () => {
    const p = gh(ci);
    expect(planFor(p, ev("manual")).jobs.get("manual")?.run).toBe(true);
    expect(planFor(p, ev("tag", "v2.0.0")).jobs.get("prod")).toMatchObject({ run: true, allowFailure: true, gate: "approval" });
  });

  it("does not start for a push the filters leave out", () => {
    const p = gh(ci);
    const plan = planFor(p, ev("push", "feature/x"));
    expect(plan.created).toBe(false);
    expect(plan.reason).toEqual({ code: "triggerOff", params: { event: "push" } });
    expect([...plan.jobs.values()].every((v) => v.run === false)).toBe(true);
    expect(planFor(p, ev("schedule")).created).toBe(false);
  });

  it("tells branch filters from tag filters", () => {
    const tagsOnly = gh("on: { push: { tags: [v*] } }\njobs:\n  a: { steps: [] }\n");
    expect(planFor(tagsOnly, ev("push")).created).toBe(false);
    expect(planFor(tagsOnly, ev("tag", "v1")).created).toBe(true);
    expect(planFor(tagsOnly, ev("tag", "x1")).created).toBe(false);
    const ignore = gh("on: { push: { branches-ignore: [wip/**], tags-ignore: [rc*] }, pull_request: { branches-ignore: [old] } }\njobs:\n  a: { steps: [] }\n");
    expect(planFor(ignore, ev("push", "wip/a")).created).toBe(false);
    expect(planFor(ignore, ev("push", "main")).created).toBe(true);
    expect(planFor(ignore, ev("tag", "rc1")).created).toBe(false);
    expect(planFor(ignore, ev("pr", "old")).created).toBe(false);
    const prOnly = gh("on: { pull_request: { branches: [main] } }\njobs:\n  a: { steps: [] }\n");
    expect(planFor(prOnly, ev("pr", "dev")).created).toBe(false);
  });

  it("cannot say whether a paths filter lets the push in", () => {
    const p = gh("on: { push: { paths: [src/**] } }\njobs:\n  a: { steps: [] }\n  b: { needs: a, steps: [] }\n");
    const plan = planFor(p, ev("push"));
    expect(plan.created).toBe("?");
    expect(plan.reason?.code).toBe("triggerPaths");
    expect(runs(p, ev("push"))).toEqual({ a: "?", b: "?" });
  });

  it("plays a reusable workflow as called, with the caller's context unknown", () => {
    const p = gh("on: workflow_call\njobs:\n  a: { if: github.event_name == 'push', steps: [] }\n  b: { needs: a, steps: [] }\n");
    expect(planFor(p, ev("push")).reason?.code).toBe("calledOnly");
    const called = planFor(p, ev("call"), true);
    expect(called.created).toBe(true);
    expect(called.jobs.get("a")?.run).toBe("?");
    expect(called.jobs.get("b")?.reason.code).toBe("needUnknown");
  });

  it("names an if it cannot parse", () => {
    const p = gh("on: push\njobs:\n  a: { if: \"github.ref ==\", steps: [] }\n");
    expect(planFor(p, ev("push")).jobs.get("a")?.reason.code).toBe("condInvalid");
  });

  it("reads contexts in any case and the pull request's base", () => {
    const p = gh("on: [push, pull_request]\njobs:\n  a: { if: GitHub.Event_Name == 'push', steps: [] }\n  b: { if: github.event.pull_request.base.ref == 'main', steps: [] }\n  c: { if: github.head_ref == 'x', steps: [] }\n");
    expect(runs(p, ev("push"))).toEqual({ a: true, b: false, c: false });
    expect(runs(p, ev("pr"))).toEqual({ a: false, b: true, c: "?" });
  });
});

describe("GitLab", () => {
  const cfg = `stages: [build, test, security, deploy]
build:
  stage: build
  script: [x]
rspec:
  stage: test
  needs: [build]
  script: [x]
sast:
  stage: security
  allow_failure: true
  script: [x]
deps:
  stage: security
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - changes: [Gemfile.lock]
  script: [x]
review:
  stage: deploy
  needs: [build]
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script: [x]
staging:
  stage: deploy
  needs: [rspec]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script: [x]
prod:
  stage: deploy
  needs: [staging]
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: manual
    - if: $CI_COMMIT_TAG
      when: manual
  script: [x]
cleanup:
  stage: deploy
  when: on_failure
  script: [x]
`;

  it("plays a push to the default branch", () => {
    const p = gl(cfg);
    const plan = planFor(p, ev("push"));
    expect(plan.created).toBe(true);
    expect(runs(p, ev("push"))).toEqual({ build: true, rspec: true, sast: true, deps: "?", review: false, staging: true, prod: true, cleanup: false });
    expect(plan.jobs.get("prod")).toMatchObject({ gate: "manual", allowFailure: false, reason: { code: "ruleMatched", params: { n: 1, when: "manual" } } });
    expect(plan.jobs.get("deps")?.reason).toEqual({ code: "ruleUnknown", params: { n: 2, what: "changes" } });
    expect(plan.jobs.get("cleanup")?.reason.code).toBe("onFailure");
    expect(plan.jobs.get("sast")?.allowFailure).toBe(true);
  });

  it("refuses the pipeline when a need is left out", () => {
    const plan = planFor(gl(cfg), ev("tag", "v1.0.0"));
    expect(plan.invalid).toBe(true);
    expect(plan.created).toBe(false);
    expect(plan.jobs.get("prod")).toMatchObject({ error: true, run: false, reason: { code: "needMissing", params: { need: "staging" } } });
  });

  it("leaves jobs without rules out of a merge request pipeline", () => {
    const p = gl(cfg);
    const plan = planFor(p, ev("pr"));
    expect(plan.jobs.get("build")?.reason).toEqual({ code: "defaultRefs", params: { refs: "branches, tags" } });
    // review needs build, which is not in a merge request pipeline.
    expect(plan.jobs.get("review")).toMatchObject({ error: true, reason: { code: "needMissing", params: { need: "build" } } });
    expect(plan.invalid).toBe(true);
  });

  it("follows workflow rules", () => {
    const wf = (rules: string) => gl(`workflow:\n  rules:\n${rules}\nj:\n  script: [x]\n`);
    expect(planFor(wf('    - if: $CI_PIPELINE_SOURCE == "schedule"'), ev("push"))).toMatchObject({ created: false, reason: { code: "workflowNone" } });
    expect(planFor(wf("    - if: $CI_COMMIT_TAG\n      when: never\n    - when: always"), ev("tag", "v1"))).toMatchObject({ created: false, reason: { code: "workflowNever", params: { n: 1 } } });
    expect(planFor(wf("    - if: $DEPLOY"), ev("push"))).toMatchObject({ created: "?", reason: { code: "workflowUnknown", params: { n: 1, what: "$DEPLOY" } } });
    expect(planFor(wf("    - if: $CI_COMMIT_BRANCH"), ev("push"))).toMatchObject({ created: true, reason: { code: "workflowRule", params: { n: 1 } } });
    expect(planFor(wf("    - if: $CI_COMMIT_BRANCH"), ev("push"), true).reason).toBeNull();
  });

  it("reads only and except", () => {
    const p = gl(`a:
  only: [main, /^release-/]
  script: [x]
b:
  except: [tags]
  script: [x]
c:
  only: { refs: [branches], variables: [$DEPLOY == "1"] }
  script: [x]
d:
  only: { refs: [merge_requests], changes: [x] }
  script: [x]
e:
  only: [schedules, web]
  script: [x]
f:
  only: ["/(a+)+$/"]
  script: [x]
g:
  only: { variables: [$CI_COMMIT_TAG] }
  except: { refs: [main], changes: [a] }
  script: [x]
`);
    expect(runs(p, ev("push", "release-1"))).toMatchObject({ a: true, b: true, c: "?", e: false, f: "?" });
    expect(runs(p, ev("push", "dev"))).toMatchObject({ a: false, f: "?" });
    expect(runs(p, ev("tag", "v1"))).toMatchObject({ b: false, g: true });
    expect(runs(p, ev("pr"))).toMatchObject({ a: false, d: "?", e: false });
    expect(runs(p, ev("schedule"))).toMatchObject({ e: true, g: false });
    expect(runs(p, ev("manual"))).toMatchObject({ e: true });
    expect(planFor(p, ev("push", "main")).jobs.get("g")?.run).toBe(false);
  });

  it("reads job variables, rules that say never, and manual jobs left to fail", () => {
    const p = gl(`variables: { TARGET: prod, DYN: $CI_COMMIT_SHA }
a:
  variables: { ON: "yes" }
  rules:
    - if: $ON == "yes" && $TARGET == "prod"
  script: [x]
b:
  rules:
    - if: $CI_COMMIT_BRANCH
      when: never
  script: [x]
c:
  rules:
    - if: $DYN
  script: [x]
d:
  when: manual
  script: [x]
e:
  rules:
    - if: $CI_COMMIT_BRANCH
      when: manual
      allow_failure: true
  script: [x]
f:
  rules:
    - when: delayed
  start_in: 5 minutes
  script: [x]
g:
  when: never
  script: [x]
h:
  rules: [{ if: "$X ==" }]
  script: [x]
`);
    const plan = planFor(p, ev("push"));
    expect(plan.jobs.get("a")?.run).toBe(true);
    expect(plan.jobs.get("b")?.reason.code).toBe("ruleNever");
    expect(plan.jobs.get("c")?.run).toBe("?");
    expect(plan.jobs.get("d")).toMatchObject({ gate: "manual", allowFailure: true });
    expect(plan.jobs.get("e")).toMatchObject({ gate: "manual", allowFailure: true });
    expect(plan.jobs.get("f")?.delayed).toBe("5 minutes");
    expect(plan.jobs.get("g")?.reason.code).toBe("whenNever");
    expect(plan.jobs.get("h")?.reason).toEqual({ code: "ruleUnknown", params: { n: 1, what: "if" } });
  });

  it("knows merge request variables are set, but not to what", () => {
    const p = gl(`a:
  rules: [{ if: $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^feat/ }]
  script: [x]
b:
  rules: [{ if: $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main" }]
  script: [x]
c:
  rules: [{ if: $CI_MERGE_REQUEST_IID }]
  script: [x]
`);
    expect(runs(p, ev("pr"))).toEqual({ a: "?", b: true, c: "?" });
    expect(runs(p, ev("push"))).toEqual({ a: false, b: false, c: false });
  });

  it("says when nothing would run, or when it cannot tell", () => {
    expect(planFor(gl("a:\n  rules: [{ if: $CI_COMMIT_TAG }]\n  script: [x]\n"), ev("push"))).toMatchObject({ created: false, reason: { code: "noJobs" } });
    expect(planFor(gl("a:\n  rules: [{ if: $X }]\n  script: [x]\n"), ev("push")).created).toBe("?");
  });

  it("marks a job behind an unknown need unknown, and passes an optional one", () => {
    const p = gl(`a:
  rules: [{ changes: [x] }]
  script: [x]
b:
  needs: [a]
  script: [x]
c:
  needs: [{ job: a, optional: true }]
  rules: [{ if: $CI_COMMIT_TAG }]
  script: [x]
d:
  needs: [{ job: c, optional: true }]
  script: [x]
`);
    const plan = planFor(p, ev("push"));
    expect(plan.jobs.get("b")?.reason.code).toBe("needUnknown");
    expect(plan.jobs.get("d")?.run).toBe(true);
    expect(plan.invalid).toBe(false);
  });

  it("waits in playback only for jobs that surely start", () => {
    const p = gl(cfg);
    const plan = planFor(p, ev("push"));
    const deploy = p.jobs.find((j) => j.id === "staging")!;
    expect(runDeps(p, plan, deploy)).toEqual(["rspec"]);
    const sast = p.jobs.find((j) => j.id === "sast")!;
    expect(runDeps(p, plan, sast)).toEqual(["build", "rspec"]);
  });
});
