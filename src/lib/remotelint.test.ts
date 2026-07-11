import { describe, expect, it } from "vitest";
import { hasRemoteLinter, parseLint } from "./remotelint";

describe("hasRemoteLinter", () => {
  it("knows which languages have a server linter", () => {
    expect(hasRemoteLinter("yaml")).toBe(true);
    expect(hasRemoteLinter("shell")).toBe(true);
    expect(hasRemoteLinter("dockerfile")).toBe(true);
    expect(hasRemoteLinter("python")).toBe(true);
    expect(hasRemoteLinter("nginx")).toBe(true);
    expect(hasRemoteLinter("rust")).toBe(false);
    expect(hasRemoteLinter("json")).toBe(false);
  });

  it("includes the Phase A daemon config validators", () => {
    for (const k of ["sshdconfig", "sudoers", "haproxy", "bind", "systemd"] as const) {
      expect(hasRemoteLinter(k)).toBe(true);
    }
  });

  it("includes the Phase B YAML-family dialects", () => {
    for (const k of ["compose", "ghactions", "prometheus", "ansible", "k8s"] as const) {
      expect(hasRemoteLinter(k)).toBe(true);
    }
  });
});

describe("parseLint (colon format)", () => {
  it("parses yamllint/shellcheck/ruff style FILE:line:col: message", () => {
    const out = [
      "FILE:3:1: [error] syntax error: expected <block end> (syntax)",
      "FILE:7:5: warning: line too long",
      "FILE:10: trailing whitespace",
      "garbage line without location",
    ].join("\n");
    const msgs = parseLint(out, "colon");
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({
      line: 3,
      col: 1,
      level: "error",
      message: "[error] syntax error: expected <block end> (syntax)",
    });
    expect(msgs[1].level).toBe("warning");
    expect(msgs[2]).toEqual({ line: 10, col: undefined, level: "info", message: "trailing whitespace" });
  });

  it("ignores empty messages and non-matching lines", () => {
    expect(parseLint("no findings here\n", "colon")).toEqual([]);
  });
});

describe("parseLint (nginx format)", () => {
  it("extracts the line from an emerg and skips the success line", () => {
    const out = [
      "nginx: [emerg] unexpected \"}\" in FILE:12",
      "nginx: configuration file FILE test failed",
    ].join("\n");
    const msgs = parseLint(out, "nginx");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].line).toBe(12);
    expect(msgs[0].level).toBe("error");
    expect(msgs[0].message).toContain("unexpected");
  });

  it("returns nothing when the config tests OK", () => {
    const ok = "nginx: configuration file FILE test is successful\n";
    expect(parseLint(ok, "nginx")).toEqual([]);
  });
});

describe("parseLint (sshd format)", () => {
  it("reads the line number and flags the option", () => {
    const out = [
      "FILE: line 42: Bad configuration option: PermitRootLoginn",
      "FILE: terminating, 1 bad configuration options",
    ].join("\n");
    const msgs = parseLint(out, "sshd");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ line: 42, level: "error", message: "Bad configuration option: PermitRootLoginn" });
    expect(msgs[1]).toEqual({ line: 1, level: "error", message: "terminating, 1 bad configuration options" });
  });

  it("treats no output as a clean config", () => {
    expect(parseLint("", "sshd")).toEqual([]);
  });
});

describe("parseLint (visudo format)", () => {
  it("extracts the line from a syntax error and drops the decoration", () => {
    const out = ">>> FILE: syntax error near line 5 <<<\n";
    const msgs = parseLint(out, "visudo");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ line: 5, level: "error", message: "syntax error near line 5" });
  });

  it("treats `parsed OK` as clean", () => {
    expect(parseLint("FILE: parsed OK\n", "visudo")).toEqual([]);
  });
});

describe("parseLint (haproxy format)", () => {
  it("parses the alert line/level and ignores the valid line", () => {
    const out = [
      "[ALERT] (1234) : parsing [FILE:12] : 'bind' expects a path",
      "[WARNING] (1234) : parsing [FILE:3] : a rule placed after a 'use_backend'",
      "Configuration file is valid",
    ].join("\n");
    const msgs = parseLint(out, "haproxy");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ line: 12, level: "error" });
    expect(msgs[0].message).toContain("'bind' expects a path");
    expect(msgs[1]).toMatchObject({ line: 3, level: "warning" });
  });

  it("returns nothing for a valid config", () => {
    expect(parseLint("Configuration file is valid\n", "haproxy")).toEqual([]);
  });
});

describe("parseLint (systemd format)", () => {
  it("parses keyed diagnostics and keeps unkeyed errors at line 1", () => {
    const out = [
      "FILE:5: Unknown key name 'Exec' in section 'Service', ignoring.",
      "Command /usr/bin/nope is not executable: No such file or directory",
      "Configuration file is fine",
    ].join("\n");
    const msgs = parseLint(out, "systemd");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ line: 5, message: "Unknown key name 'Exec' in section 'Service', ignoring." });
    expect(msgs[1]).toEqual({ line: 1, level: "error", message: "Command /usr/bin/nope is not executable: No such file or directory" });
  });

  it("returns nothing when the unit verifies clean", () => {
    expect(parseLint("", "systemd")).toEqual([]);
  });
});

describe("parseLint (generic format — compose/promtool/kubeconform)", () => {
  it("keeps problem lines and pulls an embedded line number", () => {
    const out = [
      "yaml: line 7: mapping values are not allowed in this context",
      "services.web Additional property buildd is not allowed",
    ].join("\n");
    const msgs = parseLint(out, "generic");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ line: 7, level: "error" });
    expect(msgs[1]).toMatchObject({ line: 1, level: "error" });
    expect(msgs[1].message).toContain("not allowed");
  });

  it("ignores success/summary output (valid config → clean)", () => {
    expect(parseLint("  SUCCESS: FILE is valid prometheus config\n", "generic")).toEqual([]);
    expect(parseLint("", "generic")).toEqual([]);
  });

  it("flags a kubeconform invalid-resource line at line 1", () => {
    const out = "FILE - Deployment web is invalid: problem validating schema\n";
    const msgs = parseLint(out, "generic");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ line: 1, level: "error" });
  });
});
