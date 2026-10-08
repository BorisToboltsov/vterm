import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where a container's details, logs and inspect open (v1.7): beside the list
// when the panel is wide, as a dialog when it is not.

const US = "\x1f";
const PS = [
  ["abc123456789", "edge-proxy", "nginx:1.27", "running", "Up 2 hours", "0.0.0.0:80->80/tcp", "", "", "", "2026-10-07 10:00:00 +0000 UTC", "2 hours ago", "bridge"],
].map((row) => row.join(US));

const calls: string[] = [];
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  containerRun: vi.fn(async (_session: string, args: string[]) => {
    calls.push(args.join(" "));
    await new Promise((r) => setTimeout(r, 5));
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[1] === "version") return ok("29.0.1\n");
    if (args[1] === "ps") return ok(PS.join("\n"));
    if (args[1] === "inspect") return ok('[{"Id":"abc123456789"}]');
    if (args[1] === "logs") return ok("GET /healthz 200");
    return ok("");
  }),
}));

import { flushSync } from "svelte";
import DockerPanel from "./DockerPanel.svelte";
import { resetDockState } from "./stores/dockstate.svelte";
import { panelSplits, resetPanelShares, setPanelShare } from "./stores/panelsplit.svelte";

/** Give the row the two parts share a width, as the browser's observer would
 *  report it (jsdom has no layout; Svelte binds the width through one). */
function sizeRow(part: HTMLElement, width: number) {
  const row = part.parentElement!;
  Object.defineProperty(row, "clientWidth", { configurable: true, value: width });
  const observers = (
    globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
  ).instances;
  for (const o of observers) o.cb([{ target: row }]);
}

/** Give the panel a width and let its observer see it (jsdom has no layout). */
function resize(width: number) {
  const root = document.querySelector<HTMLElement>("[data-wide]")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
  const observers = (
    globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
  ).instances;
  for (const o of observers) o.cb([]);
}

async function mount(id: string) {
  render(DockerPanel, { props: { sessionId: id, visible: true, sessionReady: true } });
  await screen.findByText("edge-proxy");
}

beforeEach(() => {
  calls.length = 0;
  resetDockState();
  resetPanelShares();
});

describe("DockerPanel — where a container's details open", () => {
  it("a narrow dock opens them as a dialog", async () => {
    await mount("d-narrow");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("docker-detail-overview"));
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });

  it("a wide panel opens them beside the list, which stays on screen", async () => {
    await mount("d-wide");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const side = screen.getByTestId("docker-side");
    expect(side).toContainElement(screen.getByTestId("docker-detail-overview"));
    expect(screen.getByTestId("docker-list-part")).toContainElement(
      screen.getByRole("button", { name: "View details" }),
    );
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });

  it("the border between the list and the pane is there only while there are two parts", async () => {
    await mount("d-border");
    resize(1200);
    const list = screen.getByTestId("docker-list-part");
    // The list alone takes the whole row.
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(list.style.width).toBe("");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    // list | border | pane, in that order, and the list takes its share.
    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("data-split", "docker");
    expect(divider.previousElementSibling).toBe(list);
    expect(divider.nextElementSibling).toBe(screen.getByTestId("docker-side"));
    expect(list.style.width).toBe("50%");
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(list.style.width).toBe("");
  });

  it("dragging the border gives the list or the pane more room, and it stays where it was left", async () => {
    await mount("d-drag");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const list = screen.getByTestId("docker-list-part");
    sizeRow(list, 1200);
    const divider = screen.getByTestId("panel-divider");
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600, clientY: 10 });
    await fireEvent.pointerMove(divider, { pointerId: 1, clientX: 420, clientY: 10 });
    await fireEvent.pointerUp(divider, { pointerId: 1, clientX: 420, clientY: 10 });
    expect(panelSplits.shares.docker).toBeCloseTo(0.35);
    expect(list.style.width).toBe("35%");
    // Closed and opened again — another container, another session: the same border.
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByTestId("docker-list-part").style.width).toBe("35%");
  });

  it("a share the row has no room for is drawn at the limit, not past it", async () => {
    setPanelShare("docker", 0.2);
    flushSync();
    await mount("d-limit");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const list = screen.getByTestId("docker-list-part");
    sizeRow(list, 800);
    // 240px of 800: the list keeps its minimum; what the user set is kept for a wider dock.
    await waitFor(() => expect(list.style.width).toBe("30%"));
    expect(panelSplits.shares.docker).toBe(0.2);
  });

  it("logs read in the pane are fetched like the dialog's, and fill it", async () => {
    await mount("d-logs");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await waitFor(() => expect(screen.getByTestId("docker-text")).toHaveTextContent("GET /healthz 200"));
    expect(calls.filter((c) => c.startsWith("docker logs"))).toHaveLength(1);
    expect(screen.getByTestId("docker-text")).toHaveClass("min-h-0", "flex-1");
  });

  it("inspect asked from the row's menu stands in front of the details, and closing it shows them again", async () => {
    await mount("d-text");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.contextMenu(screen.getByRole("listitem"));
    // "Inspect" is also a tab of the details; the one asked for is the menu's.
    const menu = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".fixed.z-50");
      expect(el).not.toBeNull();
      return el!;
    });
    await fireEvent.click(within(menu).getByText("Inspect"));
    await waitFor(() => expect(screen.getByTestId("docker-side-text")).toBeInTheDocument());
    expect(screen.queryByTestId("docker-side-detail")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.getByTestId("docker-side-detail")).toBeInTheDocument();
  });

  it("details that are open follow the panel across the threshold", async () => {
    await mount("d-cross");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    resize(1200);
    await waitFor(() => expect(screen.getByTestId("docker-side")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull();
    resize(400);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });
});
