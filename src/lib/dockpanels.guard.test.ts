// Dock-panel guard (v1.0.14): a right-dock panel is hidden, never destroyed,
// when its tab goes inactive — and a hidden panel does not poll.
//
// The two halves only work together. Before this fix the dock wrapped its
// content in `{#key activeTab}`, so every switch tore the panel down: the SFTP
// panel came back offering Connect for a channel that was never closed, the k8s
// panel forgot the context and namespace the user had picked, and Docker re-probed
// the daemon from scratch. Keeping the panels mounted fixes that — but a mounted
// panel keeps its `setInterval` too, and five sessions' worth of `docker ps` /
// `kubectl get pods` against hosts nobody is looking at is exactly what the
// "poll only while watched" rule exists to prevent. So: mounted stays, polling
// gets gated on `visible`, and this guard keeps someone from restoring one half
// without the other.
//
// Sources are read with comments stripped: this file's own rationale, and the
// comments in the components, name the anti-pattern in prose (the mdlink guard
// learned that the hard way by passing on a file whose action had been deleted
// but whose comment still mentioned it).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(process.cwd(), "src", "lib");

/** Source with comments removed — HTML, block and line. */
function code(file: string): string {
  return readFileSync(join(LIB, file), "utf8")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The markup of a single component instance in `src`, e.g. `<DockerPanel … />`. */
function instance(src: string, component: string): string {
  const at = src.indexOf(`<${component}`);
  expect(at, `${component} is rendered by the dock`).toBeGreaterThan(-1);
  const end = src.indexOf("/>", at);
  expect(end, `${component} tag is self-closing`).toBeGreaterThan(at);
  return src.slice(at, end);
}

/**
 * Effect text with bare dependency reads (`void visible;`) removed. Those lines
 * exist to make an effect re-run — they are not a gate, and the first version of
 * this guard passed on a panel that had kept `void visible;` while dropping the
 * condition that used it.
 */
function withoutBareReads(effect: string): string {
  return effect.replace(/\bvoid\s+[A-Za-z_$][\w$]*\s*;/g, "");
}

/** The body of the `$effect` that owns the polling interval. */
function pollEffect(src: string): string {
  const at = src.indexOf("setInterval");
  expect(at, "the panel polls on an interval").toBeGreaterThan(-1);
  const start = src.lastIndexOf("$effect(", at);
  expect(start, "the interval lives inside an $effect").toBeGreaterThan(-1);
  return withoutBareReads(src.slice(start, at));
}

describe("dock panel guard", () => {
  const dock = code("RightDock.svelte");

  it("does not remount panels when the dock tab changes", () => {
    // `{#key activeTab}` (or an {#if}/{:else if} chain over the active tab) is the
    // shape that destroys the panel — the whole bug.
    expect(dock).not.toMatch(/\{#key\s+activeTab\s*\}/);
    for (const tab of ["files", "git", "docker", "k8s", "ai"]) {
      expect(dock, `${tab} is mounted once and then kept`).toContain(
        `mounted.includes("${tab}")`,
      );
    }
  });

  it("tells every driver panel whether it is on screen", () => {
    for (const component of [
      "SftpPanel",
      "LocalFilePanel",
      "GitPanel",
      "DockerPanel",
      "K8sPanel",
    ]) {
      expect(instance(dock, component), `${component} gets a visible prop`).toMatch(
        /\bvisible=\{/,
      );
    }
  });

  it("stops the Docker and k8s pollers while the panel is hidden", () => {
    for (const file of ["DockerPanel.svelte", "K8sPanel.svelte"]) {
      expect(pollEffect(code(file)), `${file} gates its interval on visibility`).toMatch(
        /\bvisible\b/,
      );
    }
  });

  it("keeps the git panel from reloading behind another tab", () => {
    // Git has no interval, but it reloads on every terminal `cd` (OSC 7). Hidden,
    // that is a `git status`/`log`/`branch` batch per directory change nobody sees.
    const src = code("GitPanel.svelte");
    const at = src.indexOf("loadAll()", src.indexOf("$effect"));
    expect(at).toBeGreaterThan(-1);
    const effect = withoutBareReads(src.slice(src.lastIndexOf("$effect(", at), at));
    expect(effect).toMatch(/\bvisible\b/);
  });

  it("ignores window-wide file drops aimed at a hidden file panel", () => {
    // The drop listener is registered on the webview, not on the panel's element,
    // so a hidden panel would happily upload into a directory the user cannot see.
    const src = code("FileBrowser.svelte");
    const at = src.indexOf("onDragDropEvent");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/\bvisible\b/);
  });
});
