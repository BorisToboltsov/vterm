// Broadcast store (Svelte 5 runes): which open tabs form the synchronous-input
// group, plus the layout override. Broadcast mode itself is NOT a flag here — it
// is derived in the page from whether the *active* tab is a member, so switching
// tabs enters/leaves the mode automatically. Pure decisions (who's eligible, what
// to send, grid vs focus) live in `../broadcast.ts`.

import { pickLayout, type BroadcastLayout } from "../broadcast";

/** "auto" defers to the member count; the others pin the layout. */
export type BroadcastLayoutMode = "auto" | BroadcastLayout;

export const broadcastState = $state<{
  /** Session ids selected for the group (order is not significant). */
  members: string[];
  /** Layout override; "auto" picks grid/focus from the member count. */
  layoutMode: BroadcastLayoutMode;
}>({
  members: [],
  layoutMode: "auto",
});

export const isBroadcastMember = (sessionId: string): boolean =>
  broadcastState.members.includes(sessionId);

/** Add or remove a tab from the broadcast group. */
export function toggleBroadcastMember(sessionId: string): void {
  broadcastState.members = isBroadcastMember(sessionId)
    ? broadcastState.members.filter((id) => id !== sessionId)
    : [...broadcastState.members, sessionId];
}

/** Replace the group (deduped) — used by "add all connected". */
export function setBroadcastMembers(ids: string[]): void {
  broadcastState.members = [...new Set(ids)];
}

/** Empty the group. */
export function clearBroadcastMembers(): void {
  broadcastState.members = [];
}

/** Drop a session from the group (e.g. when its tab closes). */
export function removeBroadcastMember(sessionId: string): void {
  broadcastState.members = broadcastState.members.filter((id) => id !== sessionId);
}

/** Effective layout for `memberCount` members, honouring the override. */
export function effectiveLayout(memberCount: number): BroadcastLayout {
  return broadcastState.layoutMode === "auto"
    ? pickLayout(memberCount)
    : broadcastState.layoutMode;
}
