import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";
import { createFileLinks, type FileLinkHost, type LinkTerminal } from "./filelinkprovider";
import { DOUBLE_CLICK_MS, type FileLinkTarget } from "./termfiles";
import type { FileEntry } from "../types";

const COLS = 60;

/** A terminal buffer of plain lines; the cursor is on the last one printed. */
class FakeTerm {
  cols = COLS;
  lines: { text: string; wrapped: boolean }[] = [];
  type: "normal" | "alternate" = "normal";
  modes = { mouseTrackingMode: "none" as string };
  selection = false;
  markers: { line: number; isDisposed: boolean; dispose(): void }[] = [];

  print(text: string, wrapped = false) {
    this.lines.push({ text, wrapped });
  }

  asTerminal(): LinkTerminal {
    const self = this;
    return {
      cols: COLS,
      get modes() {
        return self.modes;
      },
      buffer: {
        get active() {
          return {
            get type() {
              return self.type;
            },
            baseY: 0,
            get cursorY() {
              return Math.max(0, self.lines.length - 1);
            },
            getLine: (y: number) => {
              const l = self.lines[y];
              if (!l) return undefined;
              return {
                isWrapped: l.wrapped,
                length: COLS,
                getCell: (x: number) => ({ getChars: () => l.text[x] ?? "", getWidth: () => 1 }),
                translateToString: () => l.text,
              };
            },
          };
        },
      },
      registerMarker: (offset = 0) => {
        const m = {
          line: self.lines.length - 1 + offset,
          isDisposed: false,
          dispose() {
            m.isDisposed = true;
          },
        };
        self.markers.push(m);
        return m;
      },
      hasSelection: () => self.selection,
    } as unknown as LinkTerminal;
  }
}

function entry(name: string, isDir = false): FileEntry {
  return { name, path: name, isDir, isSymlink: false, size: 0, modified: null, mode: null, uid: null, gid: null, user: null, group: null } as FileEntry;
}

interface Setup {
  term: FakeTerm;
  opened: FileLinkTarget[];
  list: ReturnType<typeof vi.fn>;
  links: ReturnType<typeof createFileLinks>;
  host: FileLinkHost;
}

function setup(over: Partial<FileLinkHost> = {}, fs: Record<string, FileEntry[]> = {}): Setup {
  const term = new FakeTerm();
  const opened: FileLinkTarget[] = [];
  const list = vi.fn(async (dir: string) => {
    const got = fs[dir];
    if (!got) throw new Error(`no such dir ${dir}`);
    return got;
  });
  const host: FileLinkHost = {
    local: true,
    style: () => "posix",
    shell: () => "posix",
    dirs: () => true,
    click: () => "click",
    mac: () => true,
    open: (t) => opened.push(t),
    list,
    submittedCwd: async () => "/home/u",
    ...over,
  };
  return { term, opened, list, links: createFileLinks(term.asTerminal(), host), host };
}

/** The links of 1-based buffer line `n`. */
function linksAt(s: Setup, n: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => s.links.provider.provideLinks(n, resolve));
}

const HOME: Record<string, FileEntry[]> = {
  "/home/u": [entry("a.txt"), entry("src", true), entry("notes.txt"), entry("My Notes.txt")],
  "/etc": [entry("hosts")],
};

/** Type `command` at a prompt and send it; resolves once its folder is noted. */
async function run(s: Setup, command: string) {
  s.term.print(`u@h:~$ ${command}`);
  s.links.noteSubmit(Promise.resolve());
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const click = (detail = 1, keys: Partial<MouseEvent> = {}) =>
  ({ detail, metaKey: false, ctrlKey: false, altKey: false, ...keys }) as MouseEvent;

describe("file links in a local terminal", () => {
  it("links the names of a listing that its folder has", async () => {
    const s = setup({}, HOME);
    await run(s, "ls");
    s.term.print("a.txt  src  missing");
    const links = (await linksAt(s, 2))!;
    expect(links.map((l) => l.text)).toEqual(["a.txt", "src"]);
    expect(links[0].range).toEqual({ start: { x: 1, y: 2 }, end: { x: 5, y: 2 } });
    expect(links[1].range).toEqual({ start: { x: 8, y: 2 }, end: { x: 10, y: 2 } });
  });

  it("reads `ls /etc` in /etc", async () => {
    const s = setup({}, HOME);
    await run(s, "ls /etc");
    s.term.print("hosts  a.txt");
    expect((await linksAt(s, 2))!.map((l) => l.text)).toEqual(["hosts"]);
  });

  it("reads `ls -l notes.txt` where it ran: the argument is a file", async () => {
    const s = setup({}, HOME);
    await run(s, "ls -l notes.txt");
    s.term.print("-rw-r--r-- 1 u u 3 Oct 28 14:03 notes.txt");
    expect((await linksAt(s, 2))!.map((l) => l.text)).toEqual(["notes.txt"]);
  });

  it("reads `cd /etc && ls` in /etc, where the line went first", async () => {
    const s = setup({}, HOME);
    await run(s, "cd /etc && ls");
    s.term.print("hosts  a.txt");
    expect((await linksAt(s, 2))!.map((l) => l.text)).toEqual(["hosts"]);
  });

  it("reads `cd src; ls -l notes.txt` in src when the argument is a file", async () => {
    const s = setup({}, { ...HOME, "/home/u/src": [entry("notes.txt")] });
    await run(s, "cd src; ls -l notes.txt");
    s.term.print("-rw-r--r-- 1 u u 3 Oct 28 14:03 notes.txt");
    const [link] = (await linksAt(s, 2))!;
    expect(link.text).toBe("notes.txt");
    link.activate(click(), link.text);
    await new Promise((r) => setTimeout(r, DOUBLE_CLICK_MS + 10));
    expect(s.opened).toEqual([expect.objectContaining({ path: "/home/u/src/notes.txt" })]);
  });

  it("has no folder for output before the first command", async () => {
    const s = setup({}, HOME);
    s.term.print("a.txt");
    expect(await linksAt(s, 1)).toBeUndefined();
    expect(s.list).not.toHaveBeenCalled();
  });

  it("knows no folder where the backend could not tell", async () => {
    const s = setup({ submittedCwd: async () => null }, HOME);
    await run(s, "ls");
    s.term.print("a.txt");
    expect(await linksAt(s, 2)).toBeUndefined();
  });

  it("does not read PowerShell's process folder: it does not follow `cd`", async () => {
    const submittedCwd = vi.fn(async () => "C:\\stale");
    const fs = { "C:\\Users\\bob": [entry("a.txt")] };
    const s = setup({ style: () => "windows", shell: () => "powershell", submittedCwd }, fs);
    s.links.noteCwd("C:\\Users\\bob");
    await run(s, "Get-Content x");
    s.term.print("a.txt");
    expect((await linksAt(s, 2))!.map((l) => l.text)).toEqual(["a.txt"]);
    expect(submittedCwd).not.toHaveBeenCalled();
  });

  it("places a `dir` listing by its header", async () => {
    const fs = { "C:\\Data": [entry("Report.xlsx")] };
    const s = setup({ style: () => "windows", shell: () => "cmd", submittedCwd: async () => "C:\\Users\\bob" }, fs);
    s.term.print("C:\\Users\\bob>dir C:\\Data");
    s.links.noteSubmit(Promise.resolve());
    await Promise.resolve();
    s.term.print(" Directory of C:\\Data");
    s.term.print("10/28/2026  02:00 PM    12 report.xlsx");
    expect((await linksAt(s, 3))!.map((l) => l.text)).toEqual(["report.xlsx"]);
  });

  it("offers nothing in a full-screen program or one that takes the mouse", async () => {
    const s = setup({}, HOME);
    await run(s, "ls");
    s.term.print("a.txt");
    s.term.type = "alternate";
    expect(await linksAt(s, 2)).toBeUndefined();
    s.term.type = "normal";
    s.term.modes.mouseTrackingMode = "vt200";
    expect(await linksAt(s, 2)).toBeUndefined();
  });

  it("notes no command typed into a full-screen program", () => {
    const s = setup({}, HOME);
    s.term.type = "alternate";
    s.links.noteSubmit(Promise.resolve());
    expect(s.term.markers).toHaveLength(0);
  });

  it("lists a folder once, and again after the next command", async () => {
    const s = setup({}, HOME);
    await run(s, "ls");
    s.term.print("a.txt");
    await linksAt(s, 2);
    await linksAt(s, 2);
    expect(s.list).toHaveBeenCalledTimes(1);
    await run(s, "touch b.txt");
    s.term.print("a.txt");
    await linksAt(s, 4);
    expect(s.list).toHaveBeenCalledTimes(2);
  });

  it("drops the links of a line rewritten while its folder was listed", async () => {
    let release!: (e: FileEntry[]) => void;
    const s = setup({}, {});
    s.list.mockImplementation(() => new Promise<FileEntry[]>((r) => (release = r)));
    await run(s, "ls");
    s.term.print("a.txt");
    const asked = linksAt(s, 2);
    await Promise.resolve();
    s.term.lines[1].text = "other";
    release([entry("a.txt")]);
    expect(await asked).toBeUndefined();
  });

  it("joins a wrapped line and links across the wrap", async () => {
    const long = "x".repeat(COLS - 3);
    const s = setup({}, { "/home/u": [entry("a.txt")] });
    await run(s, "ls");
    s.term.print(`${long} a.`);
    s.term.print("txt", true);
    const links = (await linksAt(s, 3))!;
    expect(links.map((l) => l.text)).toEqual(["a.txt"]);
    expect(links[0].range).toEqual({ start: { x: COLS - 1, y: 2 }, end: { x: 3, y: 3 } });
  });
});

describe("file links over SSH", () => {
  const ssh = (fs = HOME, over: Partial<FileLinkHost> = {}) => setup({ local: false, ...over }, fs);

  it("reads a command in the folder the shell reported since the last one", async () => {
    const s = ssh();
    s.links.noteCwd("/home/u");
    await run(s, "ls");
    s.term.print("a.txt");
    expect((await linksAt(s, 2))!.map((l) => l.text)).toEqual(["a.txt"]);
  });

  it("knows no folder for a line sent before the shell reported again", async () => {
    const s = ssh();
    s.links.noteCwd("/home/u");
    await run(s, "ssh other");
    await run(s, "cat notes.txt");
    s.term.print("a.txt");
    expect(await linksAt(s, 3)).toBeUndefined();
  });

  it("offers path sync for the names of a listing nobody placed — not on the prompt", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt  1.5K");
    const links = (await linksAt(s, 2))!;
    expect(links.map((l) => l.text)).toEqual(["a.txt"]);
    vi.useFakeTimers();
    try {
      links[0].activate(click(), "a.txt");
      vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(s.opened.at(-1)).toEqual({ kind: "unplaced" });
    expect(await linksAt(s, 1)).toBeUndefined();
  });

  it("still links an absolute path where the folder is unknown", async () => {
    const s = ssh();
    await run(s, "cat log");
    s.term.print("see /etc/hosts");
    expect((await linksAt(s, 2))!.map((l) => l.text)).toEqual(["/etc/hosts"]);
  });
});

describe("path sync's setup line over SSH", () => {
  // ⌘-click: opens at once, so a test does not wait out the double-click.
  const ssh = () => setup({ local: false, click: () => "modifier" }, HOME);
  const cmdClick = () => click(1, { metaKey: true });
  const typeSetup = (s: Setup) => {
    s.term.print("u@h:~$  __vtcwd(){ ...");
    s.links.noteSubmit(Promise.resolve(), true);
  };
  /** The link of `name` on 1-based line `n`, as xterm would hold it. */
  const linkOf = async (s: Setup, n: number, name: string) => {
    const link = (await linksAt(s, n))!.find((l) => l.text === name);
    expect(link, `no link ${name}`).toBeDefined();
    return link!;
  };
  /** What a click on `link` opened, once it has. */
  const clicked = async (s: Setup, link: ILink) => {
    const before = s.opened.length;
    link.activate(cmdClick(), link.text);
    await vi.waitFor(() => expect(s.opened.length).toBe(before + 1));
    return s.opened.at(-1);
  };

  it("the shell's answer to it places the command before it: its names open", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt  1.5K");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "unplaced" });
    typeSetup(s);
    s.links.noteCwd("/home/u");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "file", path: "/home/u/a.txt" });
  });

  it("a link xterm still holds from before reads the line again when clicked", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt  My Notes.txt  gone.txt");
    const stale = (await linksAt(s, 2))!;
    typeSetup(s);
    s.links.noteCwd("/home/u");
    const byName = (name: string) => stale.find((l) => l.text === name)!;
    expect(await clicked(s, byName("a.txt"))).toEqual({ kind: "file", path: "/home/u/a.txt" });
    // Offered word by word; the folder's listing knows the whole name.
    expect(await clicked(s, byName("Notes.txt"))).toEqual({ kind: "file", path: "/home/u/My Notes.txt" });
    expect(await clicked(s, byName("gone.txt"))).toEqual({ kind: "missing", name: "gone.txt" });
  });

  it("a held link still offers path sync while the shell has not answered", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    const link = await linkOf(s, 2, "a.txt");
    typeSetup(s);
    expect(await clicked(s, link)).toEqual({ kind: "unplaced" });
  });

  it("a held link whose row holds another line by now opens nothing of it", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    const link = await linkOf(s, 2, "a.txt");
    typeSetup(s);
    s.links.noteCwd("/home/u");
    s.term.lines[1].text = "notes.txt";
    expect(await clicked(s, link)).toEqual({ kind: "missing", name: "a.txt" });
  });

  it("a held link does not open over a selection", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    const link = await linkOf(s, 2, "a.txt");
    typeSetup(s);
    s.links.noteCwd("/home/u");
    s.term.selection = true;
    link.activate(cmdClick(), "a.txt");
    await new Promise((r) => setTimeout(r));
    expect(s.opened).toEqual([]);
  });

  it("places that one command only: an earlier one may have run before a cd", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    await run(s, "cd /etc");
    typeSetup(s);
    s.links.noteCwd("/etc");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "unplaced" });
  });

  it("a report with no setup line places nothing: the line may have gone to another program", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    s.links.noteCwd("/home/u");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "unplaced" });
  });

  it("a line sent before the shell answered ends the wait", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    typeSetup(s);
    await run(s, "cat notes.txt");
    s.links.noteCwd("/etc");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "unplaced" });
  });

  it("a setup line typed into a full-screen program places nothing", async () => {
    const s = ssh();
    await run(s, "ls");
    s.term.print("a.txt");
    s.term.type = "alternate";
    s.links.noteSubmit(Promise.resolve(), true);
    s.term.type = "normal";
    s.links.noteCwd("/home/u");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "unplaced" });
  });

  it("never rewrites a folder already known", async () => {
    const s = ssh();
    s.links.noteCwd("/home/u");
    await run(s, "ls");
    s.term.print("a.txt");
    typeSetup(s);
    s.links.noteCwd("/etc");
    expect(await clicked(s, await linkOf(s, 2, "a.txt"))).toEqual({ kind: "file", path: "/home/u/a.txt" });
  });

  it("the next command reads where the shell reported, as any other", async () => {
    const s = ssh();
    typeSetup(s);
    s.links.noteCwd("/home/u");
    await run(s, "ls");
    s.term.print("a.txt");
    expect(await clicked(s, await linkOf(s, 3, "a.txt"))).toEqual({ kind: "file", path: "/home/u/a.txt" });
  });
});

describe("the click", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function linked(over: Partial<FileLinkHost> = {}) {
    vi.useRealTimers();
    const s = setup(over, HOME);
    await run(s, "ls");
    s.term.print("a.txt");
    const link = (await linksAt(s, 2))![0];
    vi.useFakeTimers();
    return { s, link };
  }

  it("opens a plain click once a double-click can no longer come", async () => {
    const { s, link } = await linked();
    link.activate(click(), "a.txt");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(s.opened).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.opened).toEqual([{ kind: "file", path: "/home/u/a.txt" }]);
  });

  it("never opens on a double-click, which selects the name", async () => {
    const { s, link } = await linked();
    link.activate(click(1), "a.txt");
    link.activate(click(2), "a.txt");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
    expect(s.opened).toEqual([]);
  });

  it("never opens with a selection: dragging across a name selects it", async () => {
    const { s, link } = await linked();
    s.term.selection = true;
    link.activate(click(), "a.txt");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(s.opened).toEqual([]);
  });

  it("drops the click when a selection began while it waited", async () => {
    const { s, link } = await linked();
    link.activate(click(), "a.txt");
    s.term.selection = true;
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(s.opened).toEqual([]);
  });

  it("in modifier mode opens ⌘-click at once and ignores a plain one", async () => {
    const { s, link } = await linked({ click: () => "modifier" });
    link.activate(click(), "a.txt");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(s.opened).toEqual([]);
    link.activate(click(1, { metaKey: true }), "a.txt");
    expect(s.opened).toHaveLength(1);
  });

  it("ignores alt-click, which moves the cursor", async () => {
    const { s, link } = await linked();
    link.activate(click(1, { altKey: true }), "a.txt");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(s.opened).toEqual([]);
  });

  it("stops waiting when disposed", async () => {
    const { s, link } = await linked();
    link.activate(click(), "a.txt");
    s.links.dispose();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(s.opened).toEqual([]);
    expect(s.term.markers.every((m) => m.isDisposed)).toBe(true);
  });
});

describe("targetOf (the menu's selection)", () => {
  it("names the file a selection is, in its line's folder", async () => {
    const s = setup({}, HOME);
    await run(s, "ls");
    s.term.print("My Notes.txt  a.txt");
    expect(await s.links.targetOf("My Notes.txt", 1)).toEqual({ kind: "file", path: "/home/u/My Notes.txt" });
    expect(await s.links.targetOf(" src ", 1)).toEqual({ kind: "dir", path: "/home/u/src" });
  });

  it("names nothing for a selection that is not one name", async () => {
    const s = setup({}, HOME);
    await run(s, "ls");
    s.term.print("a.txt src");
    expect(await s.links.targetOf("a.txt src", 1)).toBeNull();
    expect(await s.links.targetOf("a.txt\nsrc", 1)).toBeNull();
    expect(await s.links.targetOf("   ", 1)).toBeNull();
    expect(await s.links.targetOf("nope", 1)).toBeNull();
  });

  it("over SSH, offers path sync for a name in a listing nobody placed", async () => {
    const s = setup({ local: false }, HOME);
    await run(s, "ls");
    s.term.print("a.txt");
    expect(await s.links.targetOf("a.txt", 1)).toEqual({ kind: "unplaced" });
    expect(await s.links.targetOf("ls", 0)).toBeNull();
  });
});

describe("blocks taken to another window (v1.35)", () => {
  it("a terminal replayed from a snapshot reads earlier output in its own folders", async () => {
    const before = setup({}, HOME);
    await run(before, "ls /etc");
    before.term.print("hosts");
    await run(before, "ls");
    before.term.print("a.txt");
    const saved = before.links.blocks();
    expect(saved).toEqual([
      { line: 0, cwd: "/home/u" },
      { line: 2, cwd: "/home/u" },
    ]);

    // The other window: the same buffer, written from the snapshot — no command typed there.
    const after = setup({ submittedCwd: async () => "/elsewhere" }, HOME);
    for (const l of before.term.lines) after.term.print(l.text, l.wrapped);
    expect(await linksAt(after, 2)).toBeUndefined();
    after.links.restore(saved);
    expect((await linksAt(after, 2))!.map((l) => l.text)).toEqual(["hosts"]);
    expect((await linksAt(after, 4))!.map((l) => l.text)).toEqual(["a.txt"]);
  });

  it("keeps out what does not fit the buffer it is given", async () => {
    const s = setup({}, HOME);
    s.term.print("u@h:~$ ls");
    s.term.print("a.txt");
    s.links.restore([
      { line: 7, cwd: "/home/u" },
      { line: -1, cwd: "/home/u" },
      { line: 0.5, cwd: "/home/u" },
    ]);
    expect(s.links.blocks()).toEqual([]);
    s.links.restore([{ line: 0, cwd: null }]);
    // A block whose folder the other window never knew: still no folder here.
    expect(s.links.blocks()).toEqual([{ line: 0, cwd: null }]);
    expect(await linksAt(s, 2)).toBeUndefined();
  });
});
