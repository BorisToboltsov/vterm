// Editing a file on the group (ADR 0064): the edit made in the editor of one
// member — the source — is carried to the same path on the other members, and
// every one of them says what it would become before anything is written.
// DOM-free (ADR 0003): the flow reads and writes, this module decides.

import type { TextFile } from "../types";
import { applyHunks, type Hunk, type Outcome } from "./linepatch";

/** Where a member stands. */
export type HostEdit =
  | { kind: "reading" }
  /** No file at that path there. Nothing is created on a server without being asked. */
  | { kind: "missing" }
  /** The file could not be read as this user — sudo can. */
  | { kind: "denied" }
  /** Read, but not as text (binary, too large) or another failure — with its reason. */
  | { kind: "failed"; error: string }
  /** Read and patched. `text` — what would be written; null for a conflict. */
  | { kind: "patched"; outcome: Outcome; file: TextFile; text: string | null; sudo: boolean }
  /** Written (or found already edited). */
  | { kind: "written" }
  /** The write failed — the file is as it was, the reason said. */
  | { kind: "notWritten"; error: string };

/** A server of the group in the edit's dialog. */
export interface EditHost {
  id: string;
  label: string;
  prod: boolean;
  edit: HostEdit;
  picked: boolean;
}

export interface EditAsk {
  /** The member whose editor holds the edit. */
  lead: string;
  leadLabel: string;
  docId: string;
  path: string;
  name: string;
  /** Null — the edit is too large to carry as a patch. */
  hunks: Hunk[] | null;
  hosts: EditHost[];
  /** Writing now. */
  writing: boolean;
  /** Written (or tried): the dialog shows the outcome and closes. */
  done: boolean;
  /** The source could not be saved: nothing else was written. */
  leadFailed: boolean;
}

/** What a failed read says about the member's file. */
export function readFailure(error: string): HostEdit {
  if (/no such file|not found|does not exist/i.test(error)) return { kind: "missing" };
  if (/permission denied/i.test(error)) return { kind: "denied" };
  return { kind: "failed", error };
}

/** The member's file, read, with the edit carried into it. */
export function patchHost(file: TextFile, hunks: readonly Hunk[], sudo: boolean): HostEdit {
  const res = applyHunks(file.content, hunks);
  return { kind: "patched", outcome: res.outcome, file, text: res.text, sudo };
}

/** There is something to write: the edit found its place and the file does not have it yet. */
export function writable(h: HostEdit): h is Extract<HostEdit, { kind: "patched" }> & { text: string } {
  return h.kind === "patched" && h.text !== null && h.outcome !== "already" && h.outcome !== "conflict";
}

/**
 * Ticked at first: where the edit landed exactly or only moved. One that landed
 * with part of its context, or at the file's edge, is offered but left for the
 * user to look at and tick — the preview is right there.
 */
export function pickedAtFirst(h: HostEdit): boolean {
  return writable(h) && (h.outcome === "clean" || h.outcome === "offset");
}

/** Counts for the dialog's button and the diagnostics. */
export function editTally(hosts: readonly HostEdit[], picked: (i: number) => boolean) {
  let write = 0;
  let already = 0;
  let left = 0;
  hosts.forEach((h, i) => {
    if (writable(h) && picked(i)) write++;
    else if (h.kind === "patched" && h.outcome === "already") already++;
    else left++;
  });
  return { write, already, left };
}
