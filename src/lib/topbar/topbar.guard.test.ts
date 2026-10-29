// Top-bar guard (v1.16): the bar's buttons are the user's list, and three
// things about that list hold whatever is done to it.
//
// The bar used to be seven fixed buttons; now a button can be taken off, a tool
// of the Utilities panel put on, and the order changed by dragging. Each of the
// rules below is one a later edit breaks without anything looking wrong:
//
//  1. One list, one writer. `settings.topbar` is assigned only in
//     `stores/topbarpins.svelte.ts`, and only the result of a function of the
//     pure model; nobody edits it in place; storage and a backup reach it only
//     through `sanitizeTopbar`. A list written by hand is how Settings gets
//     lost — and with it the way to put anything back.
//  2. The bar draws what the model says. Its buttons come from `shownTopbar`
//     and `fitTopbar`, with `mustShow` deciding what cannot go under «⋯». A
//     button hidden by a condition in the markup is how a running recording
//     stops being visible.
//  3. A drag changes the list once — on release. The store that follows the
//     pointer writes a target, not the list; the list is moved by one call in
//     `onUp`. And the slot is found by layout boxes, not drawn ones: a
//     neighbour still sliding away must already count as moved.
//  4. What is taken off the bar is still found. Broadcast and the server notes
//     had no way in but their buttons, so a button that can be taken off must
//     leave its action somewhere: the Utilities window lists every session
//     action (from the registry, with the page's state and the page's runner),
//     its own button cannot be taken off, and the two that had nothing else
//     have a command in the palette.
//
// Every check is a function over source text, so that the same file can show it
// catches the violation it exists for. Sources are read with comments stripped.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const PINS = "lib/stores/topbarpins.svelte.ts";
const DRAG = "lib/stores/topbardrag.svelte.ts";
const BAR = "lib/topbar/TopBar.svelte";
const SETTINGS = "lib/settings/settings.svelte.ts";
const PAGE = "routes/+page.svelte";
const WINDOW = "lib/utilities/UtilitiesPanel.svelte";
const MODEL = "lib/topbar/topbaractions.ts";

/** Drop every `open … close` block by scanning (one regex pass leaves a nested opener behind). */
function stripBlocks(src: string, open: string, close: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(open, i)) {
      const end = src.indexOf(close, i + open.length);
      i = end < 0 ? src.length : end + close.length;
      continue;
    }
    out += src[i++];
  }
  return out;
}

/** Source with comments removed — HTML, block and line (`://` is not a comment). */
function code(src: string): string {
  return stripBlocks(src, "<!--", "-->")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every non-test source under `src/`, as a path relative to it → its source. */
function sources(dir = SRC, acc: Record<string, string> = {}): Record<string, string> {
  // What an entry is comes with the listing, not from asking the path again.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, acc);
    else if (/\.(svelte|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      acc[relative(SRC, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  }
  return acc;
}

/** Body of `function name(…) { … }`, up to the next top-level function or export. */
function fn(text: string, name: string): string {
  const at = text.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return "";
  const rest = text.slice(at + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function |\nexport const /);
  return text.slice(at, next < 0 ? undefined : at + 1 + next);
}

// ── 1: one list, one writer ─────────────────────────────────────────────────

const ASSIGNS = /\b(?:settings|next|sink)\.topbar\s*=(?!=)/;
const MUTATES = /\.topbar\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\(|\.topbar\[[^\]]+\]\s*=(?!=)|\.topbar\.length\s*=/;

export function listViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, source] of Object.entries(files)) {
    const c = code(source);
    if (MUTATES.test(c)) out.push(`${rel} edits the top-bar list in place`);
    if (rel !== PINS && rel !== SETTINGS && ASSIGNS.test(c)) out.push(`${rel} writes settings.topbar itself`);
  }
  const pins = code(files[PINS] ?? "");
  const writes = pins.match(/settings\.topbar\s*=(?!=)[^;]*;/g) ?? [];
  if (writes.length === 0) out.push(`${PINS} no longer writes the list`);
  // Every write hands the list `next`, and every `next` is the model's answer.
  for (const w of writes) {
    if (!/^settings\.topbar\s*=\s*next;$/.test(w)) out.push(`${PINS}: \`${w}\` is not the result of the model`);
  }
  const made = pins.match(/const next = [^;]*;/g) ?? [];
  for (const m of made) {
    if (!/^const next = (?:withPinned|withUnpinned|moveTopbar)\(settings\.topbar, |^const next = \[\.\.\.DEFAULT_TOPBAR\];$/.test(m)) {
      out.push(`${PINS}: \`${m}\` builds the list outside the model`);
    }
  }
  const settings = code(files[SETTINGS] ?? "");
  if (!/topbar:\s*sanitizeTopbar\(raw\.topbar\)/.test(settings)) {
    out.push("the stored list is not read through sanitizeTopbar");
  }
  if (!/next\.topbar = sanitizeTopbar\(r\.topbar\);/.test(settings)) {
    out.push("an imported list is not read through sanitizeTopbar");
  }
  // In the settings store the list is only ever a default or a sanitized value.
  for (const m of settings.match(/\btopbar\s*[:=](?!=)\s*[^,;\n]+/g) ?? []) {
    if (!/sanitizeTopbar\(|\[\.\.\.DEFAULT_TOPBAR\]|TopbarId\[\]/.test(m)) {
      out.push(`${SETTINGS}: \`${m.trim()}\` gives the list a value of its own`);
    }
  }
  return out;
}

// ── 2: the bar draws what the model says ────────────────────────────────────

export function barViolations(bar: string): string[] {
  const c = code(bar);
  const out: string[] = [];
  if (!/const all = \$derived\(shownTopbar\(order, barState\)\);/.test(c)) {
    out.push("what the bar shows does not come from shownTopbar");
  }
  if (!/const order = \$derived\(previewTopbar\(settings\.topbar, topbarDrag\.id, topbarDrag\.over\)\);/.test(c)) {
    out.push("the bar does not draw the order a drop would give");
  }
  const fit = /const fit = \$derived\(\s*fitTopbar\(([^]*?)\),\s*\);/.exec(c)?.[1] ?? "";
  if (!fit) out.push("what fits is not decided by fitTopbar");
  else if (!/\(id\) => mustShow\(id, barState\)/.test(fit)) {
    out.push("a button that must be seen can go under the menu");
  }
  const markup = c.slice(c.lastIndexOf("</script>"));
  if (!/\{#each visible as a \(a\.id\)\}/.test(markup) || (markup.match(/\{#each /g) ?? []).length !== 1) {
    out.push("the bar's buttons are not one list drawn from the model");
  }
  // The wrapper of a button carries no condition of its own on what is shown.
  if (/\{#if (?:recording|broadcastActive|showNotes|canRecord|connected)\b/.test(markup)) {
    out.push("a button of the bar is hidden by a condition in the markup");
  }
  return out;
}

// ── 3: a drag moves the list once, by layout boxes ──────────────────────────

export function dragViolations(drag: string): string[] {
  const c = code(drag);
  const out: string[] = [];
  const calls = c.match(/\bmoveAction\(/g)?.length ?? 0;
  if (calls !== 1 || !/if \(over !== null\) moveAction\(id, over\);/.test(fn(c, "onUp"))) {
    out.push("the list is not moved exactly once, on release");
  }
  if (/\bmoveAction\(|\bpinAction\(|\bunpinAction\(/.test(fn(c, "onMove"))) {
    out.push("a pointer move changes the list");
  }
  const drop = fn(c, "topbarDropAt");
  if (!/layoutBox\(el\)/.test(drop) || /getBoundingClientRect\(/.test(drop)) {
    out.push("the slot is found by drawn boxes, not layout ones");
  }
  if (!/return topbarSlot\(x, boxes\);/.test(drop)) out.push("where a drop lands is not the model's answer");
  return out;
}

// ── 4: what is taken off the bar is still found ─────────────────────────────

export function reachViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  const page = code(files[PAGE] ?? "");
  const mount = /<UtilitiesPanel\b[^]*?\/>/.exec(page)?.[0] ?? "";
  if (!/\bactions=\{sessionActions\}/.test(mount) || !/\bonSessionAction=\{runSessionAction\}/.test(mount)) {
    out.push("the Utilities window is not given the session actions and the way to run them");
  }
  // One runner, and the compiler checks it covers every action.
  if (!/const SESSION_RUN: Record<SessionAction, \(\) => void> = \{/.test(page)) {
    out.push("the session actions are not run through a record the compiler checks");
  }
  for (const id of ["act:broadcast", "act:notes"]) {
    if (!new RegExp(`id: "${id}"`).test(page)) out.push(`the palette has no command for ${id}`);
  }
  const win = code(files[WINDOW] ?? "");
  if (
    !/const visibleActions = \$derived\(actions \? sessionActionsMatching\(search\) : \[\]\);/.test(win) ||
    !/\{#each visibleActions as a \(a\.id\)\}/.test(win)
  ) {
    out.push("the Utilities window does not list the session actions from the registry");
  }
  if (!/onSessionAction\?\.\(id\);/.test(win)) out.push("the Utilities window does not run a session action");
  // The window's own button is one of the two the bar is never without.
  const model = code(files[MODEL] ?? "");
  if (!/export const ANCHORS = \["utilities", "settings"\] as const/.test(model)) {
    out.push("the Utilities button can be taken off the bar");
  }
  if (!/for \(const id of ANCHORS\) if \(!out\.includes\(id\)\) out\.push\(id\);/.test(fn(model, "sanitizeTopbar"))) {
    out.push("a stored list that lost an anchor is not given it back");
  }
  return out;
}

describe("top-bar guard", () => {
  const all = sources();

  it("what is taken off the bar is still found in the Utilities window", () => {
    expect(reachViolations(all)).toEqual([]);
  });

  it("the list has one writer, and every value it is given is the model's", () => {
    expect(listViolations(all)).toEqual([]);
  });

  it("the bar draws what the model says", () => {
    expect(barViolations(all[BAR])).toEqual([]);
  });

  it("a drag moves the list once, on release, and aims by layout boxes", () => {
    expect(dragViolations(all[DRAG])).toEqual([]);
  });
});

describe("top-bar guard — catches what it exists for", () => {
  const all = sources();
  const withSource = (rel: string, source: string) => ({ ...all, [rel]: source });
  /** `src` with `from` replaced — failing loudly when `from` is not there to replace. */
  const mutate = (src: string, from: string, to: string): string => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("the Utilities window left without the session actions", () => {
    const blind = mutate(all[PAGE], "  actions={sessionActions}\n", "");
    expect(reachViolations(withSource(PAGE, blind))).toEqual([
      "the Utilities window is not given the session actions and the way to run them",
    ]);
    const mute = mutate(all[PAGE], "  onSessionAction={runSessionAction}\n", "");
    expect(reachViolations(withSource(PAGE, mute))).toEqual([
      "the Utilities window is not given the session actions and the way to run them",
    ]);
  });

  it("a session action with no command and no row", () => {
    const noCommand = mutate(all[PAGE], '[{ id: "act:notes",', '[{ id: "act:server-notes-removed",');
    expect(reachViolations(withSource(PAGE, noCommand))).toEqual(["the palette has no command for act:notes"]);
    const noRows = mutate(all[WINDOW], "{#each visibleActions as a (a.id)}", "{#each [] as a (a.id)}");
    expect(reachViolations(withSource(WINDOW, noRows))).toEqual([
      "the Utilities window does not list the session actions from the registry",
    ]);
  });

  it("the Utilities button made removable again", () => {
    const loose = mutate(
      all[MODEL],
      'export const ANCHORS = ["utilities", "settings"] as const',
      'export const ANCHORS = ["settings"] as const',
    );
    expect(reachViolations(withSource(MODEL, loose))).toEqual(["the Utilities button can be taken off the bar"]);
  });

  it("a runner that can miss an action", () => {
    const loose = mutate(
      all[PAGE],
      "const SESSION_RUN: Record<SessionAction, () => void> = {",
      "const SESSION_RUN: Partial<Record<SessionAction, () => void>> = {",
    );
    expect(reachViolations(withSource(PAGE, loose))).toEqual([
      "the session actions are not run through a record the compiler checks",
    ]);
  });

  it("a component that writes the list itself", () => {
    const rel = "lib/topbar/TopbarSettings.svelte";
    const broken = mutate(
      all[rel],
      "const toggle = (id: TopbarId, on: boolean) => (on ? pinAction(id) : unpinAction(id));",
      "const toggle = (id: TopbarId, on: boolean) => (settings.topbar = on ? [...settings.topbar, id] : settings.topbar.filter((x) => x !== id));",
    );
    expect(listViolations(withSource(rel, broken))).toEqual([`${rel} writes settings.topbar itself`]);
  });

  it("the list edited in place", () => {
    const broken = mutate(
      all[PINS],
      "  const next = withPinned(settings.topbar, id);\n  if (differs(next)) settings.topbar = next;",
      "  settings.topbar.push(id);",
    );
    expect(listViolations(withSource(PINS, broken))).toEqual([`${PINS} edits the top-bar list in place`]);
  });

  it("a list built outside the model — Settings can be filtered away", () => {
    const broken = mutate(
      all[PINS],
      "const next = withUnpinned(settings.topbar, id);",
      "const next = settings.topbar.filter((x) => x !== id);",
    );
    expect(listViolations(withSource(PINS, broken))).toEqual([
      `${PINS}: \`const next = settings.topbar.filter((x) => x !== id);\` builds the list outside the model`,
    ]);
  });

  it("a stored list taken as it is", () => {
    const stored = mutate(all[SETTINGS], "topbar: sanitizeTopbar(raw.topbar),", "topbar: raw.topbar,");
    expect(listViolations(withSource(SETTINGS, stored))).toEqual([
      "the stored list is not read through sanitizeTopbar",
      `${SETTINGS}: \`topbar: raw.topbar\` gives the list a value of its own`,
    ]);
    const imported = mutate(all[SETTINGS], "next.topbar = sanitizeTopbar(r.topbar);", "next.topbar = r.topbar as TopbarId[];");
    expect(listViolations(withSource(SETTINGS, imported))[0]).toBe("an imported list is not read through sanitizeTopbar");
  });

  it("a rule named only in a comment", () => {
    const broken = mutate(
      all[SETTINGS],
      "topbar: sanitizeTopbar(raw.topbar),",
      "// topbar: sanitizeTopbar(raw.topbar),\n      topbar: raw.topbar,",
    );
    expect(listViolations(withSource(SETTINGS, broken))).toContain("the stored list is not read through sanitizeTopbar");
  });

  it("a running recording allowed under the menu", () => {
    const broken = mutate(all[BAR], "(id) => mustShow(id, barState),", '(id) => id === "settings",');
    expect(barViolations(broken)).toEqual(["a button that must be seen can go under the menu"]);
  });

  it("the bar drawn from the list directly, past the model", () => {
    const broken = mutate(
      all[BAR],
      "const all = $derived(shownTopbar(order, barState));",
      "const all = $derived(order.map((id) => ({ id, pinned: true })));",
    );
    expect(barViolations(broken)).toEqual(["what the bar shows does not come from shownTopbar"]);
  });

  it("a button hidden by a condition in the markup", () => {
    const broken = mutate(
      all[BAR],
      "        {@render button(a.id)}",
      "        {#if recording || a.id !== \"record\"}{@render button(a.id)}{/if}",
    );
    expect(barViolations(broken)).toEqual(["a button of the bar is hidden by a condition in the markup"]);
  });

  it("the list moved on every pointer move", () => {
    const broken = mutate(
      all[DRAG],
      "  if (!sameSlot(topbarDrag.over, next)) topbarDrag.over = next;",
      "  if (!sameSlot(topbarDrag.over, next)) topbarDrag.over = next;\n  if (next !== null) moveAction(candidate.id, next);",
    );
    expect(dragViolations(broken)).toEqual([
      "the list is not moved exactly once, on release",
      "a pointer move changes the list",
    ]);
  });

  it("a release that moves nothing", () => {
    const broken = mutate(all[DRAG], "  if (over !== null) moveAction(id, over);\n", "");
    expect(dragViolations(broken)).toEqual(["the list is not moved exactly once, on release"]);
  });

  it("the slot found by where the buttons are drawn", () => {
    const broken = mutate(all[DRAG], "const box = layoutBox(el);", "const box = el.getBoundingClientRect();");
    expect(dragViolations(broken)).toEqual(["the slot is found by drawn boxes, not layout ones"]);
  });
});
