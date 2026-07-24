// Release-assets guard: locks in the two files that the Tauri bundler does NOT
// produce but that the release page must carry anyway — the macOS Gatekeeper
// helper (open-on-mac.sh, next to the .dmg) and the Windows portable .exe.
//
// Why a guard and not just a workflow: tauri-action uploads exactly the bundles
// it built, so both files silently vanish from GitHub Releases the moment their
// extra steps are dropped or renamed — and nothing fails, the release just comes
// out incomplete. GitLab CI (build:macos / build:windows) carries the same two,
// so the two pipelines must not drift apart.
//
// Comments are stripped before matching: a file-level text match would happily
// pass on a workflow whose step was deleted but whose comment still describes it
// (the same trap mdlink.guard.test.ts hit in Phase 44.3).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/release.yml";

const raw = readFileSync(join(ROOT, WORKFLOW), "utf8");
const code = raw
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** Step blocks of the single `release` job (list items at 6-space indent). */
const steps = code.split(/^ {6}- /m).slice(1);

const stepWith = (needle: string): string | undefined =>
  steps.find((s) => s.includes(needle));

/**
 * The step that actually uploads `needle`. Narrowed to `run:` steps carrying
 * `gh release upload`, because the release body names both files too — matching
 * on the name alone finds the prose that describes the asset, not the step that
 * produces it.
 */
const uploadStepWith = (needle: string): string | undefined =>
  steps.find(
    (s) =>
      /\n\s*run:/.test(s) && s.includes("gh release upload") && s.includes(needle),
  );

describe("release workflow builds the bundles", () => {
  it("runs tauri-action against the pushed tag", () => {
    const build = stepWith("tauri-apps/tauri-action");
    expect(build).toBeDefined();
    expect(build).toContain("${{ github.ref_name }}");
  });
});

describe("macOS: open-on-mac.sh ships next to the .dmg", () => {
  const step = uploadStepWith("scripts/open-on-mac.sh");

  it("has a step that uploads the helper to the release", () => {
    expect(step).toBeDefined();
    expect(step).toMatch(/gh release upload[^\n]*scripts\/open-on-mac\.sh/);
    expect(step).toContain("${{ github.ref_name }}");
  });

  it("runs only on the macOS runner (the .dmg it belongs to)", () => {
    expect(step).toMatch(/if:\s*matrix\.platform == 'macos-latest'/);
  });

  it("has a token to write to the release", () => {
    expect(step).toContain("GH_TOKEN");
  });

  it("the helper it uploads actually exists in the repo", () => {
    const path = join(ROOT, "scripts/open-on-mac.sh");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").startsWith("#!")).toBe(true);
  });
});

describe("Windows: portable .exe ships alongside the installers", () => {
  const step = uploadStepWith("vterm-portable-");

  it("copies the self-contained binary, not an installer", () => {
    expect(step).toBeDefined();
    expect(step).toContain("src-tauri/target/release/vterm.exe");
  });

  it("names it from the real app version", () => {
    expect(step).toContain("src-tauri/tauri.conf.json");
    expect(step).toMatch(/vterm-portable-\$v-x86_64\.exe/);
  });

  it("uploads it to the release", () => {
    expect(step).toMatch(/gh release upload/);
    expect(step).toContain("${{ github.ref_name }}");
    expect(step).toContain("GH_TOKEN");
  });

  it("runs only on the Windows runner", () => {
    expect(step).toMatch(/if:\s*matrix\.platform == 'windows-latest'/);
  });
});
