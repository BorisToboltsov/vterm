import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ServerTree from "./ServerTree.svelte";
import { layout } from "./stores/layout.svelte";
import type { ServerProfile } from "./types";

function srv(p: Partial<ServerProfile> & { id: string; alias: string }): ServerProfile {
  return {
    host: "h",
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
    ...p,
  };
}

const noop = () => {};
const baseProps = () => ({
  servers: [] as ServerProfile[],
  folders: [] as string[],
  selectedId: null as string | null,
  selectedFolder: null as string | null,
  connections: {} as Record<string, string[]>,
  onSelect: noop,
  onSelectFolder: noop,
  onConnect: noop,
  onAddServer: noop,
  onEditServer: noop,
  onDuplicateServer: noop,
  onDeleteServer: noop,
  onNewFolder: noop,
  onRenameFolder: noop,
  onDeleteFolder: noop,
  onMoveServer: noop,
  onMoveFolder: noop,
});

beforeEach(() => {
  localStorage.clear();
  layout.leftCollapsed = false;
});

describe("ServerTree", () => {
  it("renders an onboarding empty state with an add-server CTA", async () => {
    const onAddServer = vi.fn();
    render(ServerTree, { props: { ...baseProps(), onAddServer } });
    expect(screen.getByText("No servers yet")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("empty-add-server"));
    expect(onAddServer).toHaveBeenCalledOnce();
  });

  it("renders folders and servers and reports selection", async () => {
    const onSelect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web", group: "Prod" })],
        folders: ["Prod"],
        onSelect,
      },
    });
    expect(screen.getByText("Prod")).toBeInTheDocument();
    const row = screen.getByTestId("server-row");
    expect(row).toHaveAttribute("data-server-alias", "Web");
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("double-click on a server connects", async () => {
    const onConnect = vi.fn();
    render(ServerTree, {
      props: { ...baseProps(), servers: [srv({ id: "1", alias: "Web" })], onConnect },
    });
    await userEvent.dblClick(screen.getByTestId("server-row"));
    expect(onConnect).toHaveBeenCalled();
  });

  it("collapsing a folder hides its servers", async () => {
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web", group: "Prod" })],
        folders: ["Prod"],
      },
    });
    expect(screen.getByTestId("server-row")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Toggle folder"));
    expect(screen.queryByTestId("server-row")).toBeNull();
  });

  it("filters by search query", async () => {
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Alpha" }), srv({ id: "2", alias: "Beta" })],
      },
    });
    await userEvent.type(screen.getByTestId("server-search"), "alpha");
    const rows = screen.getAllByTestId("server-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-server-alias", "Alpha");
  });

  it("the expanded header matches the tab-bar height (min-h-8) so it abuts the tab bar", () => {
    render(ServerTree, { props: baseProps() });
    // The "Saved servers" title lives in the panel header row; that row must carry
    // min-h-8 (32px) — the same height as the terminal tab bar — so the open panel
    // lines up with the tab strip instead of sitting ~5px lower.
    const header = screen.getByText("Saved servers").closest("div");
    expect(header?.className).toContain("min-h-8");
  });

  it("the new-folder button requests a root folder", async () => {
    const onNewFolder = vi.fn();
    render(ServerTree, { props: { ...baseProps(), onNewFolder } });
    await userEvent.click(screen.getByLabelText("New folder"));
    expect(onNewFolder).toHaveBeenCalledWith("");
  });

  it("the toolbar add-server button (next to new-folder) requests a new server", async () => {
    const onAddServer = vi.fn();
    render(ServerTree, { props: { ...baseProps(), onAddServer } });
    await userEvent.click(screen.getByTestId("add-server"));
    expect(onAddServer).toHaveBeenCalledOnce();
  });

  it("shows a connection dot per open SSH tab of a server", () => {
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web" }), srv({ id: "2", alias: "Db" })],
        connections: { "1": ["Connected", "Connecting…"] },
      },
    });
    const dots = screen.getByTestId("conn-dots");
    // Two tabs → two dots (green + yellow); the connecting one pulses.
    const circles = dots.querySelectorAll("span.rounded-full");
    expect(circles).toHaveLength(2);
    expect(dots.querySelectorAll("span.pulse-dot")).toHaveLength(1);
    expect(dots.textContent).not.toContain("+"); // no overflow badge
  });

  it("caps the dots at 3 and shows a +N overflow badge", () => {
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web" })],
        connections: { "1": ["Connected", "Connected", "Connected", "Connected", "Connected"] },
      },
    });
    const dots = screen.getByTestId("conn-dots");
    expect(dots.querySelectorAll("span.rounded-full")).toHaveLength(3);
    expect(dots.textContent).toContain("+2");
  });

  it("renders no dots for a server with no open tabs", () => {
    render(ServerTree, {
      props: { ...baseProps(), servers: [srv({ id: "1", alias: "Web" })], connections: {} },
    });
    expect(screen.queryByTestId("conn-dots")).toBeNull();
  });

  it("clicking a folder row reports it as the selected folder", async () => {
    const onSelectFolder = vi.fn();
    render(ServerTree, {
      props: { ...baseProps(), folders: ["Prod"], onSelectFolder },
    });
    await userEvent.click(screen.getByTestId("folder-row"));
    expect(onSelectFolder).toHaveBeenCalledWith("Prod");
  });

  it("highlights the selected folder (aria-selected)", () => {
    render(ServerTree, {
      props: { ...baseProps(), folders: ["Prod", "Dev"], selectedFolder: "Prod" },
    });
    const rows = screen.getAllByTestId("folder-row");
    const prod = rows.find((r) => r.getAttribute("data-folder-path") === "Prod")!;
    const dev = rows.find((r) => r.getAttribute("data-folder-path") === "Dev")!;
    expect(prod).toHaveAttribute("aria-selected", "true");
    expect(prod.className).toContain("border-accent");
    expect(dev).toHaveAttribute("aria-selected", "false");
  });

  it("the folder toggle does not select the folder (stops propagation)", async () => {
    const onSelectFolder = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web", group: "Prod" })],
        folders: ["Prod"],
        onSelectFolder,
      },
    });
    await userEvent.click(screen.getByLabelText("Toggle folder"));
    expect(onSelectFolder).not.toHaveBeenCalled();
    // …and it still collapsed the folder.
    expect(screen.queryByTestId("server-row")).toBeNull();
  });

  it("the row duplicate button requests a copy of that server (without selecting it via bubbling)", async () => {
    const onDuplicateServer = vi.fn();
    const onSelect = vi.fn();
    const server = srv({ id: "1", alias: "Web" });
    render(ServerTree, {
      props: { ...baseProps(), servers: [server], onDuplicateServer, onSelect },
    });
    await userEvent.click(screen.getByLabelText("Duplicate server"));
    expect(onDuplicateServer).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables text selection while pressing a row, and restores it on release", async () => {
    render(ServerTree, {
      props: { ...baseProps(), servers: [srv({ id: "1", alias: "Web" })] },
    });
    const list = screen.getByRole("tree");
    expect(list.className).not.toContain("select-none");

    // Press on a server row → the list turns off text selection so a drag can't
    // start selecting the rows below it.
    await fireEvent.pointerDown(screen.getByTestId("server-row"));
    expect(list.className).toContain("select-none");

    // Releasing restores normal selection.
    await fireEvent.pointerUp(list);
    expect(list.className).not.toContain("select-none");
  });

  it("folder action buttons do not also select the folder", async () => {
    const onSelectFolder = vi.fn();
    const onRenameFolder = vi.fn();
    render(ServerTree, {
      props: { ...baseProps(), folders: ["Prod"], onSelectFolder, onRenameFolder },
    });
    await userEvent.click(screen.getByLabelText("Rename folder"));
    expect(onRenameFolder).toHaveBeenCalledWith("Prod");
    expect(onSelectFolder).not.toHaveBeenCalled();
  });

  // ── Keyboard navigation (arrows move a frame-cursor; Enter/Delete act) ──────
  it("ArrowDown from no selection moves the frame to the first row", async () => {
    const onSelect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "A" }), srv({ id: "2", alias: "B" })],
        onSelect,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("ArrowDown moves the frame to the next row", async () => {
    const onSelect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "A" }), srv({ id: "2", alias: "B" })],
        selectedId: "1",
        onSelect,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("ArrowUp moves the frame to the previous row", async () => {
    const onSelect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "A" }), srv({ id: "2", alias: "B" })],
        selectedId: "2",
        onSelect,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowUp" });
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("ArrowDown steps from a folder row into its first server", async () => {
    const onSelect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web", group: "Prod" })],
        folders: ["Prod"],
        selectedFolder: "Prod",
        onSelect,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("Enter on a server row connects it", async () => {
    const onSelect = vi.fn();
    const onConnect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web" })],
        selectedId: "1",
        onSelect,
        onConnect,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("1");
    expect(onConnect).toHaveBeenCalled();
  });

  it("Enter on a folder row toggles its collapse", async () => {
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web", group: "Prod" })],
        folders: ["Prod"],
        selectedFolder: "Prod",
      },
    });
    expect(screen.getByTestId("server-row")).toBeInTheDocument();
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
    expect(screen.queryByTestId("server-row")).toBeNull();
  });

  it("Delete on a server row requests its deletion", async () => {
    const onDeleteServer = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web" })],
        selectedId: "1",
        onDeleteServer,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "Delete" });
    expect(onDeleteServer).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
  });

  it("Delete on a folder row requests its deletion", async () => {
    const onDeleteFolder = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        folders: ["Prod"],
        selectedFolder: "Prod",
        onDeleteFolder,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: "Delete" });
    expect(onDeleteFolder).toHaveBeenCalledWith("Prod");
  });

  it("Space does not change the selection (no space-select)", async () => {
    const onSelect = vi.fn();
    const onConnect = vi.fn();
    render(ServerTree, {
      props: {
        ...baseProps(),
        servers: [srv({ id: "1", alias: "Web" })],
        selectedId: "1",
        onSelect,
        onConnect,
      },
    });
    await fireEvent.keyDown(screen.getByRole("tree"), { key: " " });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("draws an accent frame around the selected row", () => {
    render(ServerTree, {
      props: { ...baseProps(), servers: [srv({ id: "1", alias: "Web" })], selectedId: "1" },
    });
    expect(screen.getByTestId("server-row").className).toContain("outline-accent/70");
  });
});
