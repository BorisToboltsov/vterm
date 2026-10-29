// How path sync ("follow terminal") starts on a server (v1.23). Each server keeps
// its own answer in its profile — set in the server form or by the question asked
// when sync is first turned on there; a local tab's answer lives in settings, since
// it has no profile. Pure logic: the page asks it what to do, the form and the
// question write the result. See INVARIANTS («Следовать за терминалом»).

/** `ask` — the question when sync is turned on; `auto` — on at every connect;
 *  `manual` — by hand, without the question. */
export type PathSyncMode = "ask" | "auto" | "manual";

export const PATH_SYNC_MODES: readonly PathSyncMode[] = ["ask", "auto", "manual"];

export function isPathSyncMode(v: unknown): v is PathSyncMode {
  return PATH_SYNC_MODES.includes(v as PathSyncMode);
}

/**
 * A stored answer, read back. Only the two choices count: anything else — none
 * yet, a mode a newer build added, a hand-edited file — asks, so nothing turns
 * sync on (and types a command into a shell) unless the user said so.
 */
export function pathSyncMode(raw: unknown): PathSyncMode {
  return raw === "auto" || raw === "manual" ? raw : "ask";
}

/** What a profile stores for a mode: "ask" is the absence of a choice. */
export function storedPathSync(mode: PathSyncMode): string | null {
  return mode === "ask" ? null : mode;
}

/** An answer to the question: on every connect, for this session only, or by
 *  hand without being asked again. */
export type PathSyncChoice = "always" | "once" | "manual";

export const PATH_SYNC_CHOICES: readonly PathSyncChoice[] = ["always", "once", "manual"];

/** The mode an answer saves; "once" saves nothing — next time asks again. */
export function choiceMode(choice: PathSyncChoice): PathSyncMode | null {
  if (choice === "always") return "auto";
  if (choice === "manual") return "manual";
  return null;
}

/** Turning sync on by hand asks only while the server has no answer. An `auto`
 *  server turned on by hand (after switching it off) does not ask either. */
export function asksOnEnable(mode: PathSyncMode): boolean {
  return mode === "ask";
}

/**
 * Whether a tab starts following on its own when its session connects: only
 * under `auto`, and never for a tab whose shell runs a program of its own — a
 * container/pod shell or a one-shot command such as `port-forward`. The setup
 * line typed after it would land in that program, not in the host's shell.
 */
export function followsOnConnect(
  mode: PathSyncMode,
  tab: { attach: boolean; pendingCommand: boolean },
): boolean {
  return mode === "auto" && !tab.attach && !tab.pendingCommand;
}

/**
 * Whether the question shows the setup command. It does when this session needs
 * it now, and on SSH whenever the answer is a lasting one: `auto` types it at
 * every connect, `manual` types it without asking whenever a shell does not
 * report its folder — a command the app will type unasked is shown before the
 * user agrees to it. A local tab never needs it (its folder comes from the OS).
 */
export function questionShowsSetup(
  kind: "ssh" | "local" | undefined,
  needsSetup: boolean,
  choice: PathSyncChoice,
): boolean {
  if (kind === "local") return false;
  return needsSetup || choice !== "once";
}

/** A prod server told to sync at every connect types a command into a prod shell
 *  each time, and auto-recording keeps it — say so beside the choice. */
export function warnsProd(
  kind: "ssh" | "local" | undefined,
  prod: boolean,
  mode: PathSyncMode | null,
): boolean {
  return kind === "ssh" && prod && mode === "auto";
}

/** i18n key naming a mode — the server form's switch and section header. */
export function pathSyncModeKey(
  mode: PathSyncMode,
): "pathSync.modeAsk" | "pathSync.modeAuto" | "pathSync.modeManual" {
  if (mode === "auto") return "pathSync.modeAuto";
  if (mode === "manual") return "pathSync.modeManual";
  return "pathSync.modeAsk";
}

/** i18n key of the line under the server form's switch: what the mode does. */
export function pathSyncHintKey(
  mode: PathSyncMode,
): "pathSync.hintAsk" | "pathSync.hintAuto" | "pathSync.hintManual" {
  if (mode === "auto") return "pathSync.hintAuto";
  if (mode === "manual") return "pathSync.hintManual";
  return "pathSync.hintAsk";
}
