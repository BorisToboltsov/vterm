// Secret-field guard (Phase 39.7): every password/passphrase/API-key field goes
// through the `PasswordInput` primitive, never a bare `<input type="password">`.
//
// The reason it is a guard and not a convention: before this phase there were
// nine hand-rolled secret inputs across seven files, all copies of the same four
// lines, and none of them could be typed into blind-free — a user who mistypes an
// SSH password gets an auth rejection, not a hint. Adding the reveal toggle to
// each copy would have left the tenth field to be written the old way. Routing
// them through one primitive means the toggle (plus `autocomplete="off"`, the
// accessible label and the "starts masked on every mount" rule) comes with the
// field by construction.
//
// If a future field genuinely must not be revealable, exempt it here with the
// reason written down — deliberately, not by forgetting.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

const RAW_PASSWORD_INPUT = /type=["']password["']/;
// PasswordInput.svelte is the primitive itself (it owns the raw input); its own
// tests and this guard naturally quote the pattern they exist for.
const EXEMPT = /(^|[\\/])(PasswordInput\.svelte|passwordinput\.guard\.test\.ts)$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".svelte") || entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("secret field guard", () => {
  it("has no raw password input outside the PasswordInput primitive", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.test(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (RAW_PASSWORD_INPUT.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, "use <PasswordInput> — it carries the reveal toggle").toEqual([]);
  });

  it("the primitive renders a real password input (the guard has something to protect)", () => {
    const src = readFileSync(join(SRC, "lib/PasswordInput.svelte"), "utf8");
    expect(RAW_PASSWORD_INPUT.test(src) || /shown \? "text" : "password"/.test(src)).toBe(true);
  });
});
