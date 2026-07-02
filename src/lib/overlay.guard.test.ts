// Overlay stacking guard (Phase 18.4): a full-screen overlay (`fixed inset-0`,
// used for modal backdrops / dialogs / drag shields) MUST carry an explicit
// z-index. Without one it renders at `z-auto` and, once its owning panel is
// embedded inside another stacking context (e.g. SftpPanel inside RightDock),
// higher-z siblings paint over it — the overlay stays visible but its buttons
// become unclickable. This exact bug shipped in SftpPanel's hand-rolled delete
// dialog; the fix was to use the shared <Modal>/<ConfirmDialog> (which set z-40).
//
// This guard scans every .svelte file and fails if a `fixed inset-0` element has
// no `z-<n>` / `z-[...]` utility on the same line. Prefer reusing Modal/
// ConfirmDialog over hand-rolling an overlay at all (design-system invariant).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

// A full-screen overlay: `fixed` + `inset-0` in the same class value.
const OVERLAY = /fixed\s+inset-0|inset-0\s+fixed/;
// An explicit z-index utility: z-40, z-50, z-[999], etc.
const HAS_Z = /\bz-(\d|\[)/;

function svelteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      svelteFiles(full, acc);
    } else if (entry.endsWith(".svelte")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("overlay stacking guard", () => {
  it("every full-screen `fixed inset-0` overlay has an explicit z-index", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (OVERLAY.test(line) && !HAS_Z.test(line)) {
          const rel = file.slice(SRC.length + 1);
          offenders.push(`${rel}:${i + 1}: \`fixed inset-0\` without a z-index`);
        }
      });
    }
    expect(
      offenders,
      `full-screen overlays missing a z-index (reuse <Modal>/<ConfirmDialog>, or add z-40+):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
