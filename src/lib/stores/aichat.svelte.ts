// Per-session AI chat store + streaming service (Svelte 5 runes). The assistant
// conversation is kept per server/terminal tab so switching tabs preserves each
// tab's dialog; it is dropped only when the tab is closed (removeChat) or the
// user clears it (clearChat).
//
// Streaming lives here — NOT in the AiChat component — so a reply keeps arriving
// into the stored conversation even while its tab is in the background (the
// component would otherwise unmount on tab switch and drop the `ai://…` listeners).
// AiChat is just a reactive view: it renders the active session's slot and calls
// startChat / runCommand.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aiChat, cancelAiChat, writeToTerminal, annotateRecording } from "../api";
import { buildChatRequest, type AiSettings, type AiExecMode } from "../ai";
import { withContext } from "../aicontext";
import { parseChatSegments, toTerminalInput, auditLabel } from "../aiexec";
import { notifySuccess } from "./toasts.svelte";
import { t } from "../i18n";

/** One chat turn. `sent` is the full content sent to the model (question +
 *  context); the UI shows `content`. */
export interface AiChatItem {
  role: "user" | "assistant";
  content: string;
  sent?: string;
  withContext?: boolean;
}

export interface SessionChat {
  messages: AiChatItem[];
  /** Command blocks already executed, keyed `${msgIdx}:${segIdx}` (17.4). */
  executed: Record<string, boolean>;
  /** A reply is currently streaming into this session. */
  streaming: boolean;
  /** Last error for this session's chat, or null. */
  error: string | null;
}

/** Key used when there is no active session (AiChat is normally session-scoped). */
export const KEY_NONE = "_none";

export const aiChatState = $state<{ map: Record<string, SessionChat> }>({ map: {} });

// Active stream per session key (module scope → survives tab switches): its event
// listeners plus the streamId, so Stop can cancel the backend request.
interface ActiveStream {
  streamId: string;
  un: UnlistenFn[];
}
const active = new Map<string, ActiveStream>();
const encoder = new TextEncoder();

/** The chat for a session, creating an empty one on first access. */
export function getChat(sessionId: string | undefined): SessionChat {
  const id = sessionId ?? KEY_NONE;
  if (!aiChatState.map[id]) {
    aiChatState.map[id] = { messages: [], executed: {}, streaming: false, error: null };
  }
  return aiChatState.map[id];
}

/** Empty a session's conversation (the "Clear" button) without removing the slot. */
export function clearChat(sessionId: string | undefined): void {
  const c = getChat(sessionId);
  c.messages = [];
  c.executed = {};
  c.error = null;
}

/** Drop a session's conversation entirely (its tab was closed). */
export function removeChat(sessionId: string): void {
  stopStream(sessionId);
  if (!aiChatState.map[sessionId]) return;
  const next = { ...aiChatState.map };
  delete next[sessionId];
  aiChatState.map = next;
}

function stopStream(key: string): void {
  const a = active.get(key);
  if (a) {
    for (const u of a.un) u();
    active.delete(key);
  }
}

/** Stop an in-flight reply for a session (the Stop button): abort the backend
 *  request, drop listeners, and clear the streaming flag. Partial text is kept. */
export function stopChat(sessionId: string | undefined): void {
  const key = sessionId ?? KEY_NONE;
  const a = active.get(key);
  if (a) void cancelAiChat(a.streamId);
  stopStream(key);
  const c = aiChatState.map[key];
  if (c) c.streaming = false;
}

/** Options for {@link startChat}. Exec context is captured at send time. */
export interface StartChatOpts {
  sessionId: string | undefined;
  question: string;
  /** Redacted context to prepend to the message, or "" for none. */
  context: string;
  system: string;
  settings: AiSettings;
  execMode: AiExecMode;
  /** Server flags for auto-run gating (prod bars auto; noAi bars execution). */
  prod: boolean;
  noAi: boolean;
}

/**
 * Push the user turn + an assistant placeholder, then stream the reply into the
 * session's stored conversation. Listeners are registered at module scope, so the
 * reply keeps filling in even if the tab is switched away mid-stream. On completion
 * (`auto` mode, non-prod, AI allowed) runnable blocks are auto-executed.
 */
export async function startChat(opts: StartChatOpts): Promise<void> {
  const { sessionId, question, context, system, settings, execMode, prod, noAi } = opts;
  const key = sessionId ?? KEY_NONE;
  const c = getChat(sessionId);

  c.messages.push({
    role: "user",
    content: question,
    sent: withContext(context, question),
    withContext: context !== "",
  });
  const idx = c.messages.push({ role: "assistant", content: "" }) - 1;

  const streamId = crypto.randomUUID();
  const history = c.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.sent ?? m.content }));
  const req = buildChatRequest(settings, streamId, history, system);
  if (!req) {
    c.error = t("ai.disabledHint");
    return;
  }
  c.streaming = true;
  c.error = null;

  const finish = () => {
    c.streaming = false;
    stopStream(key);
  };
  const un: UnlistenFn[] = [];
  un.push(
    await listen<string>(`ai://out/${streamId}`, (e) => {
      c.messages[idx].content += e.payload;
    }),
  );
  un.push(
    await listen(`ai://done/${streamId}`, () => {
      finish();
      autoRun(sessionId, c, idx, execMode, prod, noAi);
    }),
  );
  un.push(
    await listen<string>(`ai://error/${streamId}`, (e) => {
      c.error = e.payload || t("ai.errorGeneric");
      finish();
    }),
  );
  active.set(key, { streamId, un });

  try {
    await aiChat(req);
  } catch (e) {
    if (c.streaming) {
      c.error = e instanceof Error ? e.message : String(e);
      finish();
    }
  }
}

/** Auto-execute every runnable block of a finished reply — non-prod + auto only. */
function autoRun(
  sessionId: string | undefined,
  c: SessionChat,
  msgIdx: number,
  execMode: AiExecMode,
  prod: boolean,
  noAi: boolean,
): void {
  if (execMode !== "auto" || prod || noAi || !sessionId) return;
  parseChatSegments(c.messages[msgIdx].content).forEach((seg, si) => {
    if (seg.kind === "code" && seg.runnable && seg.closed) {
      void runCommand(sessionId, c, `${msgIdx}:${si}`, seg.content, noAi);
    }
  });
}

/** Write a proposed command block to the terminal + audit it in the recording. */
export async function runCommand(
  sessionId: string | undefined,
  c: SessionChat,
  key: string,
  block: string,
  noAi: boolean,
): Promise<void> {
  if (!sessionId || noAi || c.executed[key]) return;
  c.executed[key] = true;
  try {
    await writeToTerminal(sessionId, encoder.encode(toTerminalInput(block)));
    // Best-effort audit — a no-op unless the session is recording.
    annotateRecording(sessionId, `AI ran: ${auditLabel(block)}`).catch(() => {});
    notifySuccess(t("ai.exec.sent"));
  } catch {
    c.executed[key] = false; // let the user retry on failure
  }
}
