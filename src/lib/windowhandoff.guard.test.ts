// Window guard (v1.3, ADR 0017): the contracts a tab moved out into a window of
// its own stands on.
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
  const detach = fn(c, "detachTab");
  const steps = [
    "detachBlocker(",
    "await detachBegin(sessionId)",
    "snapshot?.(sent)",
    "await detachCommit(",
    "closeTabFully(sessionId, true)",
  ].map((step) => detach.indexOf(step));
  if (steps.some((at) => at < 0) || steps.some((at, i) => i > 0 && at < steps[i - 1])) {
    out.push("detachTab does not hold, snapshot, wait for the new window and only then let go");
  }
  if (!/if \(held\) await detachAbort\(sessionId\)/.test(detach)) {
    out.push("a failed handoff leaves the session's output held");
  }
  // Keeping the session is for exactly two cases: the tab has just been taken by
  // another window, or this window failed to take it.
  const keeps = c.match(/closeTabFully\([^()]*,\s*true\)/g)?.length ?? 0;
  if (keeps !== 2 || !/onadoptfailed=\{\(\) => \{[^]*?closeTabFully\(tab\.sessionId, true\)/.test(c)) {
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
  '"sync://scan"',
  '"window://close"',
  '"vterm://open-file"',
  "OPEN_FILE_EVENT",
  "WINDOW_CLOSE_EVENT",
  "CLOSE_ASKED_EVENT",
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
    '"sync://scan"',
    "OPEN_FILE_EVENT",
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
      mutate(page, "      closeTabFully(sessionId, true);\n    } catch (e) {", "    } catch (e) {"),
      "      const sent = await detachBegin(sessionId);",
      "      closeTabFully(sessionId, true);\n      const sent = await detachBegin(sessionId);",
    );
    expect(handoffViolations(early)).toContain(
      "detachTab does not hold, snapshot, wait for the new window and only then let go",
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
});
