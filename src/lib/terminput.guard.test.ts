// Terminal-submit guard (Phase 39.5): a command written into a PTY must be
// terminated with CR, never LF.
//
// The bug: every write-a-command path appended `"\n"`, and on Windows the command
// appeared at the prompt and just sat there. LF is not what Enter sends — a
// terminal sends CR (0x0D). It worked on Linux/macOS only because readline/ZLE
// happen to bind Ctrl+J (LF) to accept-line as well; PSReadLine and cmd.exe do not.
//
// The failure mode is nasty because it is silent and partial: on a multi-line
// block, LF endings mean the earlier lines are inserted and only the last is run,
// so the shell executes something other than what the user was shown.
//
// This guard fails on an encode(...) call whose argument embeds a `\n` literal —
// the shape every one of those call sites had. Route command submission through
// `submitLine`/`submitBlock` in terminput.ts instead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

// An `encode(` call followed by an escaped newline literal on the same line.
// Deliberately not `encode\([^)]*\\n`: the argument routinely contains its own
// parentheses (`encode(`git ${args.join(" ")}\n`)`), and the negated class
// stopped at the first one — a version of this guard with that regex passed while
// the very violation it exists for was present.
const ENCODE_WITH_LF = /encode\(.*\\n/;
// terminput.ts itself is the one place allowed to talk about line endings, and
// its own test naturally quotes them.
const EXEMPT = /(^|[\\/])terminput(\.guard)?(\.test)?\.ts$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte") || entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("terminal submit guard", () => {
  it("no command is written to a PTY with an LF terminator", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.test(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (ENCODE_WITH_LF.test(line)) {
          const rel = file.slice(SRC.length + 1);
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      offenders,
      `commands submitted with LF instead of CR — Windows shells insert but do not run them.\n` +
        `Use submitLine()/submitBlock() from terminput.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
