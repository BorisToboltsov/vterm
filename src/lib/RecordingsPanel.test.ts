import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest } from "./ai";
import type { RecordingMeta } from "./types";

const REC: RecordingMeta = {
  path: "/recs/session.cast",
  title: "Deploy nginx",
  description: "",
  server: "web1",
  width: 80,
  height: 24,
  timestamp: 1_700_000_000,
  size: 1234,
};

// A tiny asciicast whose transcript carries a secret to prove redaction.
const CAST = [
  '{"version":2,"width":80,"height":24}',
  '[0.1,"o","$ export TOKEN=abc123\\r\\n"]',
  '[0.2,"o","$ systemctl restart nginx\\r\\n"]',
].join("\n");

const listRecordings = vi.fn<() => Promise<RecordingMeta[]>>();
const readRecording = vi.fn<(p: string) => Promise<string>>();
const aiChat = vi.fn<(req: AiChatRequest) => Promise<void>>();
vi.mock("./api", () => ({
  listRecordings: () => listRecordings(),
  readRecording: (p: string) => readRecording(p),
  aiChat: (req: AiChatRequest) => aiChat(req),
  // Unused on the plan path but imported by the component:
  deleteRecording: vi.fn(),
  setRecordingMeta: vi.fn(),
  exportRecording: vi.fn(),
  pickExportSavePath: vi.fn(),
  importRecording: vi.fn(),
  pickRecordingFile: vi.fn(),
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

import RecordingsPanel from "./RecordingsPanel.svelte";
import { settings } from "./settings.svelte";
import { defaultAiSettings } from "./ai";

function enableAi() {
  settings.ai = {
    ...defaultAiSettings(),
    enabled: true,
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

beforeEach(() => {
  localStorage.clear();
  settings.language = "en";
  settings.ai = defaultAiSettings();
  for (const k of Object.keys(handlers)) delete handlers[k];
  listRecordings.mockReset().mockResolvedValue([REC]);
  readRecording.mockReset().mockResolvedValue(CAST);
  aiChat.mockReset().mockResolvedValue(undefined);
});

describe("RecordingsPanel — AI generation (Phase 17.5–17.6)", () => {
  it("hides the AI button when the assistant is off", async () => {
    render(RecordingsPanel, { props: { open: true } });
    await screen.findByText("Deploy nginx");
    expect(screen.queryByTestId("rec-ai")).toBeNull();
  });

  it("consents with a redacted transcript before sending a plan", async () => {
    enableAi();
    const user = userEvent.setup();
    render(RecordingsPanel, { props: { open: true } });

    await user.click(await screen.findByTestId("rec-ai"));
    await user.click(await screen.findByTestId("rec-gen-plan"));

    const preview = await screen.findByTestId("ai-consent-preview");
    expect(preview.textContent).toContain("systemctl restart nginx");
    expect(preview.textContent).toContain("‹redacted›");
    expect(preview.textContent).not.toContain("abc123");
    expect(aiChat).not.toHaveBeenCalled();
  });

  it("streams the plan into the viewer after confirming", async () => {
    enableAi();
    const user = userEvent.setup();
    render(RecordingsPanel, { props: { open: true } });

    await user.click(await screen.findByTestId("rec-ai"));
    await user.click(await screen.findByTestId("rec-gen-plan"));
    await user.click(await screen.findByTestId("ai-consent-confirm"));

    await waitFor(() => expect(aiChat).toHaveBeenCalledOnce());
    const sent = aiChat.mock.calls[0][0].messages.at(-1)?.content ?? "";
    expect(sent).toContain("‹redacted›");
    expect(sent).not.toContain("abc123");
    expect(aiChat.mock.calls[0][0].system).toBe(settings.ai.prompts.runbook.prompts[0].content);

    emit("out", "## Runbook\n1. Restart nginx");
    emit("done");

    const view = await screen.findByTestId("rec-plan-view");
    await waitFor(() => expect(view.textContent).toContain("Runbook"));
  });

  it("generates a shell script and opens it in the editor via onOpenScript", async () => {
    enableAi();
    const onOpenScript = vi.fn();
    const user = userEvent.setup();
    render(RecordingsPanel, { props: { open: true, onOpenScript } });

    await user.click(await screen.findByTestId("rec-ai"));
    await user.click(await screen.findByTestId("rec-gen-sh"));
    await user.click(await screen.findByTestId("ai-consent-confirm"));

    await waitFor(() => expect(aiChat).toHaveBeenCalledOnce());
    expect(aiChat.mock.calls[0][0].system).toBe(settings.ai.prompts.sh.prompts[0].content);

    emit("out", "```bash\n#!/usr/bin/env bash\nsystemctl restart nginx\n```");
    emit("done");

    await waitFor(() => expect(onOpenScript).toHaveBeenCalledOnce());
    const [name, content] = onOpenScript.mock.calls[0];
    expect(name).toBe("deploy-nginx.sh");
    expect(content).toBe("#!/usr/bin/env bash\nsystemctl restart nginx");
  });

  it("uses the Ansible prompt and a .yml filename for a playbook", async () => {
    enableAi();
    const onOpenScript = vi.fn();
    const user = userEvent.setup();
    render(RecordingsPanel, { props: { open: true, onOpenScript } });

    await user.click(await screen.findByTestId("rec-ai"));
    await user.click(await screen.findByTestId("rec-gen-ansible"));
    await user.click(await screen.findByTestId("ai-consent-confirm"));

    await waitFor(() => expect(aiChat).toHaveBeenCalledOnce());
    expect(aiChat.mock.calls[0][0].system).toBe(settings.ai.prompts.ansible.prompts[0].content);

    emit("out", "```yaml\n- hosts: all\n  tasks: []\n```");
    emit("done");

    await waitFor(() => expect(onOpenScript).toHaveBeenCalledOnce());
    expect(onOpenScript.mock.calls[0][0]).toBe("deploy-nginx.yml");
  });
});
