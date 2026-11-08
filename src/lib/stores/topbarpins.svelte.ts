// The user's top-bar buttons (v1.16): the one place that changes
// `settings.topbar`. The list is a setting — it goes into a backup and reaches
// every window with the settings snapshot — and every change to it is the
// result of a pure function of `../topbaractions.ts`, so it can never lose
// Utilities or Settings, or name a button that does not exist
// (`topbar.guard.test.ts`).

import { settings } from "../settings/settings.svelte";
import type { IconName } from "../ui/icons";
import {
  actionCommand,
  commandAction,
  DEFAULT_TOPBAR,
  isPinnableCommand,
  moveTopbar,
  withPinned,
  withPinnedAt,
  withUnpinned,
  type TopbarId,
} from "../topbar/topbaractions";

/** Whether `id` is on the user's bar (reactive). */
export const isPinned = (id: TopbarId): boolean => settings.topbar.includes(id);

const differs = (next: readonly TopbarId[]): boolean =>
  next.length !== settings.topbar.length || next.some((id, i) => id !== settings.topbar[i]);

/** Put `id` on the bar. Already there, or not a button: nothing happens. */
export function pinAction(id: TopbarId): void {
  const next = withPinned(settings.topbar, id);
  if (differs(next)) settings.topbar = next;
}

/** Put `id` on the bar before the button at `index` (dropped there from the Utilities window). */
export function pinActionAt(id: TopbarId, index: number): void {
  const next = withPinnedAt(settings.topbar, id, index);
  if (differs(next)) settings.topbar = next;
}

/** Take `id` off the bar. Utilities and Settings stay; asking is a no-op. */
export function unpinAction(id: TopbarId): void {
  const next = withUnpinned(settings.topbar, id);
  if (differs(next)) settings.topbar = next;
  forgetCommands();
}

/** A ⌘K command (v1.35), as the palette names it. */
export interface CommandRef {
  id: string;
  title: string;
  icon: IconName;
}

/** Put a ⌘K command on the bar, remembering what to call it while the palette does not offer it. */
export function pinCommand(cmd: CommandRef): void {
  if (!isPinnableCommand(cmd.id)) return;
  const id = commandAction(cmd.id);
  settings.topbarCommands = { ...settings.topbarCommands, [id]: { title: cmd.title, icon: cmd.icon } };
  pinAction(id);
}

/** On the bar if it is not, off it if it is — the palette's pin. */
export function togglePinCommand(cmd: CommandRef): void {
  const id = commandAction(cmd.id);
  if (isPinned(id)) unpinAction(id);
  else pinCommand(cmd);
}

/**
 * The palette's commands as they are now: a pinned one keeps its current title
 * and icon (the language changed, a session's name did) — written only when it
 * differs, so a palette rebuilt on every keystroke writes nothing.
 */
export function refreshCommands(live: readonly CommandRef[]): void {
  let next: typeof settings.topbarCommands | null = null;
  for (const cmd of live) {
    const id = commandAction(cmd.id);
    const was = settings.topbarCommands[id];
    if (!was || (was.title === cmd.title && was.icon === cmd.icon)) continue;
    next ??= { ...settings.topbarCommands };
    next[id] = { title: cmd.title, icon: cmd.icon };
  }
  if (next) settings.topbarCommands = next;
}

/** What is remembered of commands no longer on the bar goes with them. */
function forgetCommands(): void {
  const kept = Object.keys(settings.topbarCommands).filter(
    (id) => actionCommand(id as TopbarId) !== null && settings.topbar.includes(id as TopbarId),
  );
  if (kept.length === Object.keys(settings.topbarCommands).length) return;
  settings.topbarCommands = Object.fromEntries(kept.map((id) => [id, settings.topbarCommands[id]]));
}

/** Move `id` to stand before the button at `index` (the end of a drag, once). */
export function moveAction(id: TopbarId, index: number): void {
  const next = moveTopbar(settings.topbar, id, index);
  if (differs(next)) settings.topbar = next;
}

/** The bar as a fresh install has it. */
export function resetTopbar(): void {
  const next = [...DEFAULT_TOPBAR];
  if (differs(next)) settings.topbar = next;
  forgetCommands();
}
