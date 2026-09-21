import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Clipboard text reaches the terminal only through xterm's `term.paste()`.
//
// The bug: `paste()` wrote the clipboard straight to the PTY with
// `writeToTerminal`, skipping xterm's paste. That lost bracketed paste — a
// multi-line snippet ran line by line the moment it landed instead of sitting in
// the prompt for review — and LF went through where Enter sends CR. With
// right-click bound to paste, one stray click could run a pasted block on a prod
// shell. Checked on the source with comments stripped, so a comment naming the
// old call can't trip it and a comment naming the new one can't satisfy it.

const SRC = join(process.cwd(), "src");

function strip(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
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

describe("terminal paste guard", () => {
  it("the terminal pastes through term.paste(), not straight to the PTY", () => {
    const src = strip(readFileSync(join(SRC, "lib", "Terminal.svelte"), "utf8"));
    const start = src.indexOf("async function paste()");
    expect(start, "paste() not found in Terminal.svelte").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body).toMatch(/term\??\.paste\(/);
    expect(body).not.toMatch(/writeToTerminal/);
  });

  it("no file writes clipboard text to a PTY", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => {
        const src = strip(readFileSync(f, "utf8"));
        return /readClipboard\(/.test(src) && /writeToTerminal\(/.test(src) && !f.endsWith("Terminal.svelte");
      })
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders, "clipboard → PTY must go through Terminal's term.paste()").toEqual([]);
  });
});
