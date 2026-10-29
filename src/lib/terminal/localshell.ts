// Pure resolution of which program a local terminal tab spawns, kept DOM-/store-
// free so it is unit-tested directly (architecture invariant: logic in `.ts`).
//
// The host OS is reported by the Rust backend (`host_os` command → `std::env::
// consts::OS`), so no runtime OS plugin is pulled into the offline WebView. On
// Windows the user picks a preset (cmd/PowerShell/pwsh) or a custom path; on
// macOS/Linux only a custom `$SHELL` override is offered. `null` means "let the
// backend use its OS default" (`CommandBuilder::new_default_prog()` — `%ComSpec%`
// on Windows, `$SHELL` on Unix), preserving the pre-feature behaviour exactly.

/** Which shell a local terminal spawns on Windows (see `resolveLocalShell`). */
export type WindowsShell = "cmd" | "powershell" | "pwsh" | "custom";

/** All valid `WindowsShell` values, for validation/iteration. */
export const WINDOWS_SHELLS: WindowsShell[] = ["cmd", "powershell", "pwsh", "custom"];

/** Fixed program for a Windows preset (`null` = OS default / needs a custom path). */
export function windowsShellProgram(shell: WindowsShell): string | null {
  switch (shell) {
    case "powershell":
      return "powershell.exe";
    case "pwsh":
      return "pwsh.exe";
    // `cmd` maps to the OS default (%ComSpec%, i.e. cmd.exe) so the default
    // preset keeps the exact pre-feature behaviour; `custom` has no fixed program.
    case "cmd":
    case "custom":
    default:
      return null;
  }
}

/**
 * Resolve the local-shell program to spawn, or `null` for the backend's OS
 * default. `os` is the value from the `host_os` command ("windows"/"macos"/
 * "linux"). On Windows the preset wins (custom falls back to `localShellPath`);
 * on any other OS a non-empty `localShellPath` overrides `$SHELL`.
 */
export function resolveLocalShell(
  os: string,
  windowsShell: WindowsShell,
  localShellPath: string,
): string | null {
  const custom = localShellPath.trim();
  if (os === "windows") {
    if (windowsShell === "custom") return custom || null;
    return windowsShellProgram(windowsShell);
  }
  return custom || null;
}
