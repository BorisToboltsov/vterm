import { beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import {
  copyTargetList,
  fileSelectionOf,
  pendingCopyRequest,
  requestCopy,
  resetFileCopy,
  setCopyTargets,
  setFileSelection,
  takeCopyRequest,
} from "./filecopy.svelte";

const entry = (name: string): FileEntry => ({
  name, path: `/d/${name}`, isDir: false, isSymlink: false, size: 1, modified: null,
  mode: null, uid: null, gid: null, user: null, group: null,
});

describe("what the file panels and the page tell each other", () => {
  beforeEach(resetFileCopy);

  it("the page publishes where a file can be copied to", () => {
    expect(copyTargetList()).toEqual([]);
    const targets = [{ sessionId: "db", title: "db", local: false, prod: true }];
    setCopyTargets(targets);
    expect(copyTargetList()).toEqual(targets);
  });

  it("a request waits until the page takes it — once", () => {
    const request = { from: "web", local: false, to: "db", entries: [entry("a")] };
    requestCopy(request);
    expect(pendingCopyRequest()).toEqual(request);
    expect(takeCopyRequest()).toEqual(request);
    expect(pendingCopyRequest()).toBeNull();
    expect(takeCopyRequest()).toBeNull();
  });

  it("a request for nothing is no request", () => {
    requestCopy({ from: "web", local: false, to: "db", entries: [] });
    expect(pendingCopyRequest()).toBeNull();
  });

  it("a panel on screen says what is selected in it, and takes its word back", () => {
    expect(fileSelectionOf("web")).toBeNull();
    setFileSelection("web", { local: false, entries: [entry("a"), entry("b")] });
    expect(fileSelectionOf("web")?.entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(fileSelectionOf("db")).toBeNull();
    // An empty selection is none; so is a panel that went away.
    setFileSelection("web", { local: false, entries: [] });
    expect(fileSelectionOf("web")).toBeNull();
    setFileSelection("web", { local: true, entries: [entry("a")] });
    setFileSelection("web", null);
    expect(fileSelectionOf("web")).toBeNull();
  });
});
