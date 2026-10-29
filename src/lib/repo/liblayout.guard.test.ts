// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A front-end module lives in the folder of its subsystem (v1.25.6, ADR 0045).
// Until then the root of src/lib held ~540 files side by side, and finding the
// files of one subsystem meant knowing their names. Three places agree on the
// folders: the tree itself, the directory tree in docs/ARCHITECTURE.md (which
// says what each folder holds), and LAYER_DIRS in lint/vterm.js (which folders
// are layers rather than subsystems — `vterm/layers` holds the `.ts` of every
// other folder to purity, so a renamed layer folder would turn its modules into
// "pure logic" without a word). Each check is a function over the listing or the
// text, and shows it catches its own violation.

const ROOT = process.cwd();
const LIB = join(ROOT, "src", "lib");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The one file the root of src/lib keeps: the mirror of the Rust models, under every layer. */
const ROOT_FILES = ["types.ts"];

type Entry = { name: string; dir: boolean };

const listing = (): Entry[] =>
  readdirSync(LIB, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));

/** Files at the root of src/lib that belong in a folder (dotfiles of the OS aside). */
export function rootStrays(entries: Entry[]): string[] {
  return entries
    .filter((e) => !e.dir && !e.name.startsWith(".") && !ROOT_FILES.includes(e.name))
    .map((e) => e.name);
}

/** The folders the directory tree of ARCHITECTURE.md names under `lib/`. */
export function treeFolders(architecture: string): string[] {
  // The tree's own `lib/` line; the layer diagram above it names `lib/stores/` and the like.
  const from = /── lib\/\s/.exec(architecture)?.index ?? -1;
  const to = architecture.indexOf("── src-tauri/", from);
  if (from < 0 || to < 0) return [];
  return [...architecture.slice(from + "── lib/".length, to).matchAll(/── ([\w-]+)\/\s/g)].map((m) => m[1]);
}

/** Folders of src/lib the tree does not name, and names in the tree with no folder. */
export function treeMismatch(folders: string[], named: string[]): string[] {
  return [
    ...folders.filter((f) => !named.includes(f)).map((f) => `${f}/: a folder of src/lib the ARCHITECTURE tree does not name`),
    ...named.filter((n) => !folders.includes(n)).map((n) => `${n}/: named in the ARCHITECTURE tree, no such folder`),
  ];
}

/** LAYER_DIRS of lint/vterm.js. */
export function layerDirs(lint: string): string[] {
  const list = /const LAYER_DIRS = \[([^\]]*)\]/.exec(lint)?.[1] ?? "";
  return [...list.matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
}

describe("src/lib layout guard", () => {
  const entries = listing();
  const folders = entries.filter((e) => e.dir).map((e) => e.name);

  it("the root of src/lib holds folders and types.ts, nothing else", () => {
    expect(rootStrays(entries)).toEqual([]);
    expect(entries.some((e) => e.name === "types.ts" && !e.dir)).toBe(true);
    expect(
      rootStrays([
        { name: "types.ts", dir: false },
        { name: "terminal", dir: true },
        { name: ".DS_Store", dir: false },
        { name: "termcmd.ts", dir: false },
        { name: "Terminal.svelte", dir: false },
      ]),
    ).toEqual(["termcmd.ts", "Terminal.svelte"]);
  });

  it("every folder is named in the ARCHITECTURE tree, and every name there is a folder", () => {
    const named = treeFolders(read("docs/ARCHITECTURE.md"));
    expect(named.length).toBeGreaterThan(20);
    expect(treeMismatch(folders, named)).toEqual([]);
    expect(treeMismatch([...folders, "widgets"], named.filter((n) => n !== "ui"))).toEqual([
      "ui/: a folder of src/lib the ARCHITECTURE tree does not name",
      "widgets/: a folder of src/lib the ARCHITECTURE tree does not name",
    ]);
    expect(treeMismatch(folders.filter((f) => f !== "sync"), named)).toEqual([
      "sync/: named in the ARCHITECTURE tree, no such folder",
    ]);
    // Only the lib/ subtree counts: src-tauri/ and the folders after it are not src/lib.
    const tree =
      "│ ├── lib/stores/ — runes │\n│   └── lib/   # x\n│       ├── ui/   # y\n│       └── api/   # z\n├── src-tauri/\n│   ├── src/   # w\n";
    expect(treeFolders(tree)).toEqual(["ui", "api"]);
  });

  it("each layer folder named in lint/vterm.js exists", () => {
    const layers = layerDirs(read("lint/vterm.js"));
    expect(layers).toEqual(expect.arrayContaining(["api", "stores", "page"]));
    expect(layers.filter((l) => !folders.includes(l))).toEqual([]);
    // A layer renamed in the tree but not in the linter is caught.
    expect(layerDirs('const LAYER_DIRS = ["actions", "state"];').filter((l) => !folders.includes(l))).toEqual([
      "state",
    ]);
  });
});
