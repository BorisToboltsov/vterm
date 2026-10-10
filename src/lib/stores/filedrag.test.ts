// Dragging files (v1.13): the store that owns the drag — what is under the
// pointer, what opens when files are held over it, what a release does, and the
// ways a drag ends without one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPRING_MS, type CarriedFiles, type DropMeaning, type FileTarget } from "../filedrop";
import {
  beginFileDrag,
  cancelFileDrag,
  clearGuestFiles,
  consumeFileDragClick,
  dropGuestFiles,
  fileDrag,
  fileTargetAt,
  onFileDrag,
  showGuestFiles,
  springAt,
  type FileDragHost,
  type Spring,
} from "./filedrag.svelte";

// jsdom has no layout: `elementFromPoint` is supplied per test.
const at = (id: string | null) =>
  (document.elementFromPoint = () => (id === null ? null : document.getElementById(id)));

const files = (session: string | null = "web"): CarriedFiles => ({
  from: session,
  local: false,
  label: "",
  entries: [{ path: "/etc/a.conf", name: "a.conf", isDir: false }],
});

/** A page: two tabs, the file panel of `db` with a folder row, and `db`'s terminal. */
function page() {
  document.body.innerHTML = `
    <div id="strip">
      <div id="tab-web" data-tab="web"><span id="tab-web-label">web</span></div>
      <div id="tab-db" data-tab="db"></div>
    </div>
    <button id="dock-files" data-dock-panel="files"><span id="dock-files-icon"></span></button>
    <button id="dock-git" data-dock-panel="git"></button>
    <div id="panel" data-file-panel="db">
      <div id="toolbar"></div>
      <div id="list" data-file-cwd="/srv">
        <div id="row" data-drop="/srv/backup"><span id="row-name">backup</span></div>
        <div id="file-row"><span id="file-name">notes.txt</span></div>
      </div>
    </div>
    <div id="lonely" data-file-panel="web"><div id="connect">Connect</div></div>
    <div id="area" data-views-of="db"><div id="term"></div></div>
    <div id="elsewhere"></div>
    <div id="stray" data-drop="/not/a/panel"></div>`;
  const area = document.getElementById("area") as HTMLElement;
  area.getBoundingClientRect = () => ({ left: 300, top: 60, width: 500, height: 400 }) as DOMRect;
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true });

function press(x = 10, y = 10, button = 0) {
  const el = document.createElement("div");
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  const e = new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 7, button });
  Object.defineProperty(e, "currentTarget", { value: el });
  return e;
}
const move = (x: number, y: number) => window.dispatchEvent(pointer("pointermove", x, y));
const release = (x = 0, y = 0) => window.dispatchEvent(pointer("pointerup", x, y));
const key = (k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

let dropped: { files: CarriedFiles; meaning: DropMeaning }[] = [];
let sprung: Spring[] = [];

/** A host that takes every target as a copy, and remembers what it was asked to do. */
function host(over: Partial<FileDragHost> = {}): FileDragHost {
  return {
    meaning: (_files, target: FileTarget) => ({
      kind: "copy",
      to: target.session,
      dir: target.kind === "folder" ? target.dir : null,
    }),
    drop: (f, meaning) => dropped.push({ files: f, meaning }),
    spring: (what) => sprung.push(what),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  page();
  dropped = [];
  sprung = [];
  cancelFileDrag();
  onFileDrag(host());
});
afterEach(() => {
  cancelFileDrag();
  onFileDrag(null);
  vi.useRealTimers();
});

describe("what files held at a point would land on", () => {
  it("a folder row of a file panel", () => {
    at("row-name");
    expect(fileTargetAt(1, 1)?.target).toEqual({ kind: "folder", session: "db", dir: "/srv/backup" });
  });

  it("the folder a panel's list shows, anywhere else on the list", () => {
    at("file-name");
    expect(fileTargetAt(1, 1)?.target).toEqual({ kind: "folder", session: "db", dir: "/srv" });
    at("list");
    expect(fileTargetAt(1, 1)?.target).toEqual({ kind: "folder", session: "db", dir: "/srv" });
  });

  it("the session as a whole where the panel lists nothing — its toolbar, or not connected yet", () => {
    at("toolbar");
    expect(fileTargetAt(1, 1)?.target).toEqual({ kind: "session", session: "db" });
    at("connect");
    expect(fileTargetAt(1, 1)?.target).toEqual({ kind: "session", session: "web" });
  });

  it("a session's tab, and its area in the centre — which is tinted", () => {
    at("tab-web-label");
    expect(fileTargetAt(1, 1)).toEqual({ target: { kind: "session", session: "web" }, zone: null });
    at("term");
    expect(fileTargetAt(1, 1)).toEqual({
      target: { kind: "session", session: "db" },
      zone: { x: 300, y: 60, w: 500, h: 400 },
    });
  });

  it("nothing anywhere else — a folder mark outside a file panel among it", () => {
    at("elsewhere");
    expect(fileTargetAt(1, 1)).toBeNull();
    at("stray");
    expect(fileTargetAt(1, 1)).toBeNull();
    at(null);
    expect(fileTargetAt(1, 1)).toBeNull();
  });

  it("what would open: a tab, or the dock's Files tab — no other dock tab", () => {
    at("tab-web-label");
    expect(springAt(1, 1)).toEqual({ kind: "tab", id: "web" });
    at("dock-files-icon");
    expect(springAt(1, 1)).toEqual({ kind: "files" });
    at("dock-git");
    expect(springAt(1, 1)).toBeNull();
    at("row");
    expect(springAt(1, 1)).toBeNull();
  });
});

describe("a drag out of a file panel", () => {
  it("starts once the pointer has moved, and asks then what is carried", () => {
    const pick = vi.fn(() => files());
    beginFileDrag(press(10, 10), pick);
    at("elsewhere");
    move(12, 11);
    expect(fileDrag.files).toBeNull();
    expect(pick).not.toHaveBeenCalled();
    move(40, 40);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(fileDrag.files).toEqual(files());
    expect(fileDrag).toMatchObject({ x: 40, y: 40, over: null, guest: false });
  });

  it("is not started by another button, or with nothing to carry", () => {
    beginFileDrag(press(10, 10, 2), () => files());
    move(60, 60);
    expect(fileDrag.files).toBeNull();
    beginFileDrag(press(10, 10), () => null);
    move(60, 60);
    expect(fileDrag.files).toBeNull();
    beginFileDrag(press(10, 10), () => ({ ...files(), entries: [] }));
    move(60, 60);
    expect(fileDrag.files).toBeNull();
  });

  it("offers what is under it, and only what a drop would mean something on", () => {
    onFileDrag(host({ meaning: (_f, target) => (target.session === "db" ? { kind: "copy", to: "db", dir: null } : null) }));
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    expect(fileDrag.over).toEqual({ kind: "folder", session: "db", dir: "/srv/backup" });
    at("tab-web");
    move(60, 60);
    expect(fileDrag.over).toBeNull();
    at("term");
    move(400, 200);
    expect(fileDrag.over).toEqual({ kind: "session", session: "db" });
    expect(fileDrag.zone).toEqual({ x: 300, y: 60, w: 500, h: 400 });
  });

  it("does not rewrite a target that has not changed", () => {
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    const first = fileDrag.over;
    move(51, 52);
    move(53, 54);
    expect(fileDrag.over).toBe(first);
  });

  it("does what the target means when it is let go of — and nothing before", () => {
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    move(55, 55);
    expect(dropped).toEqual([]);
    release();
    expect(dropped).toEqual([
      { files: files(), meaning: { kind: "copy", to: "db", dir: "/srv/backup" } },
    ]);
    expect(fileDrag.files).toBeNull();
    expect(fileDrag.over).toBeNull();
  });

  it("let go of over nothing does nothing", () => {
    beginFileDrag(press(), () => files());
    at("elsewhere");
    move(50, 50);
    release();
    expect(dropped).toEqual([]);
    expect(fileDrag.files).toBeNull();
  });

  it("the click that ends a drag is not a click on the row", () => {
    beginFileDrag(press(), () => files());
    at("elsewhere");
    move(50, 50);
    release();
    expect(consumeFileDragClick()).toBe(true);
    expect(consumeFileDragClick()).toBe(false);
    // A press that never became a drag swallows nothing.
    beginFileDrag(press(), () => files());
    release();
    expect(consumeFileDragClick()).toBe(false);
  });
});

describe("holding files over a tab opens it", () => {
  it("after a moment — and not if they moved on first", () => {
    beginFileDrag(press(), () => files());
    at("tab-db");
    move(50, 50);
    vi.advanceTimersByTime(SPRING_MS - 50);
    expect(sprung).toEqual([]);
    // Still over the same tab: the wait is not started over by every move.
    move(52, 51);
    vi.advanceTimersByTime(60);
    expect(sprung).toEqual([{ kind: "tab", id: "db" }]);

    sprung = [];
    at("tab-web");
    move(60, 60);
    vi.advanceTimersByTime(SPRING_MS - 50);
    at("elsewhere");
    move(70, 70);
    vi.advanceTimersByTime(SPRING_MS);
    expect(sprung).toEqual([]);
  });

  it("the dock's Files tab opens the same way", () => {
    beginFileDrag(press(), () => files());
    at("dock-files");
    move(50, 50);
    vi.advanceTimersByTime(SPRING_MS + 1);
    expect(sprung).toEqual([{ kind: "files" }]);
  });

  it("nothing opens once the files were let go of", () => {
    beginFileDrag(press(), () => files());
    at("tab-db");
    move(50, 50);
    release();
    vi.advanceTimersByTime(SPRING_MS * 2);
    expect(sprung).toEqual([]);
  });
});

describe("a drag ends without a drop", () => {
  it("on Esc — and the key goes no further", () => {
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    const e = key("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    expect(fileDrag.files).toBeNull();
    // The release that follows is not a click on the row, and drops nothing.
    release();
    vi.advanceTimersByTime(1);
    expect(dropped).toEqual([]);
    window.removeEventListener("keydown", heard);
  });

  it("another key is not the drag's business", () => {
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    expect(key("a").defaultPrevented).toBe(false);
    expect(fileDrag.files).not.toBeNull();
  });

  it("Esc with nothing in the air is left alone", () => {
    beginFileDrag(press(), () => files());
    expect(key("Escape").defaultPrevented).toBe(false);
  });

  it("when the pointer is taken away", () => {
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    window.dispatchEvent(pointer("pointercancel", 0, 0));
    expect(fileDrag.files).toBeNull();
    release();
    expect(dropped).toEqual([]);
  });
});

describe("outside the window", () => {
  it("the backend is told, one word at a time, and its answer is where the files are", async () => {
    let answer!: (v: { window: string | null; floating: boolean } | null) => void;
    const over = vi.fn(() => new Promise<{ window: string | null; floating: boolean } | null>((r) => (answer = r)));
    onFileDrag(host({ over }));
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    move(60, 60);
    move(70, 70);
    // Not a call per move while one is in flight.
    expect(over).toHaveBeenCalledTimes(1);
    answer({ window: "win-2", floating: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(fileDrag.window).toBe("win-2");
    // Another window lies under the pointer: nothing here is the target.
    expect(fileDrag.over).toBeNull();
    // What was missed while the first word was in flight is said once.
    expect(over).toHaveBeenCalledTimes(2);
  });

  it("a word that never came back does not hold up the next drag", async () => {
    const stuck = vi.fn(() => new Promise<null>(() => {}));
    onFileDrag(host({ over: stuck }));
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    release();
    const over = vi.fn(async () => ({ window: "win-2", floating: false }));
    onFileDrag(host({ over }));
    beginFileDrag(press(), () => files());
    move(50, 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(over).toHaveBeenCalledTimes(1);
    expect(fileDrag.window).toBe("win-2");
  });

  it("let go of over another window, that window does the rest — nothing is dropped here", async () => {
    const released = vi.fn();
    const left = vi.fn();
    onFileDrag(host({ over: async () => ({ window: "win-2", floating: false }), release: released, left }));
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    await vi.advanceTimersByTimeAsync(0);
    release(50, 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledWith(files());
    expect(dropped).toEqual([]);
    // Let go of out there is not "no longer held there".
    expect(left).not.toHaveBeenCalled();
    expect(fileDrag.files).toBeNull();
  });

  it("past the edge of the window nothing in it is a target", async () => {
    const released = vi.fn();
    onFileDrag(host({ over: async () => ({ window: null, floating: true }), release: released }));
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    move(2000, 50);
    expect(fileDrag.outside).toBe(true);
    expect(fileDrag.over).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(fileDrag.floating).toBe(true);
    release(2000, 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([]);
  });

  it("a drag that ends any other way takes back what was said", async () => {
    const left = vi.fn();
    onFileDrag(host({ over: async () => ({ window: null, floating: false }), left }));
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    await vi.advanceTimersByTimeAsync(0);
    key("Escape");
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toHaveBeenCalledTimes(1);
    // Dropped inside the window: said too — the backend's label comes down.
    beginFileDrag(press(), () => files());
    move(50, 50);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveLength(1);
  });

  it("with no host for it, leaving the window is just leaving", () => {
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    move(2000, 50);
    release(2000, 50);
    expect(dropped).toEqual([]);
    expect(fileDrag.files).toBeNull();
  });
});

describe("files this page does not hold itself", () => {
  const guest = files("elsewhere");

  it("are drawn where they are said to be, and offered what is under them", () => {
    at("row-name");
    showGuestFiles(guest, 120, 80);
    expect(fileDrag).toMatchObject({ files: guest, guest: true, x: 120, y: 80 });
    expect(fileDrag.over).toEqual({ kind: "folder", session: "db", dir: "/srv/backup" });
    clearGuestFiles();
    expect(fileDrag.files).toBeNull();
    expect(fileDrag.guest).toBe(false);
  });

  it("let go of here, they do what the target under that point means", () => {
    at("term");
    dropGuestFiles(guest, 400, 200);
    expect(dropped).toEqual([{ files: guest, meaning: { kind: "copy", to: "db", dir: null } }]);
    expect(fileDrag.files).toBeNull();
  });

  it("open what they are held over, like any others", () => {
    at("tab-db");
    showGuestFiles(guest, 10, 10);
    vi.advanceTimersByTime(SPRING_MS + 1);
    expect(sprung).toEqual([{ kind: "tab", id: "db" }]);
  });

  it("are not put back by Esc — this page does not hold them", () => {
    at("row-name");
    showGuestFiles(guest, 10, 10);
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(fileDrag.files).toEqual(guest);
  });

  it("never take over a drag of this page's own", () => {
    beginFileDrag(press(), () => files());
    at("row-name");
    move(50, 50);
    showGuestFiles(guest, 10, 10);
    dropGuestFiles(guest, 10, 10);
    expect(fileDrag.files).toEqual(files());
    expect(dropped).toEqual([]);
    // Nor is the page's own drag "cleared" as a guest's.
    clearGuestFiles();
    expect(fileDrag.files).toEqual(files());
  });
});
