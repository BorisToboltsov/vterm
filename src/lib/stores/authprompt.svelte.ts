// Keyboard-interactive login questions waiting for the user (v1.0.38), by session
// id. The backend parks the login until `answerAuthPrompt`; this only remembers
// what to show, so a question for a background tab is still there when the user
// switches to it. Keyed by session → cleared in `closeTabFully` (the backend side
// is released by `disconnect`). Holds questions, never answers.
import type { AuthPromptRequest } from "../types";

export const authPrompts = $state<Record<string, AuthPromptRequest>>({});

/** The server asked `sessionId` something vterm couldn't answer itself. */
export function setAuthPrompt(sessionId: string, req: AuthPromptRequest): void {
  authPrompts[sessionId] = req;
}

/** The questions were answered, cancelled, or the tab/login is gone. */
export function clearAuthPrompt(sessionId: string): void {
  delete authPrompts[sessionId];
}
