import { describe, expect, it } from "vitest";
import PLAN from "./tfplan.fixture.json?raw";
import {
  applyArgv,
  byModule,
  changeKind,
  destroys,
  initArgv,
  parsePlan,
  planArgv,
  showArgv,
  validateArgv,
} from "./tfplan";

describe("a saved plan", () => {
  const plan = parsePlan(PLAN);

  it("counts what is created, changed, replaced and destroyed; a read and a no-op are not changes", () => {
    expect(plan.errored).toBe(false);
    expect(plan.counts).toEqual({ create: 2, update: 1, replace: 1, delete: 1 });
    expect(plan.changes.map((c) => [c.address, c.kind])).toEqual([
      ["hcloud_server.web[2]", "create"],
      ["module.network.hcloud_server_network.web[2]", "create"],
      ["hcloud_firewall.base", "update"],
      ["hcloud_server.db", "replace"],
      ["hcloud_volume.old", "delete"],
      ["data.hcloud_image.debian", "read"],
    ]);
    expect(destroys(plan)).toBe(true);
  });

  it("shows how a change changes, and never a sensitive value", () => {
    const fw = plan.changes.find((c) => c.address === "hcloud_firewall.base")!;
    const plain = { beforeMask: null, afterMask: null, partlyUnknown: false };
    expect(fw.attrs).toEqual([
      { path: "rule", before: '[{"port":"22"}]', after: '[{"port":"2222"}]', ...plain },
      { path: "token", before: "", after: "", beforeMask: "sensitive", afterMask: "sensitive", partlyUnknown: false },
    ]);
    expect(JSON.stringify(plan)).not.toContain("secret");
    const db = plan.changes.find((c) => c.kind === "replace")!;
    expect(db.attrs).toEqual([
      { path: "id", before: "", after: "", beforeMask: null, afterMask: "unknown", partlyUnknown: false },
      { path: "image", before: '"debian-11"', after: '"debian-12"', ...plain },
    ]);
    // Something inside known only after apply: the rest is shown, and said so.
    const partly = parsePlan(
      JSON.stringify({
        format_version: "1.2",
        resource_changes: [
          { address: "a.b", type: "a", name: "b", change: { actions: ["update"], before: { r: [1] }, after: { r: [1] }, after_unknown: { r: [false, true] } } },
        ],
      }),
    );
    expect(partly.changes[0].attrs).toEqual([{ path: "r", before: "[1]", after: "[1]", beforeMask: null, afterMask: null, partlyUnknown: true }]);
    expect(db.replacing).toEqual(["image"]);
  });

  it("names the outputs that change, and which are sensitive", () => {
    expect(plan.outputs).toEqual([
      { name: "web_ips", kind: "update", sensitive: false },
      { name: "db_password", kind: "create", sensitive: true },
    ]);
  });

  it("groups by module, the root first", () => {
    expect(byModule(plan).map((g) => [g.module, g.changes.length])).toEqual([
      [null, 5],
      ["module.network", 1],
    ]);
  });

  it("is an error for what is not a plan", () => {
    expect(parsePlan("Error: no plan").errored).toBe(true);
    expect(parsePlan("{}").errored).toBe(true);
    expect(parsePlan('{"format_version":"1.2","errored":true}').errored).toBe(true);
    expect(destroys(parsePlan('{"format_version":"1.2"}'))).toBe(false);
  });

  it("reads every kind of action list", () => {
    expect([["create", "delete"], ["update"], ["no-op"], "x", null].map(changeKind)).toEqual(["replace", "update", "noop", "noop", "noop"]);
  });
});

describe("the commands of a plan", () => {
  it("saves the plan to the run's folder and applies exactly that file", () => {
    expect(planArgv("/srv/tf", "/tmp/vterm-iac.a/plan.tfplan", ["prod.tfvars"])).toEqual([
      "terraform",
      "-chdir=/srv/tf",
      "plan",
      "-input=false",
      "-out=/tmp/vterm-iac.a/plan.tfplan",
      "-var-file=prod.tfvars",
    ]);
    expect(applyArgv("/srv/tf", "/p.tfplan")).toEqual(["terraform", "-chdir=/srv/tf", "apply", "-input=false", "/p.tfplan"]);
    expect(showArgv("/srv/tf", "/p.tfplan")).toEqual(["terraform", "-chdir=/srv/tf", "show", "-json", "/p.tfplan"]);
    expect(initArgv("/srv/tf")).toEqual(["terraform", "-chdir=/srv/tf", "init", "-input=false"]);
    expect(validateArgv("/srv/tf")).toEqual(["terraform", "-chdir=/srv/tf", "validate"]);
  });
});
