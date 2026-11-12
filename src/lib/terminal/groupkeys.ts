// Keys mode of synchronous input (ADR 0064): what the terminal in focus is
// given is given to the group's other members — for what a command line cannot
// carry: Esc, Ctrl-keys, a full-screen editor. DOM-free (ADR 0003).
//
// The danger it is shaped against: keys meant for vim landing in a shell, where
// `dd`, `:wq` and the Enter between them are a command line. So a member gets
// the keys only while its screen is the same kind as the one typed into — both
// a full-screen program (the alternate buffer) or both a shell (the normal one).

/** Which buffer a terminal shows: a full-screen program is in the alternate one. */
export type Screen = "normal" | "alternate";

/** Who gets the keys typed into `source`, and who is passed over. */
export interface KeysPlan {
  to: string[];
  /** Members whose screen is not the source's (or is unknown) — named, not left out silently. */
  skipped: string[];
}

export function keysReceivers(
  source: string,
  members: readonly string[],
  screenOf: (id: string) => Screen | null,
): KeysPlan {
  const own = screenOf(source);
  const to: string[] = [];
  const skipped: string[] = [];
  for (const id of members) {
    if (id === source) continue;
    if (own !== null && screenOf(id) === own) to.push(id);
    else skipped.push(id);
  }
  return { to, skipped };
}

// What a terminal sends by itself rather than from a key: mouse reports (X10
// `ESC [ M` + three bytes, SGR `ESC [ < b;x;y M|m`, urxvt `ESC [ b;x;y M`) and
// focus reports (`ESC [ I`, `ESC [ O`). They name a place on *its* screen or
// *its* window — passed to another terminal they click somewhere else.
const X10_MOUSE = /\x1b\[M[\s\S]{3}/g;
const SGR_MOUSE = /\x1b\[<\d+;\d+;\d+[Mm]/g;
const URXVT_MOUSE = /\x1b\[\d+;\d+;\d+M/g;
const FOCUS = /\x1b\[[IO]/g;

/** `data` from the terminal in focus with what only made sense on its own screen taken out. */
export function mirrorable(data: string): string {
  return data.replace(X10_MOUSE, "").replace(SGR_MOUSE, "").replace(URXVT_MOUSE, "").replace(FOCUS, "");
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * The text of a bracketed paste, when `data` is one whole: each member is given
 * it through its own terminal's paste, which brackets it only if the program
 * there asked — the markers of the source's program mean nothing to another.
 */
export function pastedText(data: string): string | null {
  if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return null;
  const inner = data.slice(PASTE_START.length, data.length - PASTE_END.length);
  return inner.includes(PASTE_START) || inner.includes(PASTE_END) ? null : inner;
}
