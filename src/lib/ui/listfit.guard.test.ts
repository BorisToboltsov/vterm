// List-fit guard (v1.33): a dock list is laid out by its own width, and its
// table keeps the name.
//
// Before, the Docker and k8s panels were one query container: with logs or
// details beside the list, the panel stayed wide, the list kept every column,
// and the columns shrank in proportion — the name, the one thing that says which
// row is which, as hard as the ports. The rule now spans several places, so it
// is a guard rather than a lint rule:
//
//  - the list part of each panel is a query container of its own, tells the
//    filter row its own layout (`listWide`, by `wideWhen`) and nothing in it
//    reads the panel's;
//  - each list measures itself and draws its table from `fitColumns` — a
//    column the width does not hold leaves the table, header and rows alike,
//    and what left is said («+N»);
//  - details open on the log, and a click on a row opens them.
//
// Every check is a function over source text, so that the same file shows it
// catches the violation it exists for. Comments are cut by scanning, not by a
// regex over the markup (CodeQL, `vterm/scan-blocks`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(process.cwd(), "src", "lib");
const read = (rel: string): string => readFileSync(join(LIB, rel), "utf8");

/** Drop every `open … close` block by scanning; an opener with no closer takes the rest. */
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

/** Source without HTML and block comments, and without line comments (`://` is not one). */
function code(src: string): string {
  return stripBlocks(stripBlocks(src, "<!--", "-->"), "/*", "*/").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The opening tag of the element carrying `data-testid="<id>"`. */
function openingTag(src: string, testid: string): string {
  const at = src.indexOf(`data-testid="${testid}"`);
  if (at < 0) return "";
  const start = src.lastIndexOf("<div", at);
  const end = src.indexOf(">", at);
  return start < 0 || end < 0 ? "" : src.slice(start, end + 1);
}

/**
 * Where the opening tag that starts at `from` ends (the index after its `>`).
 * Attribute values hold `>` themselves (`onorder={(o) => …}`), so braces and
 * quotes are followed rather than guessed at.
 */
function tagEnd(src: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === quote && depth === 0) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      if (depth === 0) quote = ch;
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return src.length;
}

/** Every `<ListHeader …>` opening tag of a source. */
function listHeaders(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf("<ListHeader"); at >= 0; at = src.indexOf("<ListHeader", at + 1)) {
    out.push(src.slice(at, tagEnd(src, at)));
  }
  return out;
}

/** What lets a panel's list follow the panel's width instead of its own. */
export function panelViolations(source: string, prefix: "docker" | "k8s"): string[] {
  const c = code(source);
  const out: string[] = [];
  const part = openingTag(c, `${prefix}-list-part`);
  if (!/class="@container\b/.test(part)) out.push("the list part is not a query container of its own");
  if (!/use:wideWhen=\{\(w\) => \(listWide = w\)\}/.test(part)) out.push("the list part does not tell its own layout");
  if (listHeaders(c).some((tag) => /(^|\s)(\{wide\}|wide=\{wide\})/.test(tag))) {
    out.push("a filter row of the list reads the panel's width");
  }
  if (listHeaders(c).length === 0) out.push("the panel has no filter row to check");
  if (!/let detailTab = \$state<\w+>\("logs"\)/.test(c)) out.push("the details do not open on the log");
  return out;
}

/** What lets a list's table keep columns its width does not hold. */
export function listViolations(source: string, list: "docker.containers" | "k8s.pods"): string[] {
  const c = code(source);
  const out: string[] = [];
  if (!/bind:clientWidth=\{listWidth\}/.test(c)) out.push("the list does not measure itself");
  if (!new RegExp(`fitColumns\\(\\s*"${list.replace(".", "\\.")}"`).test(c)) out.push("the table is not drawn from fitColumns");
  if (!/hiddenFields\(/.test(c)) out.push("the columns the user hid are not taken off");
  if (!/fit\.dropped\.length > 0/.test(c)) out.push("what the width took off is not said");
  // A plain click opens the details — with or without picking several rows by
  // modifier keys (stage 2) in front of it; a click on the row's own buttons does not.
  const click = /onclick=\{\(e\) => \{([^]*?)\n\s*\}\}/.exec(c)?.[1] ?? "";
  if (!/closest\("button/.test(click) || !/onViewDetails\(/.test(click)) {
    out.push("a click on the row does not open its details");
  }
  return out;
}

describe("list-fit guard", () => {
  const docker = read("docker/DockerPanel.svelte");
  const k8s = read("k8s/K8sPanel.svelte");
  const containers = read("docker/DockerContainers.svelte");
  const pods = read("k8s/K8sPods.svelte");

  it("each panel's list is laid out by its own width, and details open on the log", () => {
    expect(panelViolations(docker, "docker")).toEqual([]);
    expect(panelViolations(k8s, "k8s")).toEqual([]);
  });

  it("each list fits its table to itself and opens a row's details on a click", () => {
    expect(listViolations(containers, "docker.containers")).toEqual([]);
    expect(listViolations(pods, "k8s.pods")).toEqual([]);
  });
});

describe("list-fit guard — catches what it exists for", () => {
  const docker = read("docker/DockerPanel.svelte");
  const containers = read("docker/DockerContainers.svelte");
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a list part that is the panel's again", () => {
    const broken = mutate(docker, 'class="@container min-h-0 min-w-0', 'class="min-h-0 min-w-0');
    expect(panelViolations(broken, "docker")).toContain("the list part is not a query container of its own");
  });

  it("a filter row reading the panel's width", () => {
    const broken = mutate(docker, 'placeholder={t("docker.filterContainers")}\n            wide={listWide}', 'placeholder={t("docker.filterContainers")}\n            {wide}');
    expect(panelViolations(broken, "docker")).toEqual(["a filter row of the list reads the panel's width"]);
  });

  it("details back on Overview", () => {
    const broken = mutate(docker, 'let detailTab = $state<DockerDetailTab>("logs")', 'let detailTab = $state<DockerDetailTab>("overview")');
    expect(panelViolations(broken, "docker")).toEqual(["the details do not open on the log"]);
  });

  it("a table that keeps every column whatever its width", () => {
    const broken = mutate(containers, 'fitColumns("docker.containers"', 'keepAll("docker.containers"');
    expect(listViolations(broken, "docker.containers")).toEqual(["the table is not drawn from fitColumns"]);
  });

  it("columns that leave without a word", () => {
    const broken = mutate(containers, "{#if fit.dropped.length > 0}", "{#if false}");
    expect(listViolations(broken, "docker.containers")).toEqual(["what the width took off is not said"]);
  });

  it("a rule written only in a comment is not a rule", () => {
    const broken = mutate(containers, "bind:clientWidth={listWidth}", "") + "\n<!-- bind:clientWidth={listWidth} -->\n";
    expect(listViolations(broken, "docker.containers")).toEqual(["the list does not measure itself"]);
  });
});
