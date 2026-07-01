import { render, screen } from "@testing-library/svelte";
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
    ...p,
  };
}

const noop = () => {};
const baseProps = () => ({
  servers: [] as ServerProfile[],
  folders: [] as string[],
  selectedId: null as string | null,
  onSelect: noop,
  onConnect: noop,
  onAddServer: noop,
  onEditServer: noop,
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
});
