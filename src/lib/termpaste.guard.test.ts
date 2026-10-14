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
// shell. Checked on the source with JS comments stripped, so a comment naming the
// old call can't trip it and a comment naming the new one can't satisfy it. Markup
// comments are left alone: both calls live in script, and a stray mention in
// markup can only over-flag (the second check), never hide a violation.

const SRC = join(process.cwd(), "src");

function strip(src: string): string {
  return src
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

export function multilineChoiceViolations(src: string): string[] {
  const clean = strip(src);
  const start = clean.indexOf("async function paste()");
  if (start < 0) return ["paste() is missing"];
  const end = clean.indexOf("\n  function finishPaste", start);
  const body = clean.slice(start, end < 0 ? undefined : end);
  const out: string[] = [];
  if (!/isMultilinePaste\(text\)/.test(body) || !/pendingPaste\s*=\s*text/.test(body)) {
    out.push("a multi-line clipboard paste does not open the choice dialog");
  }
  if (!/else\s+term\??\.paste\(text\)/.test(body)) {
    out.push("a single-line clipboard paste no longer goes straight through xterm");
  }
  if (!/TerminalPasteDialog/.test(clean) || !/onpaste=\{finishPaste\}/.test(clean)) {
    out.push("the reviewed representation is not returned to the terminal");
  }
  return out;
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

  it("a multi-line paste is reviewed, while one line stays immediate", () => {
    const src = readFileSync(join(SRC, "lib", "Terminal.svelte"), "utf8");
    expect(multilineChoiceViolations(src)).toEqual([]);
  });

  it("catches the old direct multi-line paste", () => {
    const src = readFileSync(join(SRC, "lib", "Terminal.svelte"), "utf8").replace(
      "if (isMultilinePaste(text)) pendingPaste = text;",
      "if (isMultilinePaste(text)) term?.paste(text);",
    );
    expect(multilineChoiceViolations(src)).toContain(
      "a multi-line clipboard paste does not open the choice dialog",
    );
  });
});
