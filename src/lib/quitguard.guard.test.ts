import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The close guard is armed only once someone listens for `menu://quit`.
//
// Armed, the backend vetoes every window close and quit and asks the frontend
// instead (QuitDialog). If the guard were armed before the listener exists — or
// from a second place that has no listener at all — a close request would be
// swallowed with nobody to answer it, and the window could not be closed short of
// killing the process. So `armCloseGuard()` may be called in exactly one place:
// the `.then` of the `menu://quit` subscription. Checked on the source with JS
// comments stripped, so a comment cannot satisfy or trip it.

const SRC = join(process.cwd(), "src");
const PAGE = join(SRC, "routes", "+page.svelte");

function strip(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("close guard", () => {
  it("is armed only from the page", () => {
    // A call, not the wrapper's own `function armCloseGuard()` in api/core.ts.
    const callers = sourceFiles(SRC).filter((f) =>
      /(?<!function )\barmCloseGuard\(\)/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(callers).toEqual([PAGE]);
  });

  it("is armed once, after the menu://quit listener is registered", () => {
    const page = strip(readFileSync(PAGE, "utf8"));
    const calls = page.match(/\barmCloseGuard\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    const listen = page.indexOf('listen("menu://quit"');
    expect(listen, "no menu://quit listener").toBeGreaterThan(-1);
    // The call sits in that subscription's `.then`, before the next statement.
    const tail = page.slice(listen, page.indexOf(";", page.indexOf("armCloseGuard()", listen)));
    expect(tail).toMatch(/^listen\("menu:\/\/quit"[\s\S]*\.then\([\s\S]*armCloseGuard\(\)$/);
  });
});
