import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest } from "./ai";

// Capture what reaches the broker / terminal; nothing hits the network or a PTY.
const aiChat = vi.fn<(req: AiChatRequest) => Promise<void>>();
const cancelAiChat = vi.fn<(streamId: string) => Promise<void>>();
const aiModels = vi.fn<() => Promise<string[]>>();
const aiExec = vi.fn<(id: string, cmd: string, t: number) => Promise<unknown>>();
const writeToTerminal = vi.fn<(id: string, data: Uint8Array) => Promise<void>>();
const annotateRecording = vi.fn<(id: string, text: string) => Promise<void>>();
vi.mock("./api", () => ({
  aiChat: (req: AiChatRequest) => aiChat(req),
  cancelAiChat: (streamId: string) => cancelAiChat(streamId),
  aiModels: () => aiModels(),
  aiExec: (id: string, cmd: string, tmo: number) => aiExec(id, cmd, tmo),
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

function emit(kind: "out" | "think" | "done" | "error", payload?: unknown) {
  const ch = Object.keys(handlers).find((c) => c.startsWith(`ai://${kind}/`));
  if (ch) handlers[ch]({ payload });
}

import AiChat from "./AiChat.svelte";
import { settings } from "./settings.svelte";
import { defaultAiSettings, type AiExecMode } from "./ai";
import { aiChatState, askAbout, getChat } from "./stores/aichat.svelte";

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

/**
 * Ask, then reply — waiting for the stream's listeners to actually be registered
 * first. `startChat` registers them with `await listen(...)`, so emitting straight
 * after the click can land before anyone is listening; the reply is then dropped,
 * `streaming` never clears, and the *next* question silently does nothing.
 */
async function askAndReply(text: string, out: string, done: unknown = null) {
  await ask(text);
  await waitFor(() => expect(Object.keys(handlers).some((c) => c.startsWith("ai://done/"))).toBe(true));
  emit("out", out);
  emit("done", done);
  await waitFor(() => expect(Object.keys(handlers).some((c) => c.startsWith("ai://done/"))).toBe(false));
}

beforeEach(() => {
  localStorage.clear();
  settings.language = "en";
  settings.ai = defaultAiSettings();
  aiChatState.map = {}; // reset per-session conversations
  for (const k of Object.keys(handlers)) delete handlers[k];
  aiChat.mockReset().mockResolvedValue(undefined);
  cancelAiChat.mockReset().mockResolvedValue(undefined);
  aiModels.mockReset().mockResolvedValue([]);
  aiExec.mockReset().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
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

  it("sends the active chat prompt's content", async () => {
    enableAi();
    settings.ai.prompts.chat.prompts[0].content = "Answer in one word.";
    render(AiChat, {});

    await ask("hi");

    // Since Phase 41 the system prompt is the non-editable core plus the user's
    // persona prompt, so the persona is contained rather than equal.
    expect(aiChat.mock.calls[0][0].system).toContain("Answer in one word.");
  });

  it("uses the server's chosen chat prompt (by id) over the active one", async () => {
    enableAi();
    const set = settings.ai.prompts.chat;
    set.prompts = [...set.prompts, { id: "srvp", name: "For web1", content: "You are web1's helper." }];
    render(AiChat, { props: { chatPromptId: "srvp" } });

    await ask("hi");

    expect(aiChat.mock.calls[0][0].system).toContain("You are web1's helper.");
  });

  it("the context popover widens what is sent (per-chat tier)", async () => {
    enableAi();
    const user = userEvent.setup();
    render(AiChat, {
      props: { getContext: () => ({ selection: "SEL", buffer: "WHOLE-BUFFER" }) },
    });

    await user.click(screen.getByTestId("ai-attach")); // attach on
    await user.click(screen.getByTestId("ai-tiers")); // open popover
    const menu = screen.getByTestId("ai-tiers-menu");
    await user.click(within(menu).getAllByRole("checkbox")[0]); // "whole buffer"

    await user.type(screen.getByTestId("ai-input"), "what runs here?");
    await user.click(screen.getByTestId("ai-send"));

    const preview = await screen.findByTestId("ai-consent-preview");
    expect(preview.textContent).toContain("WHOLE-BUFFER");
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
    // CR, not LF — see terminput.ts (Phase 39.5).
    expect(new TextDecoder().decode(data as Uint8Array)).toBe("ls -la\r");
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

  it("a per-server execMode override wins over the global setting", async () => {
    enableAi("confirm"); // global = confirm (would show a Run button)
    render(AiChat, { props: { sessionId: "sess1", serverExecMode: "suggest" } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-code");
    expect(screen.queryByTestId("ai-run")).toBeNull(); // suggest → no Run
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

  it("bars dialog auto-execution on a noAi server", async () => {
    enableAi("dialog");
    render(AiChat, { props: { sessionId: "sess1", noAi: true } });

    await ask("list files");
    emit("out", REPLY);
    emit("done");

    await screen.findByTestId("ai-code");
    expect(writeToTerminal).not.toHaveBeenCalled();
  });
});

describe("AiChat — model picker", () => {
  it("lists fetched models and switches the active endpoint's model on select", async () => {
    enableAi();
    aiModels.mockResolvedValue(["llama3", "qwen2.5"]);
    const user = userEvent.setup();
    render(AiChat, { props: { sessionId: "s1" } });

    const select = (await screen.findByTestId("ai-model")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    // Current model plus fetched ones are offered.
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain("llama3");
    expect(values).toContain("qwen2.5");

    await user.selectOptions(select, "llama3");
    expect(settings.ai.endpoints[0].model).toBe("llama3");
  });

  it("keeps the manual model when discovery fails", async () => {
    enableAi();
    aiModels.mockRejectedValue(new Error("offline"));
    render(AiChat, { props: { sessionId: "s1" } });

    const select = (await screen.findByTestId("ai-model")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["qwen2.5"]);
  });
});

describe("AiChat — dialog mode (17.8)", () => {
  const REPLY = "```bash\napt install nginx\n```";

  it("dialogConfirm shows a confirm bar and runs the command on confirm", async () => {
    enableAi("dialogConfirm");
    const user = userEvent.setup();
    render(AiChat, { props: { sessionId: "sess1" } });

    await ask("install nginx");
    emit("out", REPLY);
    emit("done");

    const run = await screen.findByTestId("ai-dialog-run");
    expect(aiExec).not.toHaveBeenCalled(); // waits for confirmation

    await user.click(run);
    await waitFor(() => expect(aiExec).toHaveBeenCalledOnce());
    expect(aiExec.mock.calls[0][1]).toBe("apt install nginx");
  });

  it("tells the model to run one step at a time via the core prompt", async () => {
    enableAi("dialogConfirm");
    render(AiChat, { props: { sessionId: "sess1" } });
    await ask("hi");
    // Phase 41 folded the dialog instruction into the core, where it is built
    // from the live exec mode rather than appended by the component.
    const system = aiChat.mock.calls[0][0].system ?? "";
    expect(system).toMatch(/ONE command/);
    expect(system).toMatch(/exit code as the next message/i);
  });

  it("states the execution rules the no-TTY executor imposes", async () => {
    // The single most common way a correct-looking suggestion failed: `apt install`
    // or `sudo` waiting for input that ai_exec can never deliver.
    enableAi("confirm");
    render(AiChat, { props: { sessionId: "sess1" } });
    await ask("install nginx");
    const system = aiChat.mock.calls[0][0].system ?? "";
    expect(system).toMatch(/no TTY/i);
    expect(system).toMatch(/sudo -n/);
  });

  it("warns the model when the server is production", async () => {
    enableAi("confirm");
    render(AiChat, { props: { sessionId: "sess1", prod: true } });
    await ask("restart it");
    expect(aiChat.mock.calls[0][0].system).toMatch(/PRODUCTION/);
  });

  it("says nothing about production on an ordinary server", async () => {
    enableAi("confirm");
    render(AiChat, { props: { sessionId: "sess1" } });
    await ask("restart it");
    expect(aiChat.mock.calls[0][0].system).not.toMatch(/PRODUCTION/);
  });

  it("tells the model that attached output is data, not instructions", async () => {
    // A hostile host only has to print something that reads like an order; the
    // dialog modes would otherwise execute it.
    enableAi();
    const user = userEvent.setup();
    render(AiChat, { props: { sessionId: "s1", getContext: () => ({ selection: "boom" }) } });
    await user.click(screen.getByTestId("ai-attach"));
    await user.type(screen.getByTestId("ai-input"), "what is this?");
    await user.click(screen.getByTestId("ai-send"));
    await user.click(await screen.findByTestId("ai-consent-confirm"));

    await waitFor(() => expect(aiChat).toHaveBeenCalledOnce());
    const system = aiChat.mock.calls[0][0].system ?? "";
    expect(system).toMatch(/not trusted/i);
    expect(system).toMatch(/‹redacted›/);
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

// ── Phase 40 ────────────────────────────────────────────────────────────────────

describe("AiChat — reasoning, usage and history (Phase 40)", () => {
  it("streams reasoning into its own fold, apart from the answer", async () => {
    enableAi();
    render(AiChat, { props: { sessionId: "s1" } });
    await ask("why?");

    emit("think", "checking the port…");
    emit("out", "Port 80 is taken.");
    emit("done", null);

    const fold = await screen.findByTestId("ai-reasoning");
    // Folded by default — the scratchpad explains the wait, it isn't the answer.
    expect(within(fold).queryByText(/checking the port/)).toBeNull();
    await userEvent.setup().click(within(fold).getByRole("button"));
    expect(within(fold).getByText(/checking the port/)).toBeInTheDocument();
    // Crucially, reasoning never lands in the answer body.
    expect(screen.getByText("Port 80 is taken.")).toBeInTheDocument();
  });

  it("keeps reasoning out of the command blocks offered for execution", async () => {
    // A model that reasons "I could run rm -rf /" must not have that parsed into
    // a runnable block — only the answer channel is scanned for commands.
    enableAi();
    render(AiChat, { props: { sessionId: "s1" } });
    await ask("clean up");

    emit("think", "```bash\nrm -rf /\n```");
    emit("out", "Nothing to clean.");
    emit("done", null);

    await screen.findByTestId("ai-reasoning");
    expect(screen.queryByTestId("ai-run")).toBeNull();
    expect(screen.queryByTestId("ai-code")).toBeNull();
  });

  it("shows the token counter only when the endpoint reported one", async () => {
    enableAi();
    render(AiChat, { props: { sessionId: "s1" } });
    await askAndReply("hi", "hello"); // endpoint stayed silent about usage
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    // A time-only row is still shown (we measured that ourselves), but no counts.
    const usage = screen.queryByTestId("ai-usage");
    if (usage) expect(usage.textContent).not.toMatch(/\d{2,}/);

    await askAndReply("again", "sure", { inputTokens: 1240, outputTokens: 386 });
    await waitFor(() => {
      const rows = screen.getAllByTestId("ai-usage");
      expect(rows[rows.length - 1].textContent).toContain("386");
    });
  });

  it("warns when the conversation outgrew the history cap", async () => {
    enableAi();
    settings.ai.historyLimit = 2;
    render(AiChat, { props: { sessionId: "s1" } });

    await askAndReply("one", "a");
    expect(screen.queryByTestId("ai-history-trimmed")).toBeNull();

    await askAndReply("two", "b");
    // Four messages on screen, two of them no longer sent — say so rather than
    // silently dropping turns the user can still see.
    await waitFor(() => expect(screen.getByTestId("ai-history-trimmed")).toBeInTheDocument());
  });

  it("sends only the trimmed history to the broker", async () => {
    enableAi();
    settings.ai.historyLimit = 2;
    render(AiChat, { props: { sessionId: "s1" } });
    for (const q of ["one", "two", "three"]) {
      await askAndReply(q, "ok");
    }
    const last = aiChat.mock.calls.at(-1)![0];
    expect(last.messages.length).toBeLessThanOrEqual(2);
    expect(last.messages[0].role).toBe("user"); // never opens mid-exchange
  });
});

describe("askAbout — questions raised from elsewhere (Phase 41)", () => {
  it("routes through the consent dialog instead of sending", async () => {
    // The whole point of the primitive: an entry point buys convenience, never
    // a way around the consent contract.
    enableAi();
    render(AiChat, { props: { sessionId: "s1" } });

    askAbout("s1", { question: "explain this", context: "TOKEN=secret123", label: "Terminal selection" });

    const preview = await screen.findByTestId("ai-consent-preview");
    expect(aiChat).not.toHaveBeenCalled();
    // Redacted like any other context, and labelled so the core prompt's trust
    // boundary applies to it.
    expect(preview.textContent).toContain("‹redacted›");
    expect(preview.textContent).not.toContain("secret123");
    expect(preview.textContent).toContain("Terminal selection");
  });

  it("sends the prepared question once consent is given", async () => {
    enableAi();
    render(AiChat, { props: { sessionId: "s1" } });
    askAbout("s1", { question: "why is it broken?", context: "some logs", label: "Container logs" });

    await userEvent.setup().click(await screen.findByTestId("ai-consent-confirm"));

    await waitFor(() => expect(aiChat).toHaveBeenCalledOnce());
    const sent = aiChat.mock.calls[0][0].messages.at(-1)?.content ?? "";
    expect(sent).toContain("why is it broken?");
    expect(sent).toContain("### Container logs");
  });

  it("is ignored on a server that bars the assistant", async () => {
    // `noAi` blocks context and execution outright (17.7) — an entry point must
    // not become a side door into it.
    enableAi();
    render(AiChat, { props: { sessionId: "s1", noAi: true } });
    askAbout("s1", { question: "explain", context: "logs", label: "Container logs" });

    await waitFor(() => expect(getChat("s1").ask).toBeNull());
    expect(screen.queryByTestId("ai-consent")).toBeNull();
    expect(aiChat).not.toHaveBeenCalled();
  });

  it("clears the request so it does not re-fire on re-render", async () => {
    enableAi();
    render(AiChat, { props: { sessionId: "s1" } });
    askAbout("s1", { question: "explain", context: "logs", label: "Terminal selection" });
    await screen.findByTestId("ai-consent-preview");
    expect(getChat("s1").ask).toBeNull();
  });
});
