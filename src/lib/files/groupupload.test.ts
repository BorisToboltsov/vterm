import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { canReceive, elsewhere, hostCheck, hostSources, listFailure, markOf, type UploadSource } from "./groupupload";

const entry = (name: string, size = 10, modified: number | null = 100, isDir = false): FileEntry => ({
  name,
  path: `/etc/${name}`,
  isDir,
  isSymlink: false,
  size,
  modified,
  mode: null,
  uid: null,
  gid: null,
  user: null,
  group: null,
});

const sources: UploadSource[] = [
  { path: "/home/me/app.conf", name: "app.conf", isDir: false },
  { path: "/home/me/ssl.conf", name: "ssl.conf", isDir: false },
];

describe("a server's folder against the batch", () => {
  it("tells the free names from the taken ones", () => {
    expect(hostCheck(sources, [entry("app.conf", 2100, 7), entry("other")])).toEqual({
      kind: "ready",
      free: ["ssl.conf"],
      taken: [{ name: "app.conf", isDir: false, size: 2100, modified: 7 }],
    });
  });

  it("tells a missing folder from one that could not be read", () => {
    expect(listFailure("No such file")).toEqual({ kind: "noFolder" });
    expect(listFailure("Permission denied")).toEqual({ kind: "unread", error: "Permission denied" });
    expect(canReceive({ kind: "noFolder" })).toBe(false);
  });
});

describe("what each server is sent", () => {
  const check = hostCheck(sources, [entry("app.conf")]);

  it("sends the free names only, unless the question was answered with replace", () => {
    expect(hostSources(sources, check, false)).toEqual({ sources: [sources[1]], replace: false });
    expect(hostSources(sources, check, true)).toEqual({ sources, replace: true });
  });

  it("sends nothing where every name is taken and kept, or the folder is not there", () => {
    expect(hostSources(sources, hostCheck(sources, [entry("app.conf"), entry("ssl.conf")]), false)).toBeNull();
    expect(hostSources(sources, { kind: "noFolder" }, true)).toBeNull();
    expect(hostSources(sources, { kind: "unread", error: "x" }, true)).toBeNull();
  });
});

describe("the panel's folder against the group's", () => {
  it("compares by what the listing says: size and time", () => {
    const lead = entry("app.conf", 10, 100);
    expect(markOf(lead, [entry("app.conf", 10, 100)])).toBe("same");
    expect(markOf(lead, [entry("app.conf", 11, 100)])).toBe("differs");
    expect(markOf(lead, [entry("app.conf", 10, 101)])).toBe("differs");
    expect(markOf(lead, [])).toBe("absent");
    expect(markOf(lead, null)).toBe("unknown");
  });

  it("takes a folder for the same when it is a folder there too", () => {
    expect(markOf(entry("conf.d", 4096, 1, true), [entry("conf.d", 0, 2, true)])).toBe("same");
    expect(markOf(entry("conf.d", 4096, 1, true), [entry("conf.d")])).toBe("differs");
  });

  it("names what only the other servers hold", () => {
    expect(
      elsewhere(
        [entry("app.conf")],
        [
          { label: "web-2", entries: [entry("app.conf"), entry("legacy.conf")] },
          { label: "web-3", entries: [entry("legacy.conf"), entry("b.conf")] },
          { label: "db-1", entries: null },
        ],
      ),
    ).toEqual([
      { name: "b.conf", on: ["web-3"] },
      { name: "legacy.conf", on: ["web-2", "web-3"] },
    ]);
  });
});
