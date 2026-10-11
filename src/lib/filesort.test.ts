import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  firstDir,
  isSortKey,
  nextSort,
  sameSort,
  sanitizeSort,
  SORT_KEYS,
  sortEntries,
  sortMenu,
  type FileSort,
} from "./filesort";
import type { FileEntry } from "./types";

const entry = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/srv/${name}`,
  isDir: false,
  isSymlink: false,
  size: 0,
  modified: null,
  mode: 0o644,
  uid: 0,
  gid: 0,
  user: "root",
  group: "root",
  ...over,
});
const dir = (name: string, over: Partial<FileEntry> = {}) => entry(name, { isDir: true, mode: 0o755, ...over });
const names = (list: FileEntry[]) => list.map((e) => e.name);
const by = (key: FileSort["key"], d: FileSort["dir"]): FileSort => ({ key, dir: d });

const LISTING = [
  entry("nginx.conf", { size: 2400, modified: 300 }),
  dir("sites-enabled", { modified: 100 }),
  entry("Mime.types", { size: 5300, modified: 50 }),
  dir("conf.d", { modified: 200 }),
  entry("upstreams.conf", { size: 812, modified: 250, user: "deploy", group: "www", mode: 0o640 }),
];

describe("the orders there are", () => {
  it("a listing can be ordered by each of its columns", () => {
    expect([...SORT_KEYS]).toEqual(["name", "size", "mode", "owner", "modified"]);
    expect(DEFAULT_SORT).toEqual({ key: "name", dir: "asc" });
  });

  it("text starts A→Z, a size and a time start with the biggest and the latest", () => {
    expect(SORT_KEYS.map(firstDir)).toEqual(["asc", "desc", "asc", "asc", "desc"]);
  });

  it("a click on another column takes that column; on the same one — turns it round", () => {
    expect(nextSort(DEFAULT_SORT, "modified")).toEqual(by("modified", "desc"));
    expect(nextSort(by("modified", "desc"), "modified")).toEqual(by("modified", "asc"));
    expect(nextSort(by("modified", "asc"), "modified")).toEqual(by("modified", "desc"));
    expect(nextSort(by("modified", "asc"), "name")).toEqual(by("name", "asc"));
    expect(nextSort(DEFAULT_SORT, "name")).toEqual(by("name", "desc"));
  });

  it("reads a stored choice, and falls back to the default for anything else", () => {
    expect(sanitizeSort({ key: "size", dir: "asc" })).toEqual(by("size", "asc"));
    expect(sanitizeSort({ key: "size" })).toEqual(by("size", "desc"));
    expect(sanitizeSort({ key: "size", dir: "sideways" })).toEqual(by("size", "desc"));
    for (const raw of [null, undefined, "name", 3, [], {}, { key: "colour", dir: "asc" }, { dir: "desc" }]) {
      expect(sanitizeSort(raw)).toEqual(DEFAULT_SORT);
    }
    expect(sanitizeSort(null)).not.toBe(DEFAULT_SORT);
    expect(isSortKey("owner")).toBe(true);
    expect(isSortKey("Owner")).toBe(false);
    expect(sameSort(by("size", "asc"), by("size", "asc"))).toBe(true);
    expect(sameSort(by("size", "asc"), by("size", "desc"))).toBe(false);
  });
});

describe("sortEntries", () => {
  it("by name is the order the backend gave: folders first, case-insensitive", () => {
    expect(names(sortEntries(LISTING, DEFAULT_SORT))).toEqual([
      "conf.d",
      "sites-enabled",
      "Mime.types",
      "nginx.conf",
      "upstreams.conf",
    ]);
  });

  it("the other way round folders still stand above files", () => {
    expect(names(sortEntries(LISTING, by("name", "desc")))).toEqual([
      "sites-enabled",
      "conf.d",
      "upstreams.conf",
      "nginx.conf",
      "Mime.types",
    ]);
  });

  it("by time: each group by its own times", () => {
    expect(names(sortEntries(LISTING, by("modified", "desc")))).toEqual([
      "conf.d",
      "sites-enabled",
      "nginx.conf",
      "upstreams.conf",
      "Mime.types",
    ]);
    expect(names(sortEntries(LISTING, by("modified", "asc")))).toEqual([
      "sites-enabled",
      "conf.d",
      "Mime.types",
      "upstreams.conf",
      "nginx.conf",
    ]);
  });

  it("by size: files by size, folders — which have none — by name, either way", () => {
    expect(names(sortEntries(LISTING, by("size", "desc")))).toEqual([
      "conf.d",
      "sites-enabled",
      "Mime.types",
      "nginx.conf",
      "upstreams.conf",
    ]);
    expect(names(sortEntries(LISTING, by("size", "asc"))).slice(0, 2)).toEqual(["conf.d", "sites-enabled"]);
    expect(names(sortEntries(LISTING, by("size", "asc"))).slice(2)).toEqual([
      "upstreams.conf",
      "nginx.conf",
      "Mime.types",
    ]);
  });

  it("by owner and by permissions", () => {
    expect(names(sortEntries(LISTING, by("owner", "asc"))).slice(2)).toEqual([
      "upstreams.conf",
      "Mime.types",
      "nginx.conf",
    ]);
    expect(names(sortEntries(LISTING, by("mode", "asc"))).slice(2)).toEqual([
      "upstreams.conf",
      "Mime.types",
      "nginx.conf",
    ]);
  });

  it("a time the listing did not report goes last — whichever way the order runs", () => {
    const list = [entry("known", { modified: 500 }), entry("unknown"), entry("older", { modified: 10 })];
    expect(names(sortEntries(list, by("modified", "desc")))).toEqual(["known", "older", "unknown"]);
    expect(names(sortEntries(list, by("modified", "asc")))).toEqual(["older", "known", "unknown"]);
  });

  it("an owner nobody named goes last too, and a Windows entry has none", () => {
    const list = [
      entry("b", { user: null, group: null, uid: null, gid: null }),
      entry("a", { user: "zed", group: "zed" }),
      entry("c", { mode: null, attrs: "-a---", user: null, group: null, uid: null, gid: null }),
      entry("d", { user: "amy", group: "amy" }),
    ];
    expect(names(sortEntries(list, by("owner", "asc")))).toEqual(["d", "a", "b", "c"]);
    expect(names(sortEntries(list, by("owner", "desc")))).toEqual(["a", "d", "b", "c"]);
  });

  it("Windows attribute strings order the permissions column where there are no bits", () => {
    const list = [
      entry("z", { mode: null, attrs: "-ar--" }),
      entry("y", { mode: null, attrs: "-a---" }),
      entry("x", { mode: null, attrs: null }),
    ];
    expect(names(sortEntries(list, by("mode", "asc")))).toEqual(["y", "z", "x"]);
  });

  it("equal values fall back to the name", () => {
    const list = [entry("b", { size: 10 }), entry("a", { size: 10 }), entry("c", { size: 10 })];
    expect(names(sortEntries(list, by("size", "desc")))).toEqual(["a", "b", "c"]);
    expect(names(sortEntries(list, by("size", "asc")))).toEqual(["a", "b", "c"]);
  });

  it("does not touch the list it was given", () => {
    const before = names(LISTING);
    sortEntries(LISTING, by("size", "desc"));
    expect(names(LISTING)).toEqual(before);
  });

  const anyEntry = fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 6 }),
      isDir: fc.boolean(),
      size: fc.nat(5000),
      modified: fc.option(fc.nat(1000), { nil: null }),
      mode: fc.option(fc.nat(0o777), { nil: null }),
      user: fc.option(fc.constantFrom("root", "deploy", "www"), { nil: null }),
    })
    .map((r): FileEntry => entry(r.name, { ...r, path: `/x/${r.name}`, group: r.user, uid: null, gid: null }));
  const anySort = fc.record({ key: fc.constantFrom(...SORT_KEYS), dir: fc.constantFrom("asc" as const, "desc" as const) });

  it("in every order: nothing lost, folders first, and the same listing never comes out two ways", () => {
    fc.assert(
      fc.property(fc.uniqueArray(anyEntry, { maxLength: 30, selector: (e) => e.name }), anySort, (list, sort) => {
        const out = sortEntries(list, sort);
        expect([...names(out)].sort()).toEqual([...names(list)].sort());
        const firstFile = out.findIndex((e) => !e.isDir);
        if (firstFile >= 0) expect(out.slice(firstFile).every((e) => !e.isDir)).toBe(true);
        // Total: shuffling the input does not change the answer.
        expect(names(sortEntries([...list].reverse(), sort))).toEqual(names(out));
        // Sorted once is sorted.
        expect(names(sortEntries(out, sort))).toEqual(names(out));
      }),
    );
  });

  it("turning an order round reverses what has a value, within its group — the unknown stay last", () => {
    fc.assert(
      fc.property(fc.uniqueArray(anyEntry, { maxLength: 30, selector: (e) => e.name }), (list) => {
        const files = (l: FileEntry[]) => l.filter((e) => !e.isDir);
        const down = files(sortEntries(list, by("modified", "desc")));
        const up = files(sortEntries(list, by("modified", "asc")));
        const known = (l: FileEntry[]) => l.filter((e) => e.modified !== null).map((e) => e.modified);
        expect(known(up)).toEqual([...known(down)].reverse());
        const tail = (l: FileEntry[]) => l.slice(known(l).length);
        expect(tail(down).every((e) => e.modified === null)).toBe(true);
        expect(names(tail(up))).toEqual(names(tail(down)));
      }),
    );
  });
});

describe("sortMenu", () => {
  const labels = { key: (k: string) => `col:${k}`, dir: (d: string) => `dir:${d}` };
  const rows = (items: ReturnType<typeof sortMenu>) =>
    items.flatMap((i) => (i.kind === "separator" || i.kind === "submenu" ? [] : [i]));

  it("lists the columns, then the two directions, the current ones ticked", () => {
    const items = sortMenu({ key: "modified", dir: "desc" }, labels, () => {});
    expect(rows(items).map((r) => r.label)).toEqual([
      "col:name",
      "col:size",
      "col:mode",
      "col:owner",
      "col:modified",
      "dir:asc",
      "dir:desc",
    ]);
    expect(rows(items).filter((r) => r.checked).map((r) => r.label)).toEqual(["col:modified", "dir:desc"]);
    expect(items[SORT_KEYS.length]).toEqual({ kind: "separator" });
    // Every row is a switch: the tick column is kept for the unticked ones too.
    expect(rows(items).every((r) => r.checked !== undefined)).toBe(true);
  });

  it("another column starts in its own first direction; the same one changes nothing", () => {
    const picked: FileSort[] = [];
    const items = rows(sortMenu({ key: "name", dir: "desc" }, labels, (s) => picked.push(s)));
    items.find((r) => r.label === "col:size")!.onSelect();
    items.find((r) => r.label === "col:owner")!.onSelect();
    items.find((r) => r.label === "col:name")!.onSelect();
    expect(picked).toEqual([
      { key: "size", dir: "desc" },
      { key: "owner", dir: "asc" },
      { key: "name", dir: "desc" },
    ]);
  });

  it("a direction keeps the column", () => {
    const picked: FileSort[] = [];
    const items = rows(sortMenu({ key: "size", dir: "desc" }, labels, (s) => picked.push(s)));
    items.find((r) => r.label === "dir:asc")!.onSelect();
    expect(picked).toEqual([{ key: "size", dir: "asc" }]);
  });
});
