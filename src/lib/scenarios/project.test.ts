import { describe, expect, it } from "vitest";
import { cfgInventory, inventoryCandidates, playbookCandidate, projectSigns } from "./project";

const f = (name: string) => ({ name, isDir: false });
const d = (name: string) => ({ name, isDir: true });

describe("what a folder is", () => {
  it("is Ansible by its config, its folders beside a playbook, or a playbook beside an inventory", () => {
    expect(projectSigns([f("ansible.cfg"), f("main.tf")])).toEqual({ kind: "ansible", markers: ["ansible.cfg"] });
    expect(projectSigns([d("roles"), f("web.yml")])?.kind).toBe("ansible");
    expect(projectSigns([d("group_vars"), d("host_vars")])?.kind).toBe("ansible");
    expect(projectSigns([f("site.yml"), d("inventory")])).toEqual({ kind: "ansible", markers: ["site.yml", "inventory"] });
  });

  it("is Terraform by a .tf file or its lock", () => {
    expect(projectSigns([f("main.tf"), f("variables.tf"), d("roles")])).toEqual({ kind: "terraform", markers: ["main.tf", "variables.tf"] });
    expect(projectSigns([f(".terraform.lock.hcl")])?.kind).toBe("terraform");
  });

  it("is nothing on weaker signs", () => {
    expect(projectSigns([])).toBeNull();
    expect(projectSigns([f("site.yml")])).toBeNull();
    expect(projectSigns([d("roles")])).toBeNull();
    expect(projectSigns([f("docker-compose.yml"), f("hosts")])).toBeNull();
    expect(projectSigns([d("main.tf")])).toBeNull();
  });
});

describe("the files of an Ansible project", () => {
  it("a playbook is a YAML file that is not a known other file", () => {
    expect(["site.yml", "web.yaml"].every(playbookCandidate)).toBe(true);
    expect(["requirements.yml", "compose.yaml", "galaxy.yml", "notes.md"].some(playbookCandidate)).toBe(false);
  });

  it("reads the inventory of ansible.cfg's [defaults] and adds the usual names", () => {
    const cfg = "[ssh]\ninventory = nope\n[defaults]\n# inventory = commented\ninventory = inventory/prod.ini, extra.yml ; note\nforks=5\n";
    expect(cfgInventory(cfg)).toEqual(["inventory/prod.ini", "extra.yml"]);
    expect(cfgInventory("[defaults]\nhostfile: hosts\n")).toEqual(["hosts"]);
    expect(cfgInventory("")).toEqual([]);
    // What ansible.cfg names is all Ansible reads; with nothing named, the usual names.
    expect(inventoryCandidates([d("inventory"), f("hosts"), f("site.yml")], ["inventory/prod.ini"])).toEqual(["inventory/prod.ini"]);
    expect(inventoryCandidates([d("inventory"), f("hosts"), f("site.yml")], [])).toEqual(["inventory", "hosts"]);
  });
});
