import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiSettings } from "../ai";

// Mock the backend + event bus so startChat/runCommand can be driven in tests.
const aiChat = vi.fn<(req: AiChatRequest) => Promise<void>>();
const cancelAiChat = vi.fn<(streamId: string) => Promise<void>>();
const writeToTerminal = vi.fn<(id: string, data: Uint8Array) => Promise<void>>();
const annotateRecording = vi.fn<(id: string, text: string) => Promise<void>>();
vi.mock("../api", () => ({
  aiChat: (req: AiChatRequest) => aiChat(req),
  cancelAiChat: (streamId: string) => cancelAiChat(streamId),
  writeToTerminal: (id: string, data: Uint8Array) => writeToTerminal(id, data),
  annotateRecording: (id: string, text: string) => annotateRecording(id, text),
}));

type Handler = (e: { payload: unknown }) => void;
const handlers: Record<string, Handler> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, cb: Handler) => {
    handlers[channel] = cb;
    return () => delete handlers[channel];
  }),
}));
function emit(kind: "out" | "done" | "error", payload?: unknown) {
  const ch = Object.keys(handlers).find((c) => c.startsWith(`ai://${kind}/`));
  if (ch) handlers[ch]({ payload });
}

import {
  aiChatState,
  getChat,
  clearChat,
  removeChat,
  startChat,
  stopChat,
  runCommand,
  KEY_NONE,
  type StartChatOpts,
} from "./aichat.svelte";
import { defaultAiSettings } from "../ai";

function readySettings(over: Partial<AiSettings> = {}): AiSettings {
  return {
    ...defaultAiSettings(),
    enabled: true,
    endpoints: [
      { id: "ep1", name: "Local", provider: "openai", baseUrl: "http://h/v1", model: "m", hasKey: false },
    ],
    activeEndpointId: "ep1",
    ...over,
  };
}

function opts(over: Partial<StartChatOpts> = {}): StartChatOpts {
  return {
    sessionId: "s1",
    question: "hi",
    context: "",
    system: "sys",
    settings: readySettings(),
    execMode: "confirm",
    prod: false,
    noAi: false,
    ...over,
  };
}

beforeEach(() => {
  aiChatState.map = {};
  for (const k of Object.keys(handlers)) delete handlers[k];
  aiChat.mockReset().mockResolvedValue(undefined);
  cancelAiChat.mockReset().mockResolvedValue(undefined);
  writeToTerminal.mockReset().mockResolvedValue(undefined);
  annotateRecording.mockReset().mockResolvedValue(undefined);
});

describe("aichat store slots", () => {
  it("creates an empty conversation per session on first access", () => {
    const c = getChat("s1");
    expect(c.messages).toEqual([]);
    expect(c.executed).toEqual({});
    expect(c.streaming).toBe(false);
    getChat("s1").messages.push({ role: "user", content: "hi" });
    expect(getChat("s1").messages).toHaveLength(1);
  });

  it("keeps sessions independent and falls back to a shared key", () => {
    getChat("a").messages.push({ role: "user", content: "for a" });
    expect(getChat("b").messages).toHaveLength(0);
    getChat(undefined).messages.push({ role: "user", content: "x" });
    expect(aiChatState.map[KEY_NONE].messages).toHaveLength(1);
  });

  it("clearChat empties but keeps the slot; removeChat drops it", () => {
    const c = getChat("s1");
    c.messages.push({ role: "user", content: "hi" });
    c.executed["0:0"] = true;
    clearChat("s1");
    expect(getChat("s1").messages).toEqual([]);
    expect(getChat("s1").executed).toEqual({});
    expect("s1" in aiChatState.map).toBe(true);
    removeChat("s1");
    expect("s1" in aiChatState.map).toBe(false);
    removeChat("s1"); // idempotent
  });
});

describe("startChat streaming", () => {
  it("pushes turns and streams the reply into the session", async () => {
    await startChat(opts({ question: "list files" }));
    const c = getChat("s1");
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.streaming).toBe(true);

    emit("out", "hello ");
    emit("out", "world");
    expect(c.messages[1].content).toBe("hello world");

    emit("done");
    expect(c.streaming).toBe(false);
    // Request carried the system prompt + history.
    expect(aiChat.mock.calls[0][0].system).toBe("sys");
    expect(aiChat.mock.calls[0][0].messages.at(-1)?.content).toBe("list files");
  });

  it("merges attached context into the sent message but shows only the question", async () => {
    await startChat(opts({ question: "explain", context: "### Terminal\nfoo" }));
    const c = getChat("s1");
    expect(c.messages[0].content).toBe("explain"); // display
    expect(c.messages[0].sent).toContain("foo"); // what was sent
    expect(c.messages[0].withContext).toBe(true);
  });

  it("records an error when the assistant is not configured", async () => {
    await startChat(opts({ settings: defaultAiSettings() })); // disabled → no request
    const c = getChat("s1");
    expect(c.streaming).toBe(false);
    expect(c.error).toBeTruthy();
    expect(aiChat).not.toHaveBeenCalled();
  });

  it("surfaces a stream error event", async () => {
    await startChat(opts());
    emit("error", "boom");
    const c = getChat("s1");
    expect(c.error).toBe("boom");
    expect(c.streaming).toBe(false);
  });

  it("auto-runs runnable blocks on done in auto mode (non-prod)", async () => {
    await startChat(opts({ execMode: "auto" }));
    emit("out", "```bash\nls -la\n```");
    emit("done");
    expect(writeToTerminal).toHaveBeenCalledOnce();
    expect(writeToTerminal.mock.calls[0][0]).toBe("s1");
  });

  it("does not auto-run on a prod server", async () => {
    await startChat(opts({ execMode: "auto", prod: true }));
    emit("out", "```bash\nls -la\n```");
    emit("done");
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("stopChat cancels the backend request, clears streaming, and keeps partial text", async () => {
    await startChat(opts());
    emit("out", "partial answer");
    const c = getChat("s1");
    expect(c.streaming).toBe(true);

    stopChat("s1");
    expect(cancelAiChat).toHaveBeenCalledOnce();
    // Cancels the same stream the request was started with.
    expect(cancelAiChat.mock.calls[0][0]).toBe(aiChat.mock.calls[0][0].streamId);
    expect(c.streaming).toBe(false);
    expect(c.messages[1].content).toBe("partial answer"); // kept

    // Late events after stop are ignored (listeners removed).
    emit("out", " more");
    expect(c.messages[1].content).toBe("partial answer");
  });

  it("stopChat is a no-op when nothing is streaming", () => {
    stopChat("nope");
    expect(cancelAiChat).not.toHaveBeenCalled();
  });
});

describe("runCommand", () => {
  it("writes the command + audits it, and won't run twice", async () => {
    const c = getChat("s1");
    await runCommand("s1", c, "0:0", "ls -la", false);
    expect(new TextDecoder().decode(writeToTerminal.mock.calls[0][1] as Uint8Array)).toBe("ls -la\n");
    expect(annotateRecording).toHaveBeenCalledWith("s1", "AI ran: ls -la");
    expect(c.executed["0:0"]).toBe(true);
    await runCommand("s1", c, "0:0", "ls -la", false); // already ran
    expect(writeToTerminal).toHaveBeenCalledOnce();
  });

  it("is blocked on a noAi server", async () => {
    const c = getChat("s1");
    await runCommand("s1", c, "0:0", "ls", true);
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("clears the executed mark when the write fails (retry allowed)", async () => {
    writeToTerminal.mockRejectedValueOnce(new Error("nope"));
    const c = getChat("s1");
    await runCommand("s1", c, "0:0", "ls", false);
    expect(c.executed["0:0"]).toBe(false);
  });
});
