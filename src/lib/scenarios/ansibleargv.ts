// The command a run of a playbook types into the terminal (ADR 0071): `cd` to
// the project — or to the folder of a playbook of the library, or to the run's
// folder it was carried to (ADR 0072) — then `env` with the event collector of
// vterm and the playbook with what the run dialog chose. Ansible runs only in a POSIX shell (Linux,
// macOS, WSL), so the line is POSIX. Pure.
import { shQuote } from "./recipe";

/** The collector's file name in the temporary folder of the run. */
export const COLLECTOR_FILE = "vterm_events.py";
/** Where the collector writes the events of the run, in the same folder. */
export const EVENTS_FILE = "events.out";
/** The inventory of the servers picked from the catalog, in the same folder. */
export const CATALOG_INVENTORY_FILE = "vterm-inventory.yml";
/**
 * The name a playbook of the library (ADR 0072) takes in the run's folder on a
 * server: its own, unless vterm's files of the run hold it.
 */
export const carriedName = (file: string): string =>
  [COLLECTOR_FILE, EVENTS_FILE, CATALOG_INVENTORY_FILE].includes(file) ? `playbook-${file}` : file;

/** Where Ansible looks for callbacks by default — kept after vterm's folder. */
const DEFAULT_CALLBACK_DIRS = "~/.ansible/plugins/callback:/usr/share/ansible/plugins/callback";

export interface PlaybookRun {
  /** The project folder: the command runs there, as the user would. */
  root: string;
  /** The playbook, relative to the root. */
  playbook: string;
  /** `-i` of the run (the project's inventory unless the dialog replaced it, and the catalog's). */
  inventories: string[];
  /** `--limit`: names of hosts and groups; empty — all the playbook targets. */
  limit: string[];
  /** `--tags`; empty — every task. */
  tags: string[];
  /** `--check --diff`: nothing is changed. */
  check: boolean;
  /** `-K`: Ansible asks the sudo password in the terminal. */
  askBecome: boolean;
  /** `-k`: Ansible asks the SSH password (servers that sign in with one). */
  askPass: boolean;
  /** The temporary folder of the run: the collector and the events. */
  tempDir: string;
}

/** The argv of the run, from `env` on. */
export function playbookArgv(run: PlaybookRun): string[] {
  const argv = [
    "env",
    `ANSIBLE_CALLBACK_PLUGINS=${run.tempDir}:${DEFAULT_CALLBACK_DIRS}`,
    `VTERM_EVENTS=${run.tempDir}/${EVENTS_FILE}`,
    "ansible-playbook",
    run.playbook,
  ];
  for (const inv of run.inventories) argv.push("-i", inv);
  if (run.limit.length) argv.push("--limit", run.limit.join(","));
  if (run.tags.length) argv.push("--tags", run.tags.join(","));
  if (run.check) argv.push("--check", "--diff");
  if (run.askBecome) argv.push("-K");
  if (run.askPass) argv.push("-k");
  return argv;
}

/** A POSIX token: bare when it is safe, quoted otherwise. */
const tok = (s: string): string => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) && !s.startsWith("~") ? s : shQuote(s));

/**
 * The line typed into the terminal — without the Enter (`submitLine` adds it).
 * Null when something in it cannot be typed as one line.
 */
export function playbookLine(run: PlaybookRun): string | null {
  const argv = playbookArgv(run);
  if ([run.root, ...argv].some((a) => /[\r\n]/.test(a))) return null;
  return `cd ${tok(run.root)} && ${argv.map(tok).join(" ")}`;
}

/** What the run dialog shows as the command — the same line, for reading. */
export const commandPreview = (run: PlaybookRun): string => playbookLine(run) ?? "";
