import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureDiag } from "../api/diag";
import type { AiChatRequest, AiSettings } from "../ai/ai";

// Mock the backend + event bus so startChat/runCommand can be driven in tests.
const aiChat = vi.fn<(req: AiChatRequest) => Promise<void>>();
const cancelAiChat = vi.fn<(streamId: string) => Promise<void>>();
const aiExec = vi.fn<(id: string, cmd: string, t: number) => Promise<unknown>>();
const writeToTerminal = vi.fn<(id: string, data: Uint8Array) => Promise<void>>();
const annotateRecording = vi.fn<(id: string, text: string) => Promise<void>>();
vi.mock("../api", () => ({
  aiChat: (req: AiChatRequest) => aiChat(req),
  cancelAiChat: (streamId: string) => cancelAiChat(streamId),
  aiExec: (id: string, cmd: string, tmo: number) => aiExec(id, cmd, tmo),
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
  confirmDialogStep,
  skipDialogStep,
  KEY_NONE,
  adoptChat,
  heardStream,
  liveStream,
  type StartChatOpts,
} from "./aichat.svelte";
import { defaultAiSettings } from "../ai/ai";
import { settings } from "../settings/settings.svelte";

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

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  aiChatState.map = {};
  settings.ai = defaultAiSettings();
  for (const k of Object.keys(handlers)) delete handlers[k];
  aiChat.mockReset().mockResolvedValue(undefined);
  cancelAiChat.mockReset().mockResolvedValue(undefined);
  aiExec.mockReset().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
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

  it("initializes per-chat context tiers from the global defaults", () => {
    settings.ai.includeMetadata = true;
    const c = getChat("fresh");
    expect(c.context.includeMetadata).toBe(true);
    expect(c.context.includeBuffer).toBe(false);
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

  it("translates a marked error into a friendly message", async () => {
    await startChat(opts());
    emit("error", "auth-rejected: wrong key");
    const c = getChat("s1");
    expect(c.error).not.toContain("auth-rejected"); // mapped to a localized hint
    expect(c.error).toBeTruthy();
  });

  it("never auto-runs a proposed block in confirm mode (auto mode was removed)", async () => {
    await startChat(opts({ execMode: "confirm" }));
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

  it("refuses a second user turn while a reply streams (one turn at a time)", async () => {
    await startChat(opts({ question: "one" }));
    await startChat(opts({ question: "two" }));
    expect(aiChat).toHaveBeenCalledOnce();
    expect(getChat("s1").messages.map((m) => m.content)).toEqual(["one", ""]);
  });

  it("refuses a user turn while a dialog command awaits confirmation", async () => {
    const c = getChat("s1");
    c.pending = { command: "ls", opts: opts() };
    await startChat(opts({ question: "sneak in" }));
    expect(aiChat).not.toHaveBeenCalled();
    expect(c.pending).not.toBeNull();
  });

  it("a failed reply ends the dialog loop instead of leaving the chat busy", async () => {
    await startChat(opts({ execMode: "dialog" }));
    expect(getChat("s1").dialogRunning).toBe(true);
    emit("error", "boom");
    expect(getChat("s1").dialogRunning).toBe(false);
    expect(getChat("s1").streaming).toBe(false);
  });

  it("a rejected request ends the dialog loop too", async () => {
    aiChat.mockRejectedValueOnce("network down");
    await startChat(opts({ execMode: "dialog" }));
    expect(getChat("s1").dialogRunning).toBe(false);
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
    // CR, not LF: CR is what Enter sends, and LF left the command sitting unrun
    // at a Windows prompt (Phase 39.5, terminput.ts).
    expect(new TextDecoder().decode(writeToTerminal.mock.calls[0][1] as Uint8Array)).toBe("ls -la\r");
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

describe("dialog loop (17.8)", () => {
  it("runs a command, feeds the result back, and stops when no command remains", async () => {
    await startChat(opts({ execMode: "dialog", question: "install nginx" }));
    emit("out", "```bash\napt install nginx\n```");
    emit("done");
    await flush();

    expect(aiExec).toHaveBeenCalledOnce();
    expect(aiExec.mock.calls[0][1]).toBe("apt install nginx");
    // The redacted result was sent back as a new turn (second broker call).
    expect(aiChat).toHaveBeenCalledTimes(2);

    // Second reply has no command → loop ends.
    emit("out", "Done — nginx is installed.");
    emit("done");
    await flush();
    expect(getChat("s1").dialogRunning).toBe(false);
    expect(aiExec).toHaveBeenCalledOnce();
  });

  it("dialogConfirm waits for confirmation before running", async () => {
    await startChat(opts({ execMode: "dialogConfirm" }));
    emit("out", "```bash\nls\n```");
    emit("done");
    await flush();

    const c = getChat("s1");
    expect(c.pending?.command).toBe("ls");
    expect(aiExec).not.toHaveBeenCalled();

    confirmDialogStep("s1");
    await flush();
    expect(aiExec).toHaveBeenCalledOnce();
    expect(c.pending).toBeNull();
  });

  it("skip ends the loop without running", async () => {
    await startChat(opts({ execMode: "dialogConfirm" }));
    emit("out", "```bash\nls\n```");
    emit("done");
    await flush();
    skipDialogStep("s1");
    expect(aiExec).not.toHaveBeenCalled();
    expect(getChat("s1").dialogRunning).toBe(false);
  });

  it("auto dialog still confirms an obviously dangerous command", async () => {
    const heard = captureDiag();
    await startChat(opts({ execMode: "dialog" }));
    emit("out", "```bash\nrm -rf /data\n```");
    emit("done");
    await flush();
    expect(getChat("s1").pending?.command).toContain("rm -rf");
    expect(aiExec).not.toHaveBeenCalled();
    // The safeguard is a warning of the diagnostics — without the command: it is the model's answer.
    skipDialogStep("s1");
    const events = heard.events();
    expect(events.map((e) => [e.level, e.text])).toEqual([
      ["warn", "the assistant proposed a command on the deny-list: held for confirmation"],
      ["info", "assistant step skipped by the user"],
    ]);
    expect(JSON.stringify(events)).not.toContain("rm -rf");
    heard.stop();
  });

  it("does not loop on a prod server", async () => {
    await startChat(opts({ execMode: "dialog", prod: true }));
    emit("out", "```bash\nls\n```");
    emit("done");
    await flush();
    const c = getChat("s1");
    expect(c.pending).toBeNull();
    expect(c.dialogRunning).toBe(false);
    expect(aiExec).not.toHaveBeenCalled();
  });
});

describe("an answer under way goes with its tab (v1.36, ADR 0058)", () => {
  it("is asked for in the session's name, so a move can hold it", async () => {
    void startChat(opts());
    await flush();
    expect(aiChat.mock.calls[0][0].sessionId).toBe("s1");
  });

  it("counts what it heard: a move waits for the pieces sent before the hold", async () => {
    void startChat(opts());
    await flush();
    const live = liveStream("s1");
    expect(live).toMatchObject({ idx: 1, opts: expect.objectContaining({ sessionId: "s1" }) });
    emit("out", "Dis");
    // Two were sent before the hold; one is here.
    const waited = heardStream("s1", live!.streamId, 2);
    let done = false;
    void waited.then((v) => (done = v));
    await flush();
    expect(done).toBe(false);
    emit("out", "k ");
    expect(await waited).toBe(true);
    expect(getChat("s1").messages[1].content).toBe("Disk ");
    // Another stream, or one that never came: nothing to wait for.
    expect(await heardStream("s1", "other", 0)).toBe(false);
    expect(await heardStream("nobody", live!.streamId, 0)).toBe(false);
  });

  it("gives up waiting when the pieces do not all arrive", async () => {
    void startChat(opts());
    await flush();
    expect(await heardStream("s1", liveStream("s1")!.streamId, 5, 10)).toBe(false);
  });

  it("in the window taking the tab, the rest of the answer fills the same message", async () => {
    void startChat(opts());
    await flush();
    emit("out", "Disk ");
    const live = liveStream("s1")!;
    const packed = JSON.parse(JSON.stringify(getChat("s1")));
    // The window giving the tab up lets it go: its listeners go, the stream does not stop.
    removeChat("s1");
    expect(cancelAiChat).not.toHaveBeenCalled();
    aiChatState.map = {};
    await adoptChat("s2", packed, JSON.parse(JSON.stringify(live)));
    expect(getChat("s2")).toMatchObject({ streaming: true });
    emit("out", "full");
    emit("done", null);
    expect(getChat("s2").messages[1].content).toBe("Disk full");
    expect(getChat("s2").streaming).toBe(false);
    expect(liveStream("s2")).toBeNull();
  });

  it("taken over without its stream, it claims none", async () => {
    const chat = getChat("s1");
    chat.messages.push({ role: "user", content: "q" }, { role: "assistant", content: "half" });
    chat.streaming = true;
    chat.dialogRunning = true;
    const packed = JSON.parse(JSON.stringify(chat));
    aiChatState.map = {};
    await adoptChat("s1", packed, null);
    expect(getChat("s1")).toMatchObject({ streaming: false, dialogRunning: false });
  });

  it("a dialog step's command running holds the tab — and only while it runs", async () => {
    let finish!: (v: unknown) => void;
    aiExec.mockReturnValue(new Promise((r) => (finish = r)));
    void startChat(opts({ execMode: "dialog" }));
    await flush();
    emit("out", "```bash\nuptime\n```");
    emit("done", null);
    await flush();
    expect(getChat("s1").stepRunning).toBe(true);
    finish({ stdout: "up", stderr: "", code: 0, timedOut: false });
    await flush();
    expect(getChat("s1").stepRunning).toBe(false);
  });
});
