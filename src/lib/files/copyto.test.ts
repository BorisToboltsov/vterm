import { describe, expect, it } from "vitest";
import {
  copyTargets,
  defaultDestDir,
  foreignTargets,
  MAX_SHARED_TARGETS,
  shareTargets,
  sideOf,
  targetsFrom,
  typedDir,
  type CopyTab,
} from "./copyto";

const tab = (sessionId: string, kind: "ssh" | "local", status = "Connected"): CopyTab => ({
  sessionId,
  kind,
  status,
});

describe("where a file can be copied to", () => {
  const tabs = [
    tab("web", "ssh"),
    tab("db", "ssh", "Connected (reconnected)"),
    tab("down", "ssh", "Disconnected"),
    tab("dialing", "ssh", "Connecting…"),
    tab("mine", "local"),
  ];
  const title = (t: CopyTab) => `tab ${t.sessionId}`;
  const prod = (id: string) => id === "db";

  it("offers every tab with a live session — a server's, or this machine's", () => {
    expect(copyTargets(tabs, title, prod)).toEqual([
      { sessionId: "web", title: "tab web", local: false, prod: false },
      { sessionId: "db", title: "tab db", local: false, prod: true },
      { sessionId: "mine", title: "tab mine", local: true, prod: false },
    ]);
  });

  it("offers none without a live tab", () => {
    expect(copyTargets([tab("a", "ssh", "auth-rejected")], title, prod)).toEqual([]);
    expect(copyTargets([], title, prod)).toEqual([]);
  });

  it("leaves the panel's own tab out", () => {
    const all = copyTargets(tabs, title, prod);
    expect(targetsFrom(all, "web").map((t) => t.sessionId)).toEqual(["db", "mine"]);
    expect(targetsFrom(all, null)).toHaveLength(3);
    // The only live tab is the source: nowhere to copy to.
    expect(targetsFrom(copyTargets([tab("web", "ssh")], title, prod), "web")).toEqual([]);
  });
});

describe("where it lands by default", () => {
  it("takes the folder the file panel shows, else the terminal's, else home", () => {
    expect(defaultDestDir("/srv/app", "/tmp", "/home/u")).toBe("/srv/app");
    expect(defaultDestDir(null, "/tmp", "/home/u")).toBe("/tmp");
    expect(defaultDestDir(null, null, "/home/u")).toBe("/home/u");
    expect(defaultDestDir(null, null, null)).toBeNull();
  });

  it("does not take a folder that names nothing", () => {
    expect(defaultDestDir("", "/tmp", null)).toBe("/tmp");
    // "." is the panel before its first listing, not a place.
    expect(defaultDestDir(".", null, "/home/u")).toBe("/home/u");
  });

  it("reads the folder as typed", () => {
    expect(typedDir("  /srv/app ")).toBe("/srv/app");
    expect(typedDir("   ")).toBeNull();
    expect(typedDir("")).toBeNull();
  });
});

describe("the side of a transfer a tab stands for", () => {
  it("carries the session, whether it is this machine, and what the tab is called", () => {
    expect(sideOf({ sessionId: "web", local: false, title: "web-01" })).toEqual({
      session: "web",
      local: false,
      label: "web-01",
    });
    expect(sideOf({ sessionId: "l1", local: true, title: "Local shell" })).toEqual({
      session: "l1",
      local: true,
      label: "Local shell",
    });
  });
});

describe("sessions of the other windows", () => {
  const mine = [{ sessionId: "web", title: "web-01", local: false, prod: false }];
  const theirs = [
    { sessionId: "db", title: "db-01", local: false, prod: true },
    { sessionId: "sh", title: "Local shell", local: true, prod: false },
  ];
  const heard = [
    { window: "main", targets: mine },
    { window: "win-2", targets: theirs },
  ];

  it("a window tells the others what its menu shows — and nothing else", () => {
    expect(shareTargets([{ ...mine[0], window: "win-9" }])).toEqual(mine);
  });

  it("are offered with the window that shows them; this window's own are left out", () => {
    expect(foreignTargets(heard, "main")).toEqual([
      { ...theirs[0], window: "win-2" },
      { ...theirs[1], window: "win-2" },
    ]);
    expect(foreignTargets(heard, "win-2")).toEqual([{ ...mine[0], window: "main" }]);
    // What a window shares comes back whole: said by one, read by another.
    expect(foreignTargets([{ window: "win-2", targets: shareTargets(theirs) }], "main")).toHaveLength(2);
  });

  it("are read, not trusted: what is not a whole target is left out", () => {
    expect(foreignTargets(null, "main")).toEqual([]);
    expect(foreignTargets({ window: "win-2", targets: theirs }, "main")).toEqual([]);
    const junk = [
      null,
      { window: 2, targets: theirs },
      { window: "win-2", targets: "all" },
      {
        window: "win-3",
        targets: [
          null,
          { sessionId: "", title: "x", local: false, prod: false },
          { sessionId: "a", title: 1, local: false, prod: false },
          { sessionId: "a", title: "x", local: "no", prod: false },
          { sessionId: "a", title: "x", local: false },
          { sessionId: "ok", title: "fine", local: false, prod: false, extra: "ignored" },
        ],
      },
    ];
    expect(foreignTargets(junk, "main")).toEqual([
      { sessionId: "ok", title: "fine", local: false, prod: false, window: "win-3" },
    ]);
  });

  it("no window is taken at its word for more than a menu can hold", () => {
    const many = Array.from({ length: MAX_SHARED_TARGETS + 50 }, (_, i) => ({
      sessionId: `s${i}`, title: `t${i}`, local: false, prod: false,
    }));
    expect(foreignTargets([{ window: "win-2", targets: many }], "main")).toHaveLength(
      MAX_SHARED_TARGETS,
    );
  });
});
