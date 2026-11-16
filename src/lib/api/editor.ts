// The editor's commands beyond reading and writing (ADR 0076): formatting with
// the project's own tool where the file lives.
import { call } from "./call";
import type { FormatRun } from "../types";

/**
 * Format `content` with `argv` (a formatter's stdin form, `format.ts`) in the
 * file's folder `dir` — on the session's server, or on this computer when
 * `sessionId` is null (a local file). `name` names the file (the fixer's copy
 * keeps its extension). Not installed — `found: false`.
 */
export function formatRun(sessionId: string | null, argv: string[], dir: string, name: string, content: string): Promise<FormatRun> {
  return call<FormatRun>("format_run", { sessionId, argv, dir, name, content });
}
