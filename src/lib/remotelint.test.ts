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
