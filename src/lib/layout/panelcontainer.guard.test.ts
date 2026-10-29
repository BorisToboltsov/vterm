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
// What a panel opens beside its list goes there by the one rule there is — the
// panel is wide and the row holds two parts (`fitsBeside`) — never by a width
// of its own: a second threshold is a second answer to "is this panel wide"
// (v1.15, the commit's details in the Git history).
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
    const base = spec.startsWith("#lib/") ? join("lib", spec.slice(5)) : join(dirname(rel), spec);
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
 * What lets a commit's details stand beside the history where the row does not
 * hold both, or by a width rule of their own — in `GitGraph`'s source. Empty
 * when the rule holds.
 */
export function commitPaneViolations(source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  if (!/const beside = \$derived\(wide && fitsBeside\(rowWidth\)\);/.test(c)) {
    out.push("where the details stand is not decided by `wide && fitsBeside(rowWidth)`");
  }
  if (/\browWidth\s*[<>]=?\s*\d/.test(c) || /\bisWide\(/.test(c)) {
    out.push("the history decides by a width of its own");
  }
  const markup = markupOf(source);
  const at = markup.indexOf("{#if beside}");
  const mid = at < 0 ? -1 : markup.indexOf("{:else}", at);
  const end = mid < 0 ? -1 : markup.indexOf("{/if}", mid);
  if (end < 0) return [...out, "the details have no beside / under branches"];
  const besideBranch = markup.slice(at, mid);
  const underBranch = markup.slice(mid, end);
  if (!/<SidePane\b/.test(besideBranch) || !/<PanelDivider split="gitCommit"/.test(besideBranch)) {
    out.push("beside the list the details are not a SidePane behind the panel's divider");
  }
  if ((markup.match(/<SidePane\b/g) ?? []).length !== 1 || /<PanelDivider\b/.test(underBranch)) {
    out.push("a pane or a divider stands outside the beside branch");
  }
  const same = /\{@render commitDetail\(/;
  if (!same.test(besideBranch) || !same.test(underBranch)) {
    out.push("the two places do not show the same content");
  }
  return out;
}

/**
 * What lets the file panel put its search and its transfers beside the listing
 * where the row does not hold both, or by a width rule of its own — in
 * `FileBrowser`'s source. Empty when the rule holds (v1.17).
 */
export function filePaneViolations(source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  if (!/const beside = \$derived\(wide && fitsBeside\(rowWidth\)\);/.test(c)) {
    out.push("where the search and the transfers stand is not decided by `wide && fitsBeside(rowWidth)`");
  }
  if (/\browWidth\s*[<>]=?\s*\d/.test(c) || /\bisWide\(/.test(c)) {
    out.push("the file panel decides by a width of its own");
  }
  const markup = markupOf(source);
  const at = markup.indexOf("{#if sideOpen}");
  const end = at < 0 ? -1 : markup.indexOf("\n        {/if}\n        </div>\n      {/if}", at);
  if (end < 0) return [...out, "the file panel has no column beside the listing"];
  const side = markup.slice(at, end);
  const rest = markup.slice(0, at) + markup.slice(end);
  if (!/<PanelDivider split="files"/.test(side) || !/<SidePane\b/.test(side)) {
    out.push("beside the listing the search is not a SidePane behind the panel's divider");
  }
  if (/<SidePane\b|<PanelDivider\b/.test(rest)) out.push("a pane or a divider stands outside the side column");
  // One content, two places: the same snippet under the path bar and in the pane.
  if (!/\{@render searchBox\(true\)\}/.test(side) || !/\{#if searchOpen && !beside\}[^]*?\{@render searchBox\(false\)\}/.test(rest)) {
    out.push("the search is not the same content in its two places");
  }
  // The footer stands in one of them, never in both.
  if (!/\{#if !beside\}\{@render footer\?\.\(\)\}\{\/if\}/.test(rest) || !/\{@render footer\?\.\(\)\}/.test(side)) {
    out.push("the footer does not move beside the listing with the search");
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
    expect(fixedChain("lib/ui/Modal.svelte", all)).toEqual(["Modal"]);
    expect(fixedChain("lib/ui/ContextMenu.svelte", all)).toEqual(["ContextMenu"]);
    expect(fixedChain("lib/ui/ConfirmDialog.svelte", all)).toEqual(["ConfirmDialog", "Modal"]);
    // What a wide panel shows beside its list owns no dialog…
    for (const name of [
      "ui/SidePane",
      "docker/DockerDetail",
      "docker/DockerText",
      "k8s/K8sDetail",
      "k8s/K8sText",
      "git/GitCommitDetail",
      "files/GrepResults",
    ]) {
      expect(all[`lib/${name}.svelte`], name).toBeDefined();
      expect(fixedChain(`lib/${name}.svelte`, all), name).toBeNull();
    }
    // …and the dialog around the same content does.
    expect(fixedChain("lib/docker/DockerDetailModal.svelte", all)).toEqual(["DockerDetailModal", "Modal"]);
    expect(fixedChain("lib/k8s/K8sTextModal.svelte", all)).toEqual(["K8sTextModal", "Modal"]);
  });

  it("finds the containers there are", () => {
    const withContainers = Object.keys(all).filter((rel) => containerSubtrees(markupOf(all[rel])).length > 0);
    for (const rel of ["lib/docker/DockerPanel.svelte", "lib/k8s/K8sPanel.svelte", "lib/files/FileBrowser.svelte"]) {
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

  it("a commit's details stand beside the history only where the row holds both", () => {
    expect(commitPaneViolations(all["lib/git/GitGraph.svelte"])).toEqual([]);
    // The list is a container of its own, and holds nothing fixed.
    expect(containerSubtrees(markupOf(all["lib/git/GitGraph.svelte"]))).toHaveLength(1);
    expect(containerViolations("lib/git/GitGraph.svelte", all)).toEqual([]);
  });

  it("the file panel's search and transfers stand beside the listing only where the row holds both", () => {
    expect(filePaneViolations(all["lib/files/FileBrowser.svelte"])).toEqual([]);
    // Its query container is the listing, and that holds nothing fixed.
    expect(containerViolations("lib/files/FileBrowser.svelte", all)).toEqual([]);
  });

  it("the assistant's chat owns a dialog, so it measures itself too", () => {
    const chat = all["lib/ai/AiChat.svelte"];
    expect(containerSubtrees(markupOf(chat))).toEqual([]);
    expect(code(chat)).toMatch(/use:wideWhen=\{/);
    expect(fixedChain("lib/ai/AiChat.svelte", all)).not.toBeNull();
  });

  it("a panel whose sub-views own dialogs measures itself instead of being a container", () => {
    const git = all["lib/git/GitPanel.svelte"];
    expect(containerSubtrees(markupOf(git))).toEqual([]);
    expect(code(git)).toMatch(/use:wideWhen=\{/);
    // The reason it cannot be one: its sub-views bring dialogs with them.
    for (const view of ["git/GitChanges", "git/GitBranches"]) {
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
    const rel = "lib/docker/DockerPanel.svelte";
    // The dialog used where the content should be: the mistake the split prevents.
    const broken = mutate(all[rel], "            <DockerText text={modalText} live={modalLive} fill />", "            <DockerTextModal open title={modalTitle} text={modalText} />");
    expect(containerViolations(rel, withSource(rel, broken))).toEqual([
      "lib/docker/DockerPanel.svelte: <DockerTextModal> inside a query container puts a fixed element there (DockerTextModal → Modal)",
    ]);
  });

  it("a fixed element written straight into a container", () => {
    const rel = "lib/k8s/K8sPanel.svelte";
    const broken = mutate(all[rel], '      <div class="min-h-0 min-w-0 flex-1" data-testid="k8s-side">', '      <div class="fixed inset-0 z-40" data-testid="k8s-side">');
    expect(containerViolations(rel, withSource(rel, broken))).toEqual([
      "lib/k8s/K8sPanel.svelte: a fixed element inside a query container",
    ]);
  });

  it("content that grows a dialog of its own", () => {
    const rel = "lib/docker/DockerDetail.svelte";
    const grown = all[rel]
      .replace('  import Icon from "../ui/Icon.svelte";', '  import Icon from "../ui/Icon.svelte";\n  import ConfirmDialog from "../ui/ConfirmDialog.svelte";')
      .concat("\n<ConfirmDialog open={false} title=\"x\" />\n");
    expect(grown).not.toBe(all[rel]);
    expect(containerViolations("lib/docker/DockerPanel.svelte", withSource(rel, grown))).toEqual([
      "lib/docker/DockerPanel.svelte: <DockerDetail> inside a query container puts a fixed element there (DockerDetail → ConfirmDialog → Modal)",
    ]);
  });

  it("a container put above sub-views that own dialogs", () => {
    const rel = "lib/git/GitPanel.svelte";
    const broken = mutate(all[rel], '<div class="flex h-full min-h-0 flex-col text-xs" use:wideWhen', '<div class="@container flex h-full min-h-0 flex-col text-xs" use:wideWhen');
    const found = containerViolations(rel, withSource(rel, broken));
    expect(found.some((v) => v.includes("<GitChanges>"))).toBe(true);
    expect(found.some((v) => v.includes("<GitBranches>"))).toBe(true);
  });

  it("a commit's details put beside the history by anything but the one rule", () => {
    const src = all["lib/git/GitGraph.svelte"];
    // Beside whenever the panel is wide — squeezed into a row that holds one part.
    expect(commitPaneViolations(mutate(src, "wide && fitsBeside(rowWidth)", "wide"))).toEqual([
      "where the details stand is not decided by `wide && fitsBeside(rowWidth)`",
    ]);
    // A threshold of its own.
    expect(commitPaneViolations(mutate(src, "wide && fitsBeside(rowWidth)", "rowWidth >= 900"))).toEqual([
      "where the details stand is not decided by `wide && fitsBeside(rowWidth)`",
      "the history decides by a width of its own",
    ]);
    // The rule named only in a comment.
    expect(
      commitPaneViolations(
        mutate(src, "const beside = $derived(wide && fitsBeside(rowWidth));", "// const beside = $derived(wide && fitsBeside(rowWidth));\n  const beside = $derived(wide);"),
      ),
    ).toEqual(["where the details stand is not decided by `wide && fitsBeside(rowWidth)`"]);
    // A second, simpler content for the strip: the two places drift apart.
    expect(commitPaneViolations(mutate(src, "{@render commitDetail(sel, false)}", "<p>{sel.subject}</p>"))).toEqual([
      "the two places do not show the same content",
    ]);
    // The pane brought under the list as well.
    expect(
      commitPaneViolations(
        mutate(src, "{@render commitDetail(sel, false)}", "<SidePane title={sel.short}>{@render commitDetail(sel, false)}</SidePane>"),
      ),
    ).toEqual(["a pane or a divider stands outside the beside branch"]);
  });

  it("the file panel's side column put there by anything but the one rule", () => {
    const src = all["lib/files/FileBrowser.svelte"];
    expect(filePaneViolations(mutate(src, "wide && fitsBeside(rowWidth)", "wide"))).toEqual([
      "where the search and the transfers stand is not decided by `wide && fitsBeside(rowWidth)`",
    ]);
    expect(filePaneViolations(mutate(src, "wide && fitsBeside(rowWidth)", "rowWidth >= 900"))).toEqual([
      "where the search and the transfers stand is not decided by `wide && fitsBeside(rowWidth)`",
      "the file panel decides by a width of its own",
    ]);
    // The footer drawn under the listing as well as beside it: the transfers twice.
    expect(
      filePaneViolations(mutate(src, "{#if !beside}{@render footer?.()}{/if}", "{@render footer?.()}")),
    ).toEqual(["the footer does not move beside the listing with the search"]);
    // A second, simpler search for the pane: the two places drift apart.
    expect(filePaneViolations(mutate(src, "{@render searchBox(true)}", "<p>{searchQuery}</p>"))).toEqual([
      "the search is not the same content in its two places",
    ]);
  });

  it("the chat made a query container above its consent dialog", () => {
    const rel = "lib/ai/AiChat.svelte";
    const broken = mutate(all[rel], 'class="flex h-full min-h-0 {wide', 'class="@container flex h-full min-h-0 {wide');
    expect(containerSubtrees(markupOf(broken))).toHaveLength(1);
    expect(containerViolations(rel, withSource(rel, broken)).length).toBeGreaterThan(0);
  });

  it("the commit's details growing a dialog of their own", () => {
    const rel = "lib/git/GitCommitDetail.svelte";
    const grown = all[rel]
      .replace('  import Icon from "../ui/Icon.svelte";', '  import Icon from "../ui/Icon.svelte";\n  import ContextMenu from "../ui/ContextMenu.svelte";')
      .concat("\n<ContextMenu menu={null} onclose={() => {}} />\n");
    expect(grown).not.toBe(all[rel]);
    expect(fixedChain(rel, withSource(rel, grown))).toEqual(["GitCommitDetail", "ContextMenu"]);
  });

  it("is not fooled by a comment, or by a class that merely contains the word", () => {
    const rel = "lib/docker/DockerPanel.svelte";
    const commented = mutate(all[rel], '      <div class="min-h-0 min-w-0 flex-1" data-testid="docker-side">', '      <!-- <Modal open /> a fixed overlay would go here -->\n      <div class="min-h-0 min-w-0 flex-1 table-fixed" data-testid="docker-side">');
    expect(containerViolations(rel, withSource(rel, commented))).toEqual([]);
  });
});
