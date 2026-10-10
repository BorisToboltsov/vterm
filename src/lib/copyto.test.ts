import { describe, expect, it } from "vitest";
import {
  copyTargets,
  defaultDestDir,
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
