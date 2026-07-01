import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest } from "./ai";

// Capture what reaches the broker / terminal; nothing hits the network or a PTY.
const aiChat = vi.fn<(req: AiChatRequest) => Promise<void>>();
const cancelAiChat = vi.fn<(streamId: string) => Promise<void>>();
const writeToTerminal = vi.fn<(id: string, data: Uint8Array) => Promise<void>>();
const annotateRecording = vi.fn<(id: string, text: string) => Promise<void>>();
vi.mock("./api", () => ({
  aiChat: (req: AiChatRequest) => aiChat(req),
  cancelAiChat: (streamId: string) => cancelAiChat(streamId),
  writeToTerminal: (id: string, data: Uint8Array) => writeToTerminal(id, data),
  annotateRecording: (id: string, text: string) => annotateRecording(id, text),
}));

// Capture the stream listeners so tests can drive `ai://out|done|error/{id}`.
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

import AiChat from "./AiChat.svelte";
import { settings } from "./settings.svelte";
import { defaultAiSettings, type AiExecMode } from "./ai";
import { aiChatState } from "./stores/aichat.svelte";

function enableAi(execMode: AiExecMode = "confirm") {
  settings.ai = {
    ...defaultAiSettings(),
    enabled: true,
    execMode,
    endpoints: [
      {
        id: "ep1",
        name: "Local",
        provider: "openai",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5",
        hasKey: false,
      },
    ],
    activeEndpointId: "ep1",
  };
}

async function ask(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByTestId("ai-input"), text);
  await user.click(screen.getByTestId("ai-send"));
}

beforeEach(() => {
  localStorage.clear();
  settings.language = "en";
  settings.ai = defaultAiSettings();
  aiChatState.map = {}; // reset per-session conversations
  for (const k of Object.keys(handlers)) delete handlers[k];
  aiChat.mockReset().mockResolvedValue(undefined);
  cancelAiChat.mockReset().mockResolvedValue(undefined);
  writeToTerminal.mockReset().mockResolvedValue(undefined);
  annotateRecording.mockReset().mockResolvedValue(undefined);
});

describe("AiChat — context + consent (Phase 17.3)", () => {
  it("sends without consent when no context is attached", async () => {
    enableAi();
    const user = userEvent.setup();
    render(AiChat, { props: { getContext: () => ({ selection: "ls -la" }) } });

    await user.type(screen.getByTestId("ai-input"), "hello");
    await user.click(screen.getByTestId("ai-send"));

    expect(screen.queryByTestId("ai-consent")).toBeNull();
    expect(aiChat).toHaveBeenCalledOnce();
    const req = aiChat.mock.calls[0][0];
    expect(req.messages.at(-1)?.content).toBe("hello");
  });

  it("shows the consent dialog with a redacted preview before sending context", async () => {
    enableAi();
    const user = userEvent.setup();
    render(AiChat, {
      props: { getContext: () => ({ selection: "export TOKEN=secret123" }) },
    });

    await user.click(screen.getByTestId("ai-attach"));
    await user.type(screen.getByTestId("ai-input"), "what does this do?");
    await user.click(screen.getByTestId("ai-send"));

    const preview = await screen.findByTestId("ai-consent-preview");
    expect(preview.textContent).toContain("‹redacted›");
    expect(preview.textContent).not.toContain("secret123");
    expect(aiChat).not.toHaveBeenCalled();
  });

  it("sends the question merged with the redacted context after confirming", async () => {
    enableAi();
    const user = userEvent.setup();
    render(AiChat, {
      props: { getContext: () => ({ selection: "export TOKEN=secret123" }) },
    });

    await user.click(screen.getByTestId("ai-attach"));
    await user.type(screen.getByTestId("ai-input"), "explain");
    await user.click(screen.getByTestId("ai-send"));
    await user.click(await screen.findByTestId("ai-consent-confirm"));

    await waitFor(() => expect(aiChat).toHaveBeenCalledOnce());
    const sent = aiChat.mock.calls[0][0].messages.at(-1)?.content ?? "";
    expect(sent).toContain("explain");
    expect(sent).toContain("‹redacted›");
    expect(sent).not.toContain("secret123");
    expect(screen.getByText("explain")).toBeTruthy();
  });

  it("cancelling consent sends nothing", async () => {
    enableAi();
    const user = userEvent.setup();
    render(AiChat, {
      props: { getContext: () => ({ selection: "cat /etc/hosts" }) },
    });

    await user.click(screen.getByTestId("ai-attach"));
    await user.type(screen.getByTestId("ai-input"), "hmm");
    await user.click(screen.getByTestId("ai-send"));
    await user.click(await screen.findByText("Cancel"));

    expect(aiChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ai-consent")).toBeNull();
  });

  it("disables the attach toggle when no context provider is wired", () => {
    enableAi();
    render(AiChat, {});
    expect(screen.getByTestId("ai-attach")).toBeDisabled();
  });

  it("sends the user-editable chat system prompt", async () => {
    enableAi();
    settings.ai.chatSystem = "Answer in one word.";
    render(AiChat, {});

    await ask("hi");

    expect(aiChat.mock.calls[0][0].system).toBe("Answer in one word.");
  });
});

describe("AiChat — executor (Phase 17.4)", () => {
  const REPLY = "Try:\n```bash\nls -la\n```\nDone.";

  it("confirm mode: a Run button writes the command to the terminal and audits it", async () => {
    enableAi("confirm");
    const user = userEvent.setup();
    render(AiChat, { props: { sessionId: "sess1" } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    const run = await screen.findByTestId("ai-run");
    await user.click(run);

    expect(writeToTerminal).toHaveBeenCalledOnce();
    const [id, data] = writeToTerminal.mock.calls[0];
    expect(id).toBe("sess1");
    expect(new TextDecoder().decode(data as Uint8Array)).toBe("ls -la\n");
    expect(annotateRecording).toHaveBeenCalledWith("sess1", "AI ran: ls -la");
    // After running, the button reports it ran and won't fire twice.
    expect(screen.getByTestId("ai-run")).toBeDisabled();
  });

  it("suggest mode: no Run button is offered", async () => {
    enableAi("suggest");
    render(AiChat, { props: { sessionId: "sess1" } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-code");
    expect(screen.queryByTestId("ai-run")).toBeNull();
  });

  it("auto mode on a non-prod server runs the command without a click", async () => {
    enableAi("auto");
    render(AiChat, { props: { sessionId: "sess1", prod: false } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await waitFor(() => expect(writeToTerminal).toHaveBeenCalledOnce());
    expect(writeToTerminal.mock.calls[0][0]).toBe("sess1");
  });

  it("auto mode is barred on a prod-flagged server (button only)", async () => {
    enableAi("auto");
    render(AiChat, { props: { sessionId: "sess1", prod: true } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-run");
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("does not offer execution without a session (dock has no active terminal)", async () => {
    enableAi("confirm");
    render(AiChat, {});

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-code");
    expect(screen.queryByTestId("ai-run")).toBeNull();
  });
});

describe("AiChat — noAi server block (Phase 17.7)", () => {
  const REPLY = "Try:\n```bash\nls -la\n```";

  it("disables attaching context and shows a banner", () => {
    enableAi();
    render(AiChat, { props: { getContext: () => ({ selection: "x" }), noAi: true } });
    expect(screen.getByTestId("ai-attach")).toBeDisabled();
    expect(screen.getByTestId("ai-noai-banner")).toBeTruthy();
  });

  it("offers no Run button even in confirm mode", async () => {
    enableAi("confirm");
    render(AiChat, { props: { sessionId: "sess1", noAi: true } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-code");
    expect(screen.queryByTestId("ai-run")).toBeNull();
  });

  it("bars auto-run on a noAi server", async () => {
    enableAi("auto");
    render(AiChat, { props: { sessionId: "sess1", noAi: true } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-code");
    expect(writeToTerminal).not.toHaveBeenCalled();
  });
});

describe("AiChat — stop (cancel request)", () => {
  it("swaps Send for a Stop button while streaming and cancels on click", async () => {
    enableAi();
    const user = userEvent.setup();
    render(AiChat, { props: { sessionId: "s1" } });

    await ask("hi");
    emit("out", "partial");

    const stop = await screen.findByTestId("ai-stop");
    expect(screen.queryByTestId("ai-send")).toBeNull();

    await user.click(stop);
    expect(cancelAiChat).toHaveBeenCalledOnce();

    // Back to the Send button; the partial reply is kept.
    expect(await screen.findByTestId("ai-send")).toBeTruthy();
    expect(screen.getByText("partial")).toBeTruthy();
  });
});

describe("AiChat — per-session conversation persistence", () => {
  it("keeps a separate conversation per session and restores it on switch back", async () => {
    enableAi();
    const { rerender } = render(AiChat, { props: { sessionId: "sA" } });

    await ask("hello from A");
    emit("out", "reply A");
    emit("done");
    expect(screen.getByText("hello from A")).toBeTruthy();

    // Switch to another tab's session: its conversation is empty.
    await rerender({ sessionId: "sB" });
    expect(screen.queryByText("hello from A")).toBeNull();
    expect(screen.getByText("Ask anything about this server.")).toBeTruthy();

    // Switch back to A: the earlier dialog is still there.
    await rerender({ sessionId: "sA" });
    expect(screen.getByText("hello from A")).toBeTruthy();
    expect(screen.getByText("reply A")).toBeTruthy();
  });

  it("keeps streaming into a session after its component unmounts (tab switch)", async () => {
    enableAi();
    const view = render(AiChat, { props: { sessionId: "sA" } });
    await ask("bg question");

    // Tab switched away → AiChat is destroyed, but the stream lives in the store.
    view.unmount();
    emit("out", "arrived offscreen");
    emit("done");
    expect(aiChatState.map["sA"].streaming).toBe(false);

    // Re-open the tab: the reply that arrived while away is there.
    render(AiChat, { props: { sessionId: "sA" } });
    expect(await screen.findByText(/arrived offscreen/)).toBeTruthy();
  });

  it("Clear empties only the active session's conversation", async () => {
    enableAi();
    const { rerender } = render(AiChat, { props: { sessionId: "sA" } });
    await ask("keep me");
    emit("done");

    await rerender({ sessionId: "sB" });
    await ask("clear me");
    emit("done");
    await userEvent.setup().click(screen.getByText("Clear"));
    expect(screen.queryByText("clear me")).toBeNull();

    await rerender({ sessionId: "sA" });
    expect(screen.getByText("keep me")).toBeTruthy();
  });
});
