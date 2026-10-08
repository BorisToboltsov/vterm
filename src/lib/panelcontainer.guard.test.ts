// Panel-container guard (v1.7): nothing with `position: fixed` stands inside a
// query container.
//
// A panel lays itself out by its own width with `@container` and `@wide:`
// variants (ADR 0015). The catch: an element with `container-type` is, in part
// of the engines the app runs on (the system WebView — its age is the user's),
// the containing block of its `position: fixed` descendants. A dialog rendered
// inside one stops covering the window: it is laid out and clipped by the
// panel. The same component looks right on the developer's machine and wrong on
// an older macOS or WebKitGTK.
//
// So a container's subtree must own no fixed element — not directly, and not
// through a component it renders (a `Modal`, a `ConfirmDialog`, a context menu,
// or anything that renders one). That is why a panel's dialogs stand beside its
// root, and why what a wide panel shows *beside its list* is content with no
// dialog in it (`DockerDetail`, not `DockerDetailModal`), in a `SidePane`.
//
// A panel whose sub-components own dialogs cannot be a container at all; it
// measures itself instead (`actions/panelwide.ts`, the Git panel).
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for (the second `describe`). Sources are read
// with comments stripped.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/**
 * Drop every `open … close` block by scanning. One regex pass is not enough:
 * it leaves a nested opener behind (`<!--<!-- -->` → `<!--`), and what is left
 * would be read as markup. An opener with no closer takes the rest with it.
 */
function stripBlocks(src: string, open: string, close: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(open, i)) {
      const end = src.indexOf(close, i + open.length);
      i = end < 0 ? src.length : end + close.length;
      continue;
    }
    out += src[i++];
  }
  return out;
}

const stripHtmlComments = (src: string): string => stripBlocks(src, "<!--", "-->");

/** Source with comments removed — HTML, block and line (`://` is not a comment). */
function code(src: string): string {
  return stripHtmlComments(src)
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every component under `src/`, as a path relative to it → its source. */
function components(dir = SRC, acc: Record<string, string> = {}): Record<string, string> {
  // What an entry is comes with the listing: asked of the path afterwards, the
  // answer could be about a different file than the one then read.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) components(full, acc);
    else if (entry.name.endsWith(".svelte")) {
      acc[relative(SRC, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  }
  return acc;
}

/** The markup of a component: what follows its instance script. */
function markupOf(source: string): string {
  const c = code(source);
  const at = c.lastIndexOf("</script>");
  return stripBlocks(at < 0 ? c : c.slice(at + "</script>".length), "<style", "</style>");
}

/** `fixed` as a class of its own (not `table-fixed`, not `@wide:fixed-…`). */
const FIXED = /(^|[\s"'`{])fixed(?=[\s"'`}]|$)/;

/** Components a file imports: local name → path relative to `src/`. */
function imports(rel: string, source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of code(source).matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.svelte)["']/g)) {
    const spec = m[2];
    const base = spec.startsWith("$lib/") ? join("lib", spec.slice(5)) : join(dirname(rel), spec);
    out[m[1]] = base.split(sep).join("/").replace(/^\.\//, "");
  }
  return out;
}

/** The component tags used in a stretch of markup. */
const tags = (markup: string): string[] => [
  ...new Set([...markup.matchAll(/<([A-Z]\w*)\b/g)].map((m) => m[1])),
];

/**
 * Why a component puts a fixed element on the page, as a chain of names
 * (`ConfirmDialog → Modal`), or null when it does not. A component does when
 * its own markup has one, or when it renders a component that does.
 */
export function fixedChain(
  rel: string,
  all: Record<string, string>,
  seen: Set<string> = new Set(),
): string[] | null {
  const source = all[rel];
  if (source === undefined || seen.has(rel)) return null;
  seen.add(rel);
  const name = basename(rel, ".svelte");
  const markup = markupOf(source);
  if (FIXED.test(markup)) return [name];
  const known = imports(rel, source);
  for (const tag of tags(markup)) {
    const child = known[tag];
    const chain = child ? fixedChain(child, all, seen) : null;
    if (chain) return [name, ...chain];
  }
  return null;
}

/**
 * Where the opening tag that starts at `from` ends (the index after its `>`).
 * Attribute values may hold `>` themselves (`onclick={() => …}`), so braces and
 * quotes are followed rather than guessed at.
 */
function tagEnd(markup: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < markup.length; i++) {
    const ch = markup[i];
    if (quote) {
      // A `{…}` inside a quoted attribute is an expression: it may hold the quote.
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === quote && depth === 0) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      if (depth === 0) quote = ch;
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return markup.length;
}

/** The subtrees of the elements that carry `@container`, as markup. */
export function containerSubtrees(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<([a-z][\w-]*)(?=[\s>])/g)) {
    const tag = m[1];
    const from = tagEnd(markup, m.index);
    const opening = markup.slice(m.index, from);
    if (!/(^|[\s"'`{])@container(?=[\s"'`}]|$)/.test(opening)) continue;
    if (opening.endsWith("/>")) continue;
    let depth = 1;
    let end = markup.length;
    const next = new RegExp(`<(/?)${tag}(?=[\\s>])`, "g");
    next.lastIndex = from;
    for (let t = next.exec(markup); t; t = next.exec(markup)) {
      if (t[1] === "/") depth--;
      else if (!markup.slice(t.index, tagEnd(markup, t.index)).endsWith("/>")) depth++;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out.push(markup.slice(from, end));
  }
  return out;
}

/** What stands inside the query containers of one component and should not. */
export function containerViolations(rel: string, all: Record<string, string>): string[] {
  const source = all[rel];
  const out: string[] = [];
  const known = imports(rel, source);
  for (const subtree of containerSubtrees(markupOf(source))) {
    if (FIXED.test(subtree)) out.push(`${rel}: a fixed element inside a query container`);
    for (const tag of tags(subtree)) {
      const chain = known[tag] ? fixedChain(known[tag], all) : null;
      if (chain) {
        out.push(`${rel}: <${tag}> inside a query container puts a fixed element there (${chain.join(" → ")})`);
      }
    }
  }
  return out;
}

/**
 * Containers that hold a fixed element on purpose, each with the reason it is
 * safe there. An entry that no longer excuses anything fails the gate.
 */
const EXEMPT: Record<string, string> = {};

describe("panel container guard", () => {
  const all = components();

  it("knows the dialog primitives for what they are", () => {
    expect(fixedChain("lib/Modal.svelte", all)).toEqual(["Modal"]);
    expect(fixedChain("lib/ContextMenu.svelte", all)).toEqual(["ContextMenu"]);
    expect(fixedChain("lib/ConfirmDialog.svelte", all)).toEqual(["ConfirmDialog", "Modal"]);
    // What a wide panel shows beside its list owns no dialog…
    for (const name of ["SidePane", "DockerDetail", "DockerText", "K8sDetail", "K8sText"]) {
      expect(fixedChain(`lib/${name}.svelte`, all), name).toBeNull();
    }
    // …and the dialog around the same content does.
    expect(fixedChain("lib/DockerDetailModal.svelte", all)).toEqual(["DockerDetailModal", "Modal"]);
    expect(fixedChain("lib/K8sTextModal.svelte", all)).toEqual(["K8sTextModal", "Modal"]);
  });

  it("finds the containers there are", () => {
    const withContainers = Object.keys(all).filter((rel) => containerSubtrees(markupOf(all[rel])).length > 0);
    for (const rel of ["lib/DockerPanel.svelte", "lib/K8sPanel.svelte", "lib/FileBrowser.svelte"]) {
      expect(withContainers).toContain(rel);
    }
  });

  it("no query container holds a fixed element — its own or a component's", () => {
    const found = Object.keys(all).flatMap((rel) => containerViolations(rel, all));
    const excused = Object.keys(EXEMPT);
    expect(found.filter((v) => !excused.some((rel) => v.startsWith(`${rel}:`)))).toEqual([]);
    // An exemption with nothing left to excuse is a stale licence.
    for (const rel of excused) {
      expect(found.some((v) => v.startsWith(`${rel}:`)), `${rel} is exempt but clean`).toBe(true);
    }
  });

  it("a panel whose sub-views own dialogs measures itself instead of being a container", () => {
    const git = all["lib/GitPanel.svelte"];
    expect(containerSubtrees(markupOf(git))).toEqual([]);
    expect(code(git)).toMatch(/use:wideWhen=\{/);
    // The reason it cannot be one: its sub-views bring dialogs with them.
    for (const view of ["GitChanges", "GitBranches"]) {
      expect(fixedChain(`lib/${view}.svelte`, all), view).not.toBeNull();
    }
  });
});

describe("panel container guard — catches what it exists for", () => {
  const all = components();
  /** `all` with one component's source replaced. */
  const withSource = (rel: string, source: string) => ({ ...all, [rel]: source });
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a dialog rendered inside the panel's container", () => {
    const rel = "lib/DockerPanel.svelte";
    // The dialog used where the content should be: the mistake the split prevents.
    const broken = mutate(all[rel], "            <DockerText text={modalText} live={modalLive} fill />", "            <DockerTextModal open title={modalTitle} text={modalText} />");
    expect(containerViolations(rel, withSource(rel, broken))).toEqual([
      "lib/DockerPanel.svelte: <DockerTextModal> inside a query container puts a fixed element there (DockerTextModal → Modal)",
    ]);
  });

  it("a fixed element written straight into a container", () => {
    const rel = "lib/K8sPanel.svelte";
    const broken = mutate(all[rel], '      <div class="min-h-0 min-w-0 flex-1" data-testid="k8s-side">', '      <div class="fixed inset-0 z-40" data-testid="k8s-side">');
    expect(containerViolations(rel, withSource(rel, broken))).toEqual([
      "lib/K8sPanel.svelte: a fixed element inside a query container",
    ]);
  });

  it("content that grows a dialog of its own", () => {
    const rel = "lib/DockerDetail.svelte";
    const grown = all[rel]
      .replace('  import Icon from "./Icon.svelte";', '  import Icon from "./Icon.svelte";\n  import ConfirmDialog from "./ConfirmDialog.svelte";')
      .concat("\n<ConfirmDialog open={false} title=\"x\" />\n");
    expect(grown).not.toBe(all[rel]);
    expect(containerViolations("lib/DockerPanel.svelte", withSource(rel, grown))).toEqual([
      "lib/DockerPanel.svelte: <DockerDetail> inside a query container puts a fixed element there (DockerDetail → ConfirmDialog → Modal)",
    ]);
  });

  it("a container put above sub-views that own dialogs", () => {
    const rel = "lib/GitPanel.svelte";
    const broken = mutate(all[rel], '<div class="flex h-full min-h-0 flex-col text-xs" use:wideWhen', '<div class="@container flex h-full min-h-0 flex-col text-xs" use:wideWhen');
    const found = containerViolations(rel, withSource(rel, broken));
    expect(found.some((v) => v.includes("<GitChanges>"))).toBe(true);
    expect(found.some((v) => v.includes("<GitBranches>"))).toBe(true);
  });

  it("is not fooled by a comment, or by a class that merely contains the word", () => {
    const rel = "lib/DockerPanel.svelte";
    const commented = mutate(all[rel], '      <div class="min-h-0 min-w-0 flex-1" data-testid="docker-side">', '      <!-- <Modal open /> a fixed overlay would go here -->\n      <div class="min-h-0 min-w-0 flex-1 table-fixed" data-testid="docker-side">');
    expect(containerViolations(rel, withSource(rel, commented))).toEqual([]);
  });
});
