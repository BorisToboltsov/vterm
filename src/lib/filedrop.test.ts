import { describe, expect, it } from "vitest";
import {
  describeFiles,
  desktopFiles,
  dropMeaning,
  MAX_RELAYED,
  pagePoint,
  parseFileDragMessage,
  parseFiles,
  sameTarget,
  SPRING_MS,
  type CarriedFiles,
  type DropTab,
  type FileTarget,
} from "./filedrop";

const entry = (name: string, isDir = false) => ({ path: `/etc/${name}`, name, isDir });
const from = (session: string | null, local = false): CarriedFiles => ({
  from: session,
  local,
  label: session ?? "",
  entries: [entry("a.conf"), entry("conf.d", true)],
});
const tabs: DropTab[] = [
  { sessionId: "web", kind: "ssh", connected: true },
  { sessionId: "db", kind: "ssh", connected: true },
  { sessionId: "down", kind: "ssh", connected: false },
  { sessionId: "mine", kind: "local", connected: true },
];
const folder = (session: string, dir = "/srv"): FileTarget => ({ kind: "folder", session, dir });
const whole = (session: string): FileTarget => ({ kind: "session", session });

describe("what a drop of files means", () => {
  it("inside the panel they came from it is the move that panel always did", () => {
    expect(dropMeaning(from("web"), folder("web", "/etc/conf.d"), tabs)).toEqual({
      kind: "move",
      session: "web",
      dir: "/etc/conf.d",
    });
  });

  it("back onto their own tab or terminal it is nothing", () => {
    expect(dropMeaning(from("web"), whole("web"), tabs)).toBeNull();
  });

  it("between two sessions it is always a copy — into the folder under the pointer", () => {
    expect(dropMeaning(from("web"), folder("db", "/srv/backup"), tabs)).toEqual({
      kind: "copy",
      to: "db",
      dir: "/srv/backup",
    });
    // From a server onto this machine, and back, alike.
    expect(dropMeaning(from("web"), folder("mine", "/Users/me"), tabs)?.kind).toBe("copy");
    expect(dropMeaning(from("mine", true), folder("web"), tabs)?.kind).toBe("copy");
  });

  it("onto a session as a whole the folder is asked for", () => {
    expect(dropMeaning(from("web"), whole("db"), tabs)).toEqual({ kind: "copy", to: "db", dir: null });
    expect(dropMeaning(from("web"), whole("mine"), tabs)).toEqual({ kind: "copy", to: "mine", dir: null });
  });

  it("a session that is not up is no target; nor is a tab that is not there", () => {
    expect(dropMeaning(from("web"), whole("down"), tabs)).toBeNull();
    expect(dropMeaning(from("web"), folder("down"), tabs)).toBeNull();
    expect(dropMeaning(from("web"), whole("gone"), tabs)).toBeNull();
    expect(dropMeaning(from("web"), null, tabs)).toBeNull();
  });

  it("files of another window are copied like any other — their tab is not one of these", () => {
    expect(dropMeaning(from("elsewhere"), folder("db", "/srv"), tabs)).toEqual({
      kind: "copy",
      to: "db",
      dir: "/srv",
    });
  });

  it("from the desktop into a folder a panel shows they are sent at once", () => {
    expect(dropMeaning(from(null, true), folder("web", "/var/www"), tabs)).toEqual({
      kind: "send",
      to: "web",
      dir: "/var/www",
    });
    expect(dropMeaning(from(null, true), folder("mine", "/Users/me/dl"), tabs)?.kind).toBe("send");
  });

  it("from the desktop onto a server's tab or terminal the folder is asked for", () => {
    expect(dropMeaning(from(null, true), whole("web"), tabs)).toEqual({
      kind: "copy",
      to: "web",
      dir: null,
    });
  });

  it("from the desktop onto a local terminal their paths are typed into it", () => {
    expect(dropMeaning(from(null, true), whole("mine"), tabs)).toEqual({ kind: "paste", to: "mine" });
  });

  it("nothing carried is nothing dropped", () => {
    expect(dropMeaning({ ...from("web"), entries: [] }, folder("db"), tabs)).toBeNull();
  });
});

describe("a target", () => {
  it("is the same when it is the same folder of the same session", () => {
    expect(sameTarget(folder("web", "/a"), folder("web", "/a"))).toBe(true);
    expect(sameTarget(folder("web", "/a"), folder("web", "/b"))).toBe(false);
    expect(sameTarget(folder("web", "/a"), folder("db", "/a"))).toBe(false);
    expect(sameTarget(whole("web"), whole("web"))).toBe(true);
    expect(sameTarget(whole("web"), folder("web", "/a"))).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(null, whole("web"))).toBe(false);
  });

  it("opens under held files after a moment, not at once and not after a wait", () => {
    expect(SPRING_MS).toBeGreaterThanOrEqual(500);
    expect(SPRING_MS).toBeLessThanOrEqual(1000);
  });
});

describe("files told to another window", () => {
  it("come back as they were sent", () => {
    const files = from("web");
    expect(parseFiles(describeFiles(files))).toEqual(files);
    expect(parseFiles(JSON.parse(JSON.stringify(describeFiles(files))))).toEqual(files);
  });

  it("carry nothing but what the other window needs", () => {
    const loud = { ...from("web"), entries: [{ ...entry("a"), size: 9, mode: 0o644 }] };
    expect(describeFiles(loud).entries).toEqual([{ path: "/etc/a", name: "a", isDir: false }]);
  });

  it("are read, not trusted: anything that is not whole is dropped", () => {
    const good = describeFiles(from("web"));
    for (const bad of [
      null,
      "files",
      [],
      { ...good, kind: "tab" },
      { ...good, from: null }, // the desktop's files do not come through a window
      { ...good, from: "" },
      { ...good, local: "no" },
      { ...good, label: 7 },
      { ...good, entries: [] },
      { ...good, entries: "a" },
      { ...good, entries: [{ path: "/a", name: "a" }] },
      { ...good, entries: [{ path: "", name: "a", isDir: false }] },
      { ...good, entries: [{ path: "/a", name: "", isDir: false }] },
      { ...good, entries: [null] },
      { ...good, entries: Array.from({ length: MAX_RELAYED + 1 }, () => entry("a")) },
    ]) {
      expect(parseFiles(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });

  it("a relayed message is read as one about files — or not at all", () => {
    const files = from("web");
    expect(parseFileDragMessage({ kind: "over", x: 10, y: 20, tab: describeFiles(files) })).toEqual({
      kind: "over",
      x: 10,
      y: 20,
      files,
    });
    expect(parseFileDragMessage({ kind: "drop", x: 1, y: 2, tab: describeFiles(files) })?.kind).toBe("drop");
    expect(parseFileDragMessage({ kind: "leave" })).toEqual({ kind: "leave" });
    // A tab's message is not one about files.
    const tab = { kind: "ssh", serverId: "s", alias: "web", status: "Connected" };
    expect(parseFileDragMessage({ kind: "over", x: 1, y: 2, tab })).toBeNull();
    for (const bad of [
      null,
      { kind: "over", x: "1", y: 2, tab: describeFiles(files) },
      { kind: "over", x: Number.NaN, y: 2, tab: describeFiles(files) },
      { kind: "over", x: 1, y: Number.POSITIVE_INFINITY, tab: describeFiles(files) },
      { kind: "over", x: 1, y: 2 },
      { kind: "hover", x: 1, y: 2, tab: describeFiles(files) },
    ]) {
      expect(parseFileDragMessage(bad)).toBeNull();
    }
  });
});

describe("files from the desktop", () => {
  it("are named by their paths, on either kind of path", () => {
    expect(desktopFiles(["/Users/me/a.txt", "C:\\work\\b.conf", "/Users/me/site/"])).toEqual({
      from: null,
      local: true,
      label: "",
      entries: [
        { path: "/Users/me/a.txt", name: "a.txt", isDir: false },
        { path: "C:\\work\\b.conf", name: "b.conf", isDir: false },
        { path: "/Users/me/site/", name: "site", isDir: false },
      ],
    });
    expect(desktopFiles([]).entries).toEqual([]);
  });

  it("are placed where the system says, in the page's own pixels", () => {
    expect(pagePoint({ x: 400, y: 300 }, 2)).toEqual({ x: 200, y: 150 });
    expect(pagePoint({ x: 400, y: 300 }, 1)).toEqual({ x: 400, y: 300 });
    // A ratio that is not one leaves the point alone rather than at infinity.
    expect(pagePoint({ x: 400, y: 300 }, 0)).toEqual({ x: 400, y: 300 });
  });
});
