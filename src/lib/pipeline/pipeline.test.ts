import { beforeAll, describe, expect, it } from "vitest";
import { buildGitlab } from "./gitlabci";
import { dependsOn, downstreamOf, jobAtLine, jobOf, problem, topoJobs, upstreamOf, type Pipeline, type SourceSpan } from "./pipeline";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

function gl(text: string): Pipeline {
  const doc = parseYaml(Y, text);
  const spans = new Map<string, SourceSpan>();
  for (const k of doc.keys([])) spans.set(k, { file: "/r/.gitlab-ci.yml", ...doc.span([k])! });
  return buildGitlab({ file: "/r/.gitlab-ci.yml", config: doc.value as Obj, spans, files: [], problems: [] });
}

const CFG = `stages: [build, test, deploy]
a:
  stage: build
  script: [x]
b:
  stage: test
  script: [x]
c:
  stage: deploy
  needs: [a]
  script: [x]
d:
  stage: deploy
  script: [x]
`;

describe("the pipeline's graph", () => {
  it("waits on needs, or on the stages before", () => {
    const p = gl(CFG);
    expect(dependsOn(p, jobOf(p, "c")!)).toEqual(["a"]);
    expect(dependsOn(p, jobOf(p, "d")!)).toEqual(["a", "b"]);
    expect(dependsOn(p, jobOf(p, "d")!, (id) => id !== "b")).toEqual(["a"]);
    expect(dependsOn(p, jobOf(p, "a")!)).toEqual([]);
  });

  it("orders, and walks up and down", () => {
    const p = gl(CFG);
    expect(topoJobs(p).map((j) => j.id)).toEqual(["a", "b", "c", "d"]);
    expect([...upstreamOf(p, "d")].sort()).toEqual(["a", "b"]);
    expect([...downstreamOf(p, "a")].sort()).toEqual(["b", "c", "d"]);
    expect([...upstreamOf(p, "nope")]).toEqual([]);
  });

  it("finds the job a line of the file is in", () => {
    const p = gl(CFG);
    expect(jobAtLine(p, "/r/.gitlab-ci.yml", 6)?.id).toBe("b");
    expect(jobAtLine(p, "/r/.gitlab-ci.yml", 1)).toBeNull();
    expect(jobAtLine(p, "/elsewhere.yml", 6)).toBeNull();
  });

  it("builds a problem with defaults", () => {
    expect(problem("noJobs", "error")).toEqual({ code: "noJobs", level: "error", params: {}, file: null, line: null });
  });

  it("cuts a loop of needs where it closes", () => {
    const p = gl("x:\n  needs: [y]\n  script: [a]\ny:\n  needs: [x]\n  script: [a]\n");
    expect(topoJobs(p).map((j) => j.id).sort()).toEqual(["x", "y"]);
  });
});
