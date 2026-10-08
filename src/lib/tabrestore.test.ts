import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addTab, emptyLayout, layoutProblems, loadLayout, splitWithTab } from "./splitlayout";
import type { Tab } from "./stores/tabs.svelte";
import {
  DEFAULT_RESTORE_MODE,
  isRestoreMode,
  MAX_SAVED_TABS,
  otherSlotKeys,
  parseSavedWindow,
  RESTORE_MODES,
  restoreSaved,
  SAVE_VERSION,
  savedTab,
  savedWindow,
  slotKey,
  waitReason,
  waitView,
  type SavedTab,
  type WaitFacts,
} from "./tabrestore";

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
      adopt: { cols: 80, rows: 24, data: "\u001b[31mprinted with hunter2", commands: ["export TOKEN=hunter2"] },
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
    expect(read?.tabs).toEqual(tabs.map(savedTab));
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
            expect(Object.keys(t).every((k) => ["id", "kind", "serverId", "alias", "attach"].includes(k))).toBe(true);
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

  it("the tabs of the windows that were open beside it come back to it", () => {
    const restored = restoreSaved(
      slot([tab()]),
      [slot([tab({ sessionId: "w1" })]), null, slot([tab({ sessionId: "w2", kind: "local", serverId: "" })])],
      known,
    );
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1", "w1", "w2"]);
    // They stand in no pane of the main window's layout: they join the one in focus.
    const layout = loadLayout(restored.layout, restored.tabs.map((t) => t.id));
    expect(layoutProblems(layout, ["s1", "w1", "w2"])).toEqual([]);
  });

  it("with no slot of its own it still takes in the other windows' tabs", () => {
    const restored = restoreSaved(null, [slot([tab({ sessionId: "w1" })])], known);
    expect(restored.tabs.map((t) => t.id)).toEqual(["w1"]);
    expect(restored.layout).toBeNull();
  });

  it("a tab whose server is gone is counted, not restored", () => {
    const restored = restoreSaved(
      slot([tab(), tab({ sessionId: "s2", serverId: "deleted" }), tab({ sessionId: "s3", kind: "local", serverId: "" })]),
      [slot([tab({ sessionId: "w1", serverId: "deleted-too" })])],
      known,
    );
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1", "s3"]);
    expect(restored.missing).toBe(2);
  });

  it("a tab that two windows both wrote down comes back once", () => {
    // A tab on its way between windows may be in both slots for a moment.
    const restored = restoreSaved(slot([tab()]), [slot([tab(), tab({ sessionId: "w1" })])], known);
    expect(restored.tabs.map((t) => t.id)).toEqual(["s1", "w1"]);
  });

  it("nothing saved is nothing to restore", () => {
    expect(restoreSaved(null, [], known)).toEqual({ tabs: [], layout: null, missing: 0 });
    expect(restoreSaved("junk", [42, {}], known)).toEqual({ tabs: [], layout: null, missing: 0 });
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
