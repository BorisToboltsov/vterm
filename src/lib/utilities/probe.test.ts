import { describe, it, expect } from "vitest";
import { shellQuote, isCommandMissing, probeError, stepFailed, curlProgram, auditFailure, auditExit, auditText } from "./probe";

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

describe("stepFailed", () => {
  it("stops a chain on a failed step, keeping its message", () => {
    expect(stepFailed({ stdout: "", stderr: "connect: Connection refused", exitCode: 1 })).toBe(true);
    expect(stepFailed({ stdout: "", stderr: "", exitCode: 0 })).toBe(true);
    expect(stepFailed({ stdout: "-----BEGIN CERTIFICATE-----", stderr: "depth=0", exitCode: 0 })).toBe(false);
  });
});

describe("curlProgram", () => {
  it("names curl.exe outside POSIX", () => {
    expect(curlProgram("posix")).toBe("curl");
    expect(curlProgram("powershell")).toBe("curl.exe");
    expect(curlProgram("cmd")).toBe("curl.exe");
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

describe("audit helpers", () => {
  it("records the first error line, masked", () => {
    expect(auditFailure({ stdout: "", stderr: "curl: (7) refused\nmore", exitCode: 7 })).toBe("curl: (7) refused");
    expect(auditFailure({ stdout: "", stderr: "", exitCode: 0 })).toBe("no output");
    expect(auditFailure({ stdout: "<html>", stderr: "", exitCode: 0 })).toBe("unrecognized output");
    expect(auditFailure({ stdout: "", stderr: "Authorization: Bearer abcdefghijkl failed", exitCode: 1 })).not.toContain("abcdefghijkl");
  });
  it("never records a failed answer as exit 0", () => {
    expect(auditExit(0)).toBe(1);
    expect(auditExit(7)).toBe(7);
  });
  it("masks secrets", () => {
    expect(auditText("https://u:hunter2@h/x?token=abc123")).not.toMatch(/hunter2|abc123/);
  });
});
