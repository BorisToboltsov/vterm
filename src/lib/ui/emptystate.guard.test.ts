// Empty-state guard (v1.30): an empty state fits the room it is given and never
// leaves it.
//
// The badge was a flex item of a centred column as tall as its pane. Short of
// room it was squeezed to the icon's height — a 56×28 oval — and what still did
// not fit spilled out of the pane both ways: over the dock's tab strip above, and
// in the structured log view, whose wrapper could not get shorter than its text,
// over the bottom dock. Now the empty state picks a tier by its own height
// (`emptytier.ts`, `actions/emptyfit.ts`); this keeps the pieces of that
// together:
//
//  1. The root is as tall as its room and clips (`h-full min-h-0
//     overflow-hidden`), is fitted by `use:emptyFit` and starts in the roomiest
//     tier; the content is centred by `my-auto` — it gives way at the top when
//     there is no room — not by `justify-center`, which overflows upward. A
//     circle never shrinks.
//  2. The tiers the markup reads are the model's, all of them.
//  3. A wrapper around an empty state does not centre it (it centres itself) and,
//     when it stretches (`flex-1`), can also get shorter (`min-h-0`) — the log
//     view's wrapper could not.
//
// Sources are read with comments stripped — the comments name the anti-patterns.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_TIERS } from "./emptytier";

const SRC = join(process.cwd(), "src");
const EMPTY = "lib/ui/EmptyState.svelte";

/** Source with comments removed — markup, block and line (`://` is not a comment). */
function code(src: string): string {
  return src
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const raw = (rel: string): string => readFileSync(join(SRC, ...rel.split("/")), "utf8");

/** Every Svelte component under `src/`, as a path relative to it. */
function components(dir = SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) components(full, acc);
    else if (entry.endsWith(".svelte")) acc.push(relative(SRC, full).split(sep).join("/"));
  }
  return acc;
}

/** The opening tags of the markup (after the script), in order. */
const openTags = (source: string): string[] =>
  [...code(source.replace(/<script[^]*?<\/script>/, "")).matchAll(/<div\b[^>]*>/g)].map(
    (m) => m[0],
  );

const classes = (tag: string): string => /\bclass="([^"]*)"/.exec(tag)?.[1] ?? "";
const has = (cls: string, name: string): boolean => cls.split(/\s+/).includes(name);

/** What is wrong with the empty state's own markup. */
export function rootViolations(source: string): string[] {
  const out: string[] = [];
  const [root = "", content = ""] = openTags(source);
  const rootCls = classes(root);
  for (const need of ["h-full", "min-h-0", "overflow-hidden"]) {
    if (!has(rootCls, need)) out.push(`the root lacks \`${need}\``);
  }
  if (!root.includes("use:emptyFit")) out.push("the root is not fitted by `use:emptyFit`");
  if (!root.includes(`data-tier="${EMPTY_TIERS[0]}"`)) {
    out.push(`the root does not start in the roomiest tier (\`${EMPTY_TIERS[0]}\`)`);
  }
  if (has(rootCls, "justify-center")) out.push("the root centres with `justify-center`");
  if (!has(classes(content), "my-auto")) out.push("the content is not centred by `my-auto`");
  for (const tag of openTags(source)) {
    const cls = classes(tag);
    if (has(cls, "rounded-full") && !has(cls, "shrink-0")) {
      out.push(`a circle may shrink: \`${cls}\``);
    }
  }
  return out;
}

/** Tiers the markup reads that the model lacks, and tiers of the model it never reads. */
export function tierViolations(source: string): string[] {
  const read = new Set([...code(source).matchAll(/\btier=(\w+)/g)].map((m) => m[1]));
  const known = new Set<string>(EMPTY_TIERS);
  return [
    ...[...read].filter((t) => !known.has(t)).map((t) => `the markup reads tier \`${t}\`, the model has none`),
    ...EMPTY_TIERS.filter((t) => !read.has(t)).map((t) => `the markup never reads tier \`${t}\``),
  ];
}

/** Wrappers that centre an empty state, or stretch without being able to shrink. */
export function wrapperViolations(rel: string, source: string): string[] {
  const out: string[] = [];
  const text = code(source);
  for (const m of text.matchAll(/<(EmptyState|FilteredEmpty)\b/g)) {
    // Step back over whitespace and `{#if …}` / `{:else …}` to what holds it.
    const before = text.slice(0, m.index).replace(/(\s|\{[#:][^}]*\})+$/, "");
    const tag = /<div\b[^>]*>$/.exec(before)?.[0];
    if (!tag) continue;
    const cls = classes(tag);
    if (has(cls, "justify-center") || has(cls, "items-center")) {
      out.push(`${rel}: \`${cls}\` centres a ${m[1]} — it centres itself`);
    }
    if (has(cls, "flex-1") && !has(cls, "min-h-0")) {
      out.push(`${rel}: \`${cls}\` stretches a ${m[1]} but cannot get shorter than it`);
    }
  }
  return out;
}

describe("empty-state guard", () => {
  it("the empty state clips, is fitted, starts roomiest, and no circle shrinks", () => {
    expect(rootViolations(raw(EMPTY))).toEqual([]);
  });

  it("the markup reads exactly the model's tiers", () => {
    expect(tierViolations(raw(EMPTY))).toEqual([]);
  });

  it("no wrapper centres an empty state or keeps it from getting shorter", () => {
    const users = components().filter((rel) => /<(EmptyState|FilteredEmpty)\b/.test(raw(rel)));
    // The log view, the dock's notice and the filter's are among them.
    expect(users).toEqual(
      expect.arrayContaining([
        "lib/terminal/JsonLogView.svelte",
        "lib/layout/Dock.svelte",
        "lib/ui/FilteredEmpty.svelte",
      ]),
    );
    expect(users.flatMap((rel) => wrapperViolations(rel, raw(rel)))).toEqual([]);
  });
});

describe("empty-state guard — catches what it exists for", () => {
  const empty = raw(EMPTY);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a root that lets the content out, or centres it the way that climbs", () => {
    expect(rootViolations(mutate(empty, "min-h-0 flex-col items-center overflow-hidden", "flex-col items-center"))).toEqual([
      "the root lacks `min-h-0`",
      "the root lacks `overflow-hidden`",
    ]);
    expect(
      rootViolations(mutate(empty, "flex-col items-center overflow-hidden", "flex-col items-center justify-center overflow-hidden")),
    ).toEqual(["the root centres with `justify-center`"]);
    expect(rootViolations(mutate(empty, 'class="my-auto ', 'class="'))).toEqual([
      "the content is not centred by `my-auto`",
    ]);
  });

  it("a root nobody fits, or that starts in a tight tier", () => {
    expect(rootViolations(mutate(empty, "use:emptyFit={[title, hint]}", ""))).toEqual([
      "the root is not fitted by `use:emptyFit`",
    ]);
    expect(rootViolations(mutate(empty, 'data-tier="full"', 'data-tier="line"'))).toEqual([
      "the root does not start in the roomiest tier (`full`)",
    ]);
  });

  it("a badge that may become an oval", () => {
    const broken = mutate(empty, "hidden h-14 w-14 shrink-0", "hidden h-14 w-14");
    expect(rootViolations(broken)).toHaveLength(1);
    expect(rootViolations(broken)[0]).toMatch(/^a circle may shrink/);
  });

  it("a tier the model does not have, and one the markup forgot", () => {
    expect(tierViolations(empty.replaceAll("tier=medal", "tier=medallion"))).toEqual([
      "the markup reads tier `medallion`, the model has none",
      "the markup never reads tier `medal`",
    ]);
  });

  it("the log view's old wrapper, and a stretching one that cannot shrink", () => {
    const LOG = "lib/terminal/JsonLogView.svelte";
    const broken = mutate(
      raw(LOG),
      '<div class="min-h-0 flex-1">',
      '<div class="flex flex-1 items-center justify-center p-4">',
    );
    expect(wrapperViolations(LOG, broken)).toEqual([
      `${LOG}: \`flex flex-1 items-center justify-center p-4\` centres a EmptyState — it centres itself`,
      `${LOG}: \`flex flex-1 items-center justify-center p-4\` stretches a EmptyState but cannot get shorter than it`,
    ]);
    const DOCK = "lib/layout/Dock.svelte";
    expect(
      wrapperViolations(DOCK, mutate(raw(DOCK), "vt-dock-pane min-h-0 flex-1", "vt-dock-pane flex-1")),
    ).toHaveLength(1);
  });

  it("through `{#if}` branches, and only the element right around it", () => {
    const wrapped = (cls: string, inner: string) =>
      `<div class="${cls}">\n  {#if a}\n    {:else if b}\n    ${inner}`;
    expect(wrapperViolations("x", wrapped("flex flex-1", "<FilteredEmpty summary={s} />"))).toHaveLength(1);
    // A sibling after a closed element is not wrapped by it.
    expect(wrapperViolations("x", `<div class="flex-1 justify-center"></div>\n<EmptyState icon="x" />`)).toEqual([]);
    // Nor is a comment naming the anti-pattern a wrapper.
    expect(wrapperViolations("x", `<!-- <div class="flex-1"> <EmptyState /> -->`)).toEqual([]);
  });
});
