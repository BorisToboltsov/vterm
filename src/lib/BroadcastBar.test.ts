import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BroadcastBar from "./BroadcastBar.svelte";

describe("BroadcastBar", () => {
  it("sends the typed command and clears the input", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { targetCount: 3, onsend } });
    const input = screen.getByTestId("broadcast-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "uptime" } });
    await fireEvent.click(screen.getByTestId("broadcast-send"));
    expect(onsend).toHaveBeenCalledExactlyOnceWith("uptime");
    expect(input.value).toBe("");
  });

  it("sends on Enter", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { targetCount: 2, onsend } });
    const input = screen.getByTestId("broadcast-input");
    await fireEvent.input(input, { target: { value: "ls" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onsend).toHaveBeenCalledExactlyOnceWith("ls");
  });

  it("does not send an empty command", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { targetCount: 1, onsend } });
    await fireEvent.click(screen.getByTestId("broadcast-send"));
    expect(onsend).not.toHaveBeenCalled();
  });

  it("is inert when there are no live targets", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { targetCount: 0, disabled: true, onsend } });
    const input = screen.getByTestId("broadcast-input");
    await fireEvent.input(input, { target: { value: "reboot" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onsend).not.toHaveBeenCalled();
    expect(screen.getByTestId("broadcast-send")).toBeDisabled();
  });
});
