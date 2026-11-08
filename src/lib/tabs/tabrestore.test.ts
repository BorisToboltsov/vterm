import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addTab, emptyLayout, layoutProblems, loadLayout, splitWithTab } from "../layout/splitlayout";
import type { Tab } from "../stores/tabs.svelte";
import {
  DEFAULT_RESTORE_MODE,
  isRestoreMode,
  MAX_SAVED_TABS,
  otherSlotKeys,
  parseSavedWindow,
  RESTORE_MODES,
  restoreSaved,
  SAVE_VERSION,
  isAbsolutePath,
  keepsDoc,
  MAX_SAVED_DOCS,
  savedTab,
  savedWindow,
  slotKey,
  waitReason,
  waitView,
  windowRecord,
  withWindows,
  type SavedTab,
  type TabFacts,
  type WaitFacts,
} from "./tabrestore";
import type { EditorDoc } from "../stores/workspaces.svelte";

const tab = (over: Partial<Tab> = {}): Tab => ({
  sessionId: "s1",
  kind: "ssh",
  serverId: "srv",
  alias: "web-1",
  secret: null,
  remember: false,
  status: "Connected",
  gen: 0,
  ...over,
});

const ATTACH = {
  kind: "container" as const,
  name: "nginx",
  image: "nginx:1.27",
  argv: ["docker", "exec", "-it", "nginx", "sh"],
};

/** A slot as a window would have written it, after the trip through JSON. */
const slot = (tabs: Tab[]): unknown => {
  let layout = emptyLayout();
  for (const t of tabs) layout = addTab(layout, t.sessionId);
  return JSON.parse(JSON.stringify(savedWindow(tabs, layout)));
};

describe("the setting", () => {
  it("has three modes, and waiting for the button is the default", () => {
    expect(RESTORE_MODES).toEqual(["off", "manual", "connect"]);
    expect(DEFAULT_RESTORE_MODE).toBe("manual");
    expect(isRestoreMode("connect")).toBe(true);
    for (const junk of ["", "auto", null, undefined, 1, {}]) expect(isRestoreMode(junk)).toBe(false);
  });
});

describe("what is written down of a tab", () => {
  it("is what it was and nothing about its session", () => {
    const saved = savedTab(
      tab({ secret: "hunter2", remember: true, status: "Connected", gen: 4, attach: ATTACH }),
    );
    expect(saved).toEqual({ id: "s1", kind: "ssh", serverId: "srv", alias: "web-1", attach: ATTACH });
  });

  it("never carries the secret, whatever else the tab holds", () => {
    const loaded = tab({
      secret: "hunter2",
      remember: true,
      waiting: "prod",
      adopt: {
        cols: 80,
        rows: 24,
        data: "\u001b[31mprinted with hunter2",
        commands: ["export TOKEN=hunter2"],
        lines: 24,
        fileBlocks: [{ line: 0, cwd: "/home/hunter2" }],
      },
    });
    const json = JSON.stringify(savedWindow([loaded], addTab(emptyLayout(), "s1")));
    expect(json).not.toContain("hunter2");
    expect(Object.keys(JSON.parse(json).tabs[0]).sort()).toEqual(["alias", "id", "kind", "serverId"]);
  });

  it("a local tab has no server", () => {
    expect(savedTab(tab({ kind: "local", serverId: "left-over", alias: "Local shell" })).serverId).toBe("");
  });

  it("the attachment is copied, not shared", () => {
    const saved = savedTab(tab({ attach: ATTACH }));
    expect(saved.attach).toEqual(ATTACH);
    expect(saved.attach).not.toBe(ATTACH);
    expect(saved.attach?.argv).not.toBe(ATTACH.argv);
  });

  it("a window's slot holds its tabs and the layout of its centre", () => {
    const tabs = [tab(), tab({ sessionId: "s2", kind: "local", serverId: "" })];
    const layout = splitWithTab(addTab(addTab(emptyLayout(), "s1"), "s2"), "s2", "p0", "right");
    const saved = savedWindow(tabs, layout);
    expect(saved.v).toBe(SAVE_VERSION);
    expect(saved.tabs.map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(saved.layout).toEqual({ root: layout.root, focus: layout.focus });
  });
});

describe("the slots", () => {
  it("every window has its own", () => {
    expect(slotKey("main")).toBe("vterm.tabs:main");
    expect(slotKey("win-2")).toBe("vterm.tabs:win-2");
  });

  it("the other windows' slots are told apart from everything else in storage", () => {
    const keys = ["vterm.settings", "vterm.tabs:win-3", "vterm.layout", "vterm.tabs:main", "vterm.tabs:win-2"];
    expect(otherSlotKeys(keys, slotKey("main"))).toEqual(["vterm.tabs:win-2", "vterm.tabs:win-3"]);
    expect(otherSlotKeys(keys, slotKey("win-2"))).toEqual(["vterm.tabs:main", "vterm.tabs:win-3"]);
  });
});

describe("reading a slot back", () => {
  it("takes what a window wrote", () => {
    const tabs = [tab(), tab({ sessionId: "s2", attach: ATTACH })];
    const read = parseSavedWindow(slot(tabs));
    expect(read?.tabs).toEqual(tabs.map((t) => savedTab(t)));
  });

  it("is not a slot: another version, no tab list, not an object", () => {
    expect(parseSavedWindow(null)).toBeNull();
    expect(parseSavedWindow("tabs")).toBeNull();
    expect(parseSavedWindow([])).toBeNull();
    expect(parseSavedWindow({ v: SAVE_VERSION + 1, tabs: [] })).toBeNull();
    expect(parseSavedWindow({ v: SAVE_VERSION, tabs: "none" })).toBeNull();
  });

  it("leaves out a tab it cannot read, keeps the rest", () => {
    const good = savedTab(tab());
    const read = parseSavedWindow({
      v: SAVE_VERSION,
      layout: null,
      tabs: [
        good,
        null,
        "tab",
        { ...good, id: "" },
        { ...good, id: "has space" },
        { ...good, id: "x".repeat(65) },
        { ...good, id: "s3", kind: "serial" },
        { ...good, id: "s4", serverId: "" },
        { ...good, id: "s5", serverId: 12 },
        { ...good, id: "s6", serverId: "line\nbreak" },
      ],
    });
    expect(read?.tabs).toEqual([good]);
  });

  it("an id that could not be part of an event name is not a tab", () => {
    for (const id of ["a/b", "a:b", "term://out", "ünï", "a.b"]) {
      expect(parseSavedWindow({ v: SAVE_VERSION, tabs: [{ ...savedTab(tab()), id }] })?.tabs).toEqual([]);
    }
    expect(parseSavedWindow({ v: SAVE_VERSION, tabs: [savedTab(tab({ sessionId: crypto.randomUUID() }))] })?.tabs).toHaveLength(1);
  });

  it("a tab saved twice comes back once", () => {
    const good = savedTab(tab());
    expect(parseSavedWindow({ v: SAVE_VERSION, tabs: [good, { ...good, alias: "copy" }] })?.tabs).toEqual([good]);
  });

  it("an alias that cannot be shown is dropped, the tab stays", () => {
    const read = parseSavedWindow({ v: SAVE_VERSION, tabs: [{ ...savedTab(tab()), alias: ["web"] }] });
    expect(read?.tabs[0].alias).toBe("");
  });

  it("a local tab's server id is not read", () => {
    const read = parseSavedWindow({
      v: SAVE_VERSION,
      tabs: [{ id: "l1", kind: "local", serverId: { not: "a string" }, alias: "Local shell" }],
    });
    expect(read?.tabs).toEqual([{ id: "l1", kind: "local", serverId: "", alias: "Local shell" }]);
  });

  it("a damaged attachment takes its tab with it — it is never repaired into a host shell", () => {
    const base = savedTab(tab());
    const broken: unknown[] = [
      "docker exec",
      { ...ATTACH, kind: "vm" },
      { ...ATTACH, name: "" },
      { ...ATTACH, argv: [] },
      { ...ATTACH, argv: "docker exec -it nginx sh" },
      { ...ATTACH, argv: ["docker", 7] },
      { ...ATTACH, argv: ["docker", ""] },
      { ...ATTACH, argv: ["docker", "exec\nrm -rf /"] },
      { ...ATTACH, argv: ["sh", "-c", "x".repeat(5000)] },
      { ...ATTACH, argv: Array.from({ length: 65 }, () => "a") },
      { ...ATTACH, image: 5 },
      { ...ATTACH, container: "a\u0007b" },
    ];
    for (const attach of broken) {
      expect(parseSavedWindow({ v: SAVE_VERSION, tabs: [{ ...base, attach }] })?.tabs, JSON.stringify(attach)).toEqual([]);
    }
  });

  it("reads no more tabs than a window could have had", () => {
    const many = Array.from({ length: MAX_SAVED_TABS + 50 }, (_, i) => savedTab(tab({ sessionId: `s${i}` })));
    expect(parseSavedWindow({ v: SAVE_VERSION, tabs: many })?.tabs).toHaveLength(MAX_SAVED_TABS);
  });

  it("whatever a slot holds, what is read is tabs this build could have written", () => {
    fc.assert(
      fc.property(fc.anything(), fc.array(fc.anything(), { maxLength: 8 }), (junk, tabs) => {
        for (const raw of [junk, { v: SAVE_VERSION, tabs, layout: junk }]) {
          const read = parseSavedWindow(raw);
          if (!read) continue;
          for (const t of read.tabs) {
            expect(t.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
            expect(["ssh", "local"]).toContain(t.kind);
            expect(typeof t.serverId).toBe("string");
            expect(typeof t.alias).toBe("string");
            const known = ["id", "kind", "serverId", "alias", "attach", "shellCwd", "dock", "docs", "views"];
            expect(Object.keys(t).every((k) => known.includes(k))).toBe(true);
            if (t.shellCwd !== undefined) expect(isAbsolutePath(t.shellCwd)).toBe(true);
            for (const d of t.docs ?? []) expect(isAbsolutePath(d.path)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("what the main window restores", () => {
  const known = (id: string) => id === "srv";

  it("its own tabs, in the layout they stood in", () => {
    const tabs = [tab(), tab({ sessionId: "s2", kind: "local", serverId: "" })];
    const restored = restoreSaved(slot(tabs), [], known);
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(restored.missing).toBe(0);
    const layout = loadLayout(restored.layout, restored.tabs.map((t) => t.id));
    expect(layoutProblems(layout, ["s1", "s2"])).toEqual([]);
  });

  it("the windows that were open beside it come back with their tabs (v1.36)", () => {
    const restored = restoreSaved(
      slot([tab()]),
      [
        { label: "win-2", raw: slot([tab({ sessionId: "w1" })]) },
        { label: "win-3", raw: null },
        { label: "win-4", raw: slot([tab({ sessionId: "w2", kind: "local", serverId: "" })]) },
      ],
      known,
    );
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1"]);
    // A slot with nothing to bring back opens no window.
    expect(restored.windows.map((w) => [w.label, w.window.tabs.map((t) => t.id)])).toEqual([
      ["win-2", ["w1"]],
      ["win-4", ["w2"]],
    ]);
  });

  it("a window that does not open again gives its tabs to the main one", () => {
    const restored = restoreSaved(
      slot([tab()]),
      [
        { label: "win-2", raw: slot([tab({ sessionId: "w1" })]) },
        { label: "win-4", raw: slot([tab({ sessionId: "w2", kind: "local", serverId: "" })]) },
      ],
      known,
    );
    expect(withWindows(restored, ["win-2", "win-4"]).map((t) => t.id)).toEqual(["s1"]);
    const all = withWindows(restored, ["win-2"]).map((t) => t.id);
    expect(all).toEqual(["s1", "w2"]);
    // They stand in no pane of the main window's layout: they join the one in focus.
    const layout = loadLayout(restored.layout, all);
    expect(layoutProblems(layout, all)).toEqual([]);
  });

  it("a reopened window is handed its slot as the main window read it", () => {
    const tabs = [tab({ sessionId: "w1" }), tab({ sessionId: "w2", kind: "local", serverId: "" })];
    const restored = restoreSaved(null, [{ label: "win-2", raw: slot(tabs) }], known);
    const record = windowRecord(restored.windows[0].window);
    const again = restoreSaved(JSON.parse(record), [], known);
    expect(again.tabs).toEqual(tabs.map((t) => savedTab(t)));
    expect(layoutProblems(loadLayout(again.layout, ["w1", "w2"]), ["w1", "w2"])).toEqual([]);
  });

  it("a tab whose server is gone is counted, not restored", () => {
    const restored = restoreSaved(
      slot([tab(), tab({ sessionId: "s2", serverId: "deleted" }), tab({ sessionId: "s3", kind: "local", serverId: "" })]),
      [{ label: "win-2", raw: slot([tab({ sessionId: "w1", serverId: "deleted-too" })]) }],
      known,
    );
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1", "s3"]);
    expect(restored.windows).toEqual([]);
    expect(restored.missing).toBe(2);
  });

  it("a tab that two windows both wrote down comes back once", () => {
    // A tab on its way between windows may be in both slots for a moment.
    const restored = restoreSaved(slot([tab()]), [{ label: "win-2", raw: slot([tab(), tab({ sessionId: "w1" })]) }], known);
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1"]);
    expect(restored.windows[0].window.tabs.map((t) => t.id)).toEqual(["w1"]);
  });

  it("nothing saved is nothing to restore", () => {
    const none = { tabs: [], layout: null, beforeTile: null, windows: [], missing: 0 };
    expect(restoreSaved(null, [], known)).toEqual(none);
    expect(restoreSaved("junk", [{ label: "win-2", raw: 42 }, { label: "win-3", raw: {} }], known)).toEqual(none);
  });
});

describe("where a tab was (v1.36)", () => {
  const doc = (over: Partial<EditorDoc> = {}): EditorDoc => ({
    id: "d1",
    source: "sftp",
    path: "/etc/nginx/nginx.conf",
    name: "nginx.conf",
    lang: { kind: "plain" } as EditorDoc["lang"],
    content: "user www-data; # with the token hunter2",
    baseContent: "user www-data;",
    baseSha256: "abc",
    eol: "lf",
    encoding: "utf-8",
    mode: null,
    readOnly: false,
    writeAccess: "writable",
    saveIssue: "none",
    loading: false,
    loadError: null,
    sudo: false,
    sudoPassword: "",
    gotoLine: null,
    ...over,
  });
  const views = addTab(addTab(addTab(emptyLayout(), "terminal"), "d1"), "d2");
  const facts = (over: Partial<TabFacts> = {}): TabFacts => ({
    shellCwd: "/srv/app",
    dock: {
      cwd: "/srv/app/logs",
      files: { connected: true, cwd: "/srv/app", home: "/home/deploy" },
      k8sScope: { context: "prod-eu", namespace: "shop", allNamespaces: false },
    },
    workspace: { editors: [doc(), doc({ id: "d2", path: "/etc/hosts", name: "hosts" })], layout: views },
    ...over,
  });

  it("the folders, the k8s scope and the files go with the tab — never what the files hold", () => {
    const saved = savedTab(tab(), facts());
    expect(saved.shellCwd).toBe("/srv/app");
    expect(saved.dock).toEqual({
      cwd: "/srv/app/logs",
      files: { cwd: "/srv/app", home: "/home/deploy" },
      k8s: { context: "prod-eu", namespace: "shop", allNamespaces: false },
    });
    expect(saved.docs).toEqual([
      { id: "d1", source: "sftp", path: "/etc/nginx/nginx.conf", name: "nginx.conf" },
      { id: "d2", source: "sftp", path: "/etc/hosts", name: "hosts" },
    ]);
    expect(saved.views).toEqual({ root: views.root, focus: views.focus });
    expect(JSON.stringify(saved)).not.toContain("hunter2");
  });

  it("a file opened through sudo, a diff against a commit and an unsaved buffer stay behind", () => {
    const editors = [
      doc({ id: "a", sudo: true, sudoPassword: "hunter2" }),
      doc({ id: "b", gitBase: "old text" }),
      doc({ id: "c", path: "script.sh", name: "script.sh", baseSha256: "" }),
      doc({ id: "d", source: "local", path: "C:\\Users\\me\\notes.txt", name: "notes.txt" }),
    ];
    const saved = savedTab(tab(), facts({ workspace: { editors, layout: views } }));
    expect(saved.docs?.map((d) => d.id)).toEqual(["d"]);
    expect(JSON.stringify(saved)).not.toContain("hunter2");
    expect(keepsDoc(doc({ sudo: true }))).toBe(false);
    // Nothing worth reopening: neither files nor zones are written.
    const none = savedTab(tab(), facts({ workspace: { editors: [editors[0]], layout: views } }));
    expect(none.docs).toBeUndefined();
    expect(none.views).toBeUndefined();
  });

  it("a file panel that was not connected keeps its folder for Git, not its own", () => {
    const saved = savedTab(tab(), facts({ dock: { cwd: "/srv", files: null, k8sScope: null } }));
    expect(saved.dock).toEqual({ cwd: "/srv" });
    expect(savedTab(tab(), facts({ dock: { cwd: null, files: null, k8sScope: null } })).dock).toBeUndefined();
  });

  it("a shell inside a container keeps none of its folders: they are the container's", () => {
    const saved = savedTab(tab({ attach: ATTACH }), facts());
    expect(saved.shellCwd).toBeUndefined();
    expect(saved.dock).toBeUndefined();
  });

  it("comes back as it was written", () => {
    const tabs = [tab()];
    const layout = addTab(emptyLayout(), "s1");
    const raw = JSON.parse(JSON.stringify(savedWindow(tabs, layout, () => facts())));
    expect(parseSavedWindow(raw)?.tabs).toEqual([savedTab(tab(), facts())]);
  });

  it("a damaged part is left out and the tab still comes back", () => {
    const good = savedTab(tab(), facts());
    const broken: Record<string, unknown>[] = [
      { shellCwd: "relative/dir" },
      { shellCwd: "/srv/a\nrm -rf /" },
      { shellCwd: 42 },
      { dock: { cwd: "~/logs", files: { cwd: "/srv", home: 5 }, k8s: { context: "", namespace: null, allNamespaces: false } } },
      { docs: [{ id: "has space", source: "sftp", path: "/etc/hosts", name: "hosts" }] },
      { docs: [{ id: "d9", source: "ftp", path: "/etc/hosts", name: "hosts" }] },
      { docs: [{ id: "d9", source: "sftp", path: "etc/hosts", name: "hosts" }] },
      { docs: "all of them" },
    ];
    for (const part of broken) {
      const read = parseSavedWindow({ v: SAVE_VERSION, tabs: [{ ...good, ...part }] })?.tabs;
      expect(read, JSON.stringify(part)).toHaveLength(1);
      const back = read![0];
      if ("shellCwd" in part) expect(back.shellCwd).toBeUndefined();
      if ("docs" in part) expect(back.docs).toBeUndefined();
      if ("dock" in part) expect(back.dock).toBeUndefined();
    }
  });

  it("a file listed twice comes back once, and no more files than a connection reopens", () => {
    const d = { id: "d1", source: "sftp", path: "/etc/hosts", name: "hosts" };
    const twice = parseSavedWindow({ v: SAVE_VERSION, tabs: [{ ...savedTab(tab()), docs: [d, { ...d, id: "d2" }, d] }] });
    expect(twice?.tabs[0].docs).toEqual([d]);
    const many = Array.from({ length: MAX_SAVED_DOCS + 5 }, (_, i) => ({ ...d, id: `d${i}`, path: `/etc/f${i}` }));
    const read = parseSavedWindow({ v: SAVE_VERSION, tabs: [{ ...savedTab(tab()), docs: many }] });
    expect(read?.tabs[0].docs).toHaveLength(MAX_SAVED_DOCS);
  });

  it("a grid is written with the layout to go back to, and read back as written", () => {
    const layout = addTab(addTab(emptyLayout(), "s1"), "s2");
    const before = { root: layout.root, focus: layout.focus };
    const saved = savedWindow([tab(), tab({ sessionId: "s2" })], layout, undefined, before);
    expect(saved.beforeTile).toEqual(before);
    expect(parseSavedWindow(JSON.parse(JSON.stringify(saved)))?.beforeTile).toEqual(before);
    expect(savedWindow([tab()], layout).beforeTile).toBeUndefined();
  });

  it("an absolute path is POSIX, a drive or a share — a buffer's bare name is not", () => {
    for (const p of ["/", "/srv/app", "C:\\", "d:/data", "\\\\nas\\share"]) expect(isAbsolutePath(p), p).toBe(true);
    for (const p of ["", "script.sh", "./x", "~/x", "C:", "srv/app"]) expect(isAbsolutePath(p), p).toBe(false);
  });
});

describe("which restored tabs open their session at once", () => {
  const ssh: WaitFacts = { kind: "ssh", attach: false, prod: false, needsSecret: false };
  const local: WaitFacts = { kind: "local", attach: false, prod: false, needsSecret: null };

  it("none, while the setting says they wait for their button", () => {
    expect(waitReason("manual", ssh)).toBe("manual");
    expect(waitReason("manual", local)).toBe("manual");
    expect(waitReason("manual", { ...ssh, prod: true })).toBe("manual");
  });

  it("with connecting on: a local shell, and a server that asks nothing", () => {
    expect(waitReason("connect", local)).toBeNull();
    expect(waitReason("connect", ssh)).toBeNull();
  });

  it("a production server never connects by itself", () => {
    expect(waitReason("connect", { ...ssh, prod: true })).toBe("prod");
    // Not even before anyone looked at its secret: prod is decided first.
    expect(waitReason("connect", { ...ssh, prod: true, needsSecret: null })).toBe("prod");
  });

  it("a server that would ask for a secret waits; one not asked about yet is being checked", () => {
    expect(waitReason("connect", { ...ssh, needsSecret: true })).toBe("secret");
    expect(waitReason("connect", { ...ssh, needsSecret: null })).toBe("checking");
  });

  it("a container tab waits in every mode — entering it runs a command", () => {
    for (const mode of RESTORE_MODES) {
      expect(waitReason(mode, { ...ssh, attach: true })).toBe("attach");
      expect(waitReason(mode, { ...local, attach: true })).toBe("attach");
    }
  });

  it("no combination opens a production server, a container or a server that asks", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESTORE_MODES),
        fc.record<WaitFacts>({
          kind: fc.constantFrom("ssh", "local"),
          attach: fc.boolean(),
          prod: fc.boolean(),
          needsSecret: fc.option(fc.boolean(), { nil: null }),
        }),
        (mode, f) => {
          if (waitReason(mode, f) !== null) return;
          expect(mode).toBe("connect");
          expect(f.attach).toBe(false);
          if (f.kind === "ssh") {
            expect(f.prod).toBe(false);
            expect(f.needsSecret).toBe(false);
          }
        },
      ),
    );
  });
});

describe("what the place of a waiting tab says", () => {
  const sshTab = { kind: "ssh" as const };

  it("a server: why it waits, and the button that connects", () => {
    expect(waitView("manual", sshTab)).toEqual({ icon: "server", hint: "restore.hintManual", action: "common.connect" });
    expect(waitView("prod", sshTab).hint).toBe("restore.hintProd");
    expect(waitView("secret", sshTab).hint).toBe("restore.hintSecret");
  });

  it("nothing to press while it is being checked", () => {
    expect(waitView("checking", sshTab)).toEqual({ icon: "server", hint: "restore.hintChecking", action: null });
  });

  it("a local shell is started, not connected", () => {
    expect(waitView("manual", { kind: "local" })).toEqual({
      icon: "terminal",
      hint: "restore.hintLocal",
      action: "restore.startShell",
    });
  });

  it("a container and a pod are entered, whatever the reason says", () => {
    const container: SavedTab["attach"] = ATTACH;
    expect(waitView("attach", { kind: "ssh", attach: container })).toEqual({
      icon: "container",
      hint: "restore.hintContainer",
      action: "restore.enter",
    });
    expect(waitView("manual", { kind: "local", attach: { kind: "pod" } })).toEqual({
      icon: "kubernetes",
      hint: "restore.hintPod",
      action: "restore.enter",
    });
  });
});
