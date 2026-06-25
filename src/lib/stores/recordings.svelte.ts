// Which sessions are currently recording (sessionId → recording file path).
// The Rec toggle and the per-tab indicator read this; it's session-scoped so
// each tab records independently.

export const recordingState = $state<Record<string, string>>({});

// Which recording sessions are currently *paused* (tab unwatched / idle). Drives
// the tab indicator: red dot when recording, green "pause" bars when paused.
export const recordingPaused = $state<Record<string, boolean>>({});

/** Is the given session currently recording? */
export function isRecording(sessionId: string): boolean {
  return sessionId in recordingState;
}

/** Is the given session's recording currently paused? */
export function isRecordingPaused(sessionId: string): boolean {
  return recordingPaused[sessionId] === true;
}

/** Mark a session as recording to `path`. */
export function setRecording(sessionId: string, path: string): void {
  recordingState[sessionId] = path;
}

/** Set the paused flag for a session's recording. */
export function setRecordingPausedState(sessionId: string, paused: boolean): void {
  if (paused) recordingPaused[sessionId] = true;
  else delete recordingPaused[sessionId];
}

/** Clear a session's recording flags (on stop, disconnect or tab close). */
export function clearRecording(sessionId: string): void {
  delete recordingState[sessionId];
  delete recordingPaused[sessionId];
}
