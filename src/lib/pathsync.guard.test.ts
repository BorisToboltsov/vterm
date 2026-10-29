import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Path sync per server (v1.23): the page's half. Turning sync on, the question,
// what a connect and an end do — the path-sync flow (page/pathsyncflow), held by
// its behaviour tests; following is its read-only state, so no path starts it
// past `start`. A stored answer is read through `pathSyncMode` and written from
// the question alone: lint rules `vterm/path-sync-mode` and `vterm/owned-imports`.
//
// What stays on the page is the session-status hook, and that is what this
// checks: what the tab runs of its own is read before its pending command is
// consumed — read after, the setup command would land in `port-forward` — a
// connected session is handed to the flow with it, and a closed one stops
// following. Each check is a function over the source with comments stripped,
// and shows it catches its own violation.

const PAGE = join(process.cwd(), "src", "routes", "+page.svelte");

/** Drop `<!-- … -->` blocks by scanning — one regex pass can leave a `<!--`
 *  behind (`<!--<!-- -->`); an unclosed comment drops the rest. */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("<!--", i);
    if (open < 0) return out + src.slice(i);
    out += src.slice(i, open);
    const close = src.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
  return out;
}

function strip(src: string): string {
  return stripHtmlComments(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const read = (p: string) => strip(readFileSync(p, "utf8"));

/** The connect hook: what the tab runs is read before the pending command is
 *  consumed, a connected session goes to the flow with it, and a closed one stops. */
export function connectHook(page: string): string[] {
  const out: string[] = [];
  const runs = page.indexOf("const runs = { attach: !!attach, pendingCommand: !!pendingCommand[tab.sessionId] }");
  const consumed = page.indexOf("delete pendingCommand[tab.sessionId]");
  if (runs < 0 || consumed < 0 || runs > consumed) {
    out.push("what the tab runs is not read before its pending command is consumed");
  }
  if (!/if \(st === "connected"\) pathSync\.connected\(tab, runs\)/.test(page)) {
    out.push("a connected session is not handed to the path-sync flow");
  }
  const closed = page.indexOf('if (st === "closed") {');
  if (closed < 0 || !page.slice(closed, closed + 300).includes("pathSync.closed(tab.sessionId)")) {
    out.push("a closed session does not stop following");
  }
  return out;
}

describe("path sync per server guard", () => {
  const page = read(PAGE);

  it("the connect hook reads the tab before it is consumed and hands it to the flow", () => {
    expect(connectHook(page)).toEqual([]);
  });

  it("catches the tab read after its pending command is gone", () => {
    const line = "const runs = { attach: !!attach, pendingCommand: !!pendingCommand[tab.sessionId] };";
    const moved = page
      .replace(line, "")
      .replace("delete pendingCommand[tab.sessionId];", `delete pendingCommand[tab.sessionId];\n${line}`);
    expect(connectHook(moved)).toEqual([
      "what the tab runs is not read before its pending command is consumed",
    ]);
    const unstopped = page.replace("pathSync.closed(tab.sessionId);", "");
    expect(connectHook(unstopped)).toEqual(["a closed session does not stop following"]);
  });
});
