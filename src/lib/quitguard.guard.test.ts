import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The close guard is armed only once someone listens for the question.
//
// Armed, the backend vetoes this window's close (for the main window: every quit)
// and asks the frontend instead (QuitDialog). If the guard were armed before the
// listener exists — or from a second place that has no listener at all — a close
// request would be swallowed with nobody to answer it, and the window could not
// be closed short of killing the process. So `armCloseGuard()` may be called in
// exactly one place: the `.then` of the subscription to the question — which is
// `menu://quit` in the main window and `window://close` in a window a tab was
// moved out to (v1.3, ADR 0017). Checked on the source with JS comments
// stripped, so a comment cannot satisfy or trip it.

const SRC = join(process.cwd(), "src");
const PAGE = join(SRC, "routes", "+page.svelte");

/**
 * Drop `<!-- … -->` blocks by scanning, not with one non-greedy `.replace`: a
 * single pass leaves the opener of a nested comment behind (`<!--<!-- -->` →
 * `<!--`) — CodeQL's `js/incomplete-multi-character-sanitization`. Same as
 * termctxfocus.guard.test.ts.
 */
function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    out += text[i++];
  }
  return out;
}

function strip(src: string): string {
  return stripHtmlComments(src.replace(/\r\n/g, "\n"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
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

  it("is armed once, after the listener for the question is registered", () => {
    const page = strip(readFileSync(PAGE, "utf8"));
    const calls = page.match(/\barmCloseGuard\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    const listen = page.indexOf("listenHere(CLOSE_ASKED_EVENT");
    expect(listen, "no listener for the close question").toBeGreaterThan(-1);
    // The call sits in that subscription's `.then`, before the next statement.
    const tail = page.slice(listen, page.indexOf(";", page.indexOf("armCloseGuard()", listen)));
    expect(tail).toMatch(/^listenHere\(CLOSE_ASKED_EVENT[\s\S]*\.then\([\s\S]*armCloseGuard\(\)$/);
  });

  it("each window listens for its own question", () => {
    // The main window is asked to quit, any other one to close itself — the two
    // events the backend sends (`appwin.rs`). A window listening for the other
    // one would arm a guard it can never answer.
    const page = strip(readFileSync(PAGE, "utf8"));
    expect(page).toMatch(
      /const CLOSE_ASKED_EVENT = isMainWindow \? "menu:\/\/quit" : WINDOW_CLOSE_EVENT;/,
    );
    const api = strip(readFileSync(join(SRC, "lib", "api", "window.ts"), "utf8"));
    expect(api).toMatch(/export const WINDOW_CLOSE_EVENT = "window:\/\/close";/);
  });
});
