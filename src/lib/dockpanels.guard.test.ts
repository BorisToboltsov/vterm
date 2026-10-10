// Dock-panel guard (v1.0.14, three docks since v1.1): a dock panel is hidden,
// never destroyed, when its tab goes inactive or its dock collapses — and a
// hidden panel does not poll.
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
const PAGE = join("..", "routes", "+page.svelte");

/**
 * Drop `<!-- … -->` blocks. A scan rather than `.replace(/<!--[^]*?-->/g, "")`:
 * one non-greedy pass leaves the opener behind on a nested comment
 * (`<!--<!-- -->` → `<!--`), so the strip is incomplete by construction — which is
 * also what CodeQL reports as `js/incomplete-multi-character-sanitization`.
 */
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

/** Source with comments removed — HTML, block and line (`://` is not a comment). */
function code(file: string): string {
  return stripHtmlComments(readFileSync(join(LIB, file), "utf8"))
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
  // The chrome (one instance per side) and the component that picks a session
  // panel for an id. The page supplies the snippet joining the two.
  const dock = code("Dock.svelte");
  const host = code("DockPanel.svelte");
  const page = code(PAGE);

  it("does not remount panels when the dock tab changes", () => {
    // `{#key active}` (or an {#if}/{:else if} chain over the active tab) is the
    // shape that destroys the panel — the whole bug. The dock has no key block
    // at all: a session panel is rebuilt for another session through its each-key.
    expect(dock).not.toMatch(/\{#key\b/);
    expect(dock).not.toMatch(/\{(?:#if|:else if)\s+active\s*===/);
    // Panels come from the visited list, keyed, and are hidden rather than removed.
    expect(dock).toMatch(/\{#each\s+panes\s+as\s+p\s+\(p\.key\)\s*\}/);
    expect(dock).toMatch(/visited\.includes\(p\.key\)/);
    expect(dock).toMatch(/paneShown\(p\)\s*\?\s*'vt-dock-pane'\s*:\s*'hidden'/);
  });

  it("rebuilds a session panel for another session, and nothing else", () => {
    // The session id is part of a session panel's key; the server tree's key is
    // its bare id, so switching terminal tabs leaves it alone.
    expect(dock).toMatch(
      /paneKey\s*=\s*\(id: PanelId, sid: string \| null\): string\s*=>\s*\(?\s*isSessionPanel\(id\)\s*\?\s*`\$\{sid\}\/\$\{id\}`\s*:\s*id/,
    );
    // Since v1.2 the panels of every session ON SCREEN are kept (two terminals
    // side by side: the focus moves on every click) — and only those. The kept
    // set is the focused session plus the ones the page names; with no session
    // in focus nothing session-bound is kept at all.
    expect(dock).toMatch(
      /const kept = \$derived\(\s*sessionId === null \? \[\] : \[\.\.\.new Set\(\[\.\.\.sessions, sessionId\]\)\]\s*,?\s*\)/,
    );
    expect(dock).toMatch(/kept\.map\(\(sid\) => \(\{ key: paneKey\(id, sid\), id, sid \}\)\)/);
    // …and the page does not put the docks back under a key on the active tab.
    expect(page).not.toMatch(/\{#key[^}]*\}\s*<Dock\b/);
  });

  it("tells every driver panel whether it is on screen", () => {
    // Dock → snippet → DockPanel → panel: `visible` has to survive all three hops.
    expect(dock, "the dock renders a panel with its on-screen state").toMatch(
      /\{@render\s+panel\(p\.id,\s*paneShown\(p\),\s*p\.sid\)\}/,
    );
    // A panel kept for a session that is not in focus is mounted but OFF screen:
    // without `inFocus` here, two sessions' Docker panels would both poll.
    expect(
      dock,
      "on screen = the shown tab of an open dock, for the session in focus, on a live session",
    ).toMatch(
      /paneShown\s*=\s*\(p: PaneRef\): boolean\s*=>\s*p\.id === active && inFocus\(p\) && !collapsed && !\(offline && isSessionPanel\(p\.id\)\)/,
    );
    expect(dock).toMatch(
      /inFocus\s*=\s*\(p: PaneRef\): boolean\s*=>\s*p\.sid === null \|\| p\.sid === sessionId/,
    );
    expect(instance(page, "DockPanel"), "the page passes it on").toMatch(
      /(?:^|\s)(?:\{visible\}|visible=\{visible\})/m,
    );
    for (const component of [
      "SftpPanel",
      "LocalFilePanel",
      "GitPanel",
      "DockerPanel",
      "K8sPanel",
    ]) {
      expect(instance(host, component), `${component} gets a visible prop`).toMatch(
        /(?:^|\s)(?:\{visible\}|visible=\{visible\})/m,
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

  it("lets no driver panel run before the tab's session exists", () => {
    // Local tabs used to get `sessionReady={kind === "ssh" ? sessionReady : true}`.
    // "Open shell" in Docker opens a NEW local tab, the dock remounts for it and
    // Docker probed `docker version` before the PTY was registered: the backend
    // found no session, and the panel said "Docker unavailable" until Retry —
    // on Windows, where ConPTY spawns slowly, every time. Local tabs have a real
    // connecting → connected status; every kind waits for it.
    for (const component of ["GitPanel", "DockerPanel", "K8sPanel"]) {
      const tag = instance(host, component);
      expect(tag, `${component} gets the dock's sessionReady`).toMatch(
        /(?:^|\s)(?:\{sessionReady\}|sessionReady=\{sessionReady\})/m,
      );
    }
    expect(host, "sessionReady derives from the tab's connection").toMatch(
      /const sessionReady = \$derived\(connection === "connected"\)/,
    );
  });

  it("a hidden file panel is no target for dropped files", () => {
    // The system's drop is window-wide. While each panel listened for it, a
    // panel hidden behind another dock tab uploaded into a directory the user
    // could not see — it had to check `visible` itself. Since v1.13 no panel
    // listens at all: the page hears the drop once, and what it lands on is
    // what is under the pointer (`fileTargetAt`), which a hidden panel never is.
    expect(code("FileBrowser.svelte")).not.toMatch(/onDragDropEvent|getCurrentWebview/);
    const store = readFileSync(join(LIB, "stores", "filedrag.svelte.ts"), "utf8");
    const at = store.indexOf("export function fileTargetAt(");
    const fn = store.slice(at, store.indexOf("\n}\n", at));
    expect(at).toBeGreaterThan(-1);
    expect(fn).toMatch(/document\.elementFromPoint\(x, y\)/);
    // Found from the element under the pointer, never by looking for panels.
    expect(fn).not.toMatch(/querySelector/);
  });
});
