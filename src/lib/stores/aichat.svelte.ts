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
import { aiChat, cancelAiChat, aiExec, writeToTerminal, annotateRecording } from "../api";
import { buildChatRequest, type AiSettings, type AiExecMode, type AiUsage } from "../ai/ai";
import { withContext, type ContextTiers } from "../ai/aicontext";
import { settings } from "../settings/settings.svelte";
import { toTerminalInput, auditLabel } from "../ai/aiexec";
import { nextCommand, buildFeedback, isDangerousCommand } from "../ai/aidialog";
import { notifySuccess } from "./toasts.svelte";
import { describeAiError } from "../ai/aierror";
import { chatBusy, type AskSource } from "../ai/aiask";
import { t } from "../i18n";

/** Dialog-loop guards (17.8). Configurable defaults land in 17.8.5. */
const DIALOG_MAX_STEPS = 10;
const EXEC_TIMEOUT_SECS = 60;
const isDialog = (m: AiExecMode) => m === "dialog" || m === "dialogConfirm";

/** One chat turn. `sent` is the full content sent to the model (question +
 *  context); the UI shows `content`. */
export interface AiChatItem {
  role: "user" | "assistant";
  content: string;
  sent?: string;
  withContext?: boolean;
  /** Reasoning tokens from `ai://think/{id}` (Phase 40), kept apart from the
   *  answer so the UI can fold them away. Empty/absent = the model didn't think
   *  out loud (or isn't a reasoning model). */
  reasoning?: string;
  /** Wall-clock milliseconds spent streaming this reply — shown next to the
   *  reasoning fold, where the wait is the thing being explained. */
  elapsedMs?: number;
  /** Token tally from the `ai://done` payload; absent when the endpoint never
   *  reported one, in which case the UI shows no counter at all. */
  usage?: AiUsage;
}

export interface SessionChat {
  messages: AiChatItem[];
  /** Command blocks already executed, keyed `${msgIdx}:${segIdx}` (17.4). */
  executed: Record<string, boolean>;
  /** A reply is currently streaming into this session. */
  streaming: boolean;
  /** Last error for this session's chat, or null. */
  error: string | null;
  /** Dialog-loop step count for the current run (17.8). */
  dialogStep: number;
  /** A dialog loop is active (streaming or awaiting confirmation). */
  dialogRunning: boolean;
  /**
   * A dialog step's command is running on the host now (v1.36): the one part of
   * a turn that lives in this window's memory — the tab waits for it to move.
   */
  stepRunning?: boolean;
  /** A command awaiting the user's go-ahead (dialogConfirm / dangerous), or null. */
  pending: { command: string; opts: StartChatOpts } | null;
  /** Per-chat context tiers (chosen in the Context popover; default from settings). */
  context: ContextTiers;
  /**
   * A question raised from elsewhere in the app (Phase 41): the terminal's
   * "Explain" menu item and session-bar button, the Docker/k8s detail modals, the
   * monitoring overlay.
   *
   * It is a *request*, not a send: `AiChat` weighs it (is the assistant usable
   * here at all?) and moves it into {@link attachment}, so a caller cannot route
   * context past the consent contract. Cleared once the chat has picked it up.
   */
  ask: AskRequest | null;
  /**
   * The composer chip: context attached for the next question. Sent — through
   * the consent dialog — with whatever the user types, or with the preset
   * question on an empty send; dropped by its ✕ or once sent. Kept per session so
   * it survives the dock remounting on a tab switch.
   */
  attachment: AskRequest | null;
}

/** Already-collected raw context about something on screen. */
export interface AskRequest {
  /** What it is about — picks the chip label, the `###` header and the preset question. */
  source: AskSource;
  /** Raw (unredacted) text; `AiChat` redacts and previews it like any context. */
  context: string;
}

/** Key used when there is no active session (AiChat is normally session-scoped). */
export const KEY_NONE = "_none";

export const aiChatState = $state<{ map: Record<string, SessionChat> }>({ map: {} });

// Active stream per session key (module scope → survives tab switches): its event
// listeners plus the streamId, so Stop can cancel the backend request — and,
// since v1.36, what a tab moving to another window carries of it (`LiveStream`)
// and how many of its pieces were heard here (the backend holds the rest).
interface ActiveStream {
  streamId: string;
  un: UnlistenFn[];
  live: LiveStream;
  heard: number;
  /** A handoff waits until `heard` reaches `count`. */
  waiting: { count: number; arrived: () => void } | null;
}
const active = new Map<string, ActiveStream>();

/** An answer streaming into a chat, as a tab moving to another window carries it (v1.36, ADR 0058). */
export interface LiveStream {
  streamId: string;
  /** The assistant message it fills. */
  idx: number;
  startedAt: number;
  /** The turn it answers — what happens when it ends (the dialog loop) depends on it. */
  opts: StartChatOpts;
}
const encoder = new TextEncoder();

/** The chat for a session, creating an empty one on first access. */
export function getChat(sessionId: string | undefined): SessionChat {
  const id = sessionId ?? KEY_NONE;
  if (!aiChatState.map[id]) {
    aiChatState.map[id] = {
      messages: [],
      executed: {},
      streaming: false,
      error: null,
      dialogStep: 0,
      dialogRunning: false,
      pending: null,
      ask: null,
      attachment: null,
      // New chats inherit the global tier defaults; then chosen per-chat.
      context: {
        includeBuffer: settings.ai.includeBuffer,
        includeRecording: settings.ai.includeRecording,
        includeMetadata: settings.ai.includeMetadata,
      },
    };
  }
  return aiChatState.map[id];
}

/** Empty a session's conversation (the "Clear" button) without removing the slot. */
export function clearChat(sessionId: string | undefined): void {
  const c = getChat(sessionId);
  c.messages = [];
  c.executed = {};
  c.error = null;
  c.dialogStep = 0;
  c.dialogRunning = false;
  c.pending = null;
}

/** The session's conversation as stored, or null when there is none yet. */
export function peekChat(sessionId: string): SessionChat | null {
  return aiChatState.map[sessionId] ?? null;
}

/**
 * Take over the conversation of a tab moved here from another window (ADR 0017).
 * An answer streaming in it comes along (v1.36, ADR 0058): `live` says which, and
 * this window listens for the rest of it — the backend held the pieces sent
 * while the tab was on its way and lets them go once the tab is taken over. A
 * dialog step waiting for a go-ahead comes too; one running a command does not
 * (the tab waited for it). Without a stream, nothing may claim one is running.
 */
export async function adoptChat(sessionId: string, chat: SessionChat, live: LiveStream | null = null): Promise<void> {
  const streaming = live !== null && chat.streaming && !!chat.messages[live.idx];
  aiChatState.map = {
    ...aiChatState.map,
    [sessionId]: {
      ...chat,
      streaming,
      dialogRunning: chat.dialogRunning && (streaming || chat.pending !== null),
      stepRunning: false,
      ask: null,
    },
  };
  if (streaming && live) await listenStream(sessionId, aiChatState.map[sessionId], live);
}

/** The answer streaming in a session now, as a tab moving away carries it; null — none. */
export function liveStream(sessionId: string): LiveStream | null {
  return active.get(sessionId)?.live ?? null;
}

/**
 * A tab is moving away while an answer streams in it: wait until this window
 * has heard the `count` pieces the backend sent before it held the rest — then
 * the conversation packed is the answer up to the hold. False — they did not
 * all arrive in `timeoutMs` (the move is called off), or no answer streams.
 */
export function heardStream(sessionId: string, streamId: string, count: number, timeoutMs = 3000): Promise<boolean> {
  const a = active.get(sessionId);
  if (!a || a.streamId !== streamId) return Promise.resolve(false);
  if (a.heard >= count) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      a.waiting = null;
      resolve(false);
    }, timeoutMs);
    a.waiting = {
      count,
      arrived: () => {
        clearTimeout(timer);
        a.waiting = null;
        resolve(true);
      },
    };
  });
}

/**
 * Put back the conversation of a tab of the previous launch (v1.36, ADR 0057;
 * kept only under `restoreOutput`): its turns, nothing of a run — no stream,
 * no step waiting for a go-ahead, no attachment. A chat already started here
 * is not replaced.
 */
export function restoreChat(sessionId: string, messages: AiChatItem[]): void {
  if (messages.length === 0 || aiChatState.map[sessionId]?.messages.length) return;
  getChat(sessionId).messages = messages;
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
  if (c) {
    c.streaming = false;
    c.dialogRunning = false;
    c.pending = null;
  }
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
  /** Internal: this turn is a dialog-loop feedback message (don't reset the loop). */
  feedback?: boolean;
}

/**
 * Push the user turn + an assistant placeholder, then stream the reply into the
 * session's stored conversation. Listeners are registered at module scope, so the
 * reply keeps filling in even if the tab is switched away mid-stream. On completion
 * (`auto` mode, non-prod, AI allowed) runnable blocks are auto-executed.
 */
export async function startChat(opts: StartChatOpts): Promise<void> {
  const { sessionId, question, context, system, settings } = opts;
  const key = sessionId ?? KEY_NONE;
  const c = getChat(sessionId);

  // One turn at a time (aiask.ts). Callers check first and tell the user; this is
  // the backstop, so no entry point can start a second stream over a live one.
  // A feedback turn is the dialog loop's own continuation and is expected here.
  if (!opts.feedback && chatBusy(c)) return;

  // A fresh user turn resets the dialog loop; a feedback turn continues it.
  if (!opts.feedback) {
    c.dialogStep = 0;
    c.pending = null;
    c.dialogRunning = isDialog(opts.execMode) && !opts.prod && !opts.noAi && !!sessionId;
  }

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
    c.dialogRunning = false;
    return;
  }
  req.sessionId = sessionId ?? null;
  c.streaming = true;
  c.error = null;

  const live: LiveStream = { streamId, idx, startedAt: Date.now(), opts };
  await listenStream(key, c, live);

  try {
    await aiChat(req);
  } catch (e) {
    // Not ours to report once the tab went to another window with its answer.
    if (c.streaming && active.get(key)?.streamId === streamId) {
      c.error = describeAiError(e);
      c.dialogRunning = false;
      endStream(key, c, live);
    }
  }
}

function endStream(key: string, c: SessionChat, live: LiveStream): void {
  c.streaming = false;
  const msg = c.messages[live.idx];
  if (msg) msg.elapsedMs = Date.now() - live.startedAt;
  stopStream(key);
}

/**
 * Listen for the pieces of an answer into chat `c` — when it is asked, and in
 * the window a tab with an answer under way moved to (`adoptChat`). Every piece
 * heard is counted: a move waits until all those sent before its hold arrived.
 */
async function listenStream(key: string, c: SessionChat, live: LiveStream): Promise<void> {
  const { streamId, idx, opts } = live;
  const entry: ActiveStream = { streamId, un: [], live, heard: 0, waiting: null };
  const heard = () => {
    entry.heard += 1;
    if (entry.waiting && entry.heard >= entry.waiting.count) entry.waiting.arrived();
  };
  const msg = () => c.messages[idx];
  active.set(key, entry);
  entry.un.push(
    await listen<string>(`ai://out/${streamId}`, (e) => {
      heard();
      const m = msg();
      if (m) m.content += e.payload;
    }),
  );
  // Reasoning rides its own channel, so it accumulates into its own field and
  // never lands in `content` — otherwise the model's scratchpad would be parsed
  // for runnable command blocks and offered up for execution.
  entry.un.push(
    await listen<string>(`ai://think/${streamId}`, (e) => {
      heard();
      const m = msg();
      if (m) m.reasoning = (m.reasoning ?? "") + e.payload;
    }),
  );
  entry.un.push(
    await listen<AiUsage | null>(`ai://done/${streamId}`, (e) => {
      heard();
      const m = msg();
      if (e.payload && m) m.usage = e.payload;
      endStream(key, c, live);
      afterReply(c, idx, opts);
    }),
  );
  entry.un.push(
    await listen<string>(`ai://error/${streamId}`, (e) => {
      heard();
      c.error = describeAiError(e.payload);
      // A failed reply ends the loop — left running, it would hold the chat busy.
      c.dialogRunning = false;
      endStream(key, c, live);
    }),
  );
}

/**
 * Raise a question about something the user is looking at, from anywhere in the
 * app. Nothing is sent here — `AiChat` picks the request up and runs it through
 * the same redaction + consent dialog as a hand-typed question.
 */
export function askAbout(sessionId: string | undefined, req: AskRequest): void {
  getChat(sessionId).ask = req;
}

/**
 * One-shot generation outside the chat (Phase 41): no conversation, no history,
 * no execution — just a system prompt plus one user message streamed back to the
 * caller. Used for the commit-message drafter.
 *
 * Returns a cancel function. The caller is responsible for having obtained
 * consent for whatever `content` contains; this is plumbing, not a gate.
 */
export async function generateOnce(opts: {
  system: string;
  content: string;
  settings: AiSettings;
  onToken: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}): Promise<() => void> {
  const streamId = crypto.randomUUID();
  const req = buildChatRequest(
    opts.settings,
    streamId,
    [{ role: "user", content: opts.content }],
    opts.system,
  );
  if (!req) {
    opts.onError(t("ai.disabledHint"));
    return () => {};
  }

  const un: UnlistenFn[] = [];
  let live = true;
  const cleanup = () => {
    live = false;
    for (const u of un) u();
    un.length = 0;
  };

  un.push(await listen<string>(`ai://out/${streamId}`, (e) => opts.onToken(e.payload)));
  un.push(
    await listen(`ai://done/${streamId}`, () => {
      cleanup();
      opts.onDone();
    }),
  );
  un.push(
    await listen<string>(`ai://error/${streamId}`, (e) => {
      cleanup();
      opts.onError(describeAiError(e.payload));
    }),
  );

  try {
    await aiChat(req);
  } catch (e) {
    if (live) {
      cleanup();
      opts.onError(describeAiError(e));
    }
  }
  return () => {
    if (!live) return;
    void cancelAiChat(streamId);
    cleanup();
  };
}

/** Dispatch after a reply finishes: drive the dialog loop (other modes are manual). */
function afterReply(c: SessionChat, msgIdx: number, opts: StartChatOpts): void {
  if (isDialog(opts.execMode)) {
    void maybeContinueDialog(c, msgIdx, opts);
  }
}

/**
 * Dialog loop: take the model's proposed command, run it (or wait for the user to
 * confirm in `dialogConfirm` / for a dangerous command), feed the captured result
 * back, and repeat — bounded by {@link DIALOG_MAX_STEPS}. Barred on prod/noAi.
 */
async function maybeContinueDialog(c: SessionChat, msgIdx: number, opts: StartChatOpts): Promise<void> {
  const { sessionId, execMode, prod, noAi } = opts;
  if (!sessionId || prod || noAi) {
    c.dialogRunning = false;
    return;
  }
  const cmd = nextCommand(c.messages[msgIdx].content);
  if (!cmd) {
    c.dialogRunning = false; // no command → the task is done
    return;
  }
  if (c.dialogStep >= DIALOG_MAX_STEPS) {
    c.error = t("ai.dialog.maxSteps", { max: String(DIALOG_MAX_STEPS) });
    c.dialogRunning = false;
    return;
  }
  c.dialogRunning = true;
  // Confirm each step in dialogConfirm; always confirm an obviously destructive one.
  if (execMode === "dialogConfirm" || isDangerousCommand(cmd, settings.ai.dangerousPatterns)) {
    c.pending = { command: cmd, opts };
    return;
  }
  await runDialogStep(c, cmd, opts);
}

/** Execute one dialog command and feed its (redacted) result back to the model. */
async function runDialogStep(c: SessionChat, command: string, opts: StartChatOpts): Promise<void> {
  c.pending = null;
  c.dialogStep += 1;
  let result;
  c.stepRunning = true;
  try {
    result = await aiExec(opts.sessionId as string, command, EXEC_TIMEOUT_SECS);
  } catch (e) {
    c.error = describeAiError(e);
    c.dialogRunning = false;
    return;
  } finally {
    c.stepRunning = false;
  }
  // The backend already mirrored the step into the terminal + recording.
  await startChat({ ...opts, question: buildFeedback(command, result), context: "", feedback: true });
}

/** Confirm the pending dialog command (the "Run" control in dialogConfirm). */
export function confirmDialogStep(sessionId: string | undefined): void {
  const c = getChat(sessionId);
  const p = c.pending;
  if (p) void runDialogStep(c, p.command, p.opts);
}

/** Skip the pending dialog command and end the loop (the "Skip" control). */
export function skipDialogStep(sessionId: string | undefined): void {
  const c = getChat(sessionId);
  c.pending = null;
  c.dialogRunning = false;
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
    notifySuccess(t("ai.exec.sent"), { source: "ai" });
  } catch {
    c.executed[key] = false; // let the user retry on failure
  }
}
