// Window guard (v1.3, ADR 0017; v1.4, ADR 0018; v1.10, ADR 0023): the contracts
// a tab moved to another window — one of its own, or one that is already open —
// stands on.
//
//  1. A session is ended by the tab's teardown and by nothing else. `Terminal`
//     used to disconnect in `onDestroy`; a tab handed to another window unmounts
//     its terminal while the session lives on, so a `disconnect` anywhere but in
//     `closeTabFully` — or one that ignores `keepSession` — ends the session the
//     other window has just taken over.
//  2. The handoff keeps its order. The output is held, then the terminal is
//     snapshotted, then the new window is waited for, and only then does the tab
//     leave this one. Dropping the tab earlier loses it when the window fails to
//     start; snapshotting before the hold loses whatever printed in between.
//  3. A terminal that takes a session over listens first, replays its snapshot at
//     the size it was taken at, and only then asks for the held output. In any
//     other order the output lands before the screen it belongs after.
//  4. What a window is told individually it hears through `listenHere`. The
//     plain `listen` hears what the backend sent to ANOTHER window too: a menu
//     command would open Settings in every window, and each would list the
//     other's transfers.
//  5. What belongs to the main window stays there: it alone saves the dock
//     layout, drains "Open with vterm" and reports the store warnings. A second
//     window doing the same overwrites the layout the next launch opens with and
//     opens every file twice.
//  6. A window that is already open can be handed a tab (v1.4). It says it takes
//     tabs only once it listens for the offer — announced earlier, it would be
//     offered a tab it cannot hear of. And nothing about taking a tab closes it:
//     a window opened for a tab goes when the tab does not arrive, but an open
//     one has tabs of its own, and closing it ends their sessions. A tab dropped
//     outside the window goes where the pointer is when it is released — asked
//     then, not read off where the tab was last drawn.
//  7. A tab held over another window is drawn by that window (v1.4). It hears of
//     the drag only from this one, so every way the drag can end without the tab
//     arriving has to be said — a drop that was refused, a handoff that failed —
//     or that window goes on showing a tab that is not coming. And the tab lands
//     in the place that window kept for it, not wherever a new tab would go.
//     Over the desktop the tab is drawn by a floating label; this page then
//     draws none — two labels for one tab — and every release asks the backend,
//     which is also what takes that label away. A tab only reordered in its own
//     strip, with no other window that could lie over this one, asks nobody: a
//     call per pointer move, and a window made for a label nobody will see.
//  8. A pane moves as its tabs do (v1.10): one trip per tab, and the trip is the
//     same function a single tab takes — a second copy of it would be a second
//     order of holding and letting go. The pane is judged whole before its first
//     tab leaves (a pane that left one tab behind did not move), each tab is
//     asked again at its turn, a window opened for the first tab is waited for
//     until it says it takes tabs, and a move that stopped midway says how far
//     it got. In the window taking it, only the pane's first tab is shown; the
//     others take their seats next to it — placed like a new tab, each would
//     take the pane's view in turn and the order would be the order of arrival.
//
// 2, 6, 7 and 8 are the window flow's (page/windowflow, v1.25.3): the trip, a
// tab dropped outside, an open window taking a tab and a pane moving whole are
// held by its behaviour tests, and who may call the backend's half of a handoff
// by the lint rule `vterm/owned-imports`. What stays here is the page's wiring
// of that flow, the terminal, the listeners, the main window's duties and the
// seat a tab of a moving pane takes on arrival.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for (the second `describe`). Sources are read
// with comments stripped — the comments in the components name the anti-patterns.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Drop `<!-- … -->` blocks (a scan: one regex pass leaves a nested opener behind). */
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
function code(src: string): string {
  return stripHtmlComments(src)
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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

/** Body of a component-level `function name(` (to its closing brace, 2 spaces in). */
function fn(src: string, name: string): string {
  const at = src.search(new RegExp(`(async )?function ${name}\\(`));
  return at < 0 ? "" : src.slice(at, src.indexOf("\n  }\n", at));
}

/** The block opened by `opener` (which ends in `{`), matched by brace depth. */
function block(src: string, opener: string): string {
  const at = src.indexOf(opener);
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + opener.length - 1; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  return "";
}

const PAGE = "routes/+page.svelte";
const TABS = "lib/stores/tabs.svelte.ts";
const PACKET = "lib/stores/tabpacket.ts";
const TERMINAL = "lib/terminal/Terminal.svelte";
const LAYOUT = "lib/stores/layout.svelte.ts";
const SESSION_API = "lib/api/session.ts";

// ── 1: who ends a session ────────────────────────────────────────────────────

/** A call of the `disconnect` wrapper — not its own definition. */
const DISCONNECT_CALL = /(?<!function )(?<![.\w])disconnect\(/g;

export function sessionEndViolations(rel: string, source: string): string[] {
  const c = code(source);
  const calls = c.match(DISCONNECT_CALL)?.length ?? 0;
  if (rel === SESSION_API) return [];
  if (rel !== PAGE) {
    return calls > 0 ? [`${rel} ends a session — only the tab's teardown may`] : [];
  }
  const out: string[] = [];
  if (calls !== 1) out.push(`the page ends a session in ${calls} places, not one`);
  const teardown = fn(c, "closeTabFully");
  if (!/if \(!keepSession\) void disconnect\(sessionId\)/.test(teardown)) {
    out.push("closeTabFully does not end the session, or ends it for a tab that was handed over");
  }
  return out;
}

// ── 2, 6, 7: the page's wiring of the window flow ─────────────────────────────

export function wiringViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  // The trip snapshots the terminal the tab is in, once it has the output sent.
  if (!/snapshot: async \(sid, sent\) => \(await termRefs\[sid\]\?\.snapshot\?\.\(sent\)\) \?\? null,/.test(c)) {
    out.push("the trip does not wait for the terminal's snapshot");
  }
  // Keeping the session is the flow's: the page never drops a tab and keeps its
  // session itself, and the flow's teardown is the tab's teardown.
  if (/closeTabFully\([^()]*,\s*true\)/.test(c) || !/teardown: closeTabFully,/.test(c)) {
    out.push("a tab is dropped without ending its session outside a handoff");
  }
  if (!c.includes("onadoptfailed={() => windows.adoptFailed(tab.sessionId)}")) {
    out.push("a tab that did not arrive is not given back to the window that sent it");
  }
  // It says it takes tabs once — when the subscription to the offer resolved.
  const subscribed =
    /listenHere\(HANDOFF_EVENT, \(\) => void windows\.receiveTab\(\)\),\s*\]\)\s*\.then\(\(us\) => \{[^}]*windows\.listening\(\);/;
  if ((c.match(/windows\.listening\(\)/g)?.length ?? 0) !== 1 || !subscribed.test(c)) {
    out.push("a window takes tabs before it listens for the offer of one");
  }
  if (!/listen<unknown>\(WINDOWS_EVENT, \(e\) => windows\.heardWindows\(e\.payload\)\)/.test(c)) {
    out.push("the windows that take tabs are not heard");
  }
  // One label for one tab: over another window that window draws it, over the
  // desktop the floating label does.
  if (!c.includes("{#if draggingTab && !heldOverWindow && !tabDrag.floating}")) {
    out.push("a tab held over another window is drawn in both");
  }
  return out;
}

// ── 3: a terminal taking a session over ──────────────────────────────────────

export function terminalViolations(terminal: string): string[] {
  const c = code(terminal);
  const out: string[] = [];
  const listens = c.indexOf("listen<number[]>(outputEvent(sessionId)");
  const replays = c.search(/term\.write\(data, written\)\);\s*await attachSession\(sessionId\);/);
  if (listens < 0 || replays < 0 || listens > replays) {
    out.push("an adopted terminal does not listen, replay its snapshot and only then attach");
  }
  if (!/function applyFontAndFit\(\) \{\s*if \(replaying\) return;/.test(c)) {
    out.push("an adopted terminal can be refitted before its snapshot is replayed");
  }
  if (!/if \(!replaying\) fit\.fit\(\);/.test(c)) {
    out.push("an adopted terminal is fitted to the new window before its snapshot is replayed");
  }
  if (!/received \+= 1;/.test(c) || !/if \(received < sent\)/.test(c)) {
    out.push("the snapshot does not wait for the output sent before the hold");
  }
  return out;
}

// ── 4: events addressed to one window ────────────────────────────────────────

const ADDRESSED = [
  '"menu://',
  '"sftp://progress"',
  '"sftp://job"',
  '"sync://scan"',
  '"window://close"',
  '"window://handoff"',
  '"window://drag"',
  '"vterm://open-file"',
  "OPEN_FILE_EVENT",
  "WINDOW_CLOSE_EVENT",
  "CLOSE_ASKED_EVENT",
  "HANDOFF_EVENT",
  "DRAG_EVENT",
];

export function listenerViolations(rel: string, source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  for (const m of c.matchAll(/(?<![.\w])listen(?:<[^>]*>)?\(\s*([^,)]+)/g)) {
    const event = m[1].trim();
    if (ADDRESSED.some((name) => event.startsWith(name))) {
      out.push(`${rel} hears ${event} with listen() — it would hear another window's too`);
    }
  }
  return out;
}

/** The page subscribes to everything a window is told individually. */
export function pageListenerViolations(page: string): string[] {
  const c = code(page);
  return [
    '"menu://settings"',
    '"menu://about"',
    '"menu://help"',
    '"menu://manual"',
    '"menu://monitoring"',
    "CLOSE_ASKED_EVENT",
    '"sftp://progress"',
    '"sftp://job"',
    '"sync://scan"',
    "OPEN_FILE_EVENT",
    "HANDOFF_EVENT",
    "DRAG_EVENT",
  ]
    .filter((event) => {
      const escaped = event.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      return !new RegExp(`listenHere(?:<[^>]*>)?\\(\\s*${escaped}`).test(c);
    })
    .map((event) => `the page does not listen for ${event} through listenHere`);
}

// ── 5: what is the main window's alone ───────────────────────────────────────

export function mainOnlyViolations(page: string, layout: string): string[] {
  const out: string[] = [];
  const c = code(page);
  const main = block(c, "if (isMainWindow) {");
  for (const call of ["takeStoreWarnings()", "takePendingOpens()", "listenHere<string>(OPEN_FILE_EVENT"]) {
    if ((c.split(call).length - 1) !== 1 || !main.includes(call)) {
      out.push(`${call} runs outside the main window`);
    }
  }
  if (!/\} else \{\s*void windows\.adoptHandoff\(\);/.test(c.slice(c.indexOf(main) + main.length - 1))) {
    out.push("a secondary window does not take over the tab it was opened for");
  }
  const store = code(layout);
  if (!/\$effect\(\(\) => \{\s*if \(!isMainWindow\) return;\s*const data = JSON\.stringify\(persistedLayout/.test(store)) {
    out.push("a secondary window saves its dock layout over the main window's");
  }
  return out;
}

// ── 8: a pane arrives as it was ─────────────────────────────────────────────

export function seatViolations(tabs: string, packet: string): string[] {
  const out: string[] = [];
  // The others are seated, not placed.
  if (!/adoptTab\(\s*packet\.tab,\s*packet\.terminal,\s*drop,\s*lead === null \? null : \{ tab: lead,/.test(code(packet))) {
    out.push("a packet's seat is dropped on arrival");
  }
  const adopt = code(tabs);
  const seated = block(adopt.slice(adopt.indexOf("export function adoptTab(")), "if (beside) {");
  if (!seated.includes("center = addTabBehind(") || seated.includes("placeTab(") || !seated.includes("return;")) {
    out.push("a tab that follows its pane is shown in place of the tab the pane showed");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("window guard", () => {
  it("a session is ended only by the tab's teardown", () => {
    expect(sources().flatMap((rel) => sessionEndViolations(rel, raw(rel)))).toEqual([]);
  });

  it("the page wires the window flow: the snapshot, the teardown, the offer, the label", () => {
    expect(wiringViolations(raw(PAGE))).toEqual([]);
  });

  it("a terminal takes a session over in order", () => {
    expect(terminalViolations(raw(TERMINAL))).toEqual([]);
  });

  it("events addressed to one window are heard through listenHere", () => {
    expect(sources().flatMap((rel) => listenerViolations(rel, raw(rel)))).toEqual([]);
    expect(pageListenerViolations(raw(PAGE))).toEqual([]);
  });

  it("the main window's duties stay with the main window", () => {
    expect(mainOnlyViolations(raw(PAGE), raw(LAYOUT))).toEqual([]);
  });

  it("a tab of a moving pane takes its seat on arrival", () => {
    expect(seatViolations(raw(TABS), raw(PACKET))).toEqual([]);
  });
});

describe("window guard — catches what it exists for", () => {
  const page = raw(PAGE);
  const terminal = raw(TERMINAL);
  const layout = raw(LAYOUT);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a terminal that disconnects when it unmounts", () => {
    const old = mutate(
      terminal,
      "unlisten.forEach((u) => u());",
      "unlisten.forEach((u) => u());\n    disconnect(sessionId).catch(() => {});",
    );
    expect(sessionEndViolations(TERMINAL, old)).toEqual([
      `${TERMINAL} ends a session — only the tab's teardown may`,
    ]);
    // A comment naming the call is not a call.
    expect(sessionEndViolations(TERMINAL, `// disconnect(sessionId)\n${terminal}`)).toEqual([]);
  });

  it("a teardown that ends a handed-over session, or no session at all", () => {
    expect(
      sessionEndViolations(
        PAGE,
        mutate(page, "if (!keepSession) void disconnect(sessionId)", "void disconnect(sessionId)"),
      ),
    ).toContain("closeTabFully does not end the session, or ends it for a tab that was handed over");
    expect(
      sessionEndViolations(
        PAGE,
        mutate(page, "if (!keepSession) void disconnect(sessionId).catch(() => {});", ""),
      ),
    ).toEqual(
      expect.arrayContaining([
        "the page ends a session in 0 places, not one",
        "closeTabFully does not end the session, or ends it for a tab that was handed over",
      ]),
    );
  });

  it("a second place that ends a session", () => {
    expect(
      sessionEndViolations(
        PAGE,
        mutate(page, "function requestCloseTab(sessionId: string) {", "function requestCloseTab(sessionId: string) {\n    void disconnect(sessionId);"),
      ),
    ).toContain("the page ends a session in 2 places, not one");
  });

  it("a third way to drop a tab without ending its session", () => {
    expect(
      wiringViolations(mutate(page, "else closeTabFully(sessionId);\n  }", "else closeTabFully(sessionId, true);\n  }")),
    ).toContain("a tab is dropped without ending its session outside a handoff");
  });

  it("a tab that did not arrive and is not given back", () => {
    expect(
      wiringViolations(
        mutate(page, "onadoptfailed={() => windows.adoptFailed(tab.sessionId)}", "onadoptfailed={() => closeTabFully(tab.sessionId)}"),
      ),
    ).toContain("a tab that did not arrive is not given back to the window that sent it");
  });

  it("a window that takes tabs before it can hear an offer", () => {
    const early = mutate(
      mutate(page, "        unlisteners.push(...us);\n        windows.listening();\n", "        unlisteners.push(...us);\n"),
      "    Promise.all([\n      listen<unknown>(WINDOWS_EVENT",
      "    windows.listening();\n    Promise.all([\n      listen<unknown>(WINDOWS_EVENT",
    );
    expect(wiringViolations(early)).toContain("a window takes tabs before it listens for the offer of one");
  });

  it("an offer heard by every window", () => {
    const plain = mutate(
      page,
      "listenHere(HANDOFF_EVENT, () => void windows.receiveTab())",
      "listen(HANDOFF_EVENT, () => void windows.receiveTab())",
    );
    expect(listenerViolations(PAGE, plain)).toEqual([
      `${PAGE} hears HANDOFF_EVENT with listen() — it would hear another window's too`,
    ]);
    expect(pageListenerViolations(plain)).toEqual([
      "the page does not listen for HANDOFF_EVENT through listenHere",
    ]);
  });

  it("a drag heard by every window", () => {
    const plain = mutate(page, "listenHere<unknown>(DRAG_EVENT", "listen<unknown>(DRAG_EVENT");
    expect(listenerViolations(PAGE, plain)).toEqual([
      `${PAGE} hears DRAG_EVENT with listen() — it would hear another window's too`,
    ]);
    expect(pageListenerViolations(plain)).toEqual([
      "the page does not listen for DRAG_EVENT through listenHere",
    ]);
  });

  it("a tab drawn in both windows at once", () => {
    expect(
      wiringViolations(mutate(page, "{#if draggingTab && !heldOverWindow && !tabDrag.floating}", "{#if draggingTab}")),
    ).toEqual(["a tab held over another window is drawn in both"]);
  });

  it("a terminal that attaches before its snapshot is written", () => {
    const swapped = mutate(
      terminal,
      "await new Promise<void>((written) => term.write(data, written));\n        await attachSession(sessionId);",
      "await attachSession(sessionId);\n        await new Promise<void>((written) => term.write(data, written));",
    );
    expect(terminalViolations(swapped)).toContain(
      "an adopted terminal does not listen, replay its snapshot and only then attach",
    );
  });

  it("a terminal refitted before its snapshot is replayed", () => {
    expect(terminalViolations(mutate(terminal, "    if (replaying) return;\n", ""))).toContain(
      "an adopted terminal can be refitted before its snapshot is replayed",
    );
    expect(
      terminalViolations(mutate(terminal, "if (!replaying) fit.fit();", "fit.fit();")),
    ).toContain("an adopted terminal is fitted to the new window before its snapshot is replayed");
  });

  it("a snapshot that does not wait for the output already sent", () => {
    expect(terminalViolations(mutate(terminal, "        received += 1;\n", ""))).toContain(
      "the snapshot does not wait for the output sent before the hold",
    );
  });

  it("a menu command heard by every window", () => {
    const plain = mutate(
      page,
      'listenHere("menu://settings", () => openSettings())',
      'listen("menu://settings", () => openSettings())',
    );
    expect(listenerViolations(PAGE, plain)).toEqual([
      `${PAGE} hears "menu://settings" with listen() — it would hear another window's too`,
    ]);
    expect(pageListenerViolations(plain)).toEqual([
      'the page does not listen for "menu://settings" through listenHere',
    ]);
  });

  it("transfers of another window", () => {
    const plain = mutate(
      page,
      'listenHere<SftpProgress>("sftp://progress"',
      'listen<SftpProgress>("sftp://progress"',
    );
    expect(listenerViolations(PAGE, plain)).toHaveLength(1);
    expect(pageListenerViolations(plain)).toHaveLength(1);
  });

  it("the jobs of another window's sessions", () => {
    // A job is told to the window that shows the tab of a session it touches
    // (v1.12): heard with a plain listen, its row would appear in every window.
    const plain = mutate(
      page,
      'listenHere<TransferJob>("sftp://job"',
      'listen<TransferJob>("sftp://job"',
    );
    expect(listenerViolations(PAGE, plain)).toHaveLength(1);
    expect(pageListenerViolations(plain)).toHaveLength(1);
  });

  it("a second window that opens the files the app was asked to open", () => {
    const moved = mutate(
      mutate(
        page,
        "      takePendingOpens()\n        .then((paths) => paths.forEach(handleOpenFile))\n        .catch(() => {});\n",
        "",
      ),
      "    if (isMainWindow) {",
      "    takePendingOpens()\n      .then((paths) => paths.forEach(handleOpenFile))\n      .catch(() => {});\n    if (isMainWindow) {",
    );
    expect(mainOnlyViolations(moved, layout)).toContain(
      "takePendingOpens() runs outside the main window",
    );
  });

  it("a second window that saves the dock layout", () => {
    expect(
      mainOnlyViolations(page, mutate(layout, "    if (!isMainWindow) return;\n", "")),
    ).toContain("a secondary window saves its dock layout over the main window's");
  });

  it("a second window that never takes its tab", () => {
    expect(
      mainOnlyViolations(mutate(page, "void windows.adoptHandoff();", ""), layout),
    ).toContain("a secondary window does not take over the tab it was opened for");
  });

  // ── 8: a pane arrives as it was ────────────────────────────────────────────
  const tabs = raw(TABS);
  const packet = raw(PACKET);
  const pane = (s = tabs, k = packet) => seatViolations(s, k);

  it("a seat that never reaches the store", () => {
    expect(
      pane(
        tabs,
        mutate(
          packet,
          'lead === null ? null : { tab: lead, where: packet.seat?.before ? "before" : "end" },',
          "null,",
        ),
      ),
    ).toEqual(["a packet's seat is dropped on arrival"]);
  });

  it("a tab that follows its pane shown instead of the one the pane showed", () => {
    expect(
      pane(
        mutate(
          tabs,
          "    center = addTabBehind(center, tab.sessionId, beside.tab, beside.where);\n    return;",
          "    center = placeTab(center, tab.sessionId, null);\n    return;",
        ),
      ),
    ).toEqual(["a tab that follows its pane is shown in place of the tab the pane showed"]);
    expect(
      pane(
        mutate(
          tabs,
          "    center = addTabBehind(center, tab.sessionId, beside.tab, beside.where);\n    return;",
          "    center = addTabBehind(center, tab.sessionId, beside.tab, beside.where);",
        ),
      ),
    ).toEqual(["a tab that follows its pane is shown in place of the tab the pane showed"]);
  });
});
