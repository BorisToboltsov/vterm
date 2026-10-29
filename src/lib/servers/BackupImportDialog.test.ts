import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BackupImportDialog from "./BackupImportDialog.svelte";
import type { BackupContents } from "../api/servers";
import type { ServerProfile } from "../types";

const server = (id: string, over: Partial<ServerProfile> = {}): ServerProfile => ({
  id,
  alias: id,
  host: `${id}.example.net`,
  port: 22,
  username: "boris",
  authMethod: "key",
  keyPath: "/Users/boris/.ssh/id_ed25519",
  hasSavedPassword: false,
  group: null,
  tags: [],
  prod: false,
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
  ...over,
});

const contents = (over: Partial<BackupContents> = {}): BackupContents => ({
  kind: "all",
  servers: [server("a"), server("b")],
  folders: ["Prod"],
  settings: true,
  recordings: 2,
  ...over,
});

describe("BackupImportDialog", () => {
  it("adds to the current servers by default, and says what that does", async () => {
    const onimport = vi.fn();
    render(BackupImportDialog, {
      props: { open: true, contents: contents(), fileName: "vterm.zip", current: [server("a")], onimport },
    });
    expect(screen.getByTestId("backup-file")).toHaveTextContent("vterm.zip");
    expect(screen.getByTestId("backup-mode-merge")).toBeChecked();
    expect(screen.getByTestId("backup-plan")).toHaveTextContent("Will be added: 1; already here: 1.");
    expect(screen.getByTestId("backup-import-confirm").className).not.toContain("bg-danger");
    await userEvent.click(screen.getByTestId("backup-import-confirm"));
    expect(onimport).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "merge", settings: true, recordings: true }),
    );
    expect(onimport.mock.calls[0][0].catalog.servers.map((s: ServerProfile) => s.id)).toEqual(["a", "b"]);
  });

  it("replacing names what it removes and asks with the danger button", async () => {
    const onimport = vi.fn();
    render(BackupImportDialog, {
      props: { open: true, contents: contents(), current: [server("m1"), server("m2"), server("m3")], onimport },
    });
    await userEvent.click(screen.getByTestId("backup-mode-replace"));
    expect(screen.getByTestId("backup-plan")).toHaveTextContent("Will be written: 2; yours removed: 3.");
    expect(screen.getByTestId("backup-import-confirm").className).toContain("bg-danger");
    await userEvent.click(screen.getByTestId("backup-import-confirm"));
    expect(onimport.mock.calls[0][0].catalog.servers.map((s: ServerProfile) => s.id)).toEqual(["a", "b"]);
  });

  it("changes key paths, and leaves what is left empty", async () => {
    const onimport = vi.fn();
    render(BackupImportDialog, {
      props: {
        open: true,
        contents: contents({ servers: [server("a"), server("b", { keyPath: "/Users/boris/.ssh/work" })] }),
        onimport,
      },
    });
    await userEvent.type(screen.getByLabelText("Replace /Users/boris/.ssh/work with"), "~/.ssh/work");
    await userEvent.click(screen.getByTestId("backup-import-confirm"));
    const servers = onimport.mock.calls[0][0].catalog.servers as ServerProfile[];
    expect(servers.map((s) => s.keyPath)).toEqual(["/Users/boris/.ssh/id_ed25519", "~/.ssh/work"]);
    expect(servers.map((s) => s.username)).toEqual(["boris", "boris"]);
  });

  it("taking only some parts leaves the rest out — and nothing at all cannot be imported", async () => {
    const onimport = vi.fn();
    render(BackupImportDialog, { props: { open: true, contents: contents(), onimport } });
    await userEvent.click(screen.getByTestId("backup-take-servers"));
    expect(screen.queryByTestId("backup-logins")).toBeNull();
    await userEvent.click(screen.getByTestId("backup-take-recordings"));
    await userEvent.click(screen.getByTestId("backup-import-confirm"));
    expect(onimport).toHaveBeenLastCalledWith(
      expect.objectContaining({ catalog: null, plan: null, settings: true, recordings: false }),
    );

    await userEvent.click(screen.getByTestId("backup-take-settings"));
    expect(screen.getByTestId("backup-nothing")).toHaveTextContent("Choose what to import.");
    expect(screen.getByTestId("backup-import-confirm")).toBeDisabled();
  });

  it("a backup with nothing in it says so and offers no import", () => {
    render(BackupImportDialog, {
      props: { open: true, contents: contents({ servers: null, folders: null, settings: false, recordings: null }) },
    });
    expect(screen.getByTestId("backup-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-import-confirm")).toBeNull();
  });
});
