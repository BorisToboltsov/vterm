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
const TERMINAL = "lib/Terminal.svelte";
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

// ── 2: the order of a handoff ────────────────────────────────────────────────

export function handoffViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  // The trip itself is one function (v1.10: a tab alone and a tab of a pane
  // both take it); whether the tab may go is asked by whoever sends it.
  const trip = fn(c, "handOver");
  const steps = [
    "await detachBegin(sessionId)",
    "snapshot?.(sent)",
    "await detachCommit(",
    "closeTabFully(sessionId, true)",
  ].map((step) => trip.indexOf(step));
  if (steps.some((at) => at < 0) || steps.some((at, i) => i > 0 && at < steps[i - 1])) {
    out.push("a handoff does not hold, snapshot, wait for the new window and only then let go");
  }
  if (!/if \(held\) await detachAbort\(sessionId\)/.test(trip)) {
    out.push("a failed handoff leaves the session's output held");
  }
  const detach = fn(c, "detachTab");
  const asked = detach.indexOf("detachBlocker(");
  if (asked < 0 || asked > detach.indexOf("await handOver(")) {
    out.push("a tab is handed over without being asked whether it may go");
  }
  // Keeping the session is for exactly two cases: the tab has just been taken by
  // another window, or this window failed to take it.
  const keeps = c.match(/closeTabFully\([^()]*,\s*true\)/g)?.length ?? 0;
  if (
    keeps !== 2 ||
    !c.includes("onadoptfailed={() => adoptFailed(tab.sessionId)}") ||
    !fn(c, "adoptFailed").includes("closeTabFully(sessionId, true)")
  ) {
    out.push("a tab is dropped without ending its session outside a handoff");
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
  if (!/\} else \{\s*void adoptHandoff\(\);/.test(c.slice(c.indexOf(main) + main.length - 1))) {
    out.push("a secondary window does not take over the tab it was opened for");
  }
  const store = code(layout);
  if (!/\$effect\(\(\) => \{\s*if \(!isMainWindow\) return;\s*const data = JSON\.stringify\(persistedLayout/.test(store)) {
    out.push("a secondary window saves its dock layout over the main window's");
  }
  return out;
}

// ── 6: an open window taking a tab ───────────────────────────────────────────

export function openWindowViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  // It announces itself from one effect, which waits for the listeners…
  const announces = c.match(/announceWindow\(/g)?.length ?? 0;
  if (announces !== 1 || !/if \(!takesTabs\) return;\s*void announceWindow\(/.test(c)) {
    out.push("a window says it takes tabs without checking that it listens for the offer");
  }
  // …and those are in place exactly when the subscription to the offer resolved.
  const ready = c.match(/takesTabs = true/g)?.length ?? 0;
  const subscribed = /listenHere\(HANDOFF_EVENT, \(\) => void receiveTab\(\)\),\s*\]\)\s*\.then\(\(us\) => \{[^}]*takesTabs = true;/;
  if (ready !== 1 || !subscribed.test(c)) {
    out.push("a window takes tabs before it listens for the offer of one");
  }
  // Taking a tab closes nothing; a tab that did not arrive closes only a window
  // that has no other.
  if (/closeWindow\(/.test(fn(c, "receiveTab")) || /closeWindow\(/.test(fn(c, "takeTab"))) {
    out.push("an open window that is offered a tab can close itself");
  }
  const failed = fn(c, "adoptFailed");
  const closes = failed.match(/closeWindow\(/g)?.length ?? 0;
  if (
    closes !== 1 ||
    !failed.includes("if (!isMainWindow && tabsState.list.length === 0) void closeWindow()")
  ) {
    out.push("a tab that did not arrive closes a window that has other tabs");
  }
  if (!failed.includes("declineHandoff(sessionId)") || !fn(c, "receiveTab").includes("declineHandoff()")) {
    out.push("a window that cannot take a tab leaves the other one waiting for its timeout");
  }
  // A drop outside is decided when the pointer is released.
  const drop = fn(c, "dropOutside");
  if (!drop.includes("await dragDrop(") || /tabDrag\.window|incoming\./.test(drop)) {
    out.push("a tab dropped outside goes where it was last drawn, not where it was released");
  }
  // The only tab of a secondary window may go to an open window, not to a new one.
  if (!fn(c, "detachTab").includes("detachBlocker(detachStateOf(tab), toOpenWindow)")) {
    out.push("moving to an open window is judged by the rules of opening a new one");
  }
  return out;
}

// ── 7: a tab held over another window ────────────────────────────────────────

export function crossDragViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  const drop = fn(c, "dropOutside");
  // The window the tab was dropped on keeps a place for it from `dragDrop` on.
  // Each way the tab then fails to get there has to be said.
  const refused = drop.slice(drop.indexOf("if (block) {"), drop.indexOf("await dragDrop("));
  if (!refused.includes("void dragEnd()")) {
    out.push("a tab that may not move stays drawn in the window it was held over");
  }
  if (!drop.includes("if (!(await detachTab(sessionId, { window: under }))) void dragEnd()")) {
    out.push("a handoff that failed after a drop leaves a place kept for a tab that is not coming");
  }
  // What ends the drag without a drop is said by the store, through `left`.
  // (The tab's own `left` — dragged files have one of their own, see filedrag.guard.)
  if (!/over: tellDragOver,\s*left: \(\) => void dragEnd\(\)/.test(c)) {
    out.push("a tab that came back into its window stays drawn in the other one");
  }
  // A tab that cannot go is shown to nobody.
  const over = fn(c, "tellDragOver");
  const blocked = over.indexOf("detachBlocker(detachStateOf(tab), true)");
  if (blocked < 0 || blocked > over.indexOf("dragOver(")) {
    out.push("a tab that cannot move is drawn in another window all the same");
  }
  // It lands where that window kept its place — before anything else is tried.
  const take = fn(c, "takeTab");
  if (!take.includes("const drop = takeIncomingDrop() ??") || !take.includes("unpackTab(packet, drop)")) {
    out.push("a tab dropped on a window lands where a new tab would, not where it was dropped");
  }
  // One label for one tab: over another window that window draws it, over the
  // desktop the floating label does.
  if (!c.includes("{#if draggingTab && !heldOverWindow && !tabDrag.floating}")) {
    out.push("a tab held over another window is drawn in both");
  }
  // Every release away from this window's panes asks the backend — with or
  // without another window to land in: that is what hides the floating label.
  if (!drop.includes("const under = await dragDrop(describeTab(tab))")) {
    out.push("a tab let go of over the desktop leaves its floating label there");
  }
  // A tab reordered inside its window, with no other window, asks nobody.
  const quiet = over.indexOf("if (!tabDrag.outside && windowTargets.length === 0) return null;");
  if (quiet < 0 || quiet > over.indexOf("dragOver(")) {
    out.push("a tab reordered in its own strip calls the backend on every move");
  }
  return out;
}

// ── 8: a pane that moves whole ───────────────────────────────────────────────

/** Calls of `name(` that are not its own declaration. */
const calls = (src: string, name: string): number =>
  src.match(new RegExp(`(?<!function )(?<![.\\w])${name}\\(`, "g"))?.length ?? 0;

export function paneMoveViolations(page: string, tabs: string, packet: string): string[] {
  const c = code(page);
  const out: string[] = [];
  const move = fn(c, "movePane");
  // One trip, two senders: a tab alone, and a pane.
  if (calls(c, "handOver") !== 2 || calls(move, "handOver") !== 1 || calls(c, "detachCommit") !== 1) {
    out.push("a tab is handed to another window by something other than the one trip");
  }
  const at = (step: string) => move.indexOf(step);
  const trip = at("await handOver(");
  // Whole or not at all: decided before the first tab leaves.
  if (at("paneMoveBlocker(") < 0 || at("paneMoveBlocker(") > at("paneMoveOrder(") || at("paneMoveOrder(") > trip) {
    out.push("a pane starts to move before it is known that all of it can");
  }
  // Each tab again at its turn, by the rule of an open window.
  const again = at("detachBlocker(detachStateOf(tab), true)");
  if (again < 0 || again > trip) {
    out.push("a tab of a moving pane is handed over without being asked at its turn");
  }
  // A window opened for the first tab takes the rest once it listens.
  const listed = at("await windowListed(target)");
  if (listed < 0 || listed > trip || !/windowsHeard\?\.\(\)/.test(c)) {
    out.push("the rest of a pane is sent to a window that does not take tabs yet");
  }
  // The page takes no input until the last tab has settled.
  if (at("detaching = step.tab") < 0 || at("detaching = step.tab") > trip || !/finally \{\s*detaching = null;/.test(move)) {
    out.push("a pane on its way leaves the window open to input");
  }
  if (!move.includes('"window.paneMovedPartly"')) {
    out.push("a pane that stopped midway is not said to have");
  }
  // Arriving: only the first tab opens the pane; the place the window kept wins.
  const take = fn(c, "takeTab");
  if (!take.includes("(leadsPane ? arrivalDrop(center, placement.panes) : null)")) {
    out.push("a tab that only follows its pane opens a pane of its own");
  }
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

  it("a handoff holds, snapshots, waits and only then lets go", () => {
    expect(handoffViolations(raw(PAGE))).toEqual([]);
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

  it("an open window takes a tab without risking its own", () => {
    expect(openWindowViolations(raw(PAGE))).toEqual([]);
  });

  it("a tab held over another window is told of to its end, and lands where it was dropped", () => {
    expect(crossDragViolations(raw(PAGE))).toEqual([]);
  });

  it("a pane moves whole, by the trip a tab takes, and arrives as it was", () => {
    expect(paneMoveViolations(raw(PAGE), raw(TABS), raw(PACKET))).toEqual([]);
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

  it("a tab that leaves before the new window has it", () => {
    const early = mutate(
      mutate(
        page,
        "      closeTabFully(sessionId, true);\n      return taken;\n    } catch (e) {",
        "      return taken;\n    } catch (e) {",
      ),
      "      const sent = await detachBegin(sessionId);",
      "      closeTabFully(sessionId, true);\n      const sent = await detachBegin(sessionId);",
    );
    expect(handoffViolations(early)).toContain(
      "a handoff does not hold, snapshot, wait for the new window and only then let go",
    );
  });

  it("a tab sent on its way without being asked", () => {
    const unasked = mutate(
      page,
      "    const block = detachBlocker(detachStateOf(tab), toOpenWindow);\n    if (block) {\n      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]));\n      return false;\n    }\n    detaching = sessionId;",
      "    detaching = sessionId;",
    );
    expect(handoffViolations(unasked)).toContain(
      "a tab is handed over without being asked whether it may go",
    );
  });

  it("a failed handoff that leaves the output held", () => {
    expect(
      handoffViolations(
        mutate(page, "if (held) await detachAbort(sessionId).catch(() => {});", ""),
      ),
    ).toContain("a failed handoff leaves the session's output held");
  });

  it("a third way to drop a tab without ending its session", () => {
    expect(
      handoffViolations(
        mutate(page, "else closeTabFully(sessionId);\n  }", "else closeTabFully(sessionId, true);\n  }"),
      ),
    ).toContain("a tab is dropped without ending its session outside a handoff");
  });

  it("a tab that failed to arrive and ends the session it never owned", () => {
    expect(
      handoffViolations(
        mutate(
          page,
          "    closeTabFully(sessionId, true);\n    // A window opened for this tab",
          "    closeTabFully(sessionId);\n    // A window opened for this tab",
        ),
      ),
    ).toContain("a tab is dropped without ending its session outside a handoff");
  });

  it("a window that announces itself before it can hear an offer", () => {
    expect(
      openWindowViolations(mutate(page, "    if (!takesTabs) return;\n    void announceWindow(", "    void announceWindow(")),
    ).toContain("a window says it takes tabs without checking that it listens for the offer");
    expect(
      openWindowViolations(
        mutate(page, "let takesTabs = $state(false);", "let takesTabs = $state(false);\n  takesTabs = true;"),
      ),
    ).toContain("a window takes tabs before it listens for the offer of one");
    const early = mutate(
      mutate(page, "        unlisteners.push(...us);\n        takesTabs = true;\n", "        unlisteners.push(...us);\n"),
      "    Promise.all([\n      listen<unknown>(WINDOWS_EVENT",
      "    takesTabs = true;\n    Promise.all([\n      listen<unknown>(WINDOWS_EVENT",
    );
    expect(openWindowViolations(early)).toContain(
      "a window takes tabs before it listens for the offer of one",
    );
  });

  it("an offer heard by every window", () => {
    const plain = mutate(
      page,
      "listenHere(HANDOFF_EVENT, () => void receiveTab())",
      "listen(HANDOFF_EVENT, () => void receiveTab())",
    );
    expect(listenerViolations(PAGE, plain)).toEqual([
      `${PAGE} hears HANDOFF_EVENT with listen() — it would hear another window's too`,
    ]);
    expect(pageListenerViolations(plain)).toEqual([
      "the page does not listen for HANDOFF_EVENT through listenHere",
    ]);
  });

  it("an open window that closes itself — and its other tabs — over a tab that did not arrive", () => {
    expect(
      openWindowViolations(
        mutate(
          page,
          "if (!isMainWindow && tabsState.list.length === 0) void closeWindow().catch(() => {});",
          "void closeWindow().catch(() => {});",
        ),
      ),
    ).toContain("a tab that did not arrive closes a window that has other tabs");
    expect(
      openWindowViolations(
        mutate(
          page,
          "if (!(await takeTab())) void declineHandoff().catch(() => {});",
          "if (!(await takeTab())) void closeWindow().catch(() => {});",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "an open window that is offered a tab can close itself",
        "a window that cannot take a tab leaves the other one waiting for its timeout",
      ]),
    );
  });

  it("a window that leaves the other one waiting when a tab does not arrive", () => {
    expect(
      openWindowViolations(
        mutate(page, "    void declineHandoff(sessionId).catch(() => {});\n", ""),
      ),
    ).toContain("a window that cannot take a tab leaves the other one waiting for its timeout");
  });

  it("a drop outside decided by where the tab was last drawn instead of the release", () => {
    const asked = "const under = await dragDrop(describeTab(tab)).catch(() => null);";
    for (const remembered of ["const under = tabDrag.window;", "const under = incoming.tab ? null : null;"]) {
      expect(openWindowViolations(mutate(page, asked, remembered))).toContain(
        "a tab dropped outside goes where it was last drawn, not where it was released",
      );
    }
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

  it("a window left drawing a tab that is not coming", () => {
    expect(
      crossDragViolations(
        mutate(page, "      void dragEnd().catch(() => {});\n      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]));", "      notifyInfo(t(DETACH_BLOCK_MESSAGE[block]));"),
      ),
    ).toEqual(["a tab that may not move stays drawn in the window it was held over"]);
    expect(
      crossDragViolations(
        mutate(
          page,
          "if (!(await detachTab(sessionId, { window: under }))) void dragEnd().catch(() => {});",
          "void detachTab(sessionId, { window: under });",
        ),
      ),
    ).toEqual(["a handoff that failed after a drop leaves a place kept for a tab that is not coming"]);
    expect(
      crossDragViolations(
        mutate(
          page,
          "over: tellDragOver,\n            left: () => void dragEnd().catch(() => {}),",
          "over: tellDragOver,\n            left: undefined,",
        ),
      ),
    ).toEqual(["a tab that came back into its window stays drawn in the other one"]);
  });

  it("a tab that cannot move drawn in another window", () => {
    expect(
      crossDragViolations(
        mutate(
          page,
          "if (!tab || detachBlocker(detachStateOf(tab), true)) return null;",
          "if (!tab) return null;",
        ),
      ),
    ).toEqual(["a tab that cannot move is drawn in another window all the same"]);
  });

  it("a floating label left on the desktop, or made for a tab that never leaves", () => {
    expect(
      crossDragViolations(
        mutate(
          page,
          "const under = await dragDrop(describeTab(tab)).catch(() => null);",
          "const under = windowTargets.length > 0 ? await dragDrop(describeTab(tab)).catch(() => null) : null;",
        ),
      ),
    ).toEqual(["a tab let go of over the desktop leaves its floating label there"]);
    expect(
      crossDragViolations(
        mutate(page, "    if (!tabDrag.outside && windowTargets.length === 0) return null;\n", ""),
      ),
    ).toEqual(["a tab reordered in its own strip calls the backend on every move"]);
  });

  it("a dropped tab that lands where a new one would", () => {
    const lost = "a tab dropped on a window lands where a new tab would, not where it was dropped";
    expect(
      crossDragViolations(mutate(page, "unpackTab(packet, drop);", "unpackTab(packet);")),
    ).toEqual([lost]);
    // The pane's own place tried first: a pane dropped on a strip would open a pane.
    expect(
      crossDragViolations(
        mutate(
          page,
          "const drop = takeIncomingDrop() ?? (leadsPane ? arrivalDrop(center, placement.panes) : null);",
          "const drop = (leadsPane ? arrivalDrop(center, placement.panes) : null) ?? takeIncomingDrop();",
        ),
      ),
    ).toEqual([lost]);
  });

  it("a tab drawn in both windows at once", () => {
    expect(
      crossDragViolations(
        mutate(page, "{#if draggingTab && !heldOverWindow && !tabDrag.floating}", "{#if draggingTab}"),
      ),
    ).toEqual(["a tab held over another window is drawn in both"]);
  });

  it("the only tab of a window refused its way back", () => {
    expect(
      openWindowViolations(
        mutate(
          page,
          "detachBlocker(detachStateOf(tab), toOpenWindow)",
          "detachBlocker(detachStateOf(tab))",
        ),
      ),
    ).toContain("moving to an open window is judged by the rules of opening a new one");
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
      mainOnlyViolations(mutate(page, "void adoptHandoff();", ""), layout),
    ).toContain("a secondary window does not take over the tab it was opened for");
  });

  // ── 8: a pane that moves whole ─────────────────────────────────────────────
  const tabs = raw(TABS);
  const packet = raw(PACKET);
  const pane = (p = page, s = tabs, k = packet) => paneMoveViolations(p, s, k);

  it("a second copy of the trip for the tabs of a pane", () => {
    const copied = mutate(
      page,
      "        target = await handOver(step.tab, moved === 0 ? to : { window: target }, step.seat);",
      "        target = await detachCommit(step.tab, \"{}\", { target, background: \"\" });\n        closeTabFully(step.tab, true);",
    );
    expect(pane(copied)).toContain(
      "a tab is handed to another window by something other than the one trip",
    );
    // …and it is also a third place that drops a tab without ending its session.
    expect(handoffViolations(copied)).toContain(
      "a tab is dropped without ending its session outside a handoff",
    );
  });

  it("a pane that starts to go before all of it may", () => {
    const late = mutate(
      mutate(
        page,
        "    const held = paneMoveBlocker(tabs.map(detachStateOf), toOpenWindow);\n    if (held) {",
        "    const held = null as ReturnType<typeof paneMoveBlocker>;\n    if (held) {",
      ),
      "    } finally {\n      detaching = null;\n    }\n  }\n\n  /** A secondary window, on load",
      "    } finally {\n      detaching = null;\n      paneMoveBlocker(tabs.map(detachStateOf), toOpenWindow);\n    }\n  }\n\n  /** A secondary window, on load",
    );
    expect(pane(late)).toEqual(["a pane starts to move before it is known that all of it can"]);
  });

  it("a tab of the pane whose session ended while the others went", () => {
    expect(
      pane(
        mutate(
          page,
          "        if (!tab || detachBlocker(detachStateOf(tab), true)) throw new Error(\"handoff-not-taken\");\n",
          "",
        ),
      ),
    ).toEqual(["a tab of a moving pane is handed over without being asked at its turn"]);
  });

  it("the rest of a pane sent to a window that is still loading", () => {
    const unheard = "the rest of a pane is sent to a window that does not take tabs yet";
    expect(
      pane(
        mutate(
          page,
          "if (moved > 0 && !(target && (await windowListed(target)))) {",
          "if (moved > 0 && !target) {",
        ),
      ),
    ).toEqual([unheard]);
    // Waiting for a list nobody reports the changes of is waiting for the timeout.
    expect(pane(mutate(page, "        windowsHeard?.();\n", ""))).toEqual([unheard]);
  });

  it("a window left open to clicks while its pane is leaving", () => {
    expect(pane(mutate(page, "        detaching = step.tab;\n", ""))).toEqual([
      "a pane on its way leaves the window open to input",
    ]);
  });

  it("a pane that stopped midway and said the whole of it failed", () => {
    expect(
      pane(
        mutate(
          page,
          ': t("window.paneMovedPartly", { moved, total: steps.length }),',
          ": t(detachErrorKey(e, true)),",
        ),
      ),
    ).toEqual(["a pane that stopped midway is not said to have"]);
  });

  it("every tab of an arriving pane opening a pane of its own", () => {
    expect(
      pane(
        mutate(
          page,
          "(leadsPane ? arrivalDrop(center, placement.panes) : null)",
          "(packet.seat ? arrivalDrop(center, placement.panes) : null)",
        ),
      ),
    ).toEqual(["a tab that only follows its pane opens a pane of its own"]);
  });

  it("a seat that never reaches the store", () => {
    expect(
      pane(
        page,
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
        page,
        mutate(
          tabs,
          "    center = addTabBehind(center, tab.sessionId, beside.tab, beside.where);\n    return;",
          "    center = placeTab(center, tab.sessionId, null);\n    return;",
        ),
      ),
    ).toEqual(["a tab that follows its pane is shown in place of the tab the pane showed"]);
    expect(
      pane(
        page,
        mutate(
          tabs,
          "    center = addTabBehind(center, tab.sessionId, beside.tab, beside.where);\n    return;",
          "    center = addTabBehind(center, tab.sessionId, beside.tab, beside.where);",
        ),
      ),
    ).toEqual(["a tab that follows its pane is shown in place of the tab the pane showed"]);
  });
});
