import { describe, it, expect } from "vitest";
import { shellQuote, toShellCommand, isCommandMissing, probeError } from "./probe";

describe("shellQuote", () => {
  it("leaves safe tokens unquoted", () => {
    expect(shellQuote("dig")).toBe("dig");
    expect(shellQuote("+short")).toBe("+short");
    expect(shellQuote("example.com:443")).toBe("example.com:443");
    expect(shellQuote("a/b-c_d.e")).toBe("a/b-c_d.e");
  });

  it("quotes empty and space-containing tokens", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("x; rm -rf /")).toBe("'x; rm -rf /'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("toShellCommand", () => {
  it("joins argv into a readable, safe command line", () => {
    expect(toShellCommand(["ping", "-c", "4", "a b"])).toBe("ping -c 4 'a b'");
  });
});

describe("isCommandMissing", () => {
  it("detects missing-binary wording", () => {
    expect(isCommandMissing("sh: mtr: command not found")).toBe(true);
    expect(isCommandMissing("bash: traceroute: not found")).toBe(true);
    expect(isCommandMissing("No such file or directory")).toBe(true);
  });
  it("is false for normal output", () => {
    expect(isCommandMissing("64 bytes from 1.1.1.1")).toBe(false);
  });
});

describe("probeError", () => {
  it("is empty on success with stdout", () => {
    expect(probeError("ok", "", 0)).toBe("");
  });
  it("prefers stderr on failure", () => {
    expect(probeError("", "boom", 1)).toBe("boom");
  });
  it("falls back to stdout then exit code", () => {
    expect(probeError("partial", "", 2)).toBe("partial");
    expect(probeError("", "", 7)).toBe("exit 7");
  });
});
