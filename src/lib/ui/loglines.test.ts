import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import LogTail from "./LogTail.svelte";

const LOG = [
  "2026-11-06T10:41:02.000000000Z INFO uvicorn running",
  "2026-11-06T10:41:07.000000000Z WARN pool exhausted",
  "2026-11-06T10:41:12.000000000Z ERROR connect refused",
].join("\n");

const view = () => screen.getByTestId("t-text");
const lines = () => [...view().children].map((el) => el.textContent);

describe("LogTail", () => {
  it("draws a line per log line, the severity coloured, the stamp as the time of day", () => {
    render(LogTail, { props: { text: LOG, empty: "No logs", testid: "t" } });
    expect(view().children).toHaveLength(3);
    expect(view().children[1].className).toContain("text-warn");
    expect(view().children[2].className).toContain("text-bad");
    expect(view().children[0].className).not.toMatch(/text-(warn|bad)/);
    expect(view().children[0].textContent).toMatch(/^\d\d:\d\d:\d\dINFO uvicorn running$/);
  });

  it("says an empty log, and a filter that keeps nothing, differently", async () => {
    const { rerender } = render(LogTail, { props: { text: "", empty: "No logs", testid: "t" } });
    expect(view()).toHaveTextContent("No logs");
    await rerender({ text: LOG });
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "nothing-like-it" } });
    expect(view()).toHaveTextContent("No line matches the filter");
  });

  it("narrows by text and by severity", async () => {
    render(LogTail, { props: { text: LOG, empty: "No logs", testid: "t" } });
    await fireEvent.change(screen.getByTestId("t-log-level"), { target: { value: "warn" } });
    expect(lines()).toHaveLength(2);
    await fireEvent.change(screen.getByTestId("t-log-level"), { target: { value: "error" } });
    expect(lines()).toHaveLength(1);
    await fireEvent.change(screen.getByTestId("t-log-level"), { target: { value: "all" } });
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "POOL" } });
    expect(lines()).toEqual([expect.stringContaining("pool exhausted")]);
  });

  it("hides the stamps and stops wrapping when told", async () => {
    render(LogTail, { props: { text: LOG, empty: "No logs", testid: "t" } });
    expect(view().className).toContain("whitespace-pre-wrap");
    await fireEvent.click(screen.getByTestId("t-log-wrap"));
    expect(view().className).toContain("whitespace-pre");
    expect(view().className).not.toContain("whitespace-pre-wrap");
    await fireEvent.click(screen.getByTestId("t-log-stamps"));
    expect(lines()[0]).toBe("INFO uvicorn running");
  });

  it("switches between following and held, and offers the terminal only when it can", async () => {
    const onterminal = vi.fn();
    const { rerender } = render(LogTail, { props: { text: LOG, empty: "No logs", testid: "t", live: true } });
    expect(screen.queryByTestId("t-log-terminal")).toBeNull();
    const live = screen.getByTestId("t-log-live");
    expect(live).toHaveAttribute("aria-pressed", "true");
    await fireEvent.click(live);
    expect(live).toHaveAttribute("aria-pressed", "false");
    expect(live).toHaveTextContent("Paused");
    await rerender({ onterminal });
    await fireEvent.click(screen.getByTestId("t-log-terminal"));
    expect(onterminal).toHaveBeenCalledOnce();
  });

  it("is bounded by the window unless it fills its place", async () => {
    const { rerender } = render(LogTail, { props: { text: LOG, empty: "No logs", testid: "t" } });
    expect(view().className).toContain("max-h-[60vh]");
    await rerender({ fill: true });
    expect(view()).toHaveClass("min-h-0", "flex-1");
  });
});
