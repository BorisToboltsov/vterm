import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Path sync per server (v1.23). Each server keeps its own answer to "how does
// path sync start here" — ask / always / by hand — and the page acts on it in
// few, named places. Three ways this goes wrong, each a check below:
//  - following turned on beside `startFollowing`: a path that skips the setup
//    snippet, or types it without the answer that allows it;
//  - a stored answer read raw: a mode a newer build wrote (or a hand-edited file)
//    would count as "always" somewhere and type a command into a shell unasked;
//  - the connect hook reading "does this tab run its own program" after the
//    pending command was consumed — the snippet would land in `port-forward`.
// A session's end stops following, so a reconnect is not left "following" a
// shell that no longer reports its folder. Each check is a function over the
// source with comments stripped, and shows it catches its own violation.

const LIB = join(process.cwd(), "src", "lib");
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

/** The body of `function name(…) { … }`, braces balanced. */
function body(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return "";
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

/** Following starts only in `startFollowing`; a tab arriving from another window
 *  carries the state it had (`page.followTerminal`), which is not a start. */
export function followingStarts(page: string): string[] {
  const out: string[] = [];
  const own = body(page, "startFollowing");
  if (!/followTerminal\[id\]\s*=\s*true/.test(own)) out.push("startFollowing does not turn following on");
  const rest = page.replace(own, "");
  for (const m of rest.matchAll(/^.*followTerminal\[[^\]]+\]\s*=\s*true.*$/gm)) {
    if (!/if \(page\.followTerminal\) followTerminal\[sid\] = true/.test(m[0])) {
      out.push(`following turned on outside startFollowing: ${m[0].trim()}`);
    }
  }
  if (!/startFollowing\(/.test(body(page, "enablePathSync"))) {
    out.push("turning sync on by hand does not go through startFollowing");
  }
  if (!/asksOnEnable\(tabPathSyncMode\(tab\)\)/.test(body(page, "enablePathSync"))) {
    out.push("turning sync on by hand does not ask the server's answer first");
  }
  return out;
}

/** A stored answer is read only through `pathSyncMode`. */
export function rawReads(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, src] of Object.entries(files)) {
    for (const m of src.matchAll(/^.*\.pathSync\b.*$/gm)) {
      if (!m[0].includes("pathSyncMode(")) out.push(`${name}: ${m[0].trim()}`);
    }
  }
  return out;
}

/** The connect hook: what the tab runs is read before the pending command is
 *  consumed, the hook asks `followsOnConnect`, and a closed session stops. */
export function connectHook(page: string): string[] {
  const out: string[] = [];
  const runs = page.indexOf("const runs = { attach: !!attach, pendingCommand: !!pendingCommand[tab.sessionId] }");
  const consumed = page.indexOf("delete pendingCommand[tab.sessionId]");
  if (runs < 0 || consumed < 0 || runs > consumed) {
    out.push("what the tab runs is not read before its pending command is consumed");
  }
  if (!/if \(st === "connected"\) pathSyncOnConnect\(tab, runs\)/.test(page)) {
    out.push("a connected session is not offered to pathSyncOnConnect");
  }
  if (!/followsOnConnect\(tabPathSyncMode\(tab\), runs\)/.test(body(page, "pathSyncOnConnect"))) {
    out.push("pathSyncOnConnect does not ask followsOnConnect");
  }
  const closed = page.indexOf('if (st === "closed") {');
  if (closed < 0 || !page.slice(closed, closed + 300).includes("stopFollowingOnClose(tab.sessionId)")) {
    out.push("a closed session does not stop following");
  }
  return out;
}

/** The profile's answer is written by the form and by `answerPathSync` alone. */
export function answerWrites(page: string): string[] {
  const calls = page.match(/setServerPathSync\(/g)?.length ?? 0;
  const inAnswer = body(page, "answerPathSync").match(/setServerPathSync\(/g)?.length ?? 0;
  return calls === inAnswer && inAnswer === 1 ? [] : ["setServerPathSync is called outside answerPathSync"];
}

describe("path sync per server guard", () => {
  const page = read(PAGE);
  const lib = {
    "ServerFormModal.svelte": read(join(LIB, "ServerFormModal.svelte")),
    "+page.svelte": page,
  };

  it("following starts in one place, after the server's answer", () => {
    expect(followingStarts(page)).toEqual([]);
  });

  it("catches following turned on beside startFollowing", () => {
    const broken = page.replace(
      "startFollowing(id, shellNeedsSetup(id));\n      return;",
      "followTerminal[id] = true;\n      return;",
    );
    expect(followingStarts(broken)).toEqual([
      "following turned on outside startFollowing: followTerminal[id] = true;",
      "turning sync on by hand does not go through startFollowing",
    ]);
  });

  it("a stored answer is read only through pathSyncMode", () => {
    expect(rawReads(lib)).toEqual([]);
    const broken = { x: 'if (srv?.pathSync === "auto") startFollowing(id, true);' };
    expect(rawReads(broken)).toEqual(['x: if (srv?.pathSync === "auto") startFollowing(id, true);']);
  });

  it("the connect hook reads the tab before it is consumed and asks the model", () => {
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
    const unstopped = page.replace("stopFollowingOnClose(tab.sessionId);", "");
    expect(connectHook(unstopped)).toEqual(["a closed session does not stop following"]);
  });

  it("the profile's answer is written only from the question", () => {
    expect(answerWrites(page)).toEqual([]);
    const broken = page.replace(
      "function toggleFollowTerminal(id: string) {",
      'function toggleFollowTerminal(id: string) {\n    void setServerPathSync(id, "auto");',
    );
    expect(answerWrites(broken)).toEqual(["setServerPathSync is called outside answerPathSync"]);
  });
});
