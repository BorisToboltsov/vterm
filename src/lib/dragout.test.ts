import { describe, expect, it } from "vitest";
import { dragOutBlocker, dragOutOffered, dragOutSpec, dragOutTold } from "./dragout";
import { describeFiles, type CarriedFiles, type DropTab } from "./filedrop";

const tabs: DropTab[] = [
  { sessionId: "web", kind: "ssh", connected: true },
  { sessionId: "down", kind: "ssh", connected: false },
  { sessionId: "mine", kind: "local", connected: true },
];

const files = (over: Partial<CarriedFiles> = {}): CarriedFiles => ({
  from: "web",
  local: false,
  label: "web-01",
  entries: [{ path: "/etc/nginx/nginx.conf", name: "nginx.conf", isDir: false }],
  ...over,
});

const folder = { path: "/var/www/site", name: "site", isDir: true };

describe("where the system can carry a promise", () => {
  it("is macOS and Windows", () => {
    expect(dragOutOffered("macos")).toBe(true);
    expect(dragOutOffered("windows")).toBe(true);
  });

  it("is not Linux, and not a system nobody has named yet", () => {
    expect(dragOutOffered("linux")).toBe(false);
    // The host OS is resolved once, asynchronously: empty until then.
    expect(dragOutOffered("")).toBe(false);
  });
});

describe("what can be handed to the system", () => {
  it("is files of a server whose session is up", () => {
    expect(dragOutBlocker(files(), tabs, "macos")).toBeNull();
    expect(dragOutBlocker(files(), tabs, "windows")).toBeNull();
  });

  it("is nothing where the system cannot carry it", () => {
    expect(dragOutBlocker(files(), tabs, "linux")).toBe("unsupported");
    expect(dragOutBlocker(files(), tabs, "")).toBe("unsupported");
  });

  it("is not files that are on this machine already", () => {
    // A local tab's panel: the file manager drags those itself.
    expect(dragOutBlocker(files({ from: "mine", local: true }), tabs, "macos")).toBe("here");
    // The desktop's own, passing over the window.
    expect(dragOutBlocker(files({ from: null, local: true }), tabs, "macos")).toBe("here");
  });

  it("is not files of a session that is down, or of no tab of this window", () => {
    expect(dragOutBlocker(files({ from: "down" }), tabs, "macos")).toBe("offline");
    expect(dragOutBlocker(files({ from: "gone" }), tabs, "macos")).toBe("offline");
  });

  it("is a folder on macOS, and not on Windows", () => {
    const withFolder = files({ entries: [files().entries[0], folder] });
    expect(dragOutBlocker(withFolder, tabs, "macos")).toBeNull();
    // Not "the files of it": half of what was picked up would be left behind.
    expect(dragOutBlocker(withFolder, tabs, "windows")).toBe("folders");
  });

  it("names the reason that comes first: a system that cannot is asked nothing else", () => {
    const hopeless = files({ from: "down", entries: [folder] });
    expect(dragOutBlocker(hopeless, tabs, "linux")).toBe("unsupported");
    expect(dragOutBlocker(hopeless, tabs, "windows")).toBe("offline");
  });
});

describe("which reasons the user is told", () => {
  it("is the ones a drop outside could have meant something for", () => {
    expect(dragOutTold("folders")).toBe(true);
    expect(dragOutTold("offline")).toBe(true);
  });

  it("is not what never could be, nor nothing", () => {
    expect(dragOutTold("unsupported")).toBe(false);
    expect(dragOutTold("here")).toBe(false);
    expect(dragOutTold(null)).toBe(false);
  });
});

describe("what the backend is handed", () => {
  it("names the session, its tab, each file, and the files as a window is told of them", () => {
    const carried = files({ entries: [files().entries[0], folder] });
    const spec = dragOutSpec(carried, describeFiles(carried));
    expect(spec).toEqual({
      session: "web",
      label: "web-01",
      items: [
        { path: "/etc/nginx/nginx.conf", name: "nginx.conf", isDir: false },
        { path: "/var/www/site", name: "site", isDir: true },
      ],
      carried: describeFiles(carried),
    });
  });

  it("claims no size: how long a file is, is the server's to say", () => {
    const withSize = files({
      entries: [{ ...files().entries[0], size: 42 } as CarriedFiles["entries"][number]],
    });
    const spec = dragOutSpec(withSize, {});
    expect(Object.keys(spec?.items[0] ?? {})).toEqual(["path", "name", "isDir"]);
  });

  it("is nothing for files with no session to read from, or for no files", () => {
    expect(dragOutSpec(files({ from: null }), {})).toBeNull();
    expect(dragOutSpec(files({ entries: [] }), {})).toBeNull();
  });
});
