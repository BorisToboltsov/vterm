import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BroadcastBar from "./BroadcastBar.svelte";

describe("BroadcastBar", () => {
  it("sends the typed command and clears the input", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { onsend } });
    const input = screen.getByTestId("broadcast-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "uptime" } });
    await fireEvent.click(screen.getByTestId("broadcast-send"));
    expect(onsend).toHaveBeenCalledExactlyOnceWith("uptime");
    expect(input.value).toBe("");
  });

  it("sends on Enter", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { onsend } });
    const input = screen.getByTestId("broadcast-input");
    await fireEvent.input(input, { target: { value: "ls" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onsend).toHaveBeenCalledExactlyOnceWith("ls");
  });

  it("does not send an empty command", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { onsend } });
    await fireEvent.click(screen.getByTestId("broadcast-send"));
    expect(onsend).not.toHaveBeenCalled();
  });

  it("is inert when there are no live targets", async () => {
    const onsend = vi.fn();
    render(BroadcastBar, { props: { disabled: true, onsend } });
    const input = screen.getByTestId("broadcast-input");
    await fireEvent.input(input, { target: { value: "reboot" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onsend).not.toHaveBeenCalled();
    expect(screen.getByTestId("broadcast-send")).toBeDisabled();
  });

  it("recalls what it sent with ↑ and ↓, only what starts with the text typed first", async () => {
    render(BroadcastBar, { props: { onsend: vi.fn(), recent: ["systemctl reload nginx", "df -h", "systemctl status nginx"] } });
    const input = screen.getByTestId("broadcast-input") as HTMLInputElement;
    await fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("systemctl reload nginx");
    await fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("df -h");
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
    await fireEvent.input(input, { target: { value: "systemctl s" } });
    await fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("systemctl status nginx");
  });

  it("opens the group's history on Ctrl+R and takes a command from it into the line", async () => {
    const onhistory = vi.fn();
    const onhistoryclose = vi.fn();
    const props = {
      onsend: vi.fn(),
      onhistory,
      onhistoryclose,
      history: {
        open: true,
        loading: false,
        rows: [{ cmd: "nginx -t", sent: true, on: ["web-1", "web-2"], of: 2 }],
        unread: ["db-1"],
        members: 2,
      },
    };
    render(BroadcastBar, { props });
    await fireEvent.keyDown(screen.getByTestId("broadcast-input"), { key: "r", ctrlKey: true });
    expect(onhistory).toHaveBeenCalledOnce();
    expect(screen.getByTestId("command-history-note").textContent).toContain("db-1");
    await fireEvent.click(screen.getByTitle("nginx -t"));
    expect(onhistoryclose).toHaveBeenCalledOnce();
    expect((screen.getByTestId("broadcast-input") as HTMLInputElement).value).toBe("nginx -t");
  });

  it("hands a pasted block to paste-into-all instead of flattening it into the line", async () => {
    const onpasteall = vi.fn();
    render(BroadcastBar, { props: { onsend: vi.fn(), onpasteall } });
    const input = screen.getByTestId("broadcast-input");
    const clipboardData = { getData: () => "cat >> f <<'EOF'\nx\nEOF" };
    await fireEvent.paste(input, { clipboardData });
    expect(onpasteall).toHaveBeenCalledExactlyOnceWith("cat >> f <<'EOF'\nx\nEOF");
  });

  it("in keys mode says who gets the keys instead of showing the line", async () => {
    const onmode = vi.fn();
    render(BroadcastBar, {
      props: { onsend: vi.fn(), onmode, mode: "keys", keysTo: ["web-2"], keysSkipped: ["db-1"] },
    });
    expect(screen.queryByTestId("broadcast-input")).toBeNull();
    expect(screen.queryByTestId("broadcast-send")).toBeNull();
    const status = screen.getByTestId("broadcast-keys-status").textContent ?? "";
    expect(status).toContain("web-2");
    expect(status).toContain("db-1");
    const [line, keys] = screen.getAllByRole("radio");
    expect(keys.getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(line);
    expect(onmode).toHaveBeenCalledExactlyOnceWith("line");
    // The mode stays the page's until it says otherwise (keys with prod waits for its question).
    expect(keys.getAttribute("aria-checked")).toBe("true");
  });
});
