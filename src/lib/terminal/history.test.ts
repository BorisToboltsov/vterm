import { describe, it, expect } from "vitest";
import {
  parseShellHistory,
  recentUniqueCommands,
  filterCommands,
  mergeCommands,
  createCommandCapture,
} from "./history";

describe("parseShellHistory", () => {
  it("reads plain bash history, one command per line", () => {
    expect(parseShellHistory("ls -la\ncd /etc\ngit status\n")).toEqual([
      "ls -la",
      "cd /etc",
      "git status",
    ]);
  });

  it("strips the zsh EXTENDED_HISTORY metadata prefix", () => {
    const text = ": 1700000000:0;git push\n: 1700000005:2;npm run build\n";
    expect(parseShellHistory(text)).toEqual(["git push", "npm run build"]);
  });

  it("skips bash HISTTIMEFORMAT timestamp lines", () => {
    expect(parseShellHistory("#1700000000\nls\n#1700000005\npwd\n")).toEqual(["ls", "pwd"]);
  });

  it("rejoins a backslash-continued command", () => {
    const text = ": 1700000000:0;for i in 1 2 3; do \\\necho $i; \\\ndone\n";
    expect(parseShellHistory(text)).toEqual(["for i in 1 2 3; do \necho $i; \ndone"]);
  });

  it("does not treat an escaped backslash as a continuation", () => {
    expect(parseShellHistory("echo hi\\\\\npwd\n")).toEqual(["echo hi\\\\", "pwd"]);
  });

  it("drops blank lines and normalises CRLF", () => {
    expect(parseShellHistory("ls\r\n\r\npwd\r\n")).toEqual(["ls", "pwd"]);
  });
});

describe("recentUniqueCommands", () => {
  it("returns commands newest-first with duplicates collapsed to their latest use", () => {
    const text = "ls\ngit status\nls\npwd\ngit status\n";
    expect(recentUniqueCommands(text)).toEqual(["git status", "pwd", "ls"]);
  });

  it("is empty for empty history", () => {
    expect(recentUniqueCommands("")).toEqual([]);
  });
});

describe("filterCommands", () => {
  const cmds = ["git push origin main", "npm run build", "git status"];

  it("returns everything for an empty query", () => {
    expect(filterCommands(cmds, "  ")).toEqual(cmds);
  });

  it("matches case-insensitive substrings, preserving order", () => {
    expect(filterCommands(cmds, "GIT")).toEqual(["git push origin main", "git status"]);
  });

  it("returns nothing when no command matches", () => {
    expect(filterCommands(cmds, "docker")).toEqual([]);
  });
});

describe("mergeCommands", () => {
  it("keeps the first occurrence, so live capture wins over the history file", () => {
    const captured = ["git status", "npm test"];
    const file = ["npm test", "ls", "git status"];
    expect(mergeCommands(captured, file)).toEqual(["git status", "npm test", "ls"]);
  });

  it("ignores empty lists", () => {
    expect(mergeCommands([], ["a"], [])).toEqual(["a"]);
  });
});

describe("createCommandCapture", () => {
  it("commits a command on Enter, across chunk boundaries", () => {
    const cap = createCommandCapture();
    expect(cap.feed("ec")).toEqual([]);
    expect(cap.feed("ho hi")).toEqual([]);
    expect(cap.feed("\r")).toEqual(["echo hi"]);
  });

  it("applies backspace and Ctrl-U line editing before commit", () => {
    const cap = createCommandCapture();
    expect(cap.feed("ls -laX\x7f\r")).toEqual(["ls -la"]); // backspace deletes the stray char
    expect(cap.feed("junk\x15pwd\r")).toEqual(["pwd"]); // Ctrl-U kills the line
  });

  it("drops a canceled line (Ctrl-C) and empty Enters", () => {
    const cap = createCommandCapture();
    expect(cap.feed("rm -rf /\x03")).toEqual([]);
    expect(cap.feed("\r\r")).toEqual([]);
  });

  it("does not capture a line edited with arrow keys (distrusted)", () => {
    const cap = createCommandCapture();
    // Type, then press Left arrow (ESC [ D) and edit — the buffer is unreliable.
    expect(cap.feed("ls\x1b[Dx\r")).toEqual([]);
  });

  it("does not capture a tab-completed line", () => {
    const cap = createCommandCapture();
    expect(cap.feed("cd /et\tc\r")).toEqual([]);
  });

  it("recovers on the next line after a dirty one", () => {
    const cap = createCommandCapture();
    expect(cap.feed("ls\x1b[Dx\r")).toEqual([]);
    expect(cap.feed("pwd\r")).toEqual(["pwd"]);
  });
});
