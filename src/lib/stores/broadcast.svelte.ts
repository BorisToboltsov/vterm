// Broadcast store (Svelte 5 runes): which open tabs form the synchronous-input
// group. Broadcast mode itself is NOT a flag here — it is derived in the page
// from whether the session in focus is a member, so moving the focus enters and
// leaves the mode. Pure decisions (who's eligible, what to send) live in
// `../broadcast.ts`.
//
// The group has no layout of its own (v1.9, ADR 0022): its members stand in the
// panes of the centre like any other tab, and "show them all" is the layout's
// own command (`tilePanes`).

export const broadcastState = $state<{
  /** Session ids selected for the group (order is not significant). */
  members: string[];
}>({
  members: [],
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
