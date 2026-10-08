// The two parts a wide tool panel shows side by side (v1.7) and the border
// between them the user drags (v1.10.1): Git's changes and history, a Docker or
// k8s list and the logs, inspect or details opened next to it. The pure half —
// what share the first part takes and what a drag may set; the shares
// themselves are kept by `stores/panelsplit.svelte.ts` (ADR 0003).

/** The panels that split in two, and the share of the row the first part starts with. */
export const PANEL_SPLITS = {
  // Changes (or branches) beside the history: the history is the wider one.
  git: 0.4,
  // The list beside what was opened from it: halves.
  docker: 0.5,
  k8s: 0.5,
} as const;

export type PanelSplit = keyof typeof PANEL_SPLITS;

export const isPanelSplit = (v: unknown): v is PanelSplit =>
  typeof v === "string" && Object.hasOwn(PANEL_SPLITS, v);

/** Narrowest either part is dragged to, px: a list row and a log line stay readable. */
export const PART_MIN = 240;
/** The share is never set outside these, whatever the width (also what storage may hold). */
export const SHARE_MIN = 0.2;
export const SHARE_MAX = 0.8;

/**
 * The shares a border may be set to in a row `width` px wide: within the fixed
 * limits, and neither part under `PART_MIN`. A row too narrow for two minimal
 * parts has one answer — halves; a width not measured yet (0) is bound by the
 * fixed limits alone.
 */
export function shareRange(width: number, min = PART_MIN): { min: number; max: number } {
  if (!(width > 0)) return { min: SHARE_MIN, max: SHARE_MAX };
  const least = Math.max(SHARE_MIN, min / width);
  const most = Math.min(SHARE_MAX, 1 - min / width);
  return least > most ? { min: 0.5, max: 0.5 } : { min: least, max: most };
}

/** A share brought inside what the row allows. Not a number — halves. */
export function clampShare(share: number, width: number): number {
  const range = shareRange(width);
  if (!Number.isFinite(share)) return Math.min(range.max, Math.max(range.min, 0.5));
  return Math.min(range.max, Math.max(range.min, share));
}

/** The share that puts the border `px` from the row's left edge. */
export function shareAt(width: number, px: number): number {
  return clampShare(width > 0 ? px / width : 0.5, width);
}

/** The share after moving the border by `px` (keyboard). */
export function nudgedShare(share: number, width: number, px: number): number {
  return shareAt(width, clampShare(share, width) * width + px);
}

/** A share as the CSS width of the first part: a percentage, to a hundredth. */
export const shareWidth = (share: number): string => `${Math.round(share * 1e4) / 100}%`;

export type PanelShares = Partial<Record<PanelSplit, number>>;

/**
 * The stored shares (`vterm.panelsplit`) made safe to use: known panels only,
 * finite numbers only, inside the fixed limits. Storage is user-writable and
 * outlives the build that wrote it.
 */
export function sanitizeShares(raw: unknown): PanelShares {
  const out: PanelShares = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isPanelSplit(key) && typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(SHARE_MAX, Math.max(SHARE_MIN, value));
    }
  }
  return out;
}

/** The share a panel's first part is drawn at in a row `width` px wide: the user's, or the default. */
export function panelShare(shares: PanelShares, split: PanelSplit, width: number): number {
  return clampShare(shares[split] ?? PANEL_SPLITS[split], width);
}
