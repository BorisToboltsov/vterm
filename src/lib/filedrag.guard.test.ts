// File-drag guard (v1.13).
//
// Files are dragged out of a file panel onto a folder of another session's
// panel, a session's tab or its terminal, and into another window of the app;
// in from the desktop; and over from another window. One store owns the drag
// (`stores/filedrag`), one pure model says what a drop means (`filedrop.ts`).
// Each rule below is a way that quietly stops being true:
//
//  1. The drag is the store's, not the panel's. `FileBrowser` holds no pointer,
//     tracks no move, draws no label and hears no window-wide drop: it is
//     destroyed whenever its tab stops being on screen — and files held over
//     another tab put that tab on screen. A drag kept in the panel would end
//     the moment it reached somewhere.
//  2. The window hears the system's drop once, and where it lands is read from
//     where the pointer is. A listener per panel uploaded into whichever panel
//     happened to be mounted, wherever the files were dropped.
//  3. Nothing happens until the release. The store does what a target means in
//     one place (`land`), and opens what files are held over only from its
//     timer; the page changes nothing while files are in the air.
//  4. Between two sessions a drop copies — it never moves. The only move is
//     inside one panel, and only that panel's own question starts it.
//  5. `Esc` cancels every drag of the app, and the key goes no further.
//  6. Whatever is said to another window about held files is taken back.
//
// Checked on the source with comments stripped; each check is a function over
// text, shown to catch its own violation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** Drop `<!-- … -->`, `/* … *\/` and `// …` (not the `//` of a URL). */
export function code(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    out += source[i++];
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Body of `function name(` up to the next line that closes it at its own depth. */
function fn(c: string, name: string): string {
  const at = c.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return "";
  const indent = /(^|\n)([ \t]*)[^\n]*$/.exec(c.slice(0, at))?.[2] ?? "";
  const end = c.indexOf(`\n${indent}}\n`, at);
  return c.slice(at, end < 0 ? undefined : end);
}

const BROWSER = "src/lib/FileBrowser.svelte";
const STORE = "src/lib/stores/filedrag.svelte.ts";
const MODEL = "src/lib/filedrop.ts";
const PAGE = "src/routes/+page.svelte";
const DRAGS = [
  "src/lib/stores/filedrag.svelte.ts",
  "src/lib/stores/tabdrag.svelte.ts",
  "src/lib/stores/viewdrag.svelte.ts",
  "src/lib/stores/dockdrag.svelte.ts",
];

// ── 1: the drag is the store's ──────────────────────────────────────────────

export function panelViolations(browser: string): string[] {
  const c = code(browser);
  const out: string[] = [];
  if (/setPointerCapture|releasePointerCapture/.test(c)) {
    out.push("the file panel holds the pointer of a drag itself");
  }
  if (/onpointermove=|onpointerup=|addEventListener\(\s*["']pointermove/.test(c)) {
    out.push("the file panel tracks a drag itself");
  }
  if (/onDragDropEvent|getCurrentWebview/.test(c)) {
    out.push("the file panel listens for files dropped on the window");
  }
  if (!/onpointerdown=\{\(e\) => startMove\(e, entry\)\}/.test(c) || !/beginFileDrag\(e, \(\) => \{/.test(fn(c, "startMove"))) {
    out.push("a row does not hand its drag to the store");
  }
  if (/pointer-events-none fixed/.test(c)) {
    out.push("the file panel draws the label of a drag itself");
  }
  if (!/data-file-panel=\{panelKey\}/.test(c) || !/data-file-cwd=\{isConnected && mutable \? cwd : undefined\}/.test(c)) {
    out.push("the file panel does not mark what files can be dropped on");
  }
  return out;
}

// ── 2: the system's drop is heard once, and aimed by the pointer ────────────

export function desktopViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  const hearers = Object.entries(files).filter(([, src]) => /onDragDropEvent\(/.test(code(src)));
  if (hearers.length !== 1 || hearers[0][0] !== PAGE) {
    out.push("files dropped on the window are heard somewhere other than once, by the page");
  }
  const page = code(files[PAGE] ?? "");
  const hear = fn(page, "hearDesktopDrag");
  if (!/pagePoint\(ev\.position, window\.devicePixelRatio\)/.test(hear)) {
    out.push("a drop from the desktop is not placed where the pointer is");
  }
  if (!/dropGuestFiles\(desktopFiles\(ev\.paths\), at\.x, at\.y\)/.test(hear)) {
    out.push("a drop from the desktop does not go through the target under the pointer");
  }
  if (/startTransfer|transferStart|sftpList/.test(hear)) {
    out.push("a drop from the desktop is sent without asking what it was dropped on");
  }
  return out;
}

// ── 3: nothing happens until the release ────────────────────────────────────

export function releaseViolations(store: string): string[] {
  const c = code(store);
  const out: string[] = [];
  const drops = [...c.matchAll(/host\??\.drop\(/g)].length;
  if (drops !== 1 || !/host\.drop\(files, meaning\)/.test(fn(c, "land"))) {
    out.push("files are dropped somewhere other than on release");
  }
  for (const mover of ["onMove", "aim", "offer", "showGuestFiles"]) {
    if (/\bland\(\)|host\??\.drop\(/.test(fn(c, mover))) {
      out.push(`${mover} drops the files before they are let go of`);
    }
  }
  const springs = [...c.matchAll(/host\??\.spring\(/g)].length;
  if (springs !== 1 || !/setTimeout\(\(\) => \{[^}]*host\?\.spring\(what\);?\s*\}, SPRING_MS\)/.test(fn(c, "hold"))) {
    out.push("what files are held over opens at once, not after the wait");
  }
  return out;
}

// ── 4: between two sessions it is a copy ────────────────────────────────────

export function copyViolations(model: string, page: string): string[] {
  const out: string[] = [];
  const m = code(model);
  const meaning = fn(m, "dropMeaning");
  const moves = [...meaning.matchAll(/kind: "move"/g)].length;
  const own = /if \(files\.from === target\.session\) \{([\s\S]*?)\n  \}/.exec(meaning)?.[1] ?? "";
  if (moves !== 1 || !/kind: "move"/.test(own)) {
    out.push("a drop on another session's panel can mean a move");
  }
  const drop = fn(code(page), "dropFiles");
  const move = /case "move":([\s\S]*?)return;/.exec(drop)?.[1] ?? "";
  if (!/requestMove\(/.test(move) || /sftpRename|sftpDelete|startTransfer/.test(move)) {
    out.push("a move inside a panel is done without that panel's question");
  }
  if (/sftpRename|sftpDelete|localDelete|localRename/.test(drop)) {
    out.push("dropped files are moved or deleted by the page");
  }
  return out;
}

// ── 5: Esc cancels every drag ───────────────────────────────────────────────

export function escapeViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const rel of DRAGS) {
    const c = code(files[rel] ?? "");
    if (!/stopEscape = cancelOnEscape\(/.test(c)) out.push(`${rel} is not cancelled by Esc`);
    else if (!/stopEscape\?\.\(\);\s*stopEscape = null;/.test(fn(c, "stopListening"))) {
      out.push(`${rel} goes on listening for Esc after its drag has ended`);
    }
  }
  const helper = fn(code(files["src/lib/actions/drag.ts"] ?? ""), "cancelOnEscape");
  if (
    !/e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*e\.stopImmediatePropagation\(\);/.test(helper) ||
    !/addEventListener\("keydown", onKey, true\)/.test(helper)
  ) {
    out.push("the Esc that cancels a drag goes on to the terminal");
  }
  return out;
}

// ── 6: what is said to another window is taken back ─────────────────────────

export function relayViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  const hostAt = c.indexOf("onFileDrag({");
  const host = hostAt < 0 ? "" : c.slice(hostAt, c.indexOf("\n    });", hostAt));
  if (!/over: async \(files\) => \{[\s\S]*?return dragOver\(describeFiles\(labelled\(files\)\)/.test(host)) {
    out.push("files held outside the window are shown to nobody");
  }
  // Whatever else the release does once the backend has answered, it ends by
  // saying the drag is over — on every path through it.
  const release = /release: \(files\) =>\s*void dragDrop\(describeFiles\(labelled\(files\)\)\)([\s\S]*?)\n      left:/.exec(host)?.[1] ?? "";
  const then = /\.then\(\(under\) => \{([\s\S]*?)\n          \}\),$/.exec(release)?.[1] ?? "";
  const returns = then.match(/\breturn\b[^;]*;/g) ?? [];
  if (returns.length === 0 || !returns.every((r) => /^return dragEnd\(\)/.test(r))) {
    out.push("files let go of over another window leave it drawing them");
  }
  if (!/left: \(\) => void dragEnd\(\)/.test(host)) {
    out.push("files that came back into their window stay drawn in the other one");
  }
  const heard = /listenHere<unknown>\(DRAG_EVENT, \(e\) => \{([\s\S]*?)\n      \}\),/.exec(c)?.[1] ?? "";
  if (!/const files = parseFileDragMessage\(e\.payload\);\s*if \(files\) applyFileDragMessage\(files\);/.test(heard)) {
    out.push("files held over this window from another one are not read");
  }
  return out;
}

describe("file-drag guard", () => {
  const files: Record<string, string> = {};
  for (const rel of [BROWSER, STORE, MODEL, PAGE, "src/lib/actions/drag.ts", "src/lib/SftpPanel.svelte", "src/lib/LocalFilePanel.svelte", ...DRAGS]) {
    files[rel] = read(rel);
  }

  it("the drag is the store's, not the panel's", () => {
    expect(panelViolations(files[BROWSER])).toEqual([]);
  });

  it("the system's drop is heard once, and lands where the pointer is", () => {
    expect(desktopViolations(files)).toEqual([]);
  });

  it("nothing happens until the release", () => {
    expect(releaseViolations(files[STORE])).toEqual([]);
  });

  it("between two sessions a drop copies; a move is one panel's own", () => {
    expect(copyViolations(files[MODEL], files[PAGE])).toEqual([]);
  });

  it("Esc cancels every drag of the app, and the key goes no further", () => {
    expect(escapeViolations(files)).toEqual([]);
  });

  it("what is said to another window about held files is taken back", () => {
    expect(relayViolations(files[PAGE])).toEqual([]);
  });
});

describe("the guard catches", () => {
  const mutate = (source: string, from: string, to: string): string => {
    const out = source.replace(from, to);
    expect(out, `mutation "${from.slice(0, 40)}" did not apply`).not.toBe(source);
    return out;
  };
  const browser = read(BROWSER);
  const store = read(STORE);
  const model = read(MODEL);
  const page = read(PAGE);

  it("a panel that takes its drag back", () => {
    const own = mutate(
      browser,
      "          onkeydown={onListKeydown}",
      "          onpointermove={(e) => (cursor = e.clientY)}\n          onkeydown={onListKeydown}",
    );
    expect(panelViolations(own)).toEqual(["the file panel tracks a drag itself"]);
    const capture = `${browser}\n<script>listEl?.setPointerCapture(1);</script>`;
    expect(panelViolations(capture)).toEqual(["the file panel holds the pointer of a drag itself"]);
    const unmarked = mutate(browser, "  data-file-panel={panelKey}\n", "");
    expect(panelViolations(unmarked)).toEqual(["the file panel does not mark what files can be dropped on"]);
    const direct = mutate(browser, "beginFileDrag(e, () => {", "pickUp(e, () => {");
    expect(panelViolations(direct)).toEqual(["a row does not hand its drag to the store"]);
  });

  it("a panel that hears the window's drop again", () => {
    const hearing = `${browser}\n<script>getCurrentWebview().onDragDropEvent(() => {});</script>`;
    expect(panelViolations(hearing)).toEqual(["the file panel listens for files dropped on the window"]);
    expect(desktopViolations({ [PAGE]: page, [BROWSER]: hearing })).toEqual([
      "files dropped on the window are heard somewhere other than once, by the page",
    ]);
  });

  it("a drop from the desktop that ignores where it was dropped", () => {
    const blind = mutate(
      page,
      "      if (ev.paths.length > 0) dropGuestFiles(desktopFiles(ev.paths), at.x, at.y);",
      "      if (ev.paths.length > 0) void startTransfer({ src: DISK, dst: DISK, sources: [], destDir: \"\" });",
    );
    expect(desktopViolations({ [PAGE]: blind })).toEqual([
      "a drop from the desktop does not go through the target under the pointer",
      "a drop from the desktop is sent without asking what it was dropped on",
    ]);
    const unscaled = mutate(page, "pagePoint(ev.position, window.devicePixelRatio)", "ev.position");
    expect(desktopViolations({ [PAGE]: unscaled })).toEqual([
      "a drop from the desktop is not placed where the pointer is",
    ]);
  });

  it("files dropped before they are let go of, and a tab that opens at a touch", () => {
    const eager = mutate(
      store,
      "  offer(hit !== null && host?.meaning(files, hit.target) ? hit : null);",
      "  offer(hit !== null && host?.meaning(files, hit.target) ? hit : null);\n  land();",
    );
    expect(releaseViolations(eager)).toEqual(["aim drops the files before they are let go of"]);
    const instant = mutate(
      store,
      "  springTimer = setTimeout(() => {",
      "  host?.spring(what);\n  springTimer = setTimeout(() => {",
    );
    expect(releaseViolations(instant)).toEqual([
      "what files are held over opens at once, not after the wait",
    ]);
  });

  it("a drop on another session that moves", () => {
    const moving = mutate(
      model,
      "    dir: target.kind === \"folder\" ? target.dir : null,\n  };",
      "    dir: target.kind === \"folder\" ? target.dir : null,\n  } as never as { kind: \"move\"; session: string; dir: string };",
    );
    expect(copyViolations(moving, page)).toEqual(["a drop on another session's panel can mean a move"]);
    const direct = mutate(
      page,
      "        requestMove({\n          session: meaning.session,",
      "        await sftpRename(meaning.session, files.entries[0].path, meaning.dir);\n        requestMove({\n          session: meaning.session,",
    );
    expect(copyViolations(model, direct)).toEqual([
      "a move inside a panel is done without that panel's question",
      "dropped files are moved or deleted by the page",
    ]);
  });

  it("a drag Esc does not cancel", () => {
    const all: Record<string, string> = { "src/lib/actions/drag.ts": read("src/lib/actions/drag.ts") };
    for (const rel of DRAGS) all[rel] = read(rel);
    const deaf = { ...all, [DRAGS[2]]: all[DRAGS[2]].replace("stopEscape = cancelOnEscape(", "void cancelOnEscape(") };
    expect(escapeViolations(deaf)).toEqual([`${DRAGS[2]} is not cancelled by Esc`]);
    const leaking = { ...all, [DRAGS[1]]: mutate(all[DRAGS[1]], "  stopEscape?.();\n  stopEscape = null;\n", "") };
    expect(escapeViolations(leaking)).toEqual([
      `${DRAGS[1]} goes on listening for Esc after its drag has ended`,
    ]);
    const through = { ...all, "src/lib/actions/drag.ts": mutate(all["src/lib/actions/drag.ts"], "    e.stopPropagation();\n", "") };
    expect(escapeViolations(through)).toEqual(["the Esc that cancels a drag goes on to the terminal"]);
  });

  it("a window left drawing files that are not coming", () => {
    const kept = mutate(
      page,
      "            return dragEnd().catch(() => {});\n          }),\n      left:",
      "            return undefined;\n          }),\n      left:",
    );
    expect(relayViolations(kept)).toEqual(["files let go of over another window leave it drawing them"]);
    // A path through the release that says nothing is the same hole.
    const early = mutate(
      page,
      "            if (under === null) tellNotCarried(files);\n",
      "            if (under === null) return tellNotCarried(files);\n",
    );
    expect(relayViolations(early)).toEqual(["files let go of over another window leave it drawing them"]);
    const stuck = mutate(
      page,
      "      left: () => void dragEnd().catch(() => {}),\n      out: handToSystem,\n    });",
      "      left: undefined,\n      out: handToSystem,\n    });",
    );
    expect(relayViolations(stuck)).toEqual([
      "files that came back into their window stay drawn in the other one",
    ]);
    const unread = mutate(page, "        if (files) applyFileDragMessage(files);\n", "");
    expect(relayViolations(unread)).toEqual([
      "files held over this window from another one are not read",
    ]);
  });
});
