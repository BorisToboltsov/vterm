// Tab-restore guard (v1.6, ADR 0019): the contracts that bringing tabs back
// after a restart stands on.
//
//  1. Nothing of a session reaches the disk. A tab holds the secret typed for
//     it, and on its way between windows a snapshot of its terminal. What is
//     saved is a record built field by field (`savedTab`), never a tab spread
//     into JSON — one `...tab` and the next field added to `Tab` is on disk.
//  2. The slots are read and written in one place. `vterm.tabs:*` is touched by
//     the keeper in `stores/tabrestore.svelte.ts` and by nobody else; what was
//     stored reaches the tabs store only through the parsers (`restoreSaved`,
//     and `loadLayout` for the tree — the latter is `centerlayout.guard`'s).
//  3. The main window writes its slot only after it has taken the previous
//     launch in. The store of tabs starts empty: a slot written from the first
//     moment would replace "the tabs I had" with "no tabs" before reading them.
//  4. Only the main window reads the slots, and once; a window of the previous
//     launch opened again (v1.36) takes the tabs it is handed, never a slot.
//  5. A tab that came back opens its session through the policy or through its
//     own button — never because it was mounted. `waitReason` is what keeps a
//     production server, a container and a server that asks for a password
//     from being connected to at launch; a `reconnect` that does not ask it
//     turns "restore the tabs" into "dial every server I had open".
//     How the restore flow (page/restoreflow) keeps 3–5 is its behaviour
//     tests; that nobody else takes the slots or opens the restored tabs is the
//     lint rule `vterm/owned-imports`. Checked here: how the page wires it.
//  6. A window closed on purpose forgets its tabs: its sessions end with it,
//     and what the user closed must not come back at the next launch.
//  7. What a tab printed and its conversation (v1.36, ADR 0057) reach the disk
//     in one place — the restore flow's `keep` — and only past `keepsContent`:
//     the setting, and never a production server. A closed tab's go with it.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for (the second `describe`). Sources are read
// with comments stripped — the rationale above, and the comments in the
// sources, name the anti-patterns in prose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const MODEL = "lib/tabs/tabrestore.ts";
const KEEPER = "lib/stores/tabrestore.svelte.ts";
const PAGE = "routes/+page.svelte";
const TERMINAL = "lib/terminal/Terminal.svelte";
const FLOW = "lib/page/restoreflow.svelte.ts";

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

/** Body of `function name(` in `src`, to the closing brace at `indent`. */
function fn(src: string, name: string, indent = ""): string {
  const at = src.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return "";
  const end = src.indexOf(`\n${indent}}\n`, at);
  return end < 0 ? src.slice(at) : src.slice(at, end);
}

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// ── 1: what is written ───────────────────────────────────────────────────────

/** Fields of a tab that belong to its session, not to what the tab is — and the text a file holds. */
const SESSION_FIELDS = /\b(?:secret|remember|status|adopt|waiting|gen|replay|sudoPassword|content|baseContent)\b/;

export function recordViolations(model: string): string[] {
  const c = code(model);
  const out: string[] = [];
  const record = fn(c, "savedTab");
  if (record === "") out.push("savedTab is gone");
  if (/\.\.\./.test(record)) out.push("savedTab spreads a tab instead of listing its fields");
  if (SESSION_FIELDS.test(record.slice(record.indexOf("{")))) {
    out.push("savedTab writes down something of the session");
  }
  if (!/tabs\.map\(\(tab\) => savedTab\(tab, factsOf\?\.\(tab\.sessionId\)\)\)/.test(fn(c, "savedWindow"))) {
    out.push("savedWindow does not build its tabs with savedTab");
  }
  return out;
}

// ── 2 & 3: the keeper ────────────────────────────────────────────────────────

export function keeperViolations(keeper: string): string[] {
  const c = code(keeper);
  const out: string[] = [];
  const writes = [...c.matchAll(/\.setItem\(([^;]*)\);/g)].map((m) => m[1].replace(/\s+/g, " "));
  const built = /const text = JSON\.stringify\(savedWindow\(tabs, layout, factsOf, beforeTile\)\);/.test(c);
  if (writes.length !== 1 || writes[0] !== "own, text" || !built) {
    out.push(`the slot is written with something other than savedWindow: ${writes.join(" | ")}`);
  }
  // What it says of a session is read, never made: `dockState(` creates an entry.
  if (!/function factsOf\([^]*?peekDockState\(sessionId\)[^]*?peekWorkspace\(sessionId\)/.test(c) || /\bdockState\(/.test(c)) {
    out.push("the facts written with a tab are not read through the peeks");
  }
  if (!/let writing = \$state\(!main\);/.test(c)) {
    out.push("the main window writes its slot from the start");
  }
  if (!/sync\([^]*?\): void \{\s*if \(!writing\) return;/.test(c)) {
    out.push("sync writes before the previous launch was taken in");
  }
  if (!/take\([^)]*\): SavedSlots \| null \{\s*if \(!main \|\| taken\) return null;\s*taken = true;/.test(c)) {
    out.push("the saved tabs can be taken by another window, or twice");
  }
  if (!/if \(main\) for \(const key of otherSlotKeys\(keys\(\), own\)\) remove\(key\);/.test(c)) {
    out.push("a window other than the main one removes the others' slots");
  }
  return out;
}

/** The slots, or their keeper, used outside the two files that own them. */
export function ownershipViolations(rel: string, source: string): string[] {
  if (rel === MODEL || rel === KEEPER) return [];
  const c = code(source);
  const out: string[] = [];
  if (/vterm\.tabs|\bSLOT_PREFIX\b|\bslotKey\(|\botherSlotKeys\(/.test(c)) {
    out.push(`${rel} reads or writes the saved tabs itself`);
  }
  if (/\btabKeeper\(/.test(c)) out.push(`${rel} makes a keeper of its own`);
  return out;
}

// ── 4, 5 & 6: the page and the terminal ──────────────────────────────────────

export function pageViolations(page: string, terminal: string): string[] {
  const c = code(page);
  const at = c.lastIndexOf("</script>");
  const script = c.slice(0, at);
  const markup = c.slice(at);
  const out: string[] = [];

  // 4 — the main window asks the flow, once; any other takes what it is handed, once.
  if (count(c, /\brestoreFlow\.restore\(\)/g) !== 1 || !/if \(isMainWindow\) void restoreFlow\.restore\(\);/.test(script)) {
    out.push("the saved tabs are restored somewhere other than once, in the main window");
  }
  if (
    count(c, /\brestoreFlow\.restoreWindow\(\)/g) !== 1 ||
    !/\} else \{[^]*?await restoreFlow\.restoreWindow\(\);\s*if \(back === null\) void windows\.adoptHandoff\(\);/.test(script)
  ) {
    out.push("a reopened window takes its tabs somewhere other than once, outside the main window");
  }
  // 5 — ⌘K opens what the policy lets open, and only from the palette.
  if (count(c, /\brestoreFlow\.wakeAll\(/g) !== 1 || !/run: \(\) => restoreFlow\.wakeAll\(\)/.test(script)) {
    out.push("waiting tabs are opened all at once from somewhere other than the palette");
  }
  // Its button, and the same action in the tab's menu — a gesture either way.
  const gestures =
    count(markup, /onclick=\{\(\) => restoreFlow\.wake\(tab\.sessionId\)\}/g) +
    count(script, /onSelect: \(\) => void restoreFlow\.wake\(tab\.sessionId\)/g);
  if (
    count(c, /\brestoreFlow\.wake\(/g) !== gestures ||
    !/onclick=\{\(\) => restoreFlow\.wake\(tab\.sessionId\)\}/.test(markup)
  ) {
    out.push("a waiting tab is opened by something other than its own button");
  }
  if (!/<TerminalView\b[^]*?\bwaiting=\{!!tab\.waiting\}/.test(markup)) {
    out.push("the terminal is not told that its tab waits");
  }
  const t = code(terminal);
  if (!/\} else if \(waiting\) \{\s*return;\s*\} else if \(!\(await connect\(\)\)\) \{/.test(t)) {
    out.push("Terminal.svelte connects a tab that waits");
  }

  // 6 — a window closed on purpose.
  if (!/forgetSavedTabs\(\);\s*void closeWindow\(\);/.test(markup)) {
    out.push("a window closed on purpose leaves its tabs to come back");
  }
  // 7 — a closed tab's content goes with it (one handed to another window lives on there).
  if (!/if \(!keepSession\) restoreFlow\.forget\(sessionId\);/.test(fn(script, "closeTabFully", "  "))) {
    out.push("closing a tab leaves what was kept of it for the next launch");
  }
  return out;
}

// ── 7: what a tab printed ────────────────────────────────────────────────────

export function contentViolations(flow: string): string[] {
  const c = code(flow);
  const out: string[] = [];
  const keep = fn(c, "keep", "  ");
  if (count(c, /\btabContentSave\(/g) !== 1 || !/\btabContentSave\(/.test(keep)) {
    out.push("what a tab printed is written somewhere other than keep");
  }
  const gate = keep.search(/if \(!keepsContent\(settings, isProd\(tab\)\)\) \{/);
  if (gate < 0 || gate > keep.search(/\btabContentSave\(/)) {
    out.push("what a tab printed is written before keepsContent was asked");
  }
  if (!/async function loadContent[^]*?if \(!keepsContent\(settings, isProd\(tab\)\)\) return;/.test(c)) {
    out.push("what a tab printed is read back where it is no longer kept");
  }
  return out;
}

describe("tab restore guard", () => {
  it("what is saved of a tab is a record of its own, with nothing of the session", () => {
    expect(recordViolations(raw(MODEL))).toEqual([]);
  });

  it("the slot is written by its keeper, with that record, and only once the restore is over", () => {
    expect(keeperViolations(raw(KEEPER))).toEqual([]);
  });

  it("nobody else touches the slots", () => {
    expect(sources().flatMap((rel) => ownershipViolations(rel, raw(rel)))).toEqual([]);
  });

  it("the main window restores once, and a restored tab opens by the palette or its button", () => {
    expect(pageViolations(raw(PAGE), raw(TERMINAL))).toEqual([]);
  });

  it("what a tab printed is written in one place, past the setting and the prod flag", () => {
    expect(contentViolations(raw(FLOW))).toEqual([]);
  });
});

describe("tab restore guard — catches what it exists for", () => {
  const model = raw(MODEL);
  const keeper = raw(KEEPER);
  const page = raw(PAGE);
  const terminal = raw(TERMINAL);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a tab spread into its record", () => {
    expect(
      recordViolations(
        mutate(model, "  const out: SavedTab = {\n    id: tab.sessionId,", "  const out: SavedTab = {\n    ...tab,\n    id: tab.sessionId,"),
      ),
    ).toContain("savedTab spreads a tab instead of listing its fields");
  });

  it("a session field added to the record", () => {
    expect(
      recordViolations(mutate(model, "    alias: tab.alias,\n  };", "    alias: tab.alias,\n    secret: tab.secret,\n  };")),
    ).toContain("savedTab writes down something of the session");
  });

  it("a window saved without going through the record", () => {
    expect(
      recordViolations(mutate(model, "tabs: tabs.map((tab) => savedTab(tab, factsOf?.(tab.sessionId)))", "tabs: [...tabs]")),
    ).toContain("savedWindow does not build its tabs with savedTab");
  });

  it("the terminal's output written into a tab's record", () => {
    expect(
      recordViolations(mutate(model, "    alias: tab.alias,\n  };", "    alias: tab.alias,\n    out: tab.replay,\n  };")),
    ).toContain("savedTab writes down something of the session");
  });

  it("a slot written with the tabs themselves", () => {
    expect(
      keeperViolations(
        mutate(keeper, "JSON.stringify(savedWindow(tabs, layout, factsOf, beforeTile))", "JSON.stringify({ tabs, layout })"),
      ),
    ).toEqual([expect.stringContaining("something other than savedWindow")]);
    // A second write is a second way for something to reach the disk.
    expect(
      keeperViolations(mutate(keeper, "      writing = true;", "      writing = true;\n      storage.setItem(own, \"{}\");")),
    ).toEqual([expect.stringContaining("something other than savedWindow")]);
  });

  it("a main window that writes before it has read", () => {
    expect(keeperViolations(mutate(keeper, "let writing = $state(!main);", "let writing = $state(true);"))).toContain(
      "the main window writes its slot from the start",
    );
    expect(keeperViolations(mutate(keeper, "      if (!writing) return;\n", ""))).toContain(
      "sync writes before the previous launch was taken in",
    );
  });

  it("saved tabs taken by any window, or other windows' slots dropped by any", () => {
    expect(
      keeperViolations(mutate(keeper, "if (!main || taken) return null;", "if (taken) return null;")),
    ).toContain("the saved tabs can be taken by another window, or twice");
    expect(
      keeperViolations(mutate(keeper, "if (main) for (const key of otherSlotKeys", "for (const key of otherSlotKeys")),
    ).toContain("a window other than the main one removes the others' slots");
  });

  it("a slot read from somewhere else", () => {
    expect(
      ownershipViolations("lib/Whatever.svelte", `const saved = localStorage.getItem("vterm.tabs:main");`),
    ).toEqual(["lib/Whatever.svelte reads or writes the saved tabs itself"]);
    expect(ownershipViolations("routes/+page.svelte", "const k = tabKeeper(windowLabel);")).toEqual([
      "routes/+page.svelte makes a keeper of its own",
    ]);
    expect(ownershipViolations(KEEPER, `storage.getItem(slotKey("main"))`)).toEqual([]);
  });

  it("facts of a session made rather than read", () => {
    expect(keeperViolations(mutate(keeper, "dock: peekDockState(sessionId),", "dock: dockState(sessionId),"))).toContain(
      "the facts written with a tab are not read through the peeks",
    );
  });

  it("every window restoring, or the main one restoring twice", () => {
    expect(
      pageViolations(mutate(page, "if (isMainWindow) void restoreFlow.restore();", "void restoreFlow.restore();"), terminal),
    ).toContain("the saved tabs are restored somewhere other than once, in the main window");
    expect(
      pageViolations(
        mutate(page, "if (isMainWindow) void restoreFlow.restore();", "if (isMainWindow) void restoreFlow.restore();\n      void restoreFlow.restore();"),
        terminal,
      ),
    ).toContain("the saved tabs are restored somewhere other than once, in the main window");
    expect(
      pageViolations(
        mutate(page, "if (isMainWindow) void restoreFlow.restore();", "void restoreFlow.restoreWindow();\n      if (isMainWindow) void restoreFlow.restore();"),
        terminal,
      ),
    ).toContain("a reopened window takes its tabs somewhere other than once, outside the main window");
  });

  it("a waiting tab opened by something other than its button or the palette", () => {
    const woken = mutate(
      page,
      "      if (isMainWindow) void restoreFlow.restore();",
      "      if (isMainWindow) void restoreFlow.restore();\n      for (const tab of tabsState.list) void restoreFlow.wake(tab.sessionId);",
    );
    expect(pageViolations(woken, terminal)).toContain("a waiting tab is opened by something other than its own button");
    const all = mutate(page, "      if (isMainWindow) void restoreFlow.restore();", "      if (isMainWindow) {\n        void restoreFlow.restore();\n        restoreFlow.wakeAll();\n      }");
    expect(pageViolations(all, terminal)).toContain(
      "waiting tabs are opened all at once from somewhere other than the palette",
    );
  });

  it("a terminal that connects although its tab waits", () => {
    expect(pageViolations(mutate(page, "                    waiting={!!tab.waiting}\n", ""), terminal)).toContain(
      "the terminal is not told that its tab waits",
    );
    expect(
      pageViolations(page, mutate(terminal, "    } else if (waiting) {\n      return;\n    } else if", "    } else if")),
    ).toContain("Terminal.svelte connects a tab that waits");
  });

  it("a window closed on purpose whose tabs would come back", () => {
    expect(pageViolations(mutate(page, "    forgetSavedTabs();\n", ""), terminal)).toContain(
      "a window closed on purpose leaves its tabs to come back",
    );
  });

  it("a closed tab whose output would come back", () => {
    expect(pageViolations(mutate(page, "    if (!keepSession) restoreFlow.forget(sessionId);\n", ""), terminal)).toContain(
      "closing a tab leaves what was kept of it for the next launch",
    );
  });

  it("output written past the setting, or from a second place", () => {
    const flow = raw(FLOW);
    expect(
      contentViolations(mutate(flow, "    if (!keepsContent(settings, isProd(tab))) {\n      if (kept.delete(sid))", "    if (false) {\n      if (kept.delete(sid))")),
    ).toContain("what a tab printed is written before keepsContent was asked");
    expect(
      contentViolations(mutate(flow, "    async flush(): Promise<void> {", "    async flush(): Promise<void> {\n      void tabContentSave(\"x\", \"{}\");")),
    ).toContain("what a tab printed is written somewhere other than keep");
    expect(
      contentViolations(mutate(flow, "        if (!keepsContent(settings, isProd(tab))) return;\n", "")),
    ).toContain("what a tab printed is read back where it is no longer kept");
  });

  it("is not satisfied by a comment that only names the markers", () => {
    const commented = mutate(page, "                    waiting={!!tab.waiting}\n", "                    <!-- waiting={!!tab.waiting} -->\n");
    expect(pageViolations(commented, terminal)).toContain("the terminal is not told that its tab waits");
    const prose = mutate(model, "    alias: tab.alias,\n  };", "    alias: tab.alias,\n    // never the secret\n  };");
    expect(recordViolations(prose)).toEqual([]);
  });
});
