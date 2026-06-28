import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri bridge before importing the module under test.
const invoke = vi.fn();
const open = vi.fn();
const save = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => open(...a),
  save: (...a: unknown[]) => save(...a),
}));

import * as api from "./api";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  open.mockReset();
  save.mockReset();
});

describe("invoke wrappers pass the right command + args", () => {
  it("listServers", async () => {
    invoke.mockResolvedValue([]);
    await api.listServers();
    expect(invoke).toHaveBeenCalledWith("list_servers");
  });

  it("addServer / updateServer / deleteServer", async () => {
    const profile = { alias: "a" } as never;
    await api.addServer(profile);
    expect(invoke).toHaveBeenCalledWith("add_server", { profile });
    await api.updateServer("id1", profile);
    expect(invoke).toHaveBeenCalledWith("update_server", { id: "id1", profile });
    await api.deleteServer("id1");
    expect(invoke).toHaveBeenCalledWith("delete_server", { id: "id1" });
  });

  it("folder commands", async () => {
    await api.addFolder("Prod/EU");
    expect(invoke).toHaveBeenCalledWith("add_folder", { path: "Prod/EU" });
    await api.moveFolder("Prod/EU", null);
    expect(invoke).toHaveBeenCalledWith("move_folder", { path: "Prod/EU", newParent: null });
    await api.renameFolder("Prod", "Production");
    expect(invoke).toHaveBeenCalledWith("rename_folder", { path: "Prod", newName: "Production" });
    await api.setServerGroup("id1", "Prod");
    expect(invoke).toHaveBeenCalledWith("set_server_group", { id: "id1", group: "Prod" });
  });

  it("connectSession spreads the options object into flat args", async () => {
    await api.connectSession("sess", "srv", "pw", true, 80, 24, {
      termType: "xterm-256color",
      connectTimeout: 10,
      keepaliveInterval: 15,
      hostKeyPolicy: "ask",
    });
    expect(invoke).toHaveBeenCalledWith("connect_session", {
      sessionId: "sess",
      serverId: "srv",
      secret: "pw",
      remember: true,
      cols: 80,
      rows: 24,
      termType: "xterm-256color",
      connectTimeout: 10,
      keepaliveInterval: 15,
      hostKeyPolicy: "ask",
    });
  });

  it("writeToTerminal converts the byte array", async () => {
    await api.writeToTerminal("sess", new Uint8Array([104, 105]));
    expect(invoke).toHaveBeenCalledWith("write_to_terminal", {
      sessionId: "sess",
      data: [104, 105],
    });
  });

  it("sftp commands", async () => {
    await api.sftpList("sess", "/tmp");
    expect(invoke).toHaveBeenCalledWith("sftp_list", { sessionId: "sess", path: "/tmp" });
    await api.sftpDownload("sess", "t1", "/r", "/l", true);
    expect(invoke).toHaveBeenCalledWith("sftp_download", {
      sessionId: "sess",
      transferId: "t1",
      remotePath: "/r",
      localPath: "/l",
      isDir: true,
    });
    await api.sftpCancel("t1");
    expect(invoke).toHaveBeenCalledWith("sftp_cancel", { transferId: "t1" });
  });

  it("sftp text editor commands", async () => {
    await api.sftpReadText("sess", "/etc/app.conf", 4194304);
    expect(invoke).toHaveBeenCalledWith("sftp_read_text", {
      sessionId: "sess",
      path: "/etc/app.conf",
      maxBytes: 4194304,
    });
    await api.sftpWriteText("sess", "/etc/app.conf", "data\n", "lf", "abc123");
    expect(invoke).toHaveBeenCalledWith("sftp_write_text", {
      sessionId: "sess",
      path: "/etc/app.conf",
      content: "data\n",
      eol: "lf",
      expectedSha256: "abc123",
    });
  });
});

describe("isFileChangedError", () => {
  it("matches the backend marker, ignores unrelated errors", () => {
    expect(api.isFileChangedError("file-changed: file modified on server")).toBe(true);
    expect(api.isFileChangedError(new Error("file-changed: x"))).toBe(true);
    expect(api.isFileChangedError("auth-rejected")).toBe(false);
    expect(api.isFileChangedError("some network error")).toBe(false);
  });
});

describe("remaining invoke wrappers", () => {
  it("forwards command name + args for every thin wrapper", async () => {
    invoke.mockResolvedValue(undefined);
    const cases: [Promise<unknown>, string, Record<string, unknown>][] = [
      [api.forgetSecrets("id1"), "forget_secrets", { id: "id1" }],
      [api.listFolders(), "list_folders", undefined as never],
      [api.readClipboardText(), "read_clipboard_text", undefined as never],
      [
        api.openLocalTerminal("s", 80, 24),
        "open_local_terminal",
        { sessionId: "s", cols: 80, rows: 24 },
      ],
      [api.deleteFolder("Prod"), "delete_folder", { path: "Prod" }],
      [api.connectPlan("id1"), "connect_plan", { id: "id1" }],
      [api.resizePty("s", 80, 24), "resize_pty", { sessionId: "s", cols: 80, rows: 24 }],
      [api.disconnect("s"), "disconnect", { sessionId: "s" }],
      [api.fetchMetrics("s"), "fetch_metrics", { sessionId: "s" }],
      [api.sftpHome("s"), "sftp_home", { sessionId: "s" }],
      [api.fetchMetricsDetail("s"), "fetch_metrics_detail", { sessionId: "s" }],
      [api.fetchPendingUpdates("s"), "fetch_pending_updates", { sessionId: "s" }],
      [api.sftpMkdir("s", "/d"), "sftp_mkdir", { sessionId: "s", path: "/d" }],
      [api.sftpCreateFile("s", "/f"), "sftp_create_file", { sessionId: "s", path: "/f" }],
      [
        api.annotateRecording("s", "edited /x"),
        "annotate_recording",
        { sessionId: "s", text: "edited /x" },
      ],
      [api.sftpDelete("s", "/d", true), "sftp_delete", { sessionId: "s", path: "/d", isDir: true }],
      [
        api.sftpUpload("s", "t", "/l", "/r"),
        "sftp_upload",
        { sessionId: "s", transferId: "t", localPath: "/l", remotePath: "/r" },
      ],
    ];
    for (const [call, name, args] of cases) {
      await call;
      if (args === undefined) expect(invoke).toHaveBeenCalledWith(name);
      else expect(invoke).toHaveBeenCalledWith(name, args);
    }
  });

  it("pickSavePath / pickSaveDir delegate to the native dialogs", async () => {
    save.mockResolvedValueOnce("/save/here.txt");
    expect(await api.pickSavePath("here.txt")).toBe("/save/here.txt");
    expect(save).toHaveBeenCalledWith({ defaultPath: "here.txt" });

    open.mockResolvedValueOnce("/dest/dir");
    expect(await api.pickSaveDir()).toBe("/dest/dir");
    open.mockResolvedValueOnce(null);
    expect(await api.pickSaveDir()).toBeNull();
  });
});

describe("backup wrappers", () => {
  it("exportBackup / importBackup pass the right command + args", async () => {
    invoke.mockResolvedValue(undefined);
    await api.exportBackup("/tmp/b.zip", "all", { theme: "nord" });
    expect(invoke).toHaveBeenCalledWith("export_backup", {
      path: "/tmp/b.zip",
      kind: "all",
      settings: { theme: "nord" },
    });

    invoke.mockResolvedValueOnce({
      kind: "all",
      servers: 2,
      folders: 1,
      recordings: 0,
      settings: null,
    });
    const res = await api.importBackup("/tmp/b.zip");
    expect(invoke).toHaveBeenCalledWith("import_backup", { path: "/tmp/b.zip" });
    expect(res.servers).toBe(2);
  });

  it("pickBackupSavePath / pickBackupFile use the archive-filtered dialogs", async () => {
    save.mockResolvedValueOnce("/out/vterm.zip");
    expect(await api.pickBackupSavePath("vterm-backup.zip")).toBe("/out/vterm.zip");
    expect(save).toHaveBeenCalledWith({
      defaultPath: "vterm-backup.zip",
      filters: [{ name: "vterm backup", extensions: ["zip"] }],
    });

    open.mockResolvedValueOnce("/in/vterm.zip");
    expect(await api.pickBackupFile()).toBe("/in/vterm.zip");
    open.mockResolvedValueOnce(null);
    expect(await api.pickBackupFile()).toBeNull();
  });

  it("importRecording / pickRecordingFile wrap the upload flow", async () => {
    invoke.mockResolvedValueOnce({ path: "/rec/x.cast", title: "x" });
    const meta = await api.importRecording("/src/x.cast");
    expect(invoke).toHaveBeenCalledWith("import_recording", { srcPath: "/src/x.cast" });
    expect(meta.path).toBe("/rec/x.cast");

    open.mockResolvedValueOnce("/src/y.cast");
    expect(await api.pickRecordingFile()).toBe("/src/y.cast");
    open.mockResolvedValueOnce(null);
    expect(await api.pickRecordingFile()).toBeNull();
  });
});

describe("event-name helpers", () => {
  it("mirror the Rust event format", () => {
    expect(api.outputEvent("s1")).toBe("term://out/s1");
    expect(api.closedEvent("s1")).toBe("term://closed/s1");
  });
});

describe("dialog helpers", () => {
  it("pickKeyFile returns the chosen path or null", async () => {
    open.mockResolvedValueOnce("/home/u/.ssh/id_ed25519");
    expect(await api.pickKeyFile()).toBe("/home/u/.ssh/id_ed25519");
    open.mockResolvedValueOnce(null);
    expect(await api.pickKeyFile()).toBeNull();
  });

  it("pickUploadFiles always returns an array", async () => {
    open.mockResolvedValueOnce(["/a", "/b"]);
    expect(await api.pickUploadFiles()).toEqual(["/a", "/b"]);
    open.mockResolvedValueOnce("/single");
    expect(await api.pickUploadFiles()).toEqual(["/single"]);
    open.mockResolvedValueOnce(null);
    expect(await api.pickUploadFiles()).toEqual([]);
  });
});
