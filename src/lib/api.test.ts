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

  it("AI wrappers (Phase 17): aiChat / setAiKey / forgetAiKey", async () => {
    const req = {
      streamId: "s1",
      endpointId: "e1",
      provider: "openai" as const,
      baseUrl: "http://h/v1",
      model: "qwen",
      messages: [{ role: "user" as const, content: "hi" }],
    };
    await api.aiChat(req);
    expect(invoke).toHaveBeenCalledWith("ai_chat", { req });
    await api.setAiKey("e1", "sk-x");
    expect(invoke).toHaveBeenCalledWith("set_ai_key", { endpointId: "e1", key: "sk-x" });
    await api.forgetAiKey("e1");
    expect(invoke).toHaveBeenCalledWith("forget_ai_key", { endpointId: "e1" });
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

  it("local file editor commands", async () => {
    await api.readLocalText("/home/me/notes.md", 2097152);
    expect(invoke).toHaveBeenCalledWith("read_local_text", {
      path: "/home/me/notes.md",
      maxBytes: 2097152,
    });
    await api.writeLocalText("/home/me/notes.md", "hi\n", "lf", "sha9");
    expect(invoke).toHaveBeenCalledWith("write_local_text", {
      path: "/home/me/notes.md",
      content: "hi\n",
      eol: "lf",
      expectedSha256: "sha9",
    });
    await api.takePendingOpens();
    expect(invoke).toHaveBeenCalledWith("take_pending_opens");
  });

  it("local filesystem browser commands", async () => {
    await api.localHome();
    expect(invoke).toHaveBeenCalledWith("local_home");
    await api.localList("/home/me");
    expect(invoke).toHaveBeenCalledWith("local_list", { path: "/home/me" });
    await api.localMkdir("/home/me/new");
    expect(invoke).toHaveBeenCalledWith("local_mkdir", { path: "/home/me/new" });
    await api.localCreateFile("/home/me/f.txt");
    expect(invoke).toHaveBeenCalledWith("local_create_file", { path: "/home/me/f.txt" });
    await api.localDelete("/home/me/old", true);
    expect(invoke).toHaveBeenCalledWith("local_delete", { path: "/home/me/old", isDir: true });
  });

  it("directory sync commands", async () => {
    invoke.mockResolvedValue([]);
    await api.sftpHashTree("sess", "/srv/app");
    expect(invoke).toHaveBeenCalledWith("sftp_hash_tree", { sessionId: "sess", path: "/srv/app" });
    await api.localHashTree("/home/me/app");
    expect(invoke).toHaveBeenCalledWith("local_hash_tree", { path: "/home/me/app" });
    const actions = [{ path: "a.txt", op: "upload" as const, reason: "new" as const }];
    await api.sftpSyncApply("sess", "/home/me/app", "/srv/app", actions);
    expect(invoke).toHaveBeenCalledWith("sftp_sync_apply", {
      sessionId: "sess",
      localRoot: "/home/me/app",
      remoteRoot: "/srv/app",
      actions,
    });
    await api.sftpGrep("sess", "/srv", "TODO", true, false);
    expect(invoke).toHaveBeenCalledWith("sftp_grep", {
      sessionId: "sess",
      dir: "/srv",
      query: "TODO",
      caseInsensitive: true,
      fixed: false,
    });
    await api.lintRemote("sess", "key: val\n", "yaml");
    expect(invoke).toHaveBeenCalledWith("lint_remote", {
      sessionId: "sess",
      content: "key: val\n",
      kind: "yaml",
    });
  });

  it("server tools commands", async () => {
    await api.serverToolsStatus("sess");
    expect(invoke).toHaveBeenCalledWith("server_tools_status", { sessionId: "sess" });
    await api.runToolInstall("sess", "sudo apt-get install -y shellcheck", "pw");
    expect(invoke).toHaveBeenCalledWith("run_tool_install", {
      sessionId: "sess",
      command: "sudo apt-get install -y shellcheck",
      sudoPassword: "pw",
    });
  });

  it("sftpReadText/WriteText forward sudo + backup options", async () => {
    await api.sftpReadText("s", "/etc/sudoers", 2048, true, "pw");
    expect(invoke).toHaveBeenCalledWith("sftp_read_text", {
      sessionId: "s",
      path: "/etc/sudoers",
      maxBytes: 2048,
      sudo: true,
      sudoPassword: "pw",
    });
    await api.sftpWriteText("s", "/etc/hosts", "x\n", "lf", "sha", {
      sudo: true,
      sudoPassword: "pw",
      backup: true,
    });
    expect(invoke).toHaveBeenCalledWith("sftp_write_text", {
      sessionId: "s",
      path: "/etc/hosts",
      content: "x\n",
      eol: "lf",
      expectedSha256: "sha",
      sudo: true,
      sudoPassword: "pw",
      backup: true,
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

describe("isPermissionError", () => {
  it("matches permission-denied and no-such-file (the staging-temp quirk)", () => {
    expect(api.isPermissionError("open /etc/x: Permission denied")).toBe(true);
    expect(api.isPermissionError("write /etc/.hostname.vterm-tmp-1: No such file: No such file")).toBe(
      true,
    );
    expect(api.isPermissionError(new Error("Permission denied (3)"))).toBe(true);
    expect(api.isPermissionError("connection reset")).toBe(false);
    expect(api.isPermissionError("file-changed")).toBe(false);
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
      [api.fetchExtras("s"), "fetch_extras", { sessionId: "s" }],
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
