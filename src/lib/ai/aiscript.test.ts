import { describe, it, expect } from "vitest";
import { extractScript, scriptFileName, scriptExt } from "./aiscript";

describe("scriptExt", () => {
  it("maps kinds to editor extensions", () => {
    expect(scriptExt("sh")).toBe("sh");
    expect(scriptExt("ansible")).toBe("yml");
  });
});

describe("extractScript", () => {
  it("pulls a bash block for a shell script", () => {
    const md = "Here you go:\n```bash\n#!/usr/bin/env bash\nls -la\n```\nEnjoy.";
    expect(extractScript(md, "sh")).toBe("#!/usr/bin/env bash\nls -la");
  });

  it("pulls a yaml block for an ansible playbook", () => {
    const md = "```yaml\n- hosts: all\n  tasks: []\n```";
    expect(extractScript(md, "ansible")).toBe("- hosts: all\n  tasks: []");
  });

  it("prefers the language matching the kind over other blocks", () => {
    const md = "```text\nnot this\n```\n```bash\nyes this\n```";
    expect(extractScript(md, "sh")).toBe("yes this");
  });

  it("prefers the longest matching block", () => {
    const md = "```sh\na\n```\n```sh\nlonger script here\n```";
    expect(extractScript(md, "sh")).toBe("longer script here");
  });

  it("falls back to the longest code block when none match the kind", () => {
    const md = "```text\nplain block\n```";
    expect(extractScript(md, "sh")).toBe("plain block");
  });

  it("falls back to the whole reply when there is no code block", () => {
    expect(extractScript("echo hi", "sh")).toBe("echo hi");
  });
});

describe("scriptFileName", () => {
  it("slugs the title and adds the kind extension", () => {
    expect(scriptFileName("Deploy Nginx!", "sh")).toBe("deploy-nginx.sh");
    expect(scriptFileName("Set up DB", "ansible")).toBe("set-up-db.yml");
  });

  it("falls back to a default name for empty/odd titles", () => {
    expect(scriptFileName("", "sh")).toBe("runbook.sh");
    expect(scriptFileName("***", "ansible")).toBe("runbook.yml");
  });

  it("trims very long titles", () => {
    const name = scriptFileName("a".repeat(100), "sh");
    expect(name.length).toBeLessThanOrEqual(43); // 40 slug + ".sh"
  });
});
