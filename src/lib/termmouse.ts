// What a right-click (and plain Ctrl+V) does in the terminal — pure logic, so the
// Terminal component only dispatches the answer.
//
// Right-click is a setting: "paste" (PuTTY / Windows Terminal muscle memory — the
// selection is already copied by copy-on-select, so the other half of the round
// trip is one click) or "menu" (the classic context menu). Shift+right-click always
// gives the other one, so neither choice locks the user out of the menu's items
// (Select all has no other mouse path).
//
// With copy-on-select off, a right-click over a selection copies it instead of
// pasting — otherwise there'd be no one-click copy at all, and pasting over a
// selection the user just made is never what they meant.

export type RightClickAction = "paste" | "menu";

export const RIGHT_CLICK_ACTIONS: readonly RightClickAction[] = ["paste", "menu"];

export function isRightClickAction(v: unknown): v is RightClickAction {
  return RIGHT_CLICK_ACTIONS.includes(v as RightClickAction);
}

export type RightClickEffect = "menu" | "paste" | "copy";

export interface RightClickInput {
  /** `settings.rightClick`. */
  setting: RightClickAction;
  /** Shift held — swaps to the other action. */
  shift: boolean;
  /** The terminal has a non-empty selection. */
  hasSelection: boolean;
  /** `settings.copyOnSelect` — the selection is already on the clipboard. */
  copyOnSelect: boolean;
}

export function rightClickEffect(i: RightClickInput): RightClickEffect {
  const action: RightClickAction = i.shift ? (i.setting === "menu" ? "paste" : "menu") : i.setting;
  if (action === "menu") return "menu";
  return i.hasSelection && !i.copyOnSelect ? "copy" : "paste";
}

/**
 * Whether plain Ctrl+V pastes instead of going to the shell. Only on Windows/Linux:
 * macOS has ⌘V, and there plain Ctrl+V stays a control key (emacs page-down,
 * readline quoted-insert). Unknown OS (not resolved yet) keeps the shell's meaning.
 */
export function ctrlVPastes(enabled: boolean, os: string): boolean {
  return enabled && os !== "" && os !== "macos";
}
