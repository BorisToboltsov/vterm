import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The assistant runs one turn per chat at a time.
//
// The bug: "Explain" (and every other `askAbout` entry point) went straight to the
// consent dialog and on to `startChat` without asking whether a reply was already
// streaming. The second stream took the first one's listener slot — Stop no longer
// reached it — and the first `done` cleared `streaming` while the other was still
// writing, so the two replies interleaved or broke off. Three places hold together:
// `startChat` is the backstop, the composer's `doSend` tells the user, and the ask
// handler only attaches the request as a composer chip (or turns it away with a
// reason) — it neither opens a dialog over a live turn nor parks the request until
// it fires out of the blue. Checked on the source with JS comments stripped, so a
// comment naming the call can't satisfy the check.

const SRC = join(process.cwd(), "src");

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(rel: string): string {
  return strip(readFileSync(join(SRC, rel), "utf8"));
}

/** Body of a top-level function, from its signature up to the next line that
 *  closes a block at the given indentation. */
function body(src: string, signature: string, indent: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = src.indexOf(`\n${indent}}`, start);
  return src.slice(start, end);
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("one AI turn at a time", () => {
  it("startChat refuses a user turn over a busy chat before touching the conversation", () => {
    const fn = body(read("lib/stores/aichat.svelte.ts"), "export async function startChat(", "");
    const guard = fn.search(/if\s*\(\s*!opts\.feedback\s*&&\s*chatBusy\(c\)\s*\)\s*return/);
    expect(guard, "startChat must bail on chatBusy(c) for non-feedback turns").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf("c.messages.push"));
  });

  it("the composer checks the chat before handing a question to startChat", () => {
    const fn = body(read("lib/AiChat.svelte"), "function doSend(", "  ");
    const guard = fn.indexOf("chatBusy(");
    expect(guard, "doSend must check chatBusy()").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf("startChat("));
  });

  it("a raised question is weighed by askBlocker, then only attached — never sent", () => {
    const src = read("lib/AiChat.svelte");
    const start = src.indexOf("const req = chat.ask;");
    expect(start, "the ask handler is gone from AiChat").toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("\n  });", start));
    const guard = handler.indexOf("askBlocker(");
    expect(guard, "the ask handler must consult askBlocker()").toBeGreaterThan(-1);
    expect(handler.indexOf("chat.attachment = req"), "attached before askBlocker()").toBeGreaterThan(guard);
    // A chip, not a send: the question goes out from the composer, through consent.
    expect(handler).not.toMatch(/consent\s*=|doSend\(|startChat\(/);
    // Weighed only once the question is there: a `ready` check ahead of taking the
    // request would leave it parked in the store.
    expect(handler.slice(0, handler.indexOf("chat.ask = null"))).not.toMatch(/!ready/);
  });

  it("only the chat store starts a turn", () => {
    const callers = sourceFiles(SRC)
      .filter((f) => /\bstartChat\(/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(callers).toEqual(["lib/AiChat.svelte", "lib/stores/aichat.svelte.ts"]);
  });
});
