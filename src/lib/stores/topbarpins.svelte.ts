// The user's top-bar buttons (v1.16): the one place that changes
// `settings.topbar`. The list is a setting — it goes into a backup and reaches
// every window with the settings snapshot — and every change to it is the
// result of a pure function of `../topbaractions.ts`, so it can never lose
// Utilities or Settings, or name a button that does not exist
// (`topbar.guard.test.ts`).

import { settings } from "../settings.svelte";
import {
  DEFAULT_TOPBAR,
  moveTopbar,
  withPinned,
  withUnpinned,
  type TopbarId,
} from "../topbaractions";

/** Whether `id` is on the user's bar (reactive). */
export const isPinned = (id: TopbarId): boolean => settings.topbar.includes(id);

const differs = (next: readonly TopbarId[]): boolean =>
  next.length !== settings.topbar.length || next.some((id, i) => id !== settings.topbar[i]);

/** Put `id` on the bar. Already there, or not a button: nothing happens. */
export function pinAction(id: TopbarId): void {
  const next = withPinned(settings.topbar, id);
  if (differs(next)) settings.topbar = next;
}

/** Take `id` off the bar. Utilities and Settings stay; asking is a no-op. */
export function unpinAction(id: TopbarId): void {
  const next = withUnpinned(settings.topbar, id);
  if (differs(next)) settings.topbar = next;
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
}
