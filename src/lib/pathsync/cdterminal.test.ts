import { describe, expect, it } from "vitest";
import { cdCommand, cdShellKind } from "./cdterminal";

describe("cdShellKind", () => {
  it("maps the OS default: cmd on Windows, POSIX elsewhere", () => {
    expect(cdShellKind("windows", null)).toBe("cmd");
    expect(cdShellKind("macos", null)).toBe("posix");
    expect(cdShellKind("linux", null)).toBe("posix");
    expect(cdShellKind("windows", "  ")).toBe("cmd");
  });

  it("recognises the PowerShell family, including a full path", () => {
    expect(cdShellKind("windows", "powershell.exe")).toBe("powershell");
    expect(cdShellKind("windows", "pwsh.exe")).toBe("powershell");
    expect(cdShellKind("windows", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      "powershell",
    );
    // pwsh also runs on macOS/Linux.
    expect(cdShellKind("macos", "/usr/local/bin/pwsh")).toBe("powershell");
  });

  it("recognises cmd", () => {
    expect(cdShellKind("windows", "cmd.exe")).toBe("cmd");
    expect(cdShellKind("windows", "C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  });

  // Git Bash / MSYS on Windows want POSIX quoting despite the host OS — this is
  // the case a naive "windows ⇒ cmd" rule would get wrong.
  it("recognises a POSIX shell installed on Windows", () => {
    expect(cdShellKind("windows", "C:\\Program Files\\Git\\bin\\bash.exe")).toBe("posix");
    expect(cdShellKind("windows", "zsh")).toBe("posix");
    expect(cdShellKind("windows", "fish.exe")).toBe("posix");
  });

  it("falls back to the host convention for an unknown program", () => {
    expect(cdShellKind("windows", "someshell.exe")).toBe("cmd");
    expect(cdShellKind("linux", "someshell")).toBe("posix");
  });
});

describe("cdCommand — POSIX", () => {
  it("single-quotes the path", () => {
    expect(cdCommand("/var/log", "posix")).toBe("cd '/var/log'");
    expect(cdCommand("/tmp/my dir", "posix")).toBe("cd '/tmp/my dir'");
  });

  it("escapes an embedded single quote by closing and reopening", () => {
    expect(cdCommand("/tmp/it's", "posix")).toBe("cd '/tmp/it'\\''s'");
  });

  // A path holding shell metacharacters must stay inert inside the quotes.
  it("neutralises metacharacters", () => {
    expect(cdCommand("/tmp/a;rm -rf /", "posix")).toBe("cd '/tmp/a;rm -rf /'");
    expect(cdCommand("/tmp/$(whoami)", "posix")).toBe("cd '/tmp/$(whoami)'");
  });
});

describe("cdCommand — PowerShell", () => {
  it("uses -LiteralPath so brackets aren't globbed", () => {
    expect(cdCommand("C:\\Users\\bob", "powershell")).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\bob'",
    );
    // Brackets are legal in Windows filenames and would otherwise be a wildcard.
    expect(cdCommand("C:\\logs\\[2026]", "powershell")).toBe(
      "Set-Location -LiteralPath 'C:\\logs\\[2026]'",
    );
  });

  // PowerShell doubles an embedded quote; the POSIX '\'' form would be wrong.
  it("escapes an embedded quote by doubling it", () => {
    expect(cdCommand("C:\\it's", "powershell")).toBe("Set-Location -LiteralPath 'C:\\it''s'");
  });
});

describe("cdCommand — cmd.exe", () => {
  // Two independent things cmd needs that the POSIX form gets wrong.
  it("uses double quotes, because cmd does not quote with apostrophes", () => {
    expect(cdCommand("C:\\Program Files", "cmd")).toBe('cd /d "C:\\Program Files"');
  });

  it("passes /d so that changing drive actually moves you there", () => {
    // Without /d, `cd D:\data` from C: changes D:'s directory but leaves you on
    // C: — the panel and the shell would then silently disagree.
    expect(cdCommand("D:\\data", "cmd")).toBe('cd /d "D:\\data"');
    expect(cdCommand("D:\\data", "cmd")).toContain("/d");
  });
});

describe("cdCommand — refusals", () => {
  it("refuses an empty path rather than emitting a bare cd", () => {
    // A bare `cd` would send the shell home — silently wrong, not a no-op.
    expect(cdCommand("", "posix")).toBeNull();
    expect(cdCommand("   ", "cmd")).toBeNull();
  });

  // A newline would end the cd and run the remainder as a second command.
  it("refuses a path containing a newline in every dialect", () => {
    expect(cdCommand("/tmp/a\nrm -rf /", "posix")).toBeNull();
    expect(cdCommand("C:\\a\r\nwhoami", "cmd")).toBeNull();
    expect(cdCommand("/tmp/a\nx", "powershell")).toBeNull();
  });
});
