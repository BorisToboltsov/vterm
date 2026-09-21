import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Terminal input reaches the backend only through the ordered writer.
//
// The bug: every keystroke was its own `invoke("write_to_terminal")`, and Tauri
// runs async commands as independent tasks — so fast input (auto-type, scanners,
// key repeat, WebDriver) could land out of order: the nightly E2E typed
// "echo vterm" and the shell ran "echo vtemr". `createOrderedWriter`
// (termwrite.ts) serialises writes per session. A second call site that invokes
// the command directly would race the ordered one again, so the command name may
// appear in exactly one file, inside the writer. Checked on the source with JS
// comments stripped, so a comment cannot satisfy or trip it.

const SRC = join(process.cwd(), "src");
const API = join(SRC, "lib", "api", "session.ts");

function strip(src: string): string {
  // CRLF on a Windows checkout would hide the "\n" markers below.
  return src
    .replace(/\r\n/g, "\n")
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

describe("terminal write ordering guard", () => {
  it("only api/session.ts invokes write_to_terminal", () => {
    const callers = sourceFiles(SRC).filter((f) =>
      /["'`]write_to_terminal["'`]/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(callers).toEqual([API]);
  });

  it("the invoke sits inside createOrderedWriter and writeToTerminal goes through it", () => {
    const src = strip(readFileSync(API, "utf8"));
    const invokes = src.match(/["'`]write_to_terminal["'`]/g) ?? [];
    expect(invokes).toHaveLength(1);
    const writer = src.indexOf("createOrderedWriter(");
    expect(writer, "createOrderedWriter( not used").toBeGreaterThan(-1);
    const wrapped = src.slice(writer, src.indexOf("\n);", writer));
    expect(wrapped).toMatch(/["'`]write_to_terminal["'`]/);

    const fn = src.indexOf("export function writeToTerminal(");
    const body = src.slice(fn, src.indexOf("\n}", fn));
    expect(body).not.toMatch(/invoke/);
    expect(body).toMatch(/orderedWrite\(/);
  });
});
