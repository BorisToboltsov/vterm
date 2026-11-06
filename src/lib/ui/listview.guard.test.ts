// The lists of ADR 0050 are one set (v1.29): every list named here draws the
// lists' filter row — or, for a plain search, the common field — narrows through
// the model of `listview.ts` rather than a filter of its own, and draws its
// groups with GroupHeader, not with a header of its own. A new list is added
// here, and so held to the set; `vterm/filter-field` keeps a raw search input
// out of everything else.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `src` without its `<!-- … -->` blocks, by scanning: one regex pass leaves a nested opener behind. */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** Source without comments: a mention in a comment proves nothing. */
const code = (path: string): string =>
  stripHtmlComments(readFileSync(path, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Each list → the element its filter row is: the whole row, or the field alone. */
const FILTER_ROWS: Record<string, "ListHeader" | "FilterField"> = {
  "src/lib/docker/DockerPanel.svelte": "ListHeader",
  "src/lib/docker/DockerNetworks.svelte": "ListHeader",
  "src/lib/k8s/K8sPanel.svelte": "ListHeader",
  "src/lib/k8s/K8sCluster.svelte": "ListHeader",
  "src/lib/recording/RecordingsPanel.svelte": "ListHeader",
  "src/lib/terminal/JsonLogView.svelte": "ListHeader",
  "src/lib/files/FileBrowser.svelte": "ListHeader",
  "src/lib/git/GitChanges.svelte": "ListHeader",
  "src/lib/monitoring/MonProcesses.svelte": "ListHeader",
  "src/lib/git/GitBranches.svelte": "FilterField",
  "src/lib/git/GitLogFilter.svelte": "FilterField",
  "src/lib/servers/ServerTree.svelte": "FilterField",
  "src/lib/settings/SettingsPanel.svelte": "FilterField",
  "src/lib/utilities/UtilitiesPanel.svelte": "FilterField",
  "src/lib/utilities/UtilKnownHosts.svelte": "FilterField",
};

/** The lists that draw groups. */
const GROUPED = [
  "src/lib/docker/DockerContainers.svelte",
  "src/lib/docker/DockerImages.svelte",
  "src/lib/docker/DockerNetworks.svelte",
  "src/lib/k8s/K8sPods.svelte",
  "src/lib/k8s/K8sWorkloads.svelte",
  "src/lib/k8s/K8sCluster.svelte",
  "src/lib/recording/RecordingsPanel.svelte",
  "src/lib/git/GitChanges.svelte",
];

/** The row is drawn, and is the common one. */
function rowViolations(src: string, element: "ListHeader" | "FilterField"): string[] {
  const out: string[] = [];
  if (!new RegExp(`import ${element} from "\\.\\./ui/${element}\\.svelte"`).test(src)) out.push(`imports ${element}`);
  if (!new RegExp(`<${element}\\b`).test(src)) out.push(`draws ${element}`);
  return out;
}

/** Where the whole row stands, the list is narrowed by the model's functions. */
function modelViolations(src: string): string[] {
  const imported = /import \{[^}]*\b(?:applyView|filterItems|keeps)\b[^}]*\} from "\.\.\/ui\/listview"/.test(src);
  return imported ? [] : ["narrows through listview.ts"];
}

/** Groups are drawn by GroupHeader, and no list draws a micro-label header of its own. */
function groupViolations(src: string): string[] {
  const out: string[] = [];
  if (!/import GroupHeader from "\.\.\/ui\/GroupHeader\.svelte"/.test(src) || !/<GroupHeader\b/.test(src)) {
    out.push("draws GroupHeader");
  }
  if (/text-caption uppercase tracking-wider/.test(src)) out.push("no header of its own");
  return out;
}

describe("the lists' set (ADR 0050)", () => {
  it("every list draws the common filter row", () => {
    for (const [path, element] of Object.entries(FILTER_ROWS)) {
      expect(rowViolations(code(path), element), path).toEqual([]);
    }
  });

  it("a list with the whole row narrows through the model", () => {
    for (const [path, element] of Object.entries(FILTER_ROWS)) {
      if (element === "ListHeader") expect(modelViolations(code(path)), path).toEqual([]);
    }
  });

  it("a grouped list draws its groups with GroupHeader", () => {
    for (const path of GROUPED) expect(groupViolations(code(path)), path).toEqual([]);
  });

  it("each check catches its violation", () => {
    const docker = code("src/lib/docker/DockerPanel.svelte");
    expect(rowViolations(docker.replace(/<ListHeader\b/g, "<div"), "ListHeader")).toEqual(["draws ListHeader"]);
    expect(rowViolations(`<input placeholder="Name" />`, "FilterField")).toEqual(["imports FilterField", "draws FilterField"]);
    // A list that filters by hand, not through the model.
    expect(modelViolations(docker.replace(/\bapplyView\b/g, "filterByHand"))).toEqual(["narrows through listview.ts"]);
    const pods = code("src/lib/k8s/K8sPods.svelte");
    expect(groupViolations(pods.replace(/<GroupHeader\b/g, "<div"))).toEqual(["draws GroupHeader"]);
    // The old standalone header: a micro-label of its own.
    expect(groupViolations(`${pods}\n<div class="px-2.5 py-1 text-caption uppercase tracking-wider text-muted">x</div>`)).toEqual([
      "no header of its own",
    ]);
  });
});
