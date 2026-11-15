import { describe, expect, it } from "vitest";
import { cfgInventory, projectSigns } from "./project";
import { projectFolderProblem, SCAFFOLD_DIRS, scaffoldFiles } from "./scaffold";

describe("a new Ansible project", () => {
  const files = scaffoldFiles("all: {}\n");

  it("is an Ansible project by its own signs, pointing at the inventory it carries", () => {
    const names = [...files.map((f) => f.path.split("/")[0]), ...SCAFFOLD_DIRS.filter((d) => !d.includes("/"))];
    const entries = [...new Set(names)].map((name) => ({ name, isDir: SCAFFOLD_DIRS.includes(name) }));
    expect(projectSigns(entries)?.kind).toBe("ansible");
    expect(cfgInventory(files.find((f) => f.path === "ansible.cfg")!.text)).toEqual(["inventory/vterm.yml"]);
    expect(files.find((f) => f.path === "inventory/vterm.yml")?.text).toBe("all: {}\n");
    // Every file's folder is made before it.
    for (const f of files) {
      const dir = f.path.split("/").slice(0, -1).join("/");
      if (dir) expect(SCAFFOLD_DIRS).toContain(dir);
    }
  });

  it("asks for one plain folder name", () => {
    expect(projectFolderProblem("  ")).toBe("empty");
    expect(projectFolderProblem(".hidden")).toBe("bad");
    expect(projectFolderProblem("a/b")).toBe("bad");
    expect(projectFolderProblem("infra")).toBeNull();
  });
});
