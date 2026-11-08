import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Which key paths exist on "this computer".
const onDisk = vi.hoisted(() => new Set<string>(["/Users/boris/.ssh/id_ed25519", "~/.ssh/id_ed25519"]));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  keyPathExists: vi.fn(async (path: string) => onDisk.has(path)),
}));

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

  it("skips a server that is here under another login — and adds it when told to (v1.34)", async () => {
    const onimport = vi.fn();
    const theirs = contents({ servers: [server("t", { host: "a.example.net", username: "deploy" }), server("b")] });
    render(BackupImportDialog, { props: { open: true, contents: theirs, current: [server("a")], onimport } });
    const skip = screen.getByTestId("backup-skip-same-host");
    expect(skip).toBeChecked();
    expect(screen.getByTestId("backup-plan")).toHaveTextContent("Will be added: 1; already here: 1.");
    await userEvent.click(skip);
    expect(screen.getByTestId("backup-plan")).toHaveTextContent("Will be added: 2; already here: 0.");
    await userEvent.click(screen.getByTestId("backup-import-confirm"));
    expect(onimport.mock.calls[0][0].catalog.servers.map((s: ServerProfile) => s.id)).toEqual(["a", "t", "b"]);
  });

  it("puts the added servers into a folder of their own when asked, named by the day", async () => {
    const onimport = vi.fn();
    render(BackupImportDialog, { props: { open: true, contents: contents(), current: [], onimport } });
    expect(screen.queryByTestId("backup-folder-name")).toBeNull();
    await userEvent.click(screen.getByTestId("backup-into-folder"));
    const name = screen.getByTestId<HTMLInputElement>("backup-folder-name");
    expect(name.value).toMatch(/^From backup \d{4}-\d{2}-\d{2}$/);
    await userEvent.clear(name);
    await userEvent.type(name, "Theirs");
    await userEvent.click(screen.getByTestId("backup-import-confirm"));
    const { catalog } = onimport.mock.calls[0][0];
    expect(catalog.servers.map((s: ServerProfile) => s.group)).toEqual(["Theirs", "Theirs"]);
    expect(catalog.folders).toEqual(["Theirs", "Theirs/Prod"]);
  });

  it("names a key path that is not on this computer — and stops once it is replaced with one that is", async () => {
    render(BackupImportDialog, {
      props: { open: true, contents: contents({ servers: [server("a", { keyPath: "/home/them/.ssh/id" })] }), current: [] },
    });
    expect(await screen.findByTestId("backup-key-missing")).toHaveTextContent("no such file on this computer");
    await userEvent.type(screen.getByRole("textbox", { name: /\/home\/them\/\.ssh\/id/ }), "~/.ssh/id_ed25519");
    await vi.waitFor(() => expect(screen.queryByTestId("backup-key-missing")).toBeNull());
  });

  it("a backup with nothing in it says so and offers no import", () => {
    render(BackupImportDialog, {
      props: { open: true, contents: contents({ servers: null, folders: null, settings: false, recordings: null }) },
    });
    expect(screen.getByTestId("backup-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-import-confirm")).toBeNull();
  });
});
