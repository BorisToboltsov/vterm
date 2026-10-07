// Centre-layout guard (v1.2): the contracts the panes of the centre stand on.
//
//  1. The layout changes only through the pure model. The tabs store replaces
//     its tree with a result of a `splitlayout.ts` function and nothing else;
//     nobody outside the store writes it. A tree edited by hand can hold a tab
//     twice or not at all — and a tab that is in no pane is a live session with
//     no way to reach it.
//  2. "The active tab" is derived from the layout, never stored. A second,
//     writable `activeId` is free to disagree with the tree: the docks and the
//     status bar would then follow a session other than the one in focus.
//  3. The terminals stay in ONE flat list. A `Terminal` that is created again
//     connects again — replacing the session — and starts with an empty
//     scrollback, so anything that makes its mount depend on the layout — an
//     `{#each}` over panes, an `{#if}` on the split state, a `{#key}` — turns
//     "move the tab to the other pane" into "drop the connection". (Since v1.3
//     the session is ended by the tab's teardown, not by the component going
//     away — `windowhandoff.guard` — but a remount still reconnects.)
//  4. A dragged tab changes the layout once, on release. Until then the strips
//     draw a preview; moving the tab for real on every pointer move would resize
//     terminals mid-drag. And what the strips hit-test is where tabs sit in the
//     layout, not where a slide is drawing them.
//  5. Only the pane in focus takes the keyboard when its terminal connects. A
//     terminal reconnecting in the pane next to it must not pull the cursor out
//     from under what the user is typing.
//  6. A dock panel is built for the session the dock names. The docks keep the
//     panels of every session on screen mounted; one wired to "the active tab"
//     would, while hidden, act on whichever session has the focus now.
//  7. Opening a tab is never the argument of an optional call. "Open the tab,
//     then tell whoever asked where it went" written as `place?.(openTab(…))`
//     opens nothing when nobody asked — `?.()` skips its arguments too. That
//     shipped to the preview once: ⌘T and a double-click on a server did nothing.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for (the second `describe`). Sources are read
// with comments stripped — the rationale above, and the comments in the
// components, name the anti-patterns in prose.

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

/** Body of a top-level `function name(` in `src` (to its closing brace at column 0). */
function fn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
}

// ── 1 & 2: the store ─────────────────────────────────────────────────────────

/** The local names the store imports from the pure model. */
function modelImports(store: string): string[] {
  const m = /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/splitlayout["']/.exec(store);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((spec) => spec.trim())
    .filter((spec) => spec !== "" && !spec.startsWith("type "))
    .map((spec) => spec.split(/\s+as\s+/).pop() as string);
}

export function storeViolations(source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  const model = modelImports(c);
  if (!/let center = \$state\.raw<CenterLayout>\(emptyLayout\(\)\);/.test(c)) {
    out.push("the layout is not a raw state seeded by emptyLayout()");
  }
  // Every later assignment: `center = <model function>(center, …)` or a fresh layout.
  for (const m of c.matchAll(/^[ \t]*center\s*=(?!=)\s*([^;]+);/gm)) {
    const rhs = m[1].trim();
    const call = /^([A-Za-z_$][\w$]*)\(\s*(center\b)?/.exec(rhs);
    const ok =
      call !== null &&
      model.includes(call[1]) &&
      (call[2] !== undefined || call[1] === "emptyLayout");
    if (!ok) out.push(`the layout is assigned something the model did not produce: ${rhs}`);
  }
  if (/\bset\s+(?:center|activeId|list)\s*\(/.test(c)) {
    out.push("tabsState must not expose a setter");
  }
  if (!/get activeId\(\): string \| null \{\s*return activeTabIn\(center\);\s*\}/.test(c)) {
    out.push("activeId must be derived from the layout");
  }
  if (/\bactiveId\s*:\s*(?:null|string)|\bactiveId\s*=(?!=)/.test(c)) {
    out.push("activeId is stored");
  }
  return out;
}

/** Writes to the store's state from outside it. */
export function outsideWriteViolations(rel: string, source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  if (/\btabsState\.(?:activeId|center|list)\s*(?:=(?!=)|\+\+|--|[-+*/]=)/.test(c)) {
    out.push(`${rel} assigns to tabsState`);
  }
  if (/\btabsState\.center(?:\.\w+|\[[^\]]+\])+\s*=(?!=)/.test(c)) {
    out.push(`${rel} edits the layout tree in place`);
  }
  if (/\btabsState\.list\.(?:push|pop|shift|unshift|splice|sort|reverse)\(/.test(c)) {
    out.push(`${rel} edits the tab list in place`);
  }
  return out;
}

// ── 3, 5 & 6: the page ───────────────────────────────────────────────────────

/** The `{#…}` blocks open at `offset` in a component's markup, outermost first. */
function enclosingBlocks(markup: string, offset: number): string[] {
  const stack: string[] = [];
  for (const m of markup.slice(0, offset).matchAll(/\{([#/])(\w+)([^}]*)\}/g)) {
    if (m[1] === "#") stack.push(`#${m[2]}${m[3]}`.trim());
    else stack.pop();
  }
  return stack;
}

export function pageViolations(source: string, terminal: string): string[] {
  const c = code(source);
  const markup = c.slice(c.lastIndexOf("</script>"));
  const out: string[] = [];

  const mounts = [...markup.matchAll(/<TerminalView\b/g)];
  if (mounts.length !== 1) {
    out.push(`the terminal is rendered in ${mounts.length} places, not one`);
  } else {
    const blocks = enclosingBlocks(markup, mounts[0].index);
    const want = [
      "#if tabsState.list.length > 0",
      "#each tabsState.list as tab (tab.sessionId)",
      "#key tab.gen",
    ];
    if (blocks.join(" | ") !== want.join(" | ")) {
      out.push(`the terminal's mount depends on more than the flat tab list: ${blocks.join(" | ")}`);
    }
  }

  if (!/focusOnConnect=\{tabsState\.activeId === tab\.sessionId\}/.test(markup)) {
    out.push("a terminal takes the keyboard on connect whether or not its pane is in focus");
  }
  const t = code(terminal);
  // Both ways a terminal comes to have a session: it connected, or it took one
  // over from another window (v1.3).
  if (
    !/onstatus\?\.\("connected"\);\s*if \(focusOnConnect\) term\.focus\(\);/.test(t) ||
    !/onadopted\?\.\(\);\s*if \(focusOnConnect\) term\.focus\(\);/.test(t)
  ) {
    out.push("Terminal.svelte focuses on connect without asking focusOnConnect");
  }

  const at = markup.indexOf("{#snippet dockPanel(");
  const snippet = at < 0 ? "" : markup.slice(at, markup.indexOf("{/snippet}", at));
  if (!/\{@const tab = findTab\(sid\)\}/.test(snippet)) {
    out.push("the dock snippet does not build its panel for the session it is given");
  }
  if (/\bactiveTab\b|\btabsState\.activeId\b/.test(snippet)) {
    out.push("a dock panel is wired to the active tab instead of its own session");
  }

  if (!/previewTabs\(center, pane\.id, tabDrag\.tab, tabDrag\.over\)/.test(markup)) {
    out.push("a pane's strip does not draw the preview of the drop");
  }
  if (/\?\.\(\s*open\w*\(/.test(c)) {
    out.push("a tab is opened inside an optional call — it opens only when someone listens");
  }
  const key = fn(c.replace(/\n  \}\n/g, "\n}\n"), "onPaneKey");
  if (!/e\.defaultPrevented/.test(key)) {
    out.push("the pane chords fire even when the focused control already handled the key");
  }
  return out;
}

// ── 4: the drag ──────────────────────────────────────────────────────────────

const MUTATORS = /\b(?:dropTab|moveTabTo|splitTabOff|activateTab|focusPane|joinPanes)\(/;

export function dragViolations(source: string): string[] {
  const c = code(source);
  const out: string[] = [];
  if ((c.match(/\bdropTab\(/g) ?? []).length !== 1 || !/\bdropTab\(tab, over\)/.test(fn(c, "onUp"))) {
    out.push("the layout is not committed exactly once, on release");
  }
  for (const name of ["onMove", "tabDropAt", "beginTabDrag", "onCancel", "clearDrag"]) {
    const body = fn(c, name);
    if (body === "") out.push(`${name} is gone`);
    else if (MUTATORS.test(body)) out.push(`${name} changes the layout`);
  }
  const hit = fn(c, "tabDropAt");
  const strip = hit.slice(hit.indexOf("if (strip) {"), hit.indexOf("const body ="));
  if (!/layoutBox\(t\)/.test(strip) || !/slotIndex\(/.test(strip)) {
    out.push("a strip's slot is not decided from layout boxes");
  }
  if (/getBoundingClientRect/.test(strip)) {
    out.push("a strip is hit-tested against drawn boxes — a sliding neighbour swaps straight back");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

const STORE = "lib/stores/tabs.svelte.ts";
const DRAG = "lib/stores/tabdrag.svelte.ts";
const PAGE = "routes/+page.svelte";
const TERMINAL = "lib/Terminal.svelte";

describe("centre layout guard", () => {
  it("the store replaces the layout only with what the model returns", () => {
    expect(storeViolations(raw(STORE))).toEqual([]);
    // The check has something to hold: the store does assign the layout.
    expect(code(raw(STORE)).match(/^[ \t]*center\s*=(?!=)/gm)?.length ?? 0).toBeGreaterThan(8);
  });

  it("nothing outside the store writes the tabs or the layout", () => {
    const found = sources()
      .filter((rel) => rel !== STORE)
      .flatMap((rel) => outsideWriteViolations(rel, raw(rel)));
    expect(found).toEqual([]);
  });

  it("the terminals are one flat list, placed over the panes — not inside them", () => {
    expect(pageViolations(raw(PAGE), raw(TERMINAL))).toEqual([]);
  });

  it("a dragged tab changes the layout once, and strips are hit-tested by layout", () => {
    expect(dragViolations(raw(DRAG))).toEqual([]);
  });
});

describe("centre layout guard — catches what it exists for", () => {
  const store = raw(STORE);
  const page = raw(PAGE);
  const terminal = raw(TERMINAL);
  const drag = raw(DRAG);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a layout edited by hand", () => {
    expect(
      storeViolations(
        mutate(
          store,
          "center = focusPaneIn(center, paneId);",
          "center = { ...center, focus: paneId };",
        ),
      ),
    ).toEqual([expect.stringContaining("something the model did not produce")]);
    // A helper that is not the model's does not count either.
    expect(
      storeViolations(
        mutate(store, "center = joinPanesIn(center);", "center = flatten(center);"),
      ),
    ).toEqual([expect.stringContaining("something the model did not produce")]);
    expect(
      storeViolations(mutate(store, "$state.raw<CenterLayout>(emptyLayout())", "$state(emptyLayout())")),
    ).toContain("the layout is not a raw state seeded by emptyLayout()");
  });

  it("a stored or settable activeId", () => {
    expect(
      storeViolations(
        mutate(
          store,
          "get activeId(): string | null {\n    return activeTabIn(center);\n  },",
          "get activeId(): string | null {\n    return active;\n  },\n  set activeId(v: string | null) {\n    active = v;\n  },",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "tabsState must not expose a setter",
        "activeId must be derived from the layout",
      ]),
    );
  });

  it("a write from outside the store", () => {
    expect(outsideWriteViolations("x.svelte", "tabsState.activeId = id;")).toHaveLength(1);
    expect(outsideWriteViolations("x.svelte", "tabsState.center.root.ratio = 0.3;")).toHaveLength(1);
    expect(outsideWriteViolations("x.svelte", "tabsState.list.push(tab);")).toHaveLength(1);
    expect(outsideWriteViolations("x.svelte", "tabsState.center.focus = 'p1';")).toHaveLength(1);
    // Reading and comparing are fine, and so is prose in a comment.
    expect(outsideWriteViolations("x.svelte", "if (tabsState.activeId === id) go();")).toEqual([]);
    expect(outsideWriteViolations("x.svelte", "// tabsState.activeId = id used to work")).toEqual([]);
  });

  it("a terminal mounted per pane, or under a condition on the layout", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "{#each tabsState.list as tab (tab.sessionId)}",
          "{#each paneList as pane (pane.id)}{#each tabsOf(pane.tabs) as tab (tab.sessionId)}",
        ),
        terminal,
      ),
    ).toEqual([expect.stringContaining("depends on more than the flat tab list")]);
    expect(
      pageViolations(mutate(page, "{#key tab.gen}", "{#key tabPane[tab.sessionId]}{#key tab.gen}"), terminal),
    ).toEqual([expect.stringContaining("depends on more than the flat tab list")]);
    expect(
      pageViolations(mutate(page, "{#key tab.gen}", "{#if !isSplit}{#key tab.gen}"), terminal),
    ).toEqual([expect.stringContaining("depends on more than the flat tab list")]);
    expect(
      pageViolations(mutate(page, "<TerminalView", "<TerminalView />\n<TerminalView"), terminal),
    ).toEqual([expect.stringContaining("rendered in 2 places")]);
  });

  it("a terminal that takes the keyboard from the pane next to it", () => {
    expect(
      pageViolations(
        mutate(page, "focusOnConnect={tabsState.activeId === tab.sessionId}", ""),
        terminal,
      ),
    ).toContain("a terminal takes the keyboard on connect whether or not its pane is in focus");
    for (const reached of ['onstatus?.("connected");', "onadopted?.();"]) {
      const guarded = new RegExp(
        `(${reached.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}\\s*)if \\(focusOnConnect\\) term\\.focus\\(\\);`,
      );
      expect(guarded.test(terminal), `the source no longer guards the focus after ${reached}`).toBe(true);
      expect(
        pageViolations(page, terminal.replace(guarded, "$1term.focus();")),
      ).toContain("Terminal.svelte focuses on connect without asking focusOnConnect");
    }
  });

  it("a dock panel wired to the active tab", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "getAiContext={() => gatherAiContext(tab.sessionId)}",
          "getAiContext={() => gatherAiContext(tabsState.activeId ?? tab.sessionId)}",
        ),
        terminal,
      ),
    ).toContain("a dock panel is wired to the active tab instead of its own session");
    expect(
      pageViolations(mutate(page, "{@const tab = findTab(sid)}", "{@const tab = activeTab}"), terminal),
    ).toEqual(
      expect.arrayContaining([
        "the dock snippet does not build its panel for the session it is given",
        "a dock panel is wired to the active tab instead of its own session",
      ]),
    );
  });

  it("a strip that draws the store, and a chord that ignores the editor", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "tabsOf(previewTabs(center, pane.id, tabDrag.tab, tabDrag.over)),",
          "tabsOf(pane.tabs),",
        ),
        terminal,
      ),
    ).toContain("a pane's strip does not draw the preview of the drop");
    expect(
      pageViolations(mutate(page, "if (e.defaultPrevented || bcOn) return;", "if (bcOn) return;"), terminal),
    ).toContain("the pane chords fire even when the focused control already handled the key");
  });

  it("a tab that opens only when someone asked where it went", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "const sessionId = openLocalTab();\n    place?.(sessionId);",
          "place?.(openLocalTab());",
        ),
        terminal,
      ),
    ).toEqual(["a tab is opened inside an optional call — it opens only when someone listens"]);
    expect(
      pageViolations(
        mutate(
          page,
          "const sessionId = openTabStore(server.id, server.alias, null, false);\n      place?.(sessionId);",
          "place?.(openTabStore(server.id, server.alias, null, false));",
        ),
        terminal,
      ),
    ).toEqual(["a tab is opened inside an optional call — it opens only when someone listens"]);
  });

  it("a drag that moves the tab before the release", () => {
    expect(
      dragViolations(
        mutate(
          drag,
          "tabDrag.over = offered ? hit.drop : null;",
          "tabDrag.over = offered ? hit.drop : null;\n  if (offered) dropTab(candidate.tab, hit.drop);",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "the layout is not committed exactly once, on release",
        "onMove changes the layout",
      ]),
    );
    expect(dragViolations(mutate(drag, "if (over) dropTab(tab, over);", ""))).toContain(
      "the layout is not committed exactly once, on release",
    );
  });

  it("a strip hit-tested against drawn boxes", () => {
    expect(
      dragViolations(
        mutate(
          drag,
          "const box = layoutBox(t);\n        return { start: box.left, size: box.width };",
          "const box = t.getBoundingClientRect();\n        return { start: box.left, size: box.width };",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "a strip's slot is not decided from layout boxes",
        "a strip is hit-tested against drawn boxes — a sliding neighbour swaps straight back",
      ]),
    );
  });

  it("is not satisfied by a comment that only names the markers", () => {
    const gutted = mutate(
      page,
      "focusOnConnect={tabsState.activeId === tab.sessionId}",
      "<!-- focusOnConnect={tabsState.activeId === tab.sessionId} -->",
    );
    expect(pageViolations(gutted, terminal)).toContain(
      "a terminal takes the keyboard on connect whether or not its pane is in focus",
    );
  });
});
