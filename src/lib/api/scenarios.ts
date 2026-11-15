// Scenarios API (ADR 0071, 0072): the library of recipes and playbooks on this computer, a recipe run
// on a server, and the checks and the temporary folder of an Ansible or
// Terraform project on the host where it lies. `ansible-playbook` and
// `terraform plan/apply` are not here: they are typed into the tab's terminal.
import { open } from "@tauri-apps/plugin-dialog";
import { call } from "./call";
import type { ExecOutput } from "../types";

/** One file of the library — a recipe or a playbook (mirror of `scenarios::RecipeFile`). */
export interface RecipeFile {
  path: string;
  /** The folder it was found in. */
  dir: string;
  name: string;
  text: string;
  modified: number;
}

/** A folder of a source with its names (mirror of `scenarios::SourceFolder`): a project or not, the window tells. */
export interface SourceFolder {
  path: string;
  /** The source it was found in. */
  source: string;
  entries: { name: string; isDir: boolean }[];
}

/** What a scan of the library found (mirror of `scenarios::RecipeScan`). */
export interface RecipeScan {
  /** The app's own recipes folder. */
  dir: string;
  files: RecipeFile[];
  /** Each source and the folders in it, listed. */
  folders: SourceFolder[];
  /** Sources that could not be read — named, never shown as empty. */
  unreadable: string[];
  /** Files skipped: too large or not text. */
  skipped: number;
}

/** Who a recipe runs as on the server (mirror of `scenarios::Elevation`). */
export type Elevation = "user" | "sudo" | "sudoPassword";

/** A chunk of a file of a run (mirror of `scenarios::TempChunk`): whole lines only. */
export interface TempChunk {
  exists: boolean;
  size: number;
  text: string;
  /** Bytes the lines take — the next read starts after them. */
  read: number;
}

/** Read the library: the app's recipes folder and the folders the user added. */
export function recipesScan(sources: string[]): Promise<RecipeScan> {
  return call<RecipeScan>("recipes_scan", { sources });
}

/** Save a recipe or a playbook into the app's folder; its path. A taken name without `replace` — `dest-exists`. */
export function recipeSave(name: string, text: string, replace: boolean): Promise<string> {
  return call<string>("recipe_save", { name, text, replace });
}

/** Delete a recipe or a playbook of the app's own folder. */
export function recipeDelete(path: string): Promise<void> {
  return call<void>("recipe_delete", { path });
}

/**
 * Run a recipe on an SSH session. The script (with its parameters exported at
 * its top) and the sudo password go on stdin, never on a command line; `name`
 * and `mode` label the run in the recording. `sftpCancel(cancelId)` stops it.
 * Never throws on a non-zero exit.
 */
export function recipeRun(
  sessionId: string,
  run: {
    name: string;
    mode: "check" | "apply";
    script: string;
    elevation: Elevation;
    password: string | null;
    timeoutSecs: number;
    cancelId: string;
  },
): Promise<ExecOutput> {
  return call<ExecOutput>("recipe_run", { sessionId, ...run });
}

/**
 * One check of a project (what it is, never running it): `--version`s, the
 * inventory as JSON, the installed collections, a saved plan as JSON. `config`
 * is the project's `ansible.cfg`.
 */
export function iacRun(sessionId: string, args: string[], config: string | null, timeoutSecs = 30): Promise<ExecOutput> {
  return call<ExecOutput>("iac_run", { sessionId, args, config, timeoutSecs });
}

/** Make the temporary folder of a run on the session's host with `files` in it; its path. */
export function iacTemp(sessionId: string, files: { name: string; text: string }[]): Promise<string> {
  return call<string>("iac_temp", { sessionId, files });
}

/** Read a file of a run's temporary folder from `offset`. */
export function iacRead(sessionId: string, path: string, offset: number): Promise<TempChunk> {
  return call<TempChunk>("iac_read", { sessionId, path, offset });
}

/** Remove a run's temporary folder. */
export function iacCleanup(sessionId: string, dir: string): Promise<void> {
  return call<void>("iac_cleanup", { sessionId, dir });
}

/** A folder of this computer (recipes to read, a project to pin); null — none picked. */
export async function pickRecipeFolder(title: string): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, title });
  return typeof res === "string" ? res : null;
}

/** Shell scripts and playbooks of this computer to copy into the library. */
export async function pickRecipeFiles(title: string): Promise<string[]> {
  const res = await open({ directory: false, multiple: true, title, filters: [{ name: "Shell, YAML", extensions: ["sh", "yml", "yaml"] }] });
  return Array.isArray(res) ? res : typeof res === "string" ? [res] : [];
}
