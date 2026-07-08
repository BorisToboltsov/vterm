import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotesModal from "./NotesModal.svelte";
import type { ServerProfile } from "./types";

function server(notes = ""): ServerProfile {
  return {
    id: "s1",
    alias: "Web",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    authMethod: "password",
    keyPath: null,
    hasSavedPassword: false,
    group: null,
    tags: [],
    autoRecord: false,
    noAi: false,
    chatPromptId: null,
    execMode: null,
    proxy: null,
    notes,
  };
}

describe("NotesModal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("seeds the textarea from the server's notes", () => {
    render(NotesModal, { props: { server: server("hi there"), onsave: vi.fn(), onclose: vi.fn() } });
    const ta = screen.getByTestId("notes-textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("hi there");
  });

  it("autosaves after the debounce, once, with the latest text", async () => {
    const onsave = vi.fn().mockResolvedValue(undefined);
    render(NotesModal, { props: { server: server(), onsave, onclose: vi.fn() } });
    const ta = screen.getByTestId("notes-textarea");
    await fireEvent.input(ta, { target: { value: "draft" } });
    expect(onsave).not.toHaveBeenCalled(); // still within the debounce window
    await vi.advanceTimersByTimeAsync(800);
    expect(onsave).toHaveBeenCalledExactlyOnceWith("draft");
  });

  it("Save & close flushes the pending edit then closes", async () => {
    const onsave = vi.fn().mockResolvedValue(undefined);
    const onclose = vi.fn();
    render(NotesModal, { props: { server: server(), onsave, onclose } });
    await fireEvent.input(screen.getByTestId("notes-textarea"), { target: { value: "x" } });
    await fireEvent.click(screen.getByTestId("notes-save-close"));
    await vi.runAllTimersAsync();
    expect(onsave).toHaveBeenCalledExactlyOnceWith("x"); // no double-save from the timer
    expect(onclose).toHaveBeenCalled();
  });

  it("does not save when nothing changed", async () => {
    const onsave = vi.fn().mockResolvedValue(undefined);
    const onclose = vi.fn();
    render(NotesModal, { props: { server: server("kept"), onsave, onclose } });
    await fireEvent.click(screen.getByTestId("notes-save-close"));
    await vi.runAllTimersAsync();
    expect(onsave).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalled();
  });

  it("renders a Markdown preview when toggled", async () => {
    render(NotesModal, { props: { server: server("# Heading"), onsave: vi.fn(), onclose: vi.fn() } });
    await fireEvent.click(screen.getByTestId("notes-mode-preview"));
    const pv = screen.getByTestId("notes-preview");
    expect(pv.textContent).toContain("Heading");
  });
});
