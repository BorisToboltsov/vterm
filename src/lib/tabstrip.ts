// The top strip that marks the ACTIVE tab (v1.0.42) — on the session tabs (2px)
// and the editor sub-tabs inside a session (1px). It used to sit on every prod tab
// regardless, and a red line on an inactive tab read as "this one is active".
// Now only the active tab carries it: the theme accent, or the danger red when the
// active tab is a prod session. An inactive prod tab is still told apart by its
// `prod` chip (and its terminal by the red frame) — see prodmark.guard.
//
// Classes are written out whole so Tailwind's scanner sees each one.
const STRIP = {
  2: {
    accent: "shadow-[inset_0_2px_0_0_var(--color-accent)]",
    prod: "shadow-[inset_0_2px_0_0_var(--color-bad)]",
  },
  1: {
    accent: "shadow-[inset_0_1px_0_0_var(--color-accent)]",
    prod: "shadow-[inset_0_1px_0_0_var(--color-bad)]",
  },
} as const;

/** The strip class for the active tab: accent, or red for a prod session. */
export function activeTabStrip(prod: boolean, px: 1 | 2): string {
  return STRIP[px][prod ? "prod" : "accent"];
}
