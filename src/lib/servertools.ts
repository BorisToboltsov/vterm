// Types + pure helpers for the server-tools install helper (Phase 12.8). The
// catalogue and install-command resolution live in the backend (servertools.rs);
// this mirrors the result shape and a small UI helper.

/** One optional tool's status on the active server (mirrors servertools.rs). */
export interface ToolStatus {
  id: string;
  name: string;
  installed: boolean;
  /** Install command for the detected manager, or null when unsupported. */
  command: string | null;
}

export interface ToolsStatus {
  /** Detected package manager ("apt"/"dnf"/…) or "" if none. */
  manager: string;
  tools: ToolStatus[];
}

/** True when a one-click install needs a sudo password (command starts with sudo). */
export function commandNeedsSudo(command: string): boolean {
  return command.trimStart().startsWith("sudo ");
}
