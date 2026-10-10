// "Copy to another session" (v1.12) — the pure half: which tabs a file can be
// copied to, where in them it lands by default, and what the two sides of the
// transfer are. The dialog (CopyToDialog) and the page only wire these up.
//
// A file is always copied, never moved: deleting the source on one server after
// a copy to another is not something to do behind a single gesture.

import type { TransferSide } from "./api";

/** A tab a file can be copied to. */
export interface CopyTarget {
  sessionId: string;
  /** What the tab is called on its strip. */
  title: string;
  /** A local shell tab: the files land on this machine. */
  local: boolean;
  /** Its server is marked production. */
  prod: boolean;
}

/** What the picker needs to know of a tab. */
export interface CopyTab {
  sessionId: string;
  kind: "ssh" | "local";
  status: string;
}

/**
 * The tabs files can be copied to: every tab with a live session. A server is
 * reached over the SFTP of its session, so the session has to be up — a tab
 * that is connecting, waiting or has lost its session is not offered.
 */
export function copyTargets(
  tabs: readonly CopyTab[],
  title: (tab: CopyTab) => string,
  prod: (sessionId: string) => boolean,
): CopyTarget[] {
  return tabs
    .filter((tab) => tab.status.startsWith("Connected"))
    .map((tab) => ({
      sessionId: tab.sessionId,
      title: title(tab),
      local: tab.kind === "local",
      prod: prod(tab.sessionId),
    }));
}

/** The targets offered from the panel of `from`: every one but its own tab. */
export function targetsFrom(targets: readonly CopyTarget[], from: string | null): CopyTarget[] {
  return targets.filter((t) => t.sessionId !== from);
}

/**
 * Where the files land unless the user says otherwise: the folder that tab's
 * file panel shows, else the folder its terminal is in, else its home. Null —
 * none is known yet (the caller asks the session for its home).
 */
export function defaultDestDir(
  panelDir: string | null,
  terminalDir: string | null,
  home: string | null,
): string | null {
  return [panelDir, terminalDir, home].find((d) => !!d && d !== ".") ?? null;
}

/** The side of a transfer a tab stands for. */
export function sideOf(tab: { sessionId: string; local: boolean; title: string }): TransferSide {
  return { session: tab.sessionId, local: tab.local, label: tab.title };
}

/** A destination folder as typed: trimmed, and null when it names nothing. */
export function typedDir(input: string): string | null {
  const dir = input.trim();
  return dir === "" ? null : dir;
}
