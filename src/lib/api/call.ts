// The one door to the backend (ADR 0063): every command goes through `call()`,
// and `invoke` is imported here alone (`vterm/invoke-in-call`). A command the
// backend rejected is an event of the diagnostics — its name, how long it took,
// and the error — so a new command is covered without a line of its own. Its
// arguments never are: passwords travel in them.
//
// The diagnostics' own commands are not written when they fail: the event of
// their failure would go through them again.

import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { noteRejected } from "./diag";

/** Call backend command `cmd`, as `invoke` does; a rejection is written, then thrown on. */
export async function call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const started = Date.now();
  try {
    // The arity is kept: a wrapper's test checks the exact call.
    if (args === undefined) return await invoke<T>(cmd);
    if (options === undefined) return await invoke<T>(cmd, args);
    return await invoke<T>(cmd, args, options);
  } catch (err) {
    if (!cmd.startsWith("diag_")) noteRejected(cmd, err, Date.now() - started);
    throw err;
  }
}
