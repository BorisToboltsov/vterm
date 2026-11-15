import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SudoPrompt from "./SudoPrompt.svelte";
import type { SudoAsk } from "../page/editorflow.svelte";
import type { EditorDoc } from "../stores/workspaces.svelte";

const doc = { path: "/etc/nginx/nginx.conf" } as EditorDoc;
const ask = (over: Partial<SudoAsk> = {}): SudoAsk =>
  ({ kind: "save", sid: "s1", doc, mode: "type", note: null, source: null, ...over }) as SudoAsk;

describe("SudoPrompt", () => {
  it("draws nothing without a question", () => {
    render(SudoPrompt, { props: { ask: null, onconfirm: vi.fn(), oncancel: vi.fn() } });
    expect(screen.queryByTestId("sudo-prompt-confirm")).toBeNull();
  });

  it("a password to type: whose and where, why it is asked, remember on by default", async () => {
    const onconfirm = vi.fn();
    render(SudoPrompt, {
      props: { ask: ask({ note: "sudo.triedSaved" }), who: "deploy@web", onconfirm, oncancel: vi.fn() },
    });
    expect(screen.getByTestId("sudo-prompt-path").textContent).toContain("deploy@web · /etc/nginx/nginx.conf");
    expect(screen.getByTestId("sudo-prompt-note").textContent).toContain("keychain no longer works");
    expect((screen.getByTestId("sudo-prompt-remember") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("sudo-prompt-confirm")).toBeDisabled();
    await fireEvent.input(screen.getByTestId("sudo-prompt-password"), { target: { value: "pw" } });
    await fireEvent.click(screen.getByTestId("sudo-prompt-confirm"));
    expect(onconfirm).toHaveBeenCalledOnce();
  });

  it("on prod with nothing to type: one explicit yes, naming whose password goes", async () => {
    const onconfirm = vi.fn();
    render(SudoPrompt, {
      props: { ask: ask({ kind: "check", mode: "confirm", source: "login" }), who: "deploy@db", prod: true, onconfirm, oncancel: vi.fn() },
    });
    expect(screen.getByTestId("sudo-prompt-prod").textContent).toContain("root");
    expect(screen.getByTestId("sudo-prompt-source").textContent).toContain("login password");
    expect(screen.queryByTestId("sudo-prompt-password")).toBeNull();
    await fireEvent.click(screen.getByTestId("sudo-prompt-confirm"));
    expect(onconfirm).toHaveBeenCalledOnce();
  });

  it("waits while a check is on its way", () => {
    render(SudoPrompt, { props: { ask: ask({ mode: "confirm", source: "none" }), busy: true, onconfirm: vi.fn(), oncancel: vi.fn() } });
    expect(screen.getByTestId("sudo-prompt-confirm")).toBeDisabled();
  });
});
