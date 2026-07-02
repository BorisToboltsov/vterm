// AI assistant (Phase 17, opt-in): chat/models/exec + keychain key ops. All LLM
// HTTP happens in the Rust broker; the frontend only invokes + listens on events.
import { invoke } from "@tauri-apps/api/core";
import type { AiChatRequest, AiProvider } from "../ai";

// ── AI assistant (Phase 17, opt-in) ─────────────────────────────────────────────
// All LLM HTTP happens in the Rust broker; the frontend only invokes a command and
// listens on `ai://out|done|error/{streamId}` events. Keys live in the keychain.

/** Start a streaming chat; tokens arrive on `ai://out/{streamId}` events. */
export function aiChat(req: AiChatRequest): Promise<void> {
  return invoke<void>("ai_chat", { req });
}

/** Stop an in-flight chat stream (the chat's Stop button). No-op if already done. */
export function cancelAiChat(streamId: string): Promise<void> {
  return invoke<void>("cancel_ai_chat", { streamId });
}

/** Request to list an endpoint's available models (also a reachability check). */
export interface AiModelsRequest {
  endpointId: string;
  provider: AiProvider;
  baseUrl: string;
}

/** List an endpoint's installed models (throws if unreachable). */
export function aiModels(req: AiModelsRequest): Promise<string[]> {
  return invoke<string[]>("ai_models", { req });
}

/** Result of an AI agent command execution (17.8, mirror of lib.rs AiExecResult). */
export interface AiExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Run one command for the AI dialog/agent loop, capturing stdout/stderr/exit code.
 *  Mirrored into the live terminal + recording by the backend. SSH sessions only. */
export function aiExec(
  sessionId: string,
  command: string,
  timeoutSecs: number,
): Promise<AiExecResult> {
  return invoke<AiExecResult>("ai_exec", { sessionId, command, timeoutSecs });
}

/** Store an AI endpoint's API key in the OS keychain. */
export function setAiKey(endpointId: string, key: string): Promise<void> {
  return invoke<void>("set_ai_key", { endpointId, key });
}

/** Forget an AI endpoint's API key (on clear or endpoint removal). */
export function forgetAiKey(endpointId: string): Promise<void> {
  return invoke<void>("forget_ai_key", { endpointId });
}
