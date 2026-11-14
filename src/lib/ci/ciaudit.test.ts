import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadYaml, parseYaml } from "../pipeline/yamldoc";
import { auditWorkflow, pinText, unpinnedRef } from "./ciaudit";
import { dispatchFields, formProblems, formValues, pipelineFields, prodFields } from "./cidispatch";

const Y = await loadYaml();

// The file of the renders: every finding at once.
const PR_PREVIEW = `name: PR preview
on:
  pull_request_target:
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: actions/setup-node@v4
      - run: echo "Preview \${{ github.event.pull_request.title }}"
  deploy:
    needs: preview
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
`;

describe("the security of a workflow — from the file alone", () => {
  it("finds the six things of the render, on their lines, the worst first", () => {
    const f = auditWorkflow(parseYaml(Y, PR_PREVIEW), PR_PREVIEW);
    expect(f.map((x) => [x.code, x.level, x.lines])).toEqual([
      ["prTarget", "error", [3, 8, 10]],
      ["injection", "error", [12]],
      ["unpinned", "warn", [8, 11]],
      ["noPermissions", "warn", [1]],
      ["secretsInherit", "info", [16]],
      ["persistCredentials", "info", [8]],
    ]);
    expect(f.find((x) => x.code === "unpinned")?.pins.map((p) => `${p.repo}@${p.ref}`)).toEqual(["actions/checkout@v4", "actions/setup-node@v4"]);
    expect(f.find((x) => x.code === "injection")?.detail).toBe("github.event.pull_request.title");
  });

  it("vterm's own workflows: pinned, permissions set — nothing above advice", async () => {
    for (const name of ["ci.yml", "release.yml", "deep.yml", "security.yml", "codeql.yml", "train.yml"]) {
      const text = readFileSync(join(process.cwd(), ".github", "workflows", name), "utf8");
      const f = auditWorkflow(parseYaml(Y, text), text);
      expect(f.filter((x) => x.level !== "info").map((x) => x.code), name).toEqual([]);
    }
  });

  it("a PR's own head checked out under pull_request (not _target) is no finding; an input is no injection", () => {
    const text = "on: pull_request\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@" + "a".repeat(40) + "\n        with:\n          ref: ${{ github.head_ref }}\n          persist-credentials: false\n      - run: echo ${{ inputs.name }}\n";
    expect(auditWorkflow(parseYaml(Y, text), text)).toEqual([]);
  });

  it("which `uses:` are pins waiting to happen", () => {
    expect(unpinnedRef("actions/checkout@v4")).toEqual({ repo: "actions/checkout", ref: "v4" });
    expect(unpinnedRef("github/codeql-action/init@v3")).toEqual({ repo: "github/codeql-action", ref: "v3" });
    expect(unpinnedRef(`actions/checkout@${"0".repeat(40)}`)).toBeNull();
    expect(unpinnedRef("./.github/actions/setup")).toBeNull();
    expect(unpinnedRef("docker://alpine:3")).toBeNull();
  });

  it("pins in place, keeping the tag as a comment; a line that changed meanwhile is left", () => {
    const sha = "b".repeat(40);
    const pins = auditWorkflow(parseYaml(Y, PR_PREVIEW), PR_PREVIEW).find((x) => x.code === "unpinned")!.pins;
    const out = pinText(PR_PREVIEW, pins.map((p) => ({ ...p, sha })));
    expect(out.split("\n")[7]).toBe(`      - uses: actions/checkout@${sha} # v4`);
    expect(out.split("\n")[10]).toBe(`      - uses: actions/setup-node@${sha} # v4`);
    const edited = PR_PREVIEW.replace("actions/setup-node@v4", "actions/setup-node@v5");
    expect(pinText(edited, pins.map((p) => ({ ...p, sha }))).split("\n")[10]).toBe("      - uses: actions/setup-node@v5");
  });
});

describe("the form of a run started by hand", () => {
  const DEPLOY = `on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
      dry_run:
        type: boolean
        default: true
      version:
        required: true
        description: Release to deploy
      replicas:
        type: number
jobs: {}
`;

  it("GitHub: the inputs with their types, choices and defaults, in the order written", () => {
    const fields = dispatchFields(parseYaml(Y, DEPLOY))!;
    expect(fields.map((f) => [f.name, f.kind, f.value, f.required])).toEqual([
      ["environment", "choice", "staging", false],
      ["dry_run", "boolean", "true", false],
      ["version", "string", "", true],
      ["replicas", "number", "", false],
    ]);
    expect(formProblems(fields, {})).toEqual([{ name: "version", kind: "required" }]);
    expect(formProblems(fields, { version: "1.35.0", replicas: "x", environment: "qa" })).toEqual([
      { name: "environment", kind: "choice" },
      { name: "replicas", kind: "number" },
    ]);
    expect(formValues(fields, { version: " 1.35.0 ", dry_run: "false" })).toEqual({ environment: "staging", dry_run: "false", version: "1.35.0" });
    expect(prodFields(fields, { environment: "production" })).toEqual(["environment"]);
  });

  it("a workflow without workflow_dispatch cannot be started; one without inputs has an empty form", () => {
    expect(dispatchFields(parseYaml(Y, "on: push\njobs: {}\n"))).toBeNull();
    expect(dispatchFields(parseYaml(Y, "on: [push, workflow_dispatch]\njobs: {}\n"))).toEqual([]);
    expect(dispatchFields(parseYaml(Y, "on:\n  workflow_dispatch:\njobs: {}\n"))).toEqual([]);
  });

  it("GitLab: the variables the file describes, as GitLab prefills them", () => {
    const text = "variables:\n  PLAIN: x\n  DEPLOY_TO:\n    value: staging\n    options: [staging, production]\n    description: Where to\n  NOTE:\n    description: Free text\n";
    expect(pipelineFields(parseYaml(Y, text)).map((f) => [f.name, f.kind, f.value])).toEqual([
      ["DEPLOY_TO", "choice", "staging"],
      ["NOTE", "string", ""],
    ]);
  });
});
