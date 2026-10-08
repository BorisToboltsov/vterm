// Where the user left the border between the two parts of a wide tool panel
// (v1.10.1): Git's changes and history, a Docker or k8s list and what is opened
// beside it. Kept here, not in the panel: a session panel is rebuilt on every
// terminal-tab switch, and a border that jumped back each time would not be
// something the user set. One share per panel kind, for every session.
// Persisted to localStorage under `vterm.panelsplit`; the arithmetic and the
// sanitizer are pure (`../panelsplit.ts`).

import {
  panelShare,
  sanitizeShares,
  SHARE_MAX,
  SHARE_MIN,
  shareWidth,
  type PanelShares,
  type PanelSplit,
} from "../panelsplit";

export const STORAGE_KEY = "vterm.panelsplit";

function load(): PanelShares {
  try {
    return sanitizeShares(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

export const panelSplits = $state<{ shares: PanelShares }>({ shares: load() });

/** The share a panel's first part is drawn at in a row `width` px wide (reactive). */
export function drawnShare(split: PanelSplit, width: number): number {
  return panelShare(panelSplits.shares, split, width);
}

/** The CSS width of a panel's first part in a row `width` px wide (reactive). */
export function partWidth(split: PanelSplit, width: number): string {
  return shareWidth(drawnShare(split, width));
}

export function setPanelShare(split: PanelSplit, share: number): void {
  if (!Number.isFinite(share)) return;
  panelSplits.shares[split] = Math.min(SHARE_MAX, Math.max(SHARE_MIN, share));
}

/** Back to the share the panel starts with (double-click on the border). */
export function resetPanelShare(split: PanelSplit): void {
  delete panelSplits.shares[split];
}

/** Every panel back to its default ("Reset panel layout", and tests). */
export function resetPanelShares(): void {
  panelSplits.shares = {};
}

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(panelSplits.shares);
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      /* storage unavailable — non-fatal */
    }
  });
});
