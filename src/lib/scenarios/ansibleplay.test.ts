import { describe, expect, it } from "vitest";
import { installedCollections, readPlaybook, readRequirements, roleTags } from "./ansibleplay";

describe("a playbook", () => {
  it("reads plays, roles, become, prompts and every tag; imports apart", () => {
    const pb = readPlaybook([
      { import_playbook: "db.yml" },
      { "ansible.builtin.import_playbook": "extra.yml" },
      {
        name: "Web",
        hosts: "web",
        become: "yes",
        tags: "site, web",
        roles: ["common", { role: "nginx", tags: ["tls"] }, { name: "named" }, 7],
        vars_prompt: [{ name: "release" }, "junk"],
        tasks: [
          { name: "a", tags: "deploy" },
          { block: [{ name: "b", tags: ["inner"] }], rescue: [{ tags: "rescue" }], always: "nope" },
          "junk",
        ],
        handlers: [{ tags: "h" }],
      },
      { hosts: ["db", "cache"], tasks: [] },
    ]);
    expect(pb).toEqual({
      plays: [
        { name: "Web", hosts: "web", roles: ["common", "nginx", "named"], become: true, prompts: ["release"] },
        { name: "db,cache", hosts: "db,cache", roles: [], become: false, prompts: [] },
      ],
      imports: ["db.yml", "extra.yml"],
      tags: ["deploy", "h", "inner", "rescue", "site", "tls", "web"],
    });
  });

  it("is null for a document that is not one", () => {
    expect(readPlaybook(null)).toBeNull();
    expect(readPlaybook([])).toBeNull();
    expect(readPlaybook({ hosts: "all" })).toBeNull();
    expect(readPlaybook(["x"])).toBeNull();
    // A list of tasks (a role's tasks/main.yml) has no hosts.
    expect(readPlaybook([{ name: "t", "ansible.builtin.debug": { msg: 1 } }])).toBeNull();
  });

  it("reads a role's tags", () => {
    expect(roleTags([{ tags: ["b", "a"] }, { block: [{ tags: "c" }] }])).toEqual(["a", "b", "c"]);
    expect(roleTags(null)).toEqual([]);
  });
});

describe("what a project needs", () => {
  it("reads collections and roles, old and new form", () => {
    expect(readRequirements({ collections: ["ansible.posix", { name: "community.general", version: ">=8" }], roles: [{ src: "geerlingguy.docker" }] })).toEqual({
      collections: ["ansible.posix", "community.general"],
      roles: ["geerlingguy.docker"],
    });
    expect(readRequirements([{ name: "role.a" }, "role.b"])).toEqual({ collections: [], roles: ["role.a", "role.b"] });
    expect(readRequirements("x")).toEqual({ collections: [], roles: [] });
  });

  it("reads what is installed, by every path", () => {
    const text = JSON.stringify({
      "/home/u/.ansible/collections/ansible_collections": { "ansible.posix": { version: "1.5.4" } },
      "/usr/lib/python3/dist-packages/ansible_collections": { "community.general": { version: "8.0.0" } },
    });
    expect([...installedCollections(text)!].sort()).toEqual(["ansible.posix", "community.general"]);
    expect(installedCollections("nope")).toBeNull();
    expect(installedCollections("[]")).toBeNull();
  });
});
