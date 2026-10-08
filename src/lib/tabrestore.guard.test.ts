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
//  4. Only the main window restores, and once.
//  5. A tab that came back opens its session through the policy or through its
//     own button — never because it was mounted. `waitReason` is what keeps a
//     production server, a container and a server that asks for a password
//     from being connected to at launch; a `reconnect` that does not ask it
//     turns "restore the tabs" into "dial every server I had open".
//  6. A window closed on purpose forgets its tabs: its sessions end with it,
//     and what the user closed must not come back at the next launch.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for (the second `describe`). Sources are read
// with comments stripped — the rationale above, and the comments in the
// sources, name the anti-patterns in prose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const MODEL = "lib/tabrestore.ts";
const KEEPER = "lib/stores/tabrestore.svelte.ts";
const PAGE = "routes/+page.svelte";
const TERMINAL = "lib/Terminal.svelte";

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

/** Fields of a tab that belong to its session, not to what the tab is. */
const SESSION_FIELDS = /\b(?:secret|remember|status|adopt|waiting|gen)\b/;

export function recordViolations(model: string): string[] {
  const c = code(model);
  const out: string[] = [];
  const record = fn(c, "savedTab");
  if (record === "") out.push("savedTab is gone");
  if (/\.\.\./.test(record)) out.push("savedTab spreads a tab instead of listing its fields");
  if (SESSION_FIELDS.test(record.slice(record.indexOf("{")))) {
    out.push("savedTab writes down something of the session");
  }
  if (!/tabs\.map\(savedTab\)/.test(fn(c, "savedWindow"))) {
    out.push("savedWindow does not build its tabs with savedTab");
  }
  return out;
}

// ── 2 & 3: the keeper ────────────────────────────────────────────────────────

export function keeperViolations(keeper: string): string[] {
  const c = code(keeper);
  const out: string[] = [];
  const writes = [...c.matchAll(/\.setItem\(([^;]*)\);/g)].map((m) => m[1].replace(/\s+/g, " "));
  if (writes.length !== 1 || writes[0] !== "own, JSON.stringify(savedWindow(tabs, layout))") {
    out.push(`the slot is written with something other than savedWindow: ${writes.join(" | ")}`);
  }
  if (!/let writing = \$state\(!main\);/.test(c)) {
    out.push("the main window writes its slot from the start");
  }
  if (!/sync\([^)]*\): void \{\s*if \(!writing\) return;/.test(c)) {
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

  // 4 — the main window, once.
  const restore = fn(script, "restoreSavedTabs", "  ");
  if (restore === "") out.push("restoreSavedTabs is gone");
  if (
    count(script, /\brestoreSavedTabs\(\)/g) !== 2 ||
    !/if \(isMainWindow\) restoreSavedTabs\(\);/.test(script)
  ) {
    out.push("the saved tabs are restored somewhere other than once, in the main window");
  }
  for (const call of ["takeSavedTabs", "restoreSaved", "openRestored", "startSavingTabs"]) {
    const used = count(script, new RegExp(`\\b${call}\\(`, "g"));
    if (used !== 1 || !new RegExp(`\\b${call}\\(`).test(restore)) {
      out.push(`${call} is used outside restoreSavedTabs`);
    }
  }
  // 3 — its slot is written from the end of the restore, whatever the restore did.
  if (!/\} finally \{\s*startSavingTabs\(\);\s*\}/.test(restore)) {
    out.push("the slot starts being written before, or only when, the restore went through");
  }

  // 5 — who opens a session.
  if (!/openRestored\(restored\.tabs, restored\.layout, \(tab\) =>\s*waitReason\(mode, waitFactsOf\(tab, null\)\),?\s*\)/.test(restore)) {
    out.push("restored tabs are opened without asking waitReason");
  }
  if (/\breconnectTabStore\(/.test(restore)) out.push("the restore connects a tab itself");
  for (const name of ["settleWaiting", "wakeAllWaiting"]) {
    const body = fn(script, name, "  ");
    if (body === "") {
      out.push(`${name} is gone`);
      continue;
    }
    const opens = count(body, /\breconnectTabStore\(/g);
    const asked = count(body, /if \(reason === null\)\s*\{?\s*reconnectTabStore\(/g);
    if (opens !== asked || !/const reason = [^;]*waitReason\("connect",/.test(body)) {
      out.push(`${name} opens a session waitReason did not allow`);
    }
  }
  // Its button, and the same action in the tab's menu — a gesture either way.
  const gestures =
    count(markup, /onclick=\{\(\) => wakeTab\(tab\.sessionId\)\}/g) +
    count(script, /onSelect: \(\) => void wakeTab\(tab\.sessionId\)/g);
  if (
    count(c, /\bwakeTab\(/g) !== gestures + 1 ||
    !/onclick=\{\(\) => wakeTab\(tab\.sessionId\)\}/.test(markup)
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

  it("the main window restores once, and a restored tab connects by the policy or its button", () => {
    expect(pageViolations(raw(PAGE), raw(TERMINAL))).toEqual([]);
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
    expect(recordViolations(mutate(model, "tabs: tabs.map(savedTab)", "tabs: [...tabs]"))).toContain(
      "savedWindow does not build its tabs with savedTab",
    );
  });

  it("a slot written with the tabs themselves", () => {
    expect(
      keeperViolations(mutate(keeper, "JSON.stringify(savedWindow(tabs, layout))", "JSON.stringify({ tabs, layout })")),
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

  it("every window restoring, or the main one restoring twice", () => {
    expect(
      pageViolations(mutate(page, "if (isMainWindow) restoreSavedTabs();", "restoreSavedTabs();"), terminal),
    ).toContain("the saved tabs are restored somewhere other than once, in the main window");
    expect(
      pageViolations(
        mutate(page, "if (isMainWindow) restoreSavedTabs();", "if (isMainWindow) restoreSavedTabs();\n      restoreSavedTabs();"),
        terminal,
      ),
    ).toContain("the saved tabs are restored somewhere other than once, in the main window");
  });

  it("a slot that starts being written only when the restore succeeds", () => {
    const broken = mutate(
      page,
      "    } finally {\n      // Only now may this window write its slot: before, \"no tabs yet\" would\n      // have replaced the tabs it had.\n      startSavingTabs();\n    }",
      "      startSavingTabs();\n    } finally {\n    }",
    );
    expect(pageViolations(broken, terminal)).toContain(
      "the slot starts being written before, or only when, the restore went through",
    );
  });

  it("restored tabs that connect without the policy", () => {
    expect(
      pageViolations(
        mutate(page, "waitReason(mode, waitFactsOf(tab, null)),\n      );", "null,\n      );").replace(
          "(tab) =>\n        null,",
          "() => null,",
        ),
        terminal,
      ),
    ).toContain("restored tabs are opened without asking waitReason");
    expect(
      pageViolations(
        mutate(
          page,
          "    if (reason === null) reconnectTabStore(sessionId);\n    else setWaiting(sessionId, reason);",
          "    reconnectTabStore(sessionId);",
        ),
        terminal,
      ),
    ).toContain("settleWaiting opens a session waitReason did not allow");
    expect(
      pageViolations(
        mutate(
          page,
          "      const reason = waitReason(\"connect\", waitFactsOf(tab, null));\n      if (reason === null) {",
          "      const reason = null;\n      if (reason === null) {",
        ),
        terminal,
      ),
    ).toContain("wakeAllWaiting opens a session waitReason did not allow");
  });

  it("a waiting tab opened by something other than its button", () => {
    expect(
      pageViolations(
        mutate(page, "      startSavingTabs();\n    }\n  }", "      startSavingTabs();\n    }\n    for (const tab of tabsState.list) void wakeTab(tab.sessionId);\n  }"),
        terminal,
      ),
    ).toContain("a waiting tab is opened by something other than its own button");
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

  it("is not satisfied by a comment that only names the markers", () => {
    const commented = mutate(page, "                    waiting={!!tab.waiting}\n", "                    <!-- waiting={!!tab.waiting} -->\n");
    expect(pageViolations(commented, terminal)).toContain("the terminal is not told that its tab waits");
    const prose = mutate(model, "    alias: tab.alias,\n  };", "    alias: tab.alias,\n    // never the secret\n  };");
    expect(recordViolations(prose)).toEqual([]);
  });
});
