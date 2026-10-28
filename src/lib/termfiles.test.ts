import { describe, expect, it } from "vitest";
import {
  absPath,
  blockAt,
  clickOpens,
  DEFAULT_FILE_LINK_CLICK,
  DEFAULT_FILE_LINK_MODE,
  dirsToList,
  entryKind,
  fileLinkClick,
  fileLinksAllowed,
  headerDir,
  isFileLinkClick,
  isFileLinkMode,
  lineCandidates,
  lineText,
  listingCommand,
  listingDir,
  listingOf,
  MAX_DIRS_PER_LINE,
  pickLinks,
  resolveName,
  spanRange,
  unplacedNames,
  type Listing,
  type PathStyle,
  type RowLike,
} from "./termfiles";

/** A buffer row from text; `wide` marks characters that take two cells. */
function row(text: string, cols = 80, wide = new Set<string>()): RowLike {
  const cells: { chars: string; width: number }[] = [];
  for (const ch of text) {
    if (wide.has(ch)) {
      cells.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
    } else {
      cells.push({ chars: ch, width: 1 });
    }
  }
  while (cells.length < cols) cells.push({ chars: "", width: 1 });
  return {
    length: cols,
    getCell: (x) => {
      const c = cells[x];
      return c && { getChars: () => c.chars, getWidth: () => c.width };
    },
  };
}

function dirListing(names: Record<string, "file" | "dir">, style: PathStyle = "posix"): Listing {
  return listingOf(
    Object.entries(names).map(([name, kind]) => ({ name, isDir: kind === "dir", mode: null })),
    style,
  );
}

/** The links a line has, as text, with the listings given per folder. */
function linksOf(
  text: string,
  lineDir: string | null,
  listings: Record<string, Record<string, "file" | "dir">>,
  { style = "posix" as PathStyle, dirs = true } = {},
) {
  const cands = lineCandidates(text, lineDir, style);
  const maps = new Map(Object.entries(listings).map(([d, l]) => [d, dirListing(l, style)]));
  return pickLinks(cands, (d) => maps.get(d), style, dirs).map((s) => ({
    text: text.slice(s.from, s.to),
    ...s.target,
  }));
}

describe("settings", () => {
  it("knows its modes and defaults", () => {
    expect(isFileLinkMode("confirm")).toBe(true);
    expect(isFileLinkMode("direct")).toBe(true);
    expect(isFileLinkMode("off")).toBe(true);
    expect(isFileLinkMode("always")).toBe(false);
    expect(isFileLinkMode(1)).toBe(false);
    expect(isFileLinkClick("click")).toBe(true);
    expect(isFileLinkClick("modifier")).toBe(true);
    expect(isFileLinkClick("ctrl")).toBe(false);
    expect(DEFAULT_FILE_LINK_MODE).toBe("confirm");
    expect(DEFAULT_FILE_LINK_CLICK).toBe("click");
  });
});

describe("clickOpens", () => {
  const keys = (k: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...k,
  });

  it("opens on any plain click, never on alt-click (xterm moves the cursor)", () => {
    expect(clickOpens("click", keys(), true)).toBe(true);
    expect(clickOpens("click", keys({ metaKey: true }), true)).toBe(true);
    expect(clickOpens("click", keys({ altKey: true }), false)).toBe(false);
  });

  it("in modifier mode wants ⌘ on macOS and Ctrl elsewhere", () => {
    expect(clickOpens("modifier", keys(), true)).toBe(false);
    expect(clickOpens("modifier", keys({ metaKey: true }), true)).toBe(true);
    expect(clickOpens("modifier", keys({ ctrlKey: true }), true)).toBe(false);
    expect(clickOpens("modifier", keys({ ctrlKey: true }), false)).toBe(true);
    expect(clickOpens("modifier", keys({ metaKey: true }), false)).toBe(false);
    expect(clickOpens("modifier", keys({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });
});

describe("fileLinkClick", () => {
  const file = { kind: "file" as const, path: "/etc/hosts" };

  it("asks, opens or ignores by mode", () => {
    expect(fileLinkClick("confirm", file)).toEqual({ kind: "ask", target: file });
    expect(fileLinkClick("direct", file)).toEqual({ kind: "open", target: file });
    expect(fileLinkClick("off", file)).toEqual({ kind: "ignore" });
  });

  it("offers path sync for a name nobody can place, in every mode but off", () => {
    expect(fileLinkClick("confirm", { kind: "unplaced" })).toEqual({ kind: "offerSync" });
    expect(fileLinkClick("direct", { kind: "unplaced" })).toEqual({ kind: "offerSync" });
    expect(fileLinkClick("off", { kind: "unplaced" })).toEqual({ kind: "ignore" });
  });
});

describe("fileLinksAllowed", () => {
  it("leaves a shell inside a container without file links: its files are not the host's", () => {
    expect(fileLinksAllowed({})).toBe(true);
    expect(fileLinksAllowed({ attach: undefined })).toBe(true);
    expect(fileLinksAllowed({ attach: { kind: "docker" } })).toBe(false);
  });
});

describe("lineText", () => {
  it("reads a row and trims the blank cells after it", () => {
    const line = lineText([row("ls  a.txt")], 80);
    expect(line.text).toBe("ls  a.txt");
    expect(line.cells).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("keeps a wide character's cell and skips its second half", () => {
    const line = lineText([row("日本.txt x", 80, new Set(["日", "本"]))], 80);
    expect(line.text).toBe("日本.txt x");
    expect(line.cells.slice(0, 3)).toEqual([0, 2, 4]);
    expect(line.widths.slice(0, 3)).toEqual([2, 2, 1]);
  });

  it("joins wrapped rows, counting cells from the first", () => {
    const line = lineText([row("abcd", 4), row("ef", 4)], 4);
    expect(line.text).toBe("abcdef");
    expect(line.cells).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("maps every code unit of a surrogate pair to its cell", () => {
    const line = lineText([row("😀 x", 80, new Set(["😀"]))], 80);
    expect(line.text).toBe("😀 x");
    expect(line.cells).toEqual([0, 0, 2, 3]);
  });

  it("skips a cell the row does not have", () => {
    const sparse: RowLike = { length: 3, getCell: (x) => (x === 1 ? undefined : { getChars: () => "a", getWidth: () => 1 }) };
    expect(lineText([sparse], 3).text).toBe("aa");
  });
});

describe("spanRange", () => {
  it("is 1-based and end-inclusive on the line's own row", () => {
    const line = lineText([row("ls  a.txt")], 80);
    expect(spanRange(line, 4, 9, 80, 10)).toEqual({ start: { x: 5, y: 11 }, end: { x: 9, y: 11 } });
  });

  it("ends on the second cell of a wide character", () => {
    const line = lineText([row("日本", 80, new Set(["日", "本"]))], 80);
    expect(spanRange(line, 0, 2, 80, 0)).toEqual({ start: { x: 1, y: 1 }, end: { x: 4, y: 1 } });
  });

  it("crosses into a wrapped row", () => {
    const line = lineText([row("abcd", 4), row("ef", 4)], 4);
    expect(spanRange(line, 2, 6, 4, 0)).toEqual({ start: { x: 3, y: 1 }, end: { x: 2, y: 2 } });
  });
});

describe("absPath / resolveName", () => {
  it("places a POSIX name in its folder and collapses . and ..", () => {
    expect(absPath("a.txt", "/srv/app", "posix")).toBe("/srv/app/a.txt");
    expect(absPath("./src/../a.txt", "/srv/app", "posix")).toBe("/srv/app/a.txt");
    expect(absPath("/etc//hosts", null, "posix")).toBe("/etc/hosts");
    expect(absPath("..", "/srv", "posix")).toBe("/");
    expect(absPath(".", "/srv", "posix")).toBe("/srv");
  });

  it("does not place what it cannot know", () => {
    expect(absPath("a.txt", null, "posix")).toBeNull();
    expect(absPath("a.txt", "relative/dir", "posix")).toBeNull();
    expect(absPath("~/a.txt", "/home/u", "posix")).toBeNull();
    expect(absPath("/../x", null, "posix")).toBeNull();
    expect(absPath("", "/srv", "posix")).toBeNull();
  });

  it("splits a POSIX path at its last slash; a backslash is part of the name", () => {
    expect(resolveName("conf.d/site.conf", "/etc/nginx", "posix")).toEqual({
      path: "/etc/nginx/conf.d/site.conf",
      dir: "/etc/nginx/conf.d",
      base: "site.conf",
      wantsDir: false,
    });
    expect(resolveName("/hosts", null, "posix")).toMatchObject({ dir: "/", base: "hosts" });
    expect(resolveName("a\\b", "/x", "posix")).toMatchObject({ dir: "/x", base: "a\\b" });
    expect(resolveName("src/", "/x", "posix")).toMatchObject({ base: "src", wantsDir: true });
    expect(resolveName("/", null, "posix")).toBeNull();
  });

  it("resolves Windows names with either separator and refuses a drive-relative root", () => {
    expect(resolveName("docs\\a.txt", "C:\\Users\\bob", "windows")).toEqual({
      path: "C:\\Users\\bob\\docs\\a.txt",
      dir: "C:\\Users\\bob\\docs",
      base: "a.txt",
      wantsDir: false,
    });
    expect(resolveName("D:\\x\\", null, "windows")).toMatchObject({ path: "D:\\x", wantsDir: true });
    expect(resolveName("\\Windows", "C:\\Users", "windows")).toBeNull();
    expect(resolveName("C:\\", null, "windows")).toBeNull();
    expect(resolveName("a.txt", null, "windows")).toBeNull();
  });
});

describe("links in a line", () => {
  const home = { "/home/u": { "a.txt": "file", "My Notes.txt": "file", src: "dir", "run.sh": "file", "it's.md": "file" } } as const;

  it("links the names of an `ls` listing that the folder has", () => {
    expect(linksOf("a.txt  src  missing.txt", "/home/u", home)).toEqual([
      { text: "a.txt", kind: "file", path: "/home/u/a.txt" },
      { text: "src", kind: "dir", path: "/home/u/src" },
    ]);
  });

  it("takes a name with spaces whole (BSD prints it as is), the longest first", () => {
    expect(linksOf("My Notes.txt   a.txt", "/home/u", home)).toEqual([
      { text: "My Notes.txt", kind: "file", path: "/home/u/My Notes.txt" },
      { text: "a.txt", kind: "file", path: "/home/u/a.txt" },
    ]);
  });

  it("reads GNU's quotes and `ls -F` marks without underlining the mark", () => {
    expect(linksOf("'My Notes.txt'  run.sh*  src/", "/home/u", home)).toEqual([
      { text: "'My Notes.txt'", kind: "file", path: "/home/u/My Notes.txt" },
      { text: "run.sh", kind: "file", path: "/home/u/run.sh" },
      { text: "src/", kind: "dir", path: "/home/u/src" },
    ]);
    expect(linksOf(`"it's.md"`, "/home/u", home)).toEqual([
      { text: `"it's.md"`, kind: "file", path: "/home/u/it's.md" },
    ]);
  });

  it("links the name of an `ls -l` line and its symlink target", () => {
    const line = "lrwxr-xr-x  1 u  staff  5 Oct 28 14:03 link.txt -> a.txt";
    const listing = { "/home/u": { "a.txt": "file", "link.txt": "file" } } as const;
    expect(linksOf(line, "/home/u", listing).map((l) => l.text)).toEqual(["link.txt", "a.txt"]);
  });

  it("links a path in prose, without the punctuation around it", () => {
    const listing = { "/etc": { hosts: "file" }, "/etc/nginx": { "nginx.conf": "file" } } as const;
    expect(linksOf("see (/etc/hosts). Also /etc/nginx/nginx.conf:", null, listing)).toEqual([
      { text: "/etc/hosts", kind: "file", path: "/etc/hosts" },
      { text: "/etc/nginx/nginx.conf", kind: "file", path: "/etc/nginx/nginx.conf" },
    ]);
  });

  it("wants a folder where the name ends with a slash", () => {
    const listing = { "/x": { notdir: "file" } } as const;
    expect(linksOf("notdir/", "/x", listing)).toEqual([]);
  });

  it("leaves folders as text when the file panel cannot show them", () => {
    expect(linksOf("a.txt  src", "/home/u", home, { dirs: false }).map((l) => l.text)).toEqual(["a.txt"]);
  });

  it("matches Windows names whatever their case", () => {
    const listing = { "C:\\Users\\bob": { "Readme.TXT": "file" } } as const;
    expect(linksOf("10/28/2026  02:00 PM   12 readme.txt", "C:\\Users\\bob", listing, { style: "windows" })).toEqual([
      { text: "readme.txt", kind: "file", path: "C:\\Users\\bob\\readme.txt" },
    ]);
  });

  it("links nothing in a folder that was not listed", () => {
    expect(linksOf("a.txt", "/elsewhere", home)).toEqual([]);
    expect(linksOf("a.txt", null, home)).toEqual([]);
  });

  it("never overlaps two links", () => {
    const listing = { "/x": { "a b": "file", b: "file" } } as const;
    expect(linksOf("a b", "/x", listing).map((l) => l.text)).toEqual(["a b"]);
  });
});

describe("dirsToList", () => {
  it("asks for the line's folder first, then the folders of paths", () => {
    const cands = lineCandidates("a.txt /etc/hosts /var/log/x.log", "/home/u", "posix");
    expect(dirsToList(cands, "/home/u")).toEqual(["/home/u", "/etc", "/var/log"]);
  });

  it("stops at the cap", () => {
    const text = Array.from({ length: 10 }, (_, i) => `/d${i}/f`).join(" ");
    expect(dirsToList(lineCandidates(text, null, "posix"), null)).toHaveLength(MAX_DIRS_PER_LINE);
  });

  it("has nothing to list where nothing can be placed", () => {
    expect(dirsToList(lineCandidates("a.txt b.txt", null, "posix"), null)).toEqual([]);
  });
});

describe("entryKind / listingOf", () => {
  it("opens folders and regular files and links, never a pipe, socket or device", () => {
    expect(entryKind({ isDir: true, mode: 0o040755 })).toBe("dir");
    expect(entryKind({ isDir: false, mode: 0o100644 })).toBe("file");
    expect(entryKind({ isDir: false, mode: 0o120777 })).toBe("file");
    expect(entryKind({ isDir: false, mode: 0o644 })).toBe("file");
    expect(entryKind({ isDir: false, mode: null })).toBe("file");
    expect(entryKind({ isDir: false, mode: 0o010644 })).toBeNull();
    expect(entryKind({ isDir: false, mode: 0o140755 })).toBeNull();
    expect(entryKind({ isDir: false, mode: 0o020620 })).toBeNull();
  });

  it("keys Windows names in lower case and leaves out what cannot open", () => {
    const l = listingOf(
      [
        { name: "A.txt", isDir: false, mode: null },
        { name: "fifo", isDir: false, mode: 0o010644 },
      ],
      "windows",
    );
    expect([...l.entries()]).toEqual([["a.txt", "file"]]);
  });
});

describe("listingCommand", () => {
  it("finds the listing after the prompt", () => {
    expect(listingCommand("user@host:~$ ls", "posix")).toEqual({ dir: null, several: false });
    expect(listingCommand("user@host:~$ ls -la /etc", "posix")).toEqual({ dir: "/etc", several: false });
    expect(listingCommand("[u@h ~]# ll nginx/", "posix")).toEqual({ dir: "nginx/", several: false });
    expect(listingCommand("u@mac vterm % ls 'my dir'", "posix")).toEqual({ dir: "my dir", several: false });
    expect(listingCommand("ls", "posix")).toEqual({ dir: null, several: false });
    expect(listingCommand("➜  vterm git:(main) ✗ ls src", "posix")).toEqual({ dir: "src", several: false });
  });

  it("says when several folders are listed", () => {
    expect(listingCommand("$ ls a b", "posix")).toEqual({ dir: null, several: true });
    expect(listingCommand("$ ls -laR", "posix")).toEqual({ dir: null, several: true });
    expect(listingCommand("$ ls --recursive x", "posix")).toEqual({ dir: null, several: true });
    expect(listingCommand("$ ls *.conf", "posix")).toEqual({ dir: null, several: true });
    expect(listingCommand("$ ls -- -odd", "posix")).toEqual({ dir: "-odd", several: false });
  });

  it("does not take POSIX `-s` for recursion", () => {
    expect(listingCommand("$ ls -s", "posix")).toEqual({ dir: null, several: false });
  });

  it("reads cmd and PowerShell", () => {
    expect(listingCommand("C:\\Users\\bob>dir", "windows")).toEqual({ dir: null, several: false });
    expect(listingCommand("C:\\Users\\bob>dir /s", "windows")).toEqual({ dir: null, several: true });
    expect(listingCommand("PS C:\\Users\\bob> dir C:\\Windows", "windows")).toEqual({
      dir: "C:\\Windows",
      several: false,
    });
    expect(listingCommand("PS C:\\> Get-ChildItem -Recurse", "windows")).toEqual({ dir: null, several: true });
  });

  it("is null for any other command, or a lister's name inside a word", () => {
    expect(listingCommand("$ cat ls.txt", "posix")).toBeNull();
    expect(listingCommand("$ sudo ls /root", "posix")).toBeNull();
    expect(listingCommand("u@h:~/ls-tool$ make", "posix")).toBeNull();
    expect(listingCommand("", "posix")).toBeNull();
  });
});

describe("headerDir / listingDir", () => {
  it("reads `dir` and PowerShell headers, whatever the label's language", () => {
    expect(headerDir(" Directory of C:\\Users\\bob", "windows", false)).toBe("C:\\Users\\bob");
    expect(headerDir(" Содержимое папки C:\\Program Files", "windows", false)).toBe("C:\\Program Files");
    expect(headerDir("    Directory: C:\\Users\\bob", "windows", false)).toBe("C:\\Users\\bob");
    expect(headerDir("10/28/2026  02:00 PM    <DIR>          foo", "windows", false)).toBeNull();
    expect(headerDir("C:\\Users\\bob\\a.txt", "windows", false)).toBeNull();
  });

  it("reads `ls a b` headers only where several folders were listed", () => {
    expect(headerDir("src:", "posix", true)).toBe("src");
    expect(headerDir("src:", "posix", false)).toBeNull();
    expect(headerDir("total 8", "posix", true)).toBeNull();
  });

  it("places a line by its header, else the command's folder, else where it ran", () => {
    expect(listingDir("/home/u", null, null, "posix")).toBe("/home/u");
    expect(listingDir("/home/u", { dir: "/etc", several: false }, null, "posix")).toBe("/etc");
    expect(listingDir("/home/u", { dir: "src/", several: false }, null, "posix")).toBe("/home/u/src");
    expect(listingDir("/home/u", { dir: "..", several: false }, null, "posix")).toBe("/home");
    expect(listingDir("/home/u", { dir: null, several: true }, "lib", "posix")).toBe("/home/u/lib");
    expect(listingDir(null, { dir: "/etc", several: false }, null, "posix")).toBe("/etc");
    expect(listingDir(null, { dir: "src", several: false }, null, "posix")).toBeNull();
    expect(listingDir(null, null, "C:\\x", "windows")).toBe("C:\\x");
  });
});

describe("unplacedNames", () => {
  const texts = (line: string) => unplacedNames(line).map((s) => line.slice(s.from, s.to));

  it("takes the name after an `ls -l` date, without its link target", () => {
    expect(texts("-rw-r--r--  1 boris  staff  1234 Oct 28 14:03 notes.txt")).toEqual(["notes.txt"]);
    expect(texts("-rw-r--r-- 1 root root 4096 окт 28  2025 my file")).toEqual(["my file"]);
    expect(texts("drwxr-xr-x 2 root root 4096 2026-10-28 14:03 conf.d")).toEqual(["conf.d"]);
    expect(texts("lrwxrwxrwx 1 root root 7 2026-10-28 14:03:05.123 +0300 bin -> usr/bin")).toEqual(["bin"]);
    expect(texts("-rw-r--r--. 1 root root 12 28 окт 14:03 x")).toEqual(["x"]);
  });

  it("takes nothing from an `ls -l` line it cannot read", () => {
    expect(texts("-rw-r--r-- garbage")).toEqual([]);
  });

  it("takes the words of a column listing that are not numbers", () => {
    expect(texts("total 48")).toEqual([]);
    expect(texts("a.txt  b  1.5K  42")).toEqual(["a.txt", "b"]);
  });
});

describe("blockAt", () => {
  it("finds the last block starting at or above the line", () => {
    expect(blockAt([], 5)).toBe(-1);
    expect(blockAt([3, 10, 20], 2)).toBe(-1);
    expect(blockAt([3, 10, 20], 3)).toBe(0);
    expect(blockAt([3, 10, 20], 15)).toBe(1);
    expect(blockAt([3, 10, 20], 99)).toBe(2);
  });
});
