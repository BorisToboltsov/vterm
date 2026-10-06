// Dock-layout guard (v1.1): the three contracts the dock model stands on.
//
//  1. A stored layout reaches the store only through `loadDocks`. `vterm.layout`
//     is user-writable (localStorage, a restored backup, an older or newer build);
//     a layout assigned straight from `JSON.parse` can name a panel twice or not
//     at all, and a panel that is in no dock cannot be brought back from the UI.
//  2. Two classes of tabs, never mixed (ADR 0015). Tool panels are rendered in
//     exactly one place — the snippet the page hands to the docks — so they move
//     between docks and nowhere else; terminals and editors are not panels.
//  3. A panel is told whether it is on screen, never which dock it is in. It
//     adapts to the space it has (container queries); branching on the side is
//     how a second, "horizontal" copy of every panel would start.
//  4. A panel hidden in settings is offered nowhere: not as a tab, not by ⌘K,
//     not by a button that opens it. One list (`settings.hiddenPanels`), written
//     in one place, read by everything that decides what a dock shows.
//  5. A dragged tab changes the layout once — when it is dropped. Until then the
//     strips only draw a preview, and what they hit-test is where tabs sit in
//     the layout, not where a slide is drawing them.
//
// Sources are read with comments stripped — the rationale above, and the
// comments in the components, name the anti-patterns in prose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { PANEL_IDS } from "./docklayout";

const SRC = join(process.cwd(), "src");
const LIB = join(SRC, "lib");
const PAGE = join(SRC, "routes", "+page.svelte");

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
function code(path: string): string {
  return stripHtmlComments(readFileSync(path, "utf8"))
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every non-test source file under `src/`, as a path relative to it (`/`-separated). */
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

const STORE = "lib/stores/layout.svelte.ts";
const MODEL = "lib/docklayout.ts";
const all = sources();
const read = (rel: string) => code(join(SRC, ...rel.split("/")));

/** The tool panels: everything a dock can hold. */
const SESSION_PANELS = ["SftpPanel", "LocalFilePanel", "GitPanel", "DockerPanel", "K8sPanel", "AiChat"];

describe("dock layout guard", () => {
  describe("a stored layout goes through loadDocks", () => {
    const store = read(STORE);

    it("the store parses storage only inside loadDocks", () => {
      const parses = store.match(/JSON\.parse\(/g) ?? [];
      expect(parses.length, "the layout store reads storage exactly once").toBe(1);
      expect(store).toMatch(/loadDocks\(\s*JSON\.parse\(\s*localStorage\.getItem\(STORAGE_KEY\)/);
    });

    it("the store's value is only ever a result of the pure model", () => {
      // `defaultDocks()` or `next` — the return of movePanel/revealPanel. Anything
      // else (a parsed object, a hand-built literal) skips the invariants.
      const assigned = [...store.matchAll(/layout\.docks\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(assigned.length).toBeGreaterThan(0);
      for (const rhs of assigned) expect(rhs).toMatch(/^(?:defaultDocks\(\)|next)$/);
      expect(store).toMatch(/\$state<\{ docks: Docks \}>\(\{ docks: load\(\) \}\)/);
    });

    it("nothing else reads or replaces the layout", () => {
      for (const rel of all) {
        if (rel === STORE || rel === MODEL) continue;
        const src = read(rel);
        expect(src, `${rel} reads the stored layout itself`).not.toMatch(/["'`]vterm\.layout["'`]/);
        expect(src, `${rel} replaces the layout`).not.toMatch(/layout\.docks\s*=[^=]/);
        // Reordering or re-homing a panel is `movePanel`'s job: it keeps every
        // panel in exactly one dock.
        expect(src, `${rel} edits a dock's panel list`).not.toMatch(
          /\.panels\s*(?:=[^=]|\.(?:push|splice|pop|shift|unshift|sort|reverse)\()/,
        );
      }
    });
  });

  describe("two classes of tabs", () => {
    it("the tool panels are the six the model names — no terminal, no editor", () => {
      expect([...PANEL_IDS].sort()).toEqual(["ai", "docker", "files", "git", "k8s", "servers"]);
    });

    it("a session panel is rendered by DockPanel and nowhere else", () => {
      for (const rel of all.filter((f) => f.endsWith(".svelte"))) {
        const src = read(rel);
        for (const panel of SESSION_PANELS) {
          if (!new RegExp(`<${panel}\\b`).test(src)) continue;
          expect(rel, `<${panel}> rendered outside the dock`).toBe("lib/DockPanel.svelte");
        }
      }
    });

    it("the page renders tool panels only inside the snippet it hands to the docks", () => {
      const page = code(PAGE);
      const start = page.indexOf("{#snippet dockPanel(");
      expect(start, "the dockPanel snippet exists").toBeGreaterThan(-1);
      const end = page.indexOf("{/snippet}", start);
      const outside = page.slice(0, start) + page.slice(end);
      expect(outside).not.toMatch(/<(?:DockPanel|ServerTree)\b/);
      expect(page.slice(start, end)).toMatch(/<DockPanel\b/);
      expect(page.slice(start, end)).toMatch(/<ServerTree\b/);
      // …and no other component renders them behind the page's back.
      for (const rel of all.filter((f) => f.endsWith(".svelte") && f !== "routes/+page.svelte")) {
        expect(read(rel), `${rel} renders a tool panel`).not.toMatch(/<(?:DockPanel|ServerTree)\b/);
      }
      // Every dock gets that one snippet.
      const docks = [...page.matchAll(/<Dock\b[^>]*>/g)].map((m) => m[0]);
      expect(docks).toHaveLength(3);
      for (const tag of docks) expect(tag).toMatch(/panel=\{dockPanel\}/);
      for (const side of ["left", "right", "bottom"]) {
        expect(docks.some((tag) => tag.includes(`side="${side}"`)), `${side} dock`).toBe(true);
      }
    });
  });

  describe("a panel does not know its dock", () => {
    it("the dock hands a panel its id and whether it is on screen — nothing else", () => {
      expect(read("lib/Dock.svelte")).toMatch(/panel:\s*Snippet<\[PanelId,\s*boolean\]>/);
      expect(code(PAGE)).toMatch(/\{#snippet dockPanel\(id: PanelId, visible: boolean\)\}/);
    });

    it("no panel reads the layout or the dock model", () => {
      const panels = all.filter((f) =>
        /^lib\/(?:DockPanel|ServerTree|SftpPanel|LocalFilePanel|FileBrowser|AiChat|Git\w*|Docker\w*|K8s\w*)\.svelte$/.test(
          f,
        ),
      );
      // The panels that must be covered are all there (a rename would hollow the check).
      for (const name of [...SESSION_PANELS, "ServerTree", "FileBrowser", "DockerContainers", "K8sPods"]) {
        expect(panels, `${name} is checked`).toContain(`lib/${name}.svelte`);
      }
      for (const rel of panels) {
        const src = read(rel);
        expect(src, `${rel} reads the layout store`).not.toMatch(/stores\/layout\.svelte/);
        if (rel !== "lib/DockPanel.svelte") {
          expect(src, `${rel} reads the dock model`).not.toMatch(/["']\.\/docklayout["']/);
        }
        expect(src, `${rel} is told its dock side`).not.toMatch(/\bDockSide\b|\bside\s*[:=]/);
      }
    });
  });

  describe("a hidden panel is offered nowhere", () => {
    it("the hidden list is written only by setPanelHidden and the settings loader", () => {
      for (const rel of all) {
        if (rel === "lib/settings.svelte.ts" || rel === STORE) continue;
        expect(read(rel), `${rel} writes settings.hiddenPanels itself`).not.toMatch(
          /\bhiddenPanels\s*(?:=[^=]|\.(?:push|splice|pop|shift|unshift)\()/,
        );
      }
      // The store's one write goes through the model, which refuses the server tree.
      const store = read(STORE);
      const writes = store.match(/settings\.hiddenPanels\s*=[^=]/g) ?? [];
      expect(writes).toHaveLength(1);
      expect(store).toMatch(/const next = withPanelHidden\(settings\.hiddenPanels, panel, hidden\)/);
      // …and both ways into the setting from storage are sanitized.
      const settingsSrc = read("lib/settings.svelte.ts");
      expect(settingsSrc).toMatch(/hiddenPanels:\s*sanitizeHiddenPanels\(raw\.hiddenPanels\)/);
      expect(settingsSrc).toMatch(/next\.hiddenPanels\s*=\s*sanitizeHiddenPanels\(r\.hiddenPanels\)/);
    });

    it("everything that asks what a dock shows passes the hidden list", () => {
      // A call without it would bring a hidden panel back in that one place — a
      // tab in one dock, a command in the palette, the poll for a panel nobody sees.
      const asks = /\b(availablePanels|shownPanel|isPanelShown|offeredPanels)\(([^;{}]*?)\)[;,)\n\s]/g;
      let seen = 0;
      for (const rel of all) {
        if (rel === MODEL) continue;
        for (const m of read(rel).matchAll(asks)) {
          seen += 1;
          expect(m[2], `${rel}: ${m[1]}(${m[2]}) ignores hidden panels`).toMatch(/\bhidden(?:Panels)?\b/);
        }
      }
      expect(seen, "the dock and the page were found asking").toBeGreaterThanOrEqual(5);
    });

    it("revealing a panel checks the list first", () => {
      const store = read(STORE);
      const at = store.indexOf("export function revealPanel(");
      expect(at).toBeGreaterThan(-1);
      const body = store.slice(at, store.indexOf("\n}", at));
      expect(body).toMatch(/if \(isPanelHidden\(panel\)\) return;/);
      expect(body.indexOf("isPanelHidden")).toBeLessThan(body.indexOf("revealPanelIn("));
    });

    it("the assistant's entry points switch off with its panel", () => {
      const page = code(PAGE);
      // One flag gates them all (the terminal's "ask AI", Docker, k8s, metrics).
      expect(page).toMatch(
        /const aiOn = \$derived\(aiReady\(settings\.ai\) && !isPanelHidden\("ai"\)\)/,
      );
      // …and nothing reaches the readiness check around that flag.
      expect(page.match(/aiReady\(/g) ?? []).toHaveLength(1);
    });

    it("the palette offers a hidden panel only as 'show'", () => {
      const page = code(PAGE);
      expect(page).toMatch(/PANEL_IDS\.filter\(isPanelHidden\)\.map\(/);
      expect(page).toMatch(/PANEL_IDS\.filter\(\(id\) => !isPanelHidden\(id\)\)\.flatMap\(/);
      for (const panel of ["files", "ai"]) {
        expect(page, `the ${panel} command is skipped while hidden`).toMatch(
          new RegExp(`isPanelHidden\\("${panel}"\\) \\? \\[\\] : \\[\\{ id: "act:toggle-`),
        );
      }
    });
  });

  describe("a dragged tab moves the layout once", () => {
    const drag = read("lib/stores/dockdrag.svelte.ts");
    /** Body of a top-level function of the drag store. */
    const fn = (name: string) => {
      const at = drag.indexOf(`function ${name}(`);
      expect(at, `${name} exists`).toBeGreaterThan(-1);
      return drag.slice(at, drag.indexOf("\n}\n", at));
    };

    it("commits only on release", () => {
      expect(drag.match(/\bmovePanel\(/g) ?? []).toHaveLength(1);
      expect(fn("onUp")).toMatch(/\bmovePanel\(panel, over\.side, over\.index\)/);
      for (const name of ["onMove", "dockDropAt", "beginPanelDrag", "onCancel"]) {
        expect(fn(name), `${name} changes the layout`).not.toMatch(/movePanel\(|layout\.docks\s*=/);
      }
    });

    it("the strips draw a preview of the drop, not the store", () => {
      const dock = read("lib/Dock.svelte");
      expect(dock).toMatch(/previewPanels\(layout\.docks, dockDrag\.panel, dockDrag\.over\)\[side\]/);
      // Both the strip and the rail iterate the preview; the panels below do not.
      expect(dock.match(/\{#each stripTabs as id \(id\)\}/g) ?? []).toHaveLength(2);
      expect(dock).toMatch(/\{#each panes as id \(paneKey\(id\)\)\s*\}/);
      expect(dock).toMatch(/const panes = \$derived\(\s*tabs\.filter\(/);
    });

    it("hit-tests where tabs sit, not where a slide draws them", () => {
      // Every strip that slides its tabs (`animate:glide`) has to decide the drop
      // from layout boxes. A neighbour that is still gliding away is under the
      // pointer for the length of its animation, and gets swapped straight back.
      const sliding = all.filter((f) => f.endsWith(".svelte") && /\banimate:glide\b/.test(read(f)));
      expect(sliding.sort()).toEqual(["lib/Dock.svelte", "routes/+page.svelte"]);

      const hit = fn("dockDropAt");
      expect(hit).toMatch(/layoutBox\(tab\)/);
      expect(hit).not.toMatch(/getBoundingClientRect/);

      const page = code(PAGE);
      const at = page.indexOf("function barPointerMove(");
      expect(at).toBeGreaterThan(-1);
      const bar = page.slice(at, page.indexOf("\n  }\n", at));
      expect(bar).toMatch(/layoutBox\(el\)/);
      expect(bar).toMatch(/moveTab\(dragSession, slotIndex\(/);
      expect(bar).not.toMatch(/getBoundingClientRect/);
    });
  });
});
