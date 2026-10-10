// Session-views guard (v1.11, ADR 0024): the contracts a file shown *inside its
// connection* stands on. (For one version, 1.8, a file was a tab of the centre;
// that guard — `doctabs.guard` — went with the model it held.)
//
//  1. The centre holds connections and nothing else. The tabs store knows no
//     documents and does not reach the workspaces store: a file put on the same
//     level as the connections has to be told, by rule after rule, whose it is
//     — which pane's session the docks follow, what moves with a tab to another
//     window, what a closed session takes along. Inside its connection it needs
//     none of them.
//  2. A connection's layout is replaced only with what the model returns
//     (`sessionviews.ts` over `splitlayout.ts`), like the centre's. A tree built
//     by hand can hold a view twice or not at all — a file open in no zone is a
//     buffer with unsaved edits and no way to reach it.
//  3. A document and its view come and go in one step: the functions that add
//     and remove a document are the ones that open and close its view, and
//     nobody else adds or removes documents.
//  4. The editors of a connection are ONE flat list, like the terminals. An
//     editor that is created again loses its undo history, its cursor and its
//     scroll, so its mount depends on the list of connections and on that
//     connection's documents only — not on the zones, and not on the terminal's
//     reconnect key.
//  5. A view is placed over the zone that holds it, the terminal and each file
//     alike; and a zone carries a strip only while the connection has a file
//     open — a terminal alone keeps its whole height.
//  6. "On screen" is the terminal being shown, not the connection being shown:
//     a recording pauses, and a login question waits, while a file stands in
//     front of the terminal.
//  7. A connection with unsaved edits is never closed without its question — a
//     bulk close leaves it open, a single close asks — and a layout that came
//     in a packet from another window is rebuilt against the files that came
//     with it, not trusted.
//  8. A view is dragged like a session's tab — and only inside its connection
//     (v1.11.1). The layout changes once, on release: until then the strips
//     draw a preview and a tint shows the half of a zone the view would take;
//     moving it for real on every pointer move would resize the terminal
//     mid-drag. A strip is hit-tested by where its views sit in the layout, not
//     where a slide is drawing them. And nothing outside the connection's own
//     area is a target — another connection's zones included — while the label
//     that follows the pointer stops at that area's edge: a file is saved
//     through the connection it was opened in, and a label that went on past
//     it would say the file could go where it cannot.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for (the second `describe`). Sources are read
// with comments stripped — the comments in the components name the anti-patterns.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Body of a top-level `function name(` (to its closing brace at column 0). */
function fn(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\(`));
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
}

/** Body of a component-level `function name(` (two spaces in). */
const pageFn = (src: string, name: string): string => fn(src.replace(/\n  \}\n/g, "\n}\n"), name);

/** The `{#…}` blocks open at `offset` in a component's markup, outermost first. */
function enclosingBlocks(markup: string, offset: number): string[] {
  const stack: string[] = [];
  for (const m of markup.slice(0, offset).matchAll(/\{([#/])(\w+)([^}]*)\}/g)) {
    if (m[1] === "#") stack.push(`#${m[2]}${m[3]}`.trim());
    else stack.pop();
  }
  return stack;
}

const TABS = "lib/stores/tabs.svelte.ts";
const WORKSPACES = "lib/stores/workspaces.svelte.ts";
const VIEWDRAG = "lib/stores/viewdrag.svelte.ts";
const PAGE = "routes/+page.svelte";

// ── 1: the centre holds connections only ─────────────────────────────────────

export function centreViolations(tabs: string): string[] {
  const c = code(tabs);
  const out: string[] = [];
  if (/from\s*["']\.\/workspaces\.svelte["']/.test(c)) {
    out.push("the tabs store reaches the workspaces store");
  }
  if (/\b(?:openDocTab|closeDocTab|sessionOfTab)\b|\bdocs\b/.test(c)) {
    out.push("the tabs store keeps tabs that are not connections");
  }
  return out;
}

// ── 2 & 3: the workspaces store ──────────────────────────────────────────────

/** The functions of the pure model the store imports (local names). */
function modelImports(store: string): string[] {
  const names: string[] = [];
  for (const m of store.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/(?:sessionviews|splitlayout)["']/g,
  )) {
    for (const spec of m[1].split(",")) {
      const name = spec.trim();
      if (name !== "" && !name.startsWith("type ")) names.push(name.split(/\s+as\s+/).pop() as string);
    }
  }
  return names;
}

export function storeViolations(store: string): string[] {
  const c = code(store);
  const out: string[] = [];
  const model = modelImports(c);
  // Every layout written into a workspace: a call of the model, or the value a
  // call of the model was just bound to (`layout`, shorthand).
  for (const m of c.matchAll(/\blayout:\s*([^,}\n]+)/g)) {
    const value = m[1].trim();
    // The type of the field, not a value.
    if (/^ViewLayout\b/.test(value)) continue;
    const call = /^([A-Za-z_$][\w$]*)\(/.exec(value);
    if (!call || !model.includes(call[1])) {
      out.push(`a connection's layout is given something the model did not produce: ${value}`);
    }
  }
  for (const m of c.matchAll(/\bconst layout = ([^;]+);/g)) {
    const call = /^([A-Za-z_$][\w$]*)\(/.exec(m[1].trim());
    if (!call || !(model.includes(call[1]) || call[1] === "next")) {
      out.push(`a connection's layout is given something the model did not produce: ${m[1].trim()}`);
    }
  }
  // What `relayout` is handed: one call of the model on the layout it was given.
  for (const m of c.matchAll(/relayout\(sessionId, \(layout\) => ([^;]+)\);/g)) {
    const call = /^([A-Za-z_$][\w$]*)\(layout\b/.exec(m[1].trim());
    if (!call || !model.includes(call[1])) {
      out.push(`a zone command does something the model did not: ${m[1].trim()}`);
    }
  }
  if (/kind:\s*["'](?:pane|split)["']|\.tabs\s*=(?!=)|\.active\s*=(?!=)|\broot:\s*\{/.test(c)) {
    out.push("the store builds or edits a layout tree by hand");
  }
  // A document and its view, in one step.
  for (const name of ["addEditor", "addScratchEditor"]) {
    if (!/patch\(sessionId, \{ editors: \[\.\.\.ws\.editors, doc\], layout: openView\(ws\.layout, id\) \}\);/.test(fn(c, name))) {
      out.push(`${name} adds a document without opening its view`);
    }
  }
  const close = fn(c, "closeEditor");
  if (
    !/editors: ws\.editors\.filter\(\(e\) => e\.id !== id\),\s*layout: closeView\(ws\.layout, id\),/.test(close)
  ) {
    out.push("closeEditor removes a document and leaves its view in a zone");
  }
  // Nobody else changes which documents there are: three writers, and the one
  // that only edits a document in place (`updateDoc`, a `map`).
  const writers = (c.match(/\beditors: (?:\[\.\.\.ws\.editors, doc\]|ws\.editors\.filter\()/g) ?? []).length;
  if (writers !== 3) {
    out.push(`documents are added or removed in ${writers} places, not three`);
  }
  // A layout that came from another window is rebuilt, not taken.
  if (!/const layout = loadViews\(ws\.layout,/.test(fn(c, "adoptWorkspace"))) {
    out.push("a workspace from another window brings its layout in unchecked");
  }
  return out;
}

// ── 4, 5 & 6: the page ───────────────────────────────────────────────────────

export function pageViolations(page: string): string[] {
  const c = code(page);
  const at = c.lastIndexOf("</script>");
  const script = c.slice(0, at);
  const markup = c.slice(at);
  const out: string[] = [];

  const editors = [...markup.matchAll(/<EditorTab\b/g)];
  if (editors.length !== 1) {
    out.push(`the editor is rendered in ${editors.length} places, not one`);
  } else {
    const blocks = enclosingBlocks(markup, editors[0].index);
    const want = [
      "#if tabsState.list.length > 0",
      "#each tabsState.list as tab (tab.sessionId)",
      "#each ws.editors as ed (ed.id)",
      // What the editor shows while its file loads — its content, not its place.
      "#if ed.loadError",
    ];
    if (blocks.join(" | ") !== want.join(" | ")) {
      out.push(`an editor's mount depends on more than its connection's documents: ${blocks.join(" | ")}`);
    }
  }

  // Over the zone that holds it — the terminal and each file alike.
  if (
    !/style=\{rectStyle\(termZone \? vp\.panes\[termZone\.id\] : undefined, vb, hasFiles \? VIEW_STRIP : 0\)\}/.test(
      markup,
    )
  ) {
    out.push("the terminal is not placed over its zone, or keeps a strip's room with no strip");
  }
  if (!/style=\{rectStyle\(zone \? vp\.panes\[zone\.id\] : undefined, vb, VIEW_STRIP\)\}/.test(markup)) {
    out.push("a file is not placed over the zone that holds it");
  }
  if (!/\{@const vp = layoutRects\(views\.root, vb\)\}/.test(markup)) {
    out.push("the zones are not laid out by the model");
  }
  // A strip only while there is a file.
  const strip = markup.indexOf('data-testid="view-strip"');
  if (strip < 0 || !enclosingBlocks(markup, strip).includes("#if hasFiles")) {
    out.push("a connection with no file open carries a strip of views");
  }
  // What a view shows is the layout's to say.
  if (!/class="absolute flex flex-col \{terminalShown\(views\) \? '' : 'invisible'\}"/.test(markup)) {
    out.push("the terminal is shown whether or not its zone shows it");
  }
  if (!/class="absolute flex flex-col \{zone\?\.active === ed\.id \? '' : 'invisible'\}"/.test(markup)) {
    out.push("a file is shown whether or not its zone shows it");
  }

  if (
    !/onScreenSessions\(\[\.\.\.shownIds\], \(id\) => terminalShown\(getWorkspace\(id\)\.layout\)\)/.test(
      script,
    )
  ) {
    out.push("a connection showing a file counts as a terminal on screen");
  }

  // Unsaved edits: never closed without their question.
  const bulk = pageFn(script, "closeInBulk");
  if (!/if \(!hasUnsaved\(getWorkspace\(tab\.sessionId\)\)\) closeTabFully\(tab\.sessionId\);/.test(bulk)) {
    out.push("a bulk close takes a connection's unsaved edits with it");
  }
  for (const name of ["closeOtherTabs", "closeTabsToRight"]) {
    const body = pageFn(script, name);
    if (/closeTabFully\(/.test(body) || !/closeInBulk\(/.test(body)) {
      out.push(`${name} closes connections without asking closeInBulk`);
    }
  }
  if (
    !/isLive\(tab\.status\) \|\| hasUnsaved\(getWorkspace\(sessionId\)\)/.test(
      pageFn(script, "requestCloseTab"),
    )
  ) {
    out.push("a dead connection with unsaved edits closes without a question");
  }
  return out;
}

// ── 8: the drag ──────────────────────────────────────────────────────────────

/** Everything of the workspaces store that changes a connection's layout or its documents. */
const VIEW_MUTATORS =
  /\b(?:dropSessionView|showSessionView|splitSessionView|moveSessionViewNext|focusSessionZone|joinSessionZones|setSessionZoneRatio|addEditor|addScratchEditor|closeEditor)\(/;

export function dragViolations(drag: string, page: string): string[] {
  const c = code(drag);
  const out: string[] = [];
  if (
    (c.match(/\bdropSessionView\(/g) ?? []).length !== 1 ||
    !/\bdropSessionView\(session, view, over\)/.test(fn(c, "onUp"))
  ) {
    out.push("a view's drop is not committed exactly once, on release");
  }
  for (const name of ["onMove", "viewDropAt", "beginViewDrag", "onCancel", "clearDrag"]) {
    const body = fn(c, name);
    if (body === "") out.push(`${name} is gone`);
    else if (VIEW_MUTATORS.test(body)) out.push(`${name} changes the layout`);
  }
  // Inside its own connection, or nowhere — said before any target is looked for.
  const hit = fn(c, "viewDropAt");
  const home = hit.indexOf("if (!home || home.dataset.viewsOf !== session) return null;");
  const targets = ['closest<HTMLElement>("[data-viewstrip]")', 'closest<HTMLElement>("[data-zone-body]")'].map(
    (target) => hit.indexOf(target),
  );
  if (home < 0 || targets.some((at) => at < 0 || at < home)) {
    out.push("a view can be dropped outside the connection it belongs to");
  }
  const strip = hit.slice(hit.indexOf("if (strip) {"), hit.indexOf("const body ="));
  if (!/layoutBox\(v\)/.test(strip) || !/slotIndex\(/.test(strip)) {
    out.push("a strip's slot is not decided from layout boxes");
  }
  if (/getBoundingClientRect/.test(strip)) {
    out.push("a strip is hit-tested against drawn boxes — a sliding neighbour swaps straight back");
  }
  if (
    !/dropChanges\(getWorkspace\(candidate\.session\)\.layout, candidate\.view, hit\.drop\)/.test(
      fn(c, "onMove"),
    )
  ) {
    out.push("a drop that would change nothing is offered as a target");
  }

  const p = code(page);
  const at = p.lastIndexOf("</script>");
  const script = p.slice(0, at);
  const markup = p.slice(at);
  if (!/data-views-of=\{tab\.sessionId\}/.test(markup)) {
    out.push("a connection's area is not marked — a view has nothing to stay inside");
  }
  if (
    !/viewDrag\.session === tab\.sessionId \? previewTabs\(views, zone\.id, viewDrag\.view, viewDrag\.over\) : zone\.tabs/.test(
      markup,
    )
  ) {
    out.push("a zone's strip does not draw the preview of the drop");
  }
  if (!/\{@const at = confinedGhost\(viewDrag\.x, viewDrag\.y, viewDrag\.area, viewGhost\)\}/.test(markup)) {
    out.push("the label of a dragged view follows the pointer out of its connection");
  }
  if (!/const dropZone = \$derived\(tabDrag\.zone \?\? incoming\.zone \?\? viewDrag\.zone\);/.test(script)) {
    out.push("the half of a zone a dragged view would take is not shown");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("session views guard", () => {
  it("the centre holds connections and nothing else", () => {
    expect(centreViolations(raw(TABS))).toEqual([]);
  });

  it("a connection's layout comes from the model, and a document from the step that opens its view", () => {
    expect(storeViolations(raw(WORKSPACES))).toEqual([]);
    // The check has something to hold: the store does write layouts.
    expect(code(raw(WORKSPACES)).match(/\blayout:\s*\w+\(/g)?.length ?? 0).toBeGreaterThan(4);
  });

  it("editors are one flat list per connection, placed over their zones, and the terminal is on screen only when shown", () => {
    expect(pageViolations(raw(PAGE))).toEqual([]);
  });

  it("a view is dragged inside its connection: previewed, dropped once, never taken out", () => {
    expect(dragViolations(raw(VIEWDRAG), raw(PAGE))).toEqual([]);
  });
});

describe("session views guard — catches what it exists for", () => {
  const tabs = raw(TABS);
  const store = raw(WORKSPACES);
  const page = raw(PAGE);

  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a file made a tab of the centre again", () => {
    expect(
      centreViolations(
        mutate(
          tabs,
          "export const findTab = ",
          "let docs = $state.raw<Record<string, string>>({});\nexport function openDocTab(id: string) {\n  docs = { ...docs, [id]: id };\n}\nexport const findTab = ",
        ),
      ),
    ).toEqual(["the tabs store keeps tabs that are not connections"]);
    expect(
      centreViolations(`import { getWorkspace } from "./workspaces.svelte";\n${tabs}`),
    ).toEqual(["the tabs store reaches the workspaces store"]);
    // Prose in a comment is not a dependency.
    expect(centreViolations(`// see ./workspaces.svelte for a connection's docs\n${tabs}`)).toEqual([]);
  });

  it("a layout built or edited by hand", () => {
    expect(
      storeViolations(
        mutate(
          store,
          "relayout(sessionId, (layout) => focusPane(layout, zone));",
          "relayout(sessionId, (layout) => ({ ...layout, focus: zone }));",
        ),
      ),
    ).toEqual([expect.stringContaining("a zone command does something the model did not")]);
    expect(
      storeViolations(
        mutate(
          store,
          "const EMPTY: Workspace = { editors: [], layout: terminalOnly() };",
          'const EMPTY: Workspace = { editors: [], layout: { root: { kind: "pane", id: "p0", tabs: ["terminal"], active: "terminal" }, focus: "p0", seq: 1 } };',
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("something the model did not produce"),
        "the store builds or edits a layout tree by hand",
      ]),
    );
    // A helper that is not the model's does not count.
    expect(
      storeViolations(
        mutate(store, "layout: openView(ws.layout, id) });\n  return id;\n}\n\n/**\n * Add an already-filled", "layout: withFile(ws.layout, id) });\n  return id;\n}\n\n/**\n * Add an already-filled"),
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("something the model did not produce: withFile(")]),
    );
  });

  it("a document opened without a view, or closed with its view left in a zone", () => {
    expect(
      storeViolations(
        mutate(
          store,
          "patch(sessionId, { editors: [...ws.editors, doc], layout: openView(ws.layout, id) });\n  return id;\n}\n\n/**\n * Add an already-filled",
          "patch(sessionId, { editors: [...ws.editors, doc] });\n  return id;\n}\n\n/**\n * Add an already-filled",
        ),
      ),
    ).toEqual(["addEditor adds a document without opening its view"]);
    expect(
      storeViolations(mutate(store, "    layout: closeView(ws.layout, id),\n", "")),
    ).toEqual(["closeEditor removes a document and leaves its view in a zone"]);
    // A fourth place that drops documents — past the step that closes their views.
    expect(
      storeViolations(
        mutate(
          store,
          "export function removeWorkspace(",
          "export function closeAll(sessionId: string): void {\n  const ws = ensure(sessionId);\n  patch(sessionId, { editors: ws.editors.filter(() => false) });\n}\n\nexport function removeWorkspace(",
        ),
      ),
    ).toEqual(["documents are added or removed in 4 places, not three"]);
  });

  it("a layout from another window taken as it came", () => {
    expect(
      storeViolations(
        mutate(
          store,
          "const layout = loadViews(ws.layout, editors.map((e) => e.id));",
          "const layout = ws.layout;",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("something the model did not produce: ws.layout"),
        "a workspace from another window brings its layout in unchecked",
      ]),
    );
  });

  it("an editor mounted per zone, or made anew when the terminal reconnects", () => {
    const perZone = mutate(
      page,
      "{#each ws.editors as ed (ed.id)}\n                  {@const zone = paneOf(views, ed.id)}",
      "{#each panes(views) as z (z.id)}{#each ws.editors as ed (ed.id)}\n                  {@const zone = paneOf(views, ed.id)}",
    );
    expect(pageViolations(perZone)).toEqual([
      expect.stringContaining("depends on more than its connection's documents"),
    ]);
    const keyed = mutate(
      page,
      "{#each ws.editors as ed (ed.id)}\n                  {@const zone = paneOf(views, ed.id)}",
      "{#key tab.gen}{#each ws.editors as ed (ed.id)}\n                  {@const zone = paneOf(views, ed.id)}",
    );
    expect(pageViolations(keyed)).toEqual([
      expect.stringContaining("depends on more than its connection's documents"),
    ]);
    expect(pageViolations(mutate(page, "<EditorTab", "<EditorTab />\n<EditorTab"))).toEqual([
      expect.stringContaining("rendered in 2 places"),
    ]);
  });

  it("a view placed anywhere but over its zone, or shown when its zone shows another", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "style={rectStyle(zone ? vp.panes[zone.id] : undefined, vb, VIEW_STRIP)}",
          "style={rectStyle(undefined, vb, VIEW_STRIP)}",
        ),
      ),
    ).toEqual(["a file is not placed over the zone that holds it"]);
    expect(
      pageViolations(
        mutate(
          page,
          "style={rectStyle(termZone ? vp.panes[termZone.id] : undefined, vb, hasFiles ? VIEW_STRIP : 0)}",
          "style={rectStyle(termZone ? vp.panes[termZone.id] : undefined, vb, VIEW_STRIP)}",
        ),
      ),
    ).toEqual(["the terminal is not placed over its zone, or keeps a strip's room with no strip"]);
    expect(
      pageViolations(
        mutate(
          page,
          "class=\"absolute flex flex-col {zone?.active === ed.id ? '' : 'invisible'}\"",
          'class="absolute flex flex-col"',
        ),
      ),
    ).toEqual(["a file is shown whether or not its zone shows it"]);
    expect(
      pageViolations(
        mutate(
          page,
          "class=\"absolute flex flex-col {terminalShown(views) ? '' : 'invisible'}\"",
          'class="absolute flex flex-col"',
        ),
      ),
    ).toEqual(["the terminal is shown whether or not its zone shows it"]);
  });

  it("a strip of views over a terminal that has no files", () => {
    expect(
      pageViolations(mutate(page, "{#if hasFiles}\n", "{#if true}\n")),
    ).toEqual(["a connection with no file open carries a strip of views"]);
  });

  it("a recording that runs, or a login question asked, behind a file", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "onScreenSessions([...shownIds], (id) => terminalShown(getWorkspace(id).layout))",
          "onScreenSessions([...shownIds], () => true)",
        ),
      ),
    ).toEqual(["a connection showing a file counts as a terminal on screen"]);
  });

  it("unsaved edits closed without their question", () => {
    expect(
      pageViolations(
        mutate(
          page,
          "if (!hasUnsaved(getWorkspace(tab.sessionId))) closeTabFully(tab.sessionId);",
          "closeTabFully(tab.sessionId);",
        ),
      ),
    ).toEqual(["a bulk close takes a connection's unsaved edits with it"]);
    expect(
      pageViolations(
        mutate(page, "if (tab.sessionId !== keep) closeInBulk(tab);", "if (tab.sessionId !== keep) closeTabFully(tab.sessionId);"),
      ),
    ).toEqual(["closeOtherTabs closes connections without asking closeInBulk"]);
    expect(
      pageViolations(
        mutate(
          page,
          "isLive(tab.status) || hasUnsaved(getWorkspace(sessionId))",
          "isLive(tab.status)",
        ),
      ),
    ).toEqual(["a dead connection with unsaved edits closes without a question"]);
  });

  // ── 8: the drag ────────────────────────────────────────────────────────────
  const drag = raw(VIEWDRAG);

  it("a view that moves before it is let go of", () => {
    expect(
      dragViolations(
        mutate(
          drag,
          "  offer(offered ? hit : null);",
          "  offer(offered ? hit : null);\n  if (offered) dropSessionView(candidate.session, candidate.view, hit.drop);",
        ),
        page,
      ),
    ).toEqual(
      expect.arrayContaining([
        "a view's drop is not committed exactly once, on release",
        "onMove changes the layout",
      ]),
    );
    expect(
      dragViolations(mutate(drag, "  if (over) dropSessionView(session, view, over);\n", ""), page),
    ).toEqual(["a view's drop is not committed exactly once, on release"]);
  });

  it("a view that can be dropped on another connection", () => {
    const gone = "a view can be dropped outside the connection it belongs to";
    expect(
      dragViolations(
        mutate(drag, "  if (!home || home.dataset.viewsOf !== session) return null;\n", ""),
        page,
      ),
    ).toEqual([gone]);
    // Any connection's area is not this view's own.
    expect(
      dragViolations(
        mutate(
          drag,
          "  if (!home || home.dataset.viewsOf !== session) return null;\n",
          "  if (!home) return null;\n",
        ),
        page,
      ),
    ).toEqual([gone]);
    // Asked after a target was already found is asked too late.
    const late = mutate(
      mutate(drag, "  if (!home || home.dataset.viewsOf !== session) return null;\n", ""),
      "  const body = el?.closest<HTMLElement>(\"[data-zone-body]\");",
      "  if (!home || home.dataset.viewsOf !== session) return null;\n  const body = el?.closest<HTMLElement>(\"[data-zone-body]\");",
    );
    expect(dragViolations(late, page)).toEqual([gone]);
  });

  it("a strip hit-tested against drawn boxes", () => {
    expect(
      dragViolations(
        mutate(
          drag,
          "const box = layoutBox(v);\n        return { start: box.left, size: box.width };",
          "const box = v.getBoundingClientRect();\n        return { start: box.left, size: box.width };",
        ),
        page,
      ),
    ).toEqual(
      expect.arrayContaining([
        "a strip's slot is not decided from layout boxes",
        "a strip is hit-tested against drawn boxes — a sliding neighbour swaps straight back",
      ]),
    );
  });

  it("a target that changes nothing, offered all the same", () => {
    expect(
      dragViolations(
        mutate(
          drag,
          "hit !== null && dropChanges(getWorkspace(candidate.session).layout, candidate.view, hit.drop);",
          "hit !== null;",
        ),
        page,
      ),
    ).toEqual(["a drop that would change nothing is offered as a target"]);
  });

  it("a label that follows the pointer out, a strip that shows no preview, a half that is not shown", () => {
    expect(
      dragViolations(
        drag,
        mutate(
          page,
          "{@const at = confinedGhost(viewDrag.x, viewDrag.y, viewDrag.area, viewGhost)}",
          "{@const at = { x: viewDrag.x + 12, y: viewDrag.y + 8 }}",
        ),
      ),
    ).toEqual(["the label of a dragged view follows the pointer out of its connection"]);
    expect(
      dragViolations(
        drag,
        mutate(
          page,
          "{#each viewDrag.session === tab.sessionId ? previewTabs(views, zone.id, viewDrag.view, viewDrag.over) : zone.tabs as view (view)}",
          "{#each zone.tabs as view (view)}",
        ),
      ),
    ).toEqual(["a zone's strip does not draw the preview of the drop"]);
    expect(
      dragViolations(
        drag,
        mutate(
          page,
          "const dropZone = $derived(tabDrag.zone ?? incoming.zone ?? viewDrag.zone);",
          "const dropZone = $derived(tabDrag.zone ?? incoming.zone);",
        ),
      ),
    ).toEqual(["the half of a zone a dragged view would take is not shown"]);
    expect(
      dragViolations(drag, mutate(page, "                data-views-of={tab.sessionId}\n", "")),
    ).toEqual(["a connection's area is not marked — a view has nothing to stay inside"]);
  });

  it("is not satisfied by a comment that only names the markers", () => {
    const gutted = mutate(
      page,
      "style={rectStyle(zone ? vp.panes[zone.id] : undefined, vb, VIEW_STRIP)}",
      "<!-- style={rectStyle(zone ? vp.panes[zone.id] : undefined, vb, VIEW_STRIP)} -->",
    );
    expect(pageViolations(gutted)).toContain("a file is not placed over the zone that holds it");
  });
});
