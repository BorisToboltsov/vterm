// The page of the floating label over the desktop (`static/ghost.html`, ADR 0018):
// a copy of the dragged tab since v1.36. It is told how to look by the backend
// (`dragghost::show` → `setGhost`) and is a picture — so what it is told lands
// as text, a part the tab does not have is not drawn, and the tab's font and
// colours are the ones it is given.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), "static", name), "utf8");
const page = read("ghost.html");
const script = read("ghost.js");

type Ghost = (look: Record<string, unknown>) => void;

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = page.slice(page.indexOf("<body>") + "<body>".length, page.lastIndexOf("</body>"));
  // The script as the page runs it: one global function.
  window.eval(script);
});

const set: Ghost = (look) => (window as unknown as { setGhost: Ghost }).setGhost(look);
const el = (id: string) => document.getElementById(id) as HTMLElement;

describe("the floating label", () => {
  it("is the tab: its name, a container's host, the prod chip, its font and colours", () => {
    set({
      title: "nginx",
      sub: "· web-01",
      chip: "prod",
      chipFg: "#ef5350",
      bg: "#0f1622",
      accent: "#ef5350",
      dot: "#4caf50",
      font: "15.4px / 22px Inter, sans-serif",
    });
    expect([el("title").textContent, el("sub").textContent, el("chip").textContent]).toEqual(["nginx", "· web-01", "prod"]);
    expect([el("sub").hidden, el("chip").hidden]).toEqual([false, false]);
    expect(el("tab").style.font).toContain("15.4px");
    const root = document.documentElement.style;
    expect([root.getPropertyValue("--accent"), root.getPropertyValue("--chip-fg")]).toEqual(["#ef5350", "#ef5350"]);
  });

  it("draws no part the tab does not have — a label of files, a tab of a page of an older build", () => {
    set({ title: "web-01 +2", accent: "#5b9bd5" });
    expect([el("sub").hidden, el("chip").hidden]).toEqual([true, true]);
    expect(el("tab").style.font).toBe("");
  });

  it("takes what it is told as text, never as markup", () => {
    set({ title: '<img src=x onerror="alert(1)">', sub: "<b>host</b>" });
    expect(el("title").textContent).toBe('<img src=x onerror="alert(1)">');
    expect(el("tab").querySelector("img, b")).toBeNull();
  });
});
