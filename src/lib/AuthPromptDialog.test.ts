import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const answerAuthPrompt = vi.fn();
vi.mock("./api", () => ({
  answerAuthPrompt: (...a: unknown[]) => answerAuthPrompt(...a),
}));

import AuthPromptDialog from "./AuthPromptDialog.svelte";
import type { AuthPromptRequest } from "./types";

const req = (over: Partial<AuthPromptRequest> = {}): AuthPromptRequest => ({
  stage: "server",
  host: "10.0.0.1",
  username: "root",
  name: "",
  instructions: "",
  prompts: [
    { prompt: "Verification code: ", echo: false },
    { prompt: "Passcode or option (1-3): ", echo: true },
  ],
  ...over,
});

beforeEach(() => {
  answerAuthPrompt.mockReset();
  answerAuthPrompt.mockResolvedValue(undefined);
});

describe("AuthPromptDialog", () => {
  it("renders hidden questions as secret fields and shown ones as plain inputs", () => {
    render(AuthPromptDialog, { props: { sessionId: "s1", request: req(), ondone: vi.fn() } });
    expect(screen.getByText("The server asks")).toBeInTheDocument();
    expect(screen.getByText("root@10.0.0.1")).toBeInTheDocument();
    expect(screen.getByTestId("auth-prompt-field-0")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("auth-prompt-field-1")).not.toHaveAttribute("type", "password");
  });

  it("sends the answers in the order shown, then hands back", async () => {
    const ondone = vi.fn();
    render(AuthPromptDialog, { props: { sessionId: "s1", request: req(), ondone } });
    await fireEvent.input(screen.getByTestId("auth-prompt-field-0"), { target: { value: "123456" } });
    await fireEvent.input(screen.getByTestId("auth-prompt-field-1"), { target: { value: "1" } });
    await fireEvent.click(screen.getByTestId("auth-prompt-submit"));
    await waitFor(() => expect(ondone).toHaveBeenCalledOnce());
    expect(answerAuthPrompt).toHaveBeenCalledWith("s1", ["123456", "1"]);
  });

  it("cancel sends null — the backend ends the login", async () => {
    const ondone = vi.fn();
    render(AuthPromptDialog, { props: { sessionId: "s1", request: req(), ondone } });
    await fireEvent.click(screen.getByTestId("auth-prompt-cancel"));
    await waitFor(() => expect(ondone).toHaveBeenCalledOnce());
    expect(answerAuthPrompt).toHaveBeenCalledWith("s1", null);
  });

  it("names the jump host and shows the server's text as plain text", () => {
    render(AuthPromptDialog, {
      props: {
        sessionId: "s1",
        request: req({ stage: "proxy", instructions: "<b>Duo</b> two-factor\\nPick one" }),
        ondone: vi.fn(),
      },
    });
    expect(screen.getByText("The jump host asks")).toBeInTheDocument();
    const text = screen.getByTestId("auth-prompt-instructions");
    // Untrusted: no markup is interpreted.
    expect(text.querySelector("b")).toBeNull();
    expect(text.textContent).toContain("<b>Duo</b>");
  });

  it("still hands back when the login already ended on the server", async () => {
    answerAuthPrompt.mockRejectedValue("no login question is waiting for this session");
    const ondone = vi.fn();
    render(AuthPromptDialog, { props: { sessionId: "s1", request: req(), ondone } });
    await fireEvent.click(screen.getByTestId("auth-prompt-submit"));
    await waitFor(() => expect(ondone).toHaveBeenCalledOnce());
  });
});
