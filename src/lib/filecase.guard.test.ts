// File-name case guard: no two paths in the repo differ only by case.
//
// macOS and Windows volumes ignore case by default, so `K8sRoute.test.ts` and
// `k8sroute.test.ts` are one file there and two on Linux. Writing the second on
// a Mac silently replaced the first — 400 lines of model tests, no error from
// any tool — and the commit then carried a single path, so CI had nothing to
// notice. The reverse breaks too: two such paths committed from Linux cannot
// both be checked out on macOS or Windows.
//
// Three checks, because no single one sees every case:
//   1. the working tree — where a pair committed from Linux shows up in CI;
//   2. the git index — the same pair on a volume that holds only one of them;
//   3. the tests the tree implies — `K8sRoute.svelte` beside `k8sroute.ts` is
//      legal on any volume, but by convention both are tested in
//      `<name>.test.ts`, and those two are one file. This is the only check
//      that sees the overwrite coming on the machine where it happens.
//
// A real collision cannot be created on a case-insensitive volume — the second
// file IS the first — so check 1 can never fail on a developer's Mac, and the
// proof it keeps against a live violation has to be the synthetic lists below.
// Seeing it fail for real takes a case-sensitive volume (docs/TESTS.md).

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
// Where tracked files live. Top-level files are covered by the index check.
const ROOTS = ["src", "src-tauri", "scripts", "docs", "static", "e2e", ".github"];
const SKIP = new Set(["node_modules", "target", ".svelte-kit", "build"]);

// Pairs that predate the guard, with the reason each still stands. An entry is
// a debt, not a licence: it holds only while the component has no test.
const KNOWN_CLASHES: Record<string, string> = {
  "src/lib/FileBrowser.svelte ↔ src/lib/filebrowser.ts":
    "FileBrowser.svelte takes no FileBrowser.test.ts (excluded from coverage; its " +
    "behaviour tests are pathbar/localdrives/sftp*.test.ts), so filebrowser.test.ts has no rival",
};

/** Repo-relative, `/`-separated paths of every file under the roots. */
function treePaths(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  for (const root of ROOTS) walk(root);
  return out;
}

/** Every path in the git index, or null where there is none to read (a source
 *  tarball, an image without git). */
function indexPaths(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Groups of paths a case-insensitive volume holds as one entry: the same
 * directory as written, names equal once case is ignored. Directories count —
 * `src/Lib/a.ts` beside `src/lib/b.ts` is two spellings of one folder.
 */
export function caseCollisions(paths: string[]): string[][] {
  const spellings = new Map<string, Set<string>>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const key = `${dir}\0${parts[i].toLowerCase()}`;
      let seen = spellings.get(key);
      if (!seen) spellings.set(key, (seen = new Set()));
      seen.add(parts.slice(0, i + 1).join("/"));
    }
  }
  return [...spellings.values()]
    .filter((seen) => seen.size > 1)
    .map((seen) => [...seen].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Where the repo keeps a front-end source's test: `foo.ts`, `foo.svelte.ts`
 *  and `Foo.svelte` all go to `<name>.test.ts` beside them. Null for tests and
 *  for anything vitest does not pick up. */
export function testPathOf(path: string): string | null {
  if (!path.startsWith("src/") || /\.(test|spec|d)\.ts$/.test(path)) return null;
  const source = /^(.*?)(\.svelte\.ts|\.svelte|\.ts)$/.exec(path);
  return source ? `${source[1]}.test.ts` : null;
}

/** Sources whose conventional test files would be one file. */
export function testClashes(paths: string[]): string[][] {
  const sourceOf = new Map<string, string>();
  for (const path of paths) {
    const test = testPathOf(path);
    if (test) sourceOf.set(test, path);
  }
  return caseCollisions([...sourceOf.keys()])
    .filter((tests) => tests.every((test) => sourceOf.has(test)))
    .map((tests) => tests.map((test) => sourceOf.get(test)!));
}

const pairs = (groups: string[][]) => groups.map((group) => group.join(" ↔ "));

describe("file-name case guard", () => {
  const tree = treePaths();
  const index = indexPaths();

  it("no two paths in the tree differ only by case", () => {
    expect(tree.length).toBeGreaterThan(0);
    const found = pairs(caseCollisions(tree));
    expect(found, `one file on macOS and Windows:\n${found.join("\n")}`).toEqual([]);
  });

  it.skipIf(index === null)("no two paths in the git index differ only by case", () => {
    expect(index!.length).toBeGreaterThan(0);
    const found = pairs(caseCollisions(index!));
    expect(
      found,
      `both are in the index, a macOS or Windows checkout holds one of them:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("no two sources would share a test file", () => {
    const found = pairs(testClashes(tree)).filter((pair) => !(pair in KNOWN_CLASHES));
    expect(
      found,
      `their <name>.test.ts are one file on macOS and Windows — give the component ` +
        `a base name that differs by more than case:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("an exemption that no longer applies is removed", () => {
    const live = pairs(testClashes(tree));
    const stale = Object.keys(KNOWN_CLASHES).filter((pair) => !live.includes(pair));
    expect(stale, `no longer a clash — drop from KNOWN_CLASHES:\n${stale.join("\n")}`).toEqual([]);
  });

  it("catches two files that differ only by case", () => {
    expect(caseCollisions(["src/lib/K8sRoute.test.ts", "src/lib/k8sroute.test.ts"])).toEqual([
      ["src/lib/K8sRoute.test.ts", "src/lib/k8sroute.test.ts"],
    ]);
    // Same name elsewhere, or a different extension, is not a collision.
    expect(
      caseCollisions([
        "src/lib/k8sroute.test.ts",
        "src/lib/stores/K8sRoute.test.ts",
        "src/lib/K8sRoute.svelte",
        "src/lib/k8sroute.ts",
      ]),
    ).toEqual([]);
  });

  it("catches two spellings of one directory, once", () => {
    expect(caseCollisions(["src/Lib/a.ts", "src/lib/a.ts", "src/lib/b.ts"])).toEqual([
      ["src/Lib", "src/lib"],
    ]);
  });

  it("catches a component named like its module before either test exists", () => {
    expect(testClashes(["src/lib/K8sRoute.svelte", "src/lib/k8sroute.ts"])).toEqual([
      ["src/lib/K8sRoute.svelte", "src/lib/k8sroute.ts"],
    ]);
    expect(testClashes(["src/lib/Tabs.svelte", "src/lib/tabs.svelte.ts"])).toHaveLength(1);
    // The rename that fixed it, and files that are not tested by this convention.
    expect(testClashes(["src/lib/K8sRouteView.svelte", "src/lib/k8sroute.ts"])).toEqual([]);
    expect(testClashes(["scripts/Icons.ts", "scripts/icons.svelte"])).toEqual([]);
    expect(testClashes(["src/lib/K8s.test.ts", "src/lib/k8s.guard.test.ts"])).toEqual([]);
  });
});
