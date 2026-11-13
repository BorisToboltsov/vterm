import { beforeAll, describe, expect, it } from "vitest";
import { parseWorkflow } from "./ghactions";
import { buildMap, eventKey, mapPlans, startedBy } from "./pipemap";
import { loadYaml, parseYaml, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

const wf = (file: string, text: string) => parseWorkflow(file, parseYaml(Y, text));

describe("buildMap", () => {
  it("lays out pipelines, what they call and what starts them", () => {
    const e2e = wf("/w/e2e.yml", "on: workflow_call\njobs:\n  smoke: { steps: [] }\n");
    const ci = wf("/w/ci.yml", "name: CI\non: { push: { branches: [main] }, pull_request: }\njobs:\n  test: { steps: [] }\n  e2e: { uses: ./e2e.yml }\n");
    ci.jobs[1].call!.pipeline = e2e;
    const release = wf("/w/release.yml", "on: { push: { tags: [v*] } }\njobs:\n  ci: { uses: ./ci.yml }\n");
    release.jobs[0].call!.pipeline = ci;
    const docs = wf("/w/docs.yml", "on: { workflow_run: { workflows: [CI, Missing] } }\njobs:\n  publish: { steps: [] }\n");
    const map = buildMap([ci, release, docs, e2e]);
    expect(map.cards.map((c) => `${c.id}${c.called ? " (called)" : ""}`)).toEqual(["/w/ci.yml", "/w/release.yml", "/w/docs.yml", "/w/e2e.yml (called)"]);
    expect(map.calls).toEqual([
      { from: "/w/ci.yml", to: "/w/e2e.yml", after: false },
      { from: "/w/release.yml", to: "/w/ci.yml", after: false },
      { from: "/w/ci.yml", to: "/w/docs.yml", after: true },
    ]);
    expect(map.events.map(eventKey)).toEqual(["push:main", "pr:main", "tag:v1.0.0"]);
  });

  it("plays each card for an event, a called one as called", () => {
    const e2e = wf("/w/e2e.yml", "on: workflow_call\njobs:\n  smoke: { steps: [] }\n");
    const ci = wf("/w/ci.yml", "on: push\njobs:\n  e2e: { uses: ./e2e.yml }\n");
    ci.jobs[0].call!.pipeline = e2e;
    const map = buildMap([ci]);
    expect(map.cards.find((c) => c.id === "/w/e2e.yml")?.called).toBe(true);
    const push = map.events[0];
    const plans = mapPlans(map, push);
    expect(plans.get("/w/e2e.yml")?.created).toBe(true);
    expect(startedBy(map, push)).toEqual(["/w/ci.yml"]);
    expect(startedBy(map, { kind: "schedule", ref: "main", defaultBranch: "main" })).toEqual([]);
  });

  it("keeps a pipeline once though both the group and a call bring it", () => {
    const e2e = wf("/w/e2e.yml", "on: [workflow_call, workflow_dispatch]\njobs:\n  smoke: { steps: [] }\n");
    const ci = wf("/w/ci.yml", "on: push\njobs:\n  e2e: { uses: ./e2e.yml }\n");
    ci.jobs[0].call!.pipeline = e2e;
    const map = buildMap([ci, e2e]);
    expect(map.cards).toHaveLength(2);
    expect(map.cards[1].called).toBe(false);
  });
});
