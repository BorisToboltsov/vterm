import { describe, expect, it } from "vitest";
import { SUBMIT, submitBlock, submitLine } from "./terminput";

describe("SUBMIT", () => {
  // The whole point of Phase 39.5: LF is not Enter. bash/zsh accept it by
  // accident (Ctrl+J is also accept-line); PSReadLine and cmd.exe do not, so a
  // command sent with LF just sat on the Windows prompt unexecuted.
  it("is CR, which is what pressing Enter actually sends", () => {
    expect(SUBMIT).toBe("\r");
    expect(SUBMIT).not.toBe("\n");
  });
});

describe("submitLine", () => {
  it("terminates a command with CR", () => {
    expect(submitLine("ls -la")).toBe("ls -la\r");
    expect(submitLine("cd /var/log")).toBe("cd /var/log\r");
  });

  it("never emits LF", () => {
    expect(submitLine("whoami")).not.toContain("\n");
  });

  // A leading space is how a caller keeps a command out of shell history
  // (HISTCONTROL=ignorespace); trimming would silently defeat that.
  it("preserves surrounding whitespace", () => {
    expect(submitLine(" secret-cmd")).toBe(" secret-cmd\r");
    expect(submitLine("echo hi ")).toBe("echo hi \r");
  });

  it("still terminates an empty command (an Enter on its own)", () => {
    expect(submitLine("")).toBe("\r");
  });
});

describe("submitBlock", () => {
  // The dangerous case: with LF between lines, Windows would submit only the
  // last line — silently running something other than what was shown.
  it("converts every internal line ending, not just the trailing one", () => {
    expect(submitBlock("cd /tmp\nls\n")).toBe("cd /tmp\rls\r");
    expect(submitBlock("a\nb\nc")).toBe("a\rb\rc\r");
  });

  it("normalises CRLF input too", () => {
    expect(submitBlock("cd /tmp\r\nls\r\n")).toBe("cd /tmp\rls\r");
  });

  it("drops trailing blank lines so the shell isn't given empty prompts", () => {
    expect(submitBlock("ls\n\n\n")).toBe("ls\r");
  });

  it("emits nothing for an empty or blank-only block", () => {
    expect(submitBlock("")).toBe("");
    expect(submitBlock("\n\n")).toBe("");
  });

  it("never emits LF", () => {
    expect(submitBlock("one\ntwo\nthree\n")).not.toContain("\n");
  });
});
