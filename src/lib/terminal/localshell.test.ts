import { describe, it, expect } from "vitest";
import { resolveLocalShell, windowsShellProgram, WINDOWS_SHELLS } from "./localshell";

describe("windowsShellProgram", () => {
  it("maps presets to fixed programs, cmd/custom to the OS default", () => {
    expect(windowsShellProgram("powershell")).toBe("powershell.exe");
    expect(windowsShellProgram("pwsh")).toBe("pwsh.exe");
    expect(windowsShellProgram("cmd")).toBeNull();
    expect(windowsShellProgram("custom")).toBeNull();
  });

  it("covers every declared shell value", () => {
    for (const s of WINDOWS_SHELLS) {
      // Either a fixed program or null (custom/cmd) — never undefined.
      expect(windowsShellProgram(s)).not.toBeUndefined();
    }
  });
});

describe("resolveLocalShell on Windows", () => {
  it("cmd falls back to the OS default (null → %ComSpec%)", () => {
    expect(resolveLocalShell("windows", "cmd", "")).toBeNull();
  });

  it("selects the PowerShell programs", () => {
    expect(resolveLocalShell("windows", "powershell", "")).toBe("powershell.exe");
    expect(resolveLocalShell("windows", "pwsh", "")).toBe("pwsh.exe");
  });

  it("custom uses the trimmed path, or the default when blank", () => {
    expect(resolveLocalShell("windows", "custom", "  C:\\bin\\nu.exe  ")).toBe("C:\\bin\\nu.exe");
    expect(resolveLocalShell("windows", "custom", "   ")).toBeNull();
  });

  it("ignores localShellPath for the non-custom presets", () => {
    expect(resolveLocalShell("windows", "powershell", "C:\\ignored.exe")).toBe("powershell.exe");
  });
});

describe("resolveLocalShell on macOS/Linux", () => {
  it("uses a non-empty custom path as a $SHELL override, ignoring windowsShell", () => {
    expect(resolveLocalShell("macos", "powershell", "/bin/zsh")).toBe("/bin/zsh");
    expect(resolveLocalShell("linux", "cmd", "  /usr/bin/fish ")).toBe("/usr/bin/fish");
  });

  it("blank path means the OS default ($SHELL)", () => {
    expect(resolveLocalShell("macos", "cmd", "")).toBeNull();
    expect(resolveLocalShell("linux", "custom", "   ")).toBeNull();
  });
});
