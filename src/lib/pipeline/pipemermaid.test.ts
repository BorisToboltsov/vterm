import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "./ghactions";
import { buildGitlab } from "./gitlabci";
import { toMermaid } from "./pipemermaid";
import { loadYaml, parseYaml, type Obj, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

describe("toMermaid", () => {
  it("writes a workflow's jobs and needs", () => {
    const p = parseWorkflow(
      "/r/.github/workflows/ci.yml",
      parseYaml(Y, 'on: push\njobs:\n  test: { strategy: { matrix: { os: [a, b] } }, steps: [] }\n  deploy:\n    name: \'Deploy "prod" <now>\'\n    needs: test\n    environment: production\n    uses: ./x.yml\n'),
    );
    expect(toMermaid(p, "links")).toBe(
      'flowchart LR\n  j0["test (×2)"]\n  j1["Deploy prod now (env: production, → ./x.yml)"]\n  j0 --> j1\n',
    );
  });

  it("puts GitLab stages in subgraphs, in order", () => {
    const doc = parseYaml(Y, "stages: [build, deploy]\nb:\n  stage: build\n  script: [x]\nd:\n  stage: deploy\n  when: manual\n  needs: [b]\n  script: [x]\n");
    const p = buildGitlab({ file: "/r/.gitlab-ci.yml", config: doc.value as Obj, spans: new Map(), files: [], problems: [] });
    expect(toMermaid(p, "stages")).toBe(
      [
        "flowchart LR",
        '  subgraph s0["build"]',
        "    direction TB",
        '    j0["b"]',
        "  end",
        '  subgraph s1["deploy"]',
        "    direction TB",
        '    j1["d (manual)"]',
        "  end",
        "  s0 --> s1",
        "  j0 --> j1",
        "",
      ].join("\n"),
    );
  });
});
