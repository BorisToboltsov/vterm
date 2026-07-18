// Diagnostic-path guard (Phase 39): shipped code MUST NOT reference hard-coded
// absolute scratch paths like `/tmp/vterm-…`. A temporary diagnostic block that
// read `/tmp/vterm-realtest.conf` and wrote `/tmp/vterm-editdiag*.json` from
// `onMount` was committed to main and shipped: on every launch it raised a
// "stat /tmp/vterm-realtest.conf: no such path" toast (very visible on Windows,
// where `/tmp` does not exist at all) and force-opened a local shell tab before
// the user asked for one.
//
// This guard scans every .svelte/.ts source file (tests excluded — fixtures
// legitimately name paths) and fails on `/tmp/…` string literals outside
// comments. Real scratch files must go through the OS temp dir on the Rust
// side, never a hard-coded literal on the front end. Windows drive literals
// (`C:\…`) are deliberately NOT flagged: they are legitimate placeholders in
// shell-path settings and doc comments.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

// A `/tmp/...` path inside a string literal.
const SCRATCH = /["'`]\/tmp\//;
// Line comments and JSDoc continuation lines — prose about `/tmp` is fine.
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (
      (entry.endsWith(".svelte") || entry.endsWith(".ts")) &&
      !entry.endsWith(".test.ts")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe("diagnostic path guard", () => {
  it("no shipped source hard-codes an absolute scratch path", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (SCRATCH.test(line) && !COMMENT.test(line)) {
          const rel = file.slice(SRC.length + 1);
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      offenders,
      `hard-coded absolute scratch paths (leftover diagnostics?):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
