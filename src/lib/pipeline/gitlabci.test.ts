import { beforeAll, describe, expect, it } from "vitest";
import {
  buildGitlab,
  deepMerge,
  includesOf,
  parallelOf,
  parseOnly,
  parseRules,
  resolveExtends,
  resolveReferences,
  triggerOf,
} from "./gitlabci";
import type { SourceSpan } from "./pipeline";
import { loadYaml, parseYaml, YamlReference, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const FILE = "/r/.gitlab-ci.yml";
function build(text: string) {
  const doc = parseYaml(Y, text);
  const spans = new Map<string, SourceSpan>();
  for (const k of doc.keys([])) spans.set(k, { file: FILE, ...doc.span([k])! });
  return buildGitlab({ file: FILE, config: doc.value as Obj, spans, files: [{ path: FILE, state: "read", detail: null }], problems: [] });
}

describe("includesOf", () => {
  it("tells this repository's files from everything else", () => {
    const inc = includesOf({
      include: [
        "ci/a.yml",
        "https://x/y.yml",
        { local: "/ci/b.yml" },
        { local: "/ci/c.yml", rules: [{ if: "$X" }] },
        { project: "infra/ci", file: ["/a.yml", "/b.yml"] },
        { project: "infra/ci" },
        { remote: "https://x/z.yml" },
        { template: "Auto-DevOps.gitlab-ci.yml" },
        { component: "gitlab.com/x/y@1" },
        42,
      ],
    });
    expect(inc).toEqual([
      { kind: "local", path: "ci/a.yml", conditional: false },
      { kind: "external", label: "https://x/y.yml" },
      { kind: "local", path: "/ci/b.yml", conditional: false },
      { kind: "local", path: "/ci/c.yml", conditional: true },
      { kind: "external", label: "project: infra/ci (/a.yml, /b.yml)" },
      { kind: "external", label: "project: infra/ci" },
      { kind: "external", label: "remote: https://x/z.yml" },
      { kind: "external", label: "template: Auto-DevOps.gitlab-ci.yml" },
      { kind: "external", label: "component: gitlab.com/x/y@1" },
    ]);
    expect(includesOf({ include: "a.yml" })).toEqual([{ kind: "local", path: "a.yml", conditional: false }]);
    expect(includesOf({})).toEqual([]);
  });
});

describe("merging", () => {
  it("merges maps key by key and replaces anything else", () => {
    expect(deepMerge({ a: { x: 1, y: [1] }, b: 1 }, { a: { y: [2], z: 3 }, c: 4 })).toEqual({ a: { x: 1, y: [2], z: 3 }, b: 1, c: 4 });
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(deepMerge([1], [2])).toEqual([2]);
  });

  it("resolves extends, nearest last, the job's own keys over all", () => {
    const config: Obj = {
      ".a": { script: ["a"], variables: { A: "1", B: "a" } },
      ".b": { extends: ".a", variables: { B: "b" }, image: "b" },
      job: { extends: [".b", ".c"], image: "own" },
    };
    const found: string[] = [];
    const job = resolveExtends(config, "job", (code, parent) => found.push(`${code}:${parent}`));
    expect(job).toEqual({ script: ["a"], variables: { A: "1", B: "b" }, image: "own" });
    expect(found).toEqual(["extendsUnknown:.c"]);
  });

  it("stops at a loop of extends", () => {
    const found: string[] = [];
    resolveExtends({ ".a": { extends: ".b" }, ".b": { extends: ".a" }, j: { extends: ".a" } }, "j", (code) => found.push(code));
    expect(found).toContain("extendsCycle");
    expect(resolveExtends({}, "missing", () => {})).toEqual({});
  });

  it("replaces references, flattening a list into the list it stands in", () => {
    const config: Obj = { ".s": { script: ["a", "b"], rules: [{ if: "$X" }] }, ".t": { more: new YamlReference([".s", "script"]) } };
    const missing: string[] = [];
    const out = resolveReferences(
      { script: [new YamlReference([".s", "script"]), "c"], rules: [new YamlReference([".s", "rules"])], x: new YamlReference([".t", "more"]), y: new YamlReference([".nope", "a"]) },
      config,
      (p) => missing.push(p.join(".")),
    );
    expect(out).toEqual({ script: ["a", "b", "c"], rules: [{ if: "$X" }], x: ["a", "b"], y: null });
    expect(missing).toEqual([".nope.a"]);
  });
});

describe("job parts", () => {
  it("reads rules and only/except", () => {
    expect(parseRules([{ if: "$A", when: "manual", allow_failure: true }, { changes: ["x"] }, { exists: ["y"], when: "bogus" }, "x"])).toEqual([
      { if: "$A", changes: false, exists: false, when: "manual", allowFailure: true },
      { if: null, changes: true, exists: false, when: null, allowFailure: null },
      { if: null, changes: false, exists: true, when: null, allowFailure: null },
    ]);
    expect(parseRules("x")).toBeNull();
    expect(parseOnly(["main", "tags"])).toEqual({ refs: ["main", "tags"], variables: [], changes: false });
    expect(parseOnly({ refs: "branches", variables: ["$A == 'x'"], changes: ["a"] })).toEqual({ refs: ["branches"], variables: ["$A == 'x'"], changes: true });
    expect(parseOnly(undefined)).toBeNull();
  });

  it("makes the copies of parallel", () => {
    expect(parallelOf("rspec", 3)?.items).toEqual(["rspec 1/3", "rspec 2/3", "rspec 3/3"]);
    expect(parallelOf("x", 1)).toBeNull();
    expect(parallelOf("x", { matrix: [{ P: ["aws", "gcp"], S: "eu" }, { P: "azure", S: ["us", "eu"] }] })?.items).toEqual([
      "aws · eu",
      "gcp · eu",
      "azure · us",
      "azure · eu",
    ]);
    expect(parallelOf("x", { matrix: "$M" })?.items).toBeNull();
    expect(parallelOf("x", { matrix: [{ P: [{}] }] })?.items).toBeNull();
    expect(parallelOf("x", { matrix: ["nope"] })?.items).toBeNull();
  });

  it("tells a child pipeline from another project's", () => {
    expect(triggerOf("group/app")).toEqual({ file: "group/app", pipeline: null, missing: "external", waits: false });
    expect(triggerOf({ project: "g/app", branch: "main" })?.missing).toBe("external");
    expect(triggerOf({ include: "ci/child.yml" })).toEqual({ file: "ci/child.yml", pipeline: null, missing: null, waits: false });
    // The trigger job waits for its child only when the strategy says so.
    expect(triggerOf({ include: "ci/child.yml", strategy: "depend" })?.waits).toBe(true);
    expect(triggerOf({ include: "ci/child.yml", strategy: "mirror" })?.waits).toBe(true);
    expect(triggerOf({ project: "g/app", strategy: "depend" })?.waits).toBe(true);
    expect(triggerOf({ include: [{ local: "ci/c.yml" }] })?.file).toBe("ci/c.yml");
    expect(triggerOf({ include: [{ artifact: "gen.yml", job: "g" }] })?.missing).toBe("external");
    expect(triggerOf({ include: [{ project: "x", file: "y" }] })?.file).toBe("project: x");
    expect(triggerOf({ include: [{ template: "t.yml" }] })?.file).toBe("template: t.yml");
    expect(triggerOf({ strategy: "depend" })).toBeNull();
    expect(triggerOf(undefined)).toBeNull();
  });
});

describe("buildGitlab", () => {
  it("reads jobs by stage, skipping templates and keywords", () => {
    const p = build(`stages: [build, test, deploy]
variables: { APP: shop }
default:
  before_script: [echo default]
workflow:
  name: Shop
  rules:
    - if: $CI_COMMIT_BRANCH
.tpl:
  script: [make]
build-image:
  stage: build
  extends: .tpl
compile:
  stage: build
  inherit: { default: false }
  script: [rake]
rspec:
  needs: [build-image, { job: compile, optional: true }, { job: x, project: other/p }]
  parallel: 3
  script:
    - |
      bundle exec rspec
      more
deploy:
  stage: deploy
  when: manual
  environment: { name: production }
  script: [./deploy]
`);
    expect(p.name).toBe("Shop");
    expect(p.variables).toEqual({ APP: "shop" });
    expect(p.workflowRules).toEqual([{ if: "$CI_COMMIT_BRANCH", changes: false, exists: false, when: null, allowFailure: null }]);
    expect(p.stages).toEqual(["build", "test", "deploy"]);
    expect(p.jobs.map((j) => `${j.id}@${j.stage}`)).toEqual(["build-image@build", "compile@build", "rspec@test", "deploy@deploy"]);
    const [image, compile, rspec, deploy] = p.jobs;
    expect(image.steps).toEqual(["echo default", "make"]);
    expect(compile.steps).toEqual(["rake"]);
    expect(rspec.needs).toEqual([{ job: "build-image", optional: false }, { job: "compile", optional: true }]);
    expect(rspec.matrix?.items).toHaveLength(3);
    expect(rspec.steps).toEqual(["echo default", "bundle exec rspec"]);
    expect(deploy.when).toBe("manual");
    expect(deploy.allowFailure).toBe(true);
    expect(deploy.environment).toBe("production");
    expect(deploy.span.line).toBe(25);
    expect(p.problems).toEqual([]);
  });

  it("takes GitLab's default stages and shows .pre/.post only when used", () => {
    const p = build("lint:\n  stage: .pre\n  script: [x]\nt:\n  script: [y]\n");
    expect(p.stages).toEqual([".pre", "build", "test", "deploy"]);
    expect(p.jobs[1].stage).toBe("test");
  });

  it("does not count a manual job made by rules as one that may be skipped past", () => {
    const p = build("d:\n  when: manual\n  rules: [{ if: $A }]\n  script: [x]\n");
    expect(p.jobs[0].allowFailure).toBe(false);
  });

  it("reports what GitLab would refuse", () => {
    const p = build(`stages: [build, test]
a:
  stage: nowhere
  script: [x]
b:
  stage: build
  needs: [c, ghost]
  script: [x]
c:
  stage: test
  extends: .missing
  script: [x]
d:
  trigger: other/project
e:
  script: [!reference [.nope, script]]
`);
    const codes = p.problems.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["stageUnknown", "needsLaterStage", "needsUnknown", "extendsUnknown", "callExternal", "referenceUnknown"]));
    expect(p.jobs.find((j) => j.id === "d")?.steps).toEqual(["trigger: other/project"]);
    expect(p.jobs.find((j) => j.id === "e")?.steps).toEqual(["!reference ?"]);
  });

  it("reports a config with no jobs and a loop of needs", () => {
    expect(build("stages: [a]\n").problems.map((x) => x.code)).toEqual(["noJobs"]);
    const p = build("x:\n  needs: [y]\n  script: [a]\ny:\n  needs: [x]\n  script: [a]\n");
    expect(p.problems.filter((x) => x.code === "needsCycle")).toHaveLength(2);
  });
});
