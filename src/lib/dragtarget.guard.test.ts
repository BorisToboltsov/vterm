// Drag-target guard (v1.11.2): what a tab strip is drawn from while something
// is dragged is written only when it changes.
//
// A drag works out where its tab would land on every pointer move, and the
// strips draw the order that drop would give. The natural line —
// `drag.over = hit.drop` — hands the store a new object on each move, equal to
// the last one or not; the strip's `{#each}` then gets a new list, and Svelte
// answers a new list by measuring every tab in it and starting every slide
// (`animate:glide`) over from where the tab stands. A slide starts with a frame
// of standing still, so tabs that had just begun to give way moved in jerks for
// as long as the pointer did — and it showed only in the terminal strip, where
// the pointer keeps moving over the slot it has taken.
//
//  1. In every drag store, a field that holds an object the strips are drawn
//     from — the target, the tinted part of a pane, the tab held over the
//     window — is assigned behind a comparison with what it holds. Clearing it
//     (`= null`) needs none: null is null again.
//  2. A store that keeps a drop target is in the table below. A new drag is
//     asked the same without anyone remembering to.
//
// Sources are read with comments stripped — the comments name the anti-pattern.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** The drag stores, and the fields of each that hold an object a strip is drawn from. */
const DRAGS: Record<string, readonly string[]> = {
  "lib/stores/dockdrag.svelte.ts": ["over"],
  "lib/stores/filedrag.svelte.ts": ["over", "zone"],
  "lib/stores/tabdrag.svelte.ts": ["over", "zone"],
  "lib/stores/tabincoming.svelte.ts": ["tab", "over", "zone"],
  "lib/stores/viewdrag.svelte.ts": ["over", "zone", "area"],
};

/** Source with comments removed — block and line (`://` is not a comment). */
function code(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const raw = (rel: string): string => readFileSync(join(SRC, ...rel.split("/")), "utf8");

/** Every non-test source file under `src/`, as a path relative to it. */
function sources(dir = SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      acc.push(relative(SRC, full).split(sep).join("/"));
    }
  }
  return acc;
}

/** The file keeps a drop target: something assigns to an `.over`. */
const KEEPS_TARGET = /\b\w+\.over\s*=(?!=)/;

/**
 * Assignments to `fields` that hand the store a value without asking whether
 * it is the one already there.
 */
export function targetViolations(rel: string, source: string, fields: readonly string[]): string[] {
  const out: string[] = [];
  const assign = new RegExp(`\\b(\\w+)\\.(${fields.join("|")})\\s*=(?!=)\\s*([^;]+);`);
  for (const line of code(source).split("\n")) {
    const m = assign.exec(line);
    if (!m) continue;
    const [, store, field, value] = m;
    if (value.trim() === "null") continue;
    // The comparison is with this very field, and the assignment is all it guards.
    const guarded = new RegExp(
      `^\\s*if \\(!same\\w+\\(${store}\\.${field}, [^)]+\\)\\) ${store}\\.${field} = `,
    );
    if (!guarded.test(line)) {
      out.push(`${rel}: \`${line.trim()}\` writes ${store}.${field} without comparing it first`);
    }
  }
  return out;
}

/** Files that keep a drop target and are not in the table. */
export function unlistedDrags(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([rel, source]) => KEEPS_TARGET.test(code(source)) && !(rel in DRAGS))
    .map(([rel]) => `${rel} keeps a drop target and is not in DRAGS`);
}

describe("drag-target guard", () => {
  it("every drag store writes its target only when it is another one", () => {
    for (const [rel, fields] of Object.entries(DRAGS)) {
      const source = raw(rel);
      // The store still keeps a target — or the table has gone stale.
      expect(KEEPS_TARGET.test(code(source)), rel).toBe(true);
      expect(targetViolations(rel, source, fields)).toEqual([]);
    }
  });

  it("every store that keeps a drop target is one of them", () => {
    const files = Object.fromEntries(sources().map((rel) => [rel, raw(rel)]));
    expect(unlistedDrags(files)).toEqual([]);
  });
});

describe("drag-target guard — catches what it exists for", () => {
  const TABDRAG = "lib/stores/tabdrag.svelte.ts";
  const tabdrag = raw(TABDRAG);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("the target written on every move", () => {
    const broken = mutate(
      tabdrag,
      "  if (!sameDrop(tabDrag.over, drop)) tabDrag.over = drop;",
      "  tabDrag.over = drop;",
    );
    expect(targetViolations(TABDRAG, broken, DRAGS[TABDRAG])).toEqual([
      `${TABDRAG}: \`tabDrag.over = drop;\` writes tabDrag.over without comparing it first`,
    ]);
  });

  it("a comparison of something else does not count", () => {
    const broken = mutate(
      tabdrag,
      "  if (!sameRect(tabDrag.zone, zone)) tabDrag.zone = zone;",
      "  if (!sameDrop(tabDrag.over, drop)) tabDrag.zone = zone;",
    );
    expect(targetViolations(TABDRAG, broken, DRAGS[TABDRAG])).toHaveLength(1);
    // Nor does one that guards more than the assignment.
    expect(
      targetViolations(TABDRAG, "if (moved) tabDrag.over = hit.drop;", DRAGS[TABDRAG]),
    ).toHaveLength(1);
  });

  it("the tab held over the window, the dock's target, a view's area", () => {
    const INCOMING = "lib/stores/tabincoming.svelte.ts";
    expect(
      targetViolations(
        INCOMING,
        mutate(
          raw(INCOMING),
          "  if (!sameTab(incoming.tab, msg.tab)) incoming.tab = msg.tab;",
          "  incoming.tab = msg.tab;",
        ),
        DRAGS[INCOMING],
      ),
    ).toHaveLength(1);
    const DOCK = "lib/stores/dockdrag.svelte.ts";
    expect(
      targetViolations(
        DOCK,
        mutate(
          raw(DOCK),
          "  if (!sameTarget(dockDrag.over, next)) dockDrag.over = next;",
          "  dockDrag.over = next;",
        ),
        DRAGS[DOCK],
      ),
    ).toHaveLength(1);
    const VIEW = "lib/stores/viewdrag.svelte.ts";
    expect(
      targetViolations(
        VIEW,
        mutate(
          raw(VIEW),
          "  if (!sameRect(viewDrag.area, area)) viewDrag.area = area;",
          "  viewDrag.area = area;",
        ),
        DRAGS[VIEW],
      ),
    ).toHaveLength(1);
  });

  it("clearing a target, and naming the anti-pattern in a comment, are fine", () => {
    expect(targetViolations(TABDRAG, "tabDrag.over = null;\ntabDrag.zone = null;", ["over", "zone"])).toEqual([]);
    expect(targetViolations(TABDRAG, "// tabDrag.over = hit.drop;\n", ["over"])).toEqual([]);
    // A comparison (`===`) is not an assignment.
    expect(targetViolations(TABDRAG, "if (tabDrag.over === drop) return;", ["over"])).toEqual([]);
  });

  it("a new drag store nobody listed", () => {
    expect(unlistedDrags({ "lib/stores/newdrag.svelte.ts": "newDrag.over = hit.drop;" })).toEqual([
      "lib/stores/newdrag.svelte.ts keeps a drop target and is not in DRAGS",
    ]);
    expect(unlistedDrags({ "lib/stores/tabdrag.svelte.ts": tabdrag })).toEqual([]);
    expect(unlistedDrags({ "lib/x.ts": "// x.over = 1\nexport const a = 1;" })).toEqual([]);
  });
});
