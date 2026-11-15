import { describe, expect, it } from "vitest";
import { carriedName, commandPreview, playbookArgv, playbookLine, type PlaybookRun } from "./ansibleargv";

const run: PlaybookRun = {
  root: "/home/deploy/infra/ansible",
  playbook: "site.yml",
  inventories: ["inventory/prod.ini", "/tmp/vterm-iac.x/vterm-inventory.yml"],
  limit: ["web-1", "db"],
  tags: ["deploy"],
  check: true,
  askBecome: true,
  askPass: false,
  tempDir: "/tmp/vterm-iac.x",
};

describe("the command of a run", () => {
  it("passes the collector and the choices of the dialog", () => {
    expect(playbookArgv(run)).toEqual([
      "env",
      "ANSIBLE_CALLBACK_PLUGINS=/tmp/vterm-iac.x:~/.ansible/plugins/callback:/usr/share/ansible/plugins/callback",
      "VTERM_EVENTS=/tmp/vterm-iac.x/events.out",
      "ansible-playbook",
      "site.yml",
      "-i",
      "inventory/prod.ini",
      "-i",
      "/tmp/vterm-iac.x/vterm-inventory.yml",
      "--limit",
      "web-1,db",
      "--tags",
      "deploy",
      "--check",
      "--diff",
      "-K",
    ]);
    const bare = playbookArgv({ ...run, limit: [], tags: [], check: false, askBecome: false, askPass: true, inventories: [] });
    expect(bare.slice(3)).toEqual(["ansible-playbook", "site.yml", "-k"]);
  });

  it("is typed as one POSIX line in the project folder, quoting what needs it", () => {
    const line = playbookLine({ ...run, root: "/srv/my infra", playbook: "o'neil.yml" })!;
    expect(line.startsWith("cd '/srv/my infra' && env ANSIBLE_CALLBACK_PLUGINS=/tmp/vterm-iac.x:~/.ansible")).toBe(true);
    expect(line).toContain(` 'o'\\''neil.yml' `);
    expect(commandPreview(run)).toBe(playbookLine(run));
  });

  it("refuses a line break anywhere", () => {
    expect(playbookLine({ ...run, playbook: "a\nrm -rf /" })).toBeNull();
    expect(playbookLine({ ...run, root: "/a\n" })).toBeNull();
    expect(commandPreview({ ...run, root: "/a\n" })).toBe("");
  });

  it("a playbook carried to a server keeps its name, unless vterm's files of the run hold it", () => {
    expect(carriedName("web.yml")).toBe("web.yml");
    expect(carriedName("vterm-inventory.yml")).toBe("playbook-vterm-inventory.yml");
    expect(carriedName("vterm_events.py")).toBe("playbook-vterm_events.py");
  });
});
