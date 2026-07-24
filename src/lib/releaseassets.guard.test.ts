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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/release.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";

/** Файл workflow без строк-комментариев (см. преамбулу — комментарий лгал бы). */
const codeOf = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const code = codeOf(WORKFLOW);

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

// A tag must not be able to publish a release built from a red tree. Before this
// gate, release.yml ran zero tests: `git push origin v1.0.1` produced three
// signed-off bundles even with clippy red, coverage under threshold and
// `pnpm build` broken. Nothing failed — the release just shipped.
//
// The dependency is the whole point, so it is what gets asserted: dropping
// `needs` (or quietly pointing `verify` at something else) is exactly the change
// that would look like a harmless speed-up in review.
describe("release runs behind the quality gates", () => {
  const jobsBlock = code.slice(code.indexOf("\njobs:"));
  /** Job blocks are the 2-space-indented keys under `jobs:`. */
  const jobs = new Map(
    jobsBlock
      .split(/^ {2}(?=\S)/m)
      .slice(1)
      .map((block) => [block.slice(0, block.indexOf(":")), block] as const),
  );

  it("has a verify job that reuses ci.yml rather than copying its steps", () => {
    const verify = jobs.get("verify");
    expect(verify, "job `verify` not found in release.yml").toBeDefined();
    expect(verify).toMatch(/uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  });

  it("blocks the build matrix on that job", () => {
    const release = jobs.get("release");
    expect(release, "job `release` not found in release.yml").toBeDefined();
    expect(release).toMatch(/needs:\s*(verify\b|\[[^\]]*\bverify\b)/);
  });

  it("the reused workflow is actually callable", () => {
    // `workflow_call` is what makes it reusable; without it the `uses:` above
    // fails at dispatch time, i.e. only ever on a real tag push.
    expect(codeOf(CI_WORKFLOW)).toMatch(/^\s*workflow_call:/m);
  });

  it("the reused workflow runs the gates the DoD names", () => {
    const ci = codeOf(CI_WORKFLOW);
    for (const cmd of [
      "pnpm check",
      "pnpm test:coverage",
      "pnpm build",
      "cargo fmt",
      "cargo clippy",
      "cargo test",
    ]) {
      expect(ci, `CI does not run \`${cmd}\``).toContain(cmd);
    }
  });
});

// pnpm 11 needs Node >= 22.13 (it requires `node:sqlite`) and dies on the very
// first invocation — which is the setup-node step itself, since `cache: pnpm`
// runs `pnpm store path`. The pin is a floor, not a preference: bumping pnpm
// without bumping Node passes review, passes locally, and takes out all three
// platforms at once. Whoever raises either pin must look at the other.
// Checked across BOTH workflows, and across every occurrence inside each: ci.yml
// sets the pair up twice (the `web` and `deps` jobs), so a first-match check
// would bless a file whose second job still pinned Node 20.
describe.each([WORKFLOW, CI_WORKFLOW])("toolchain pins in %s", (rel) => {
  const wf = codeOf(rel);

  const majorsOf = (re: RegExp): number[] => {
    const found = [...wf.matchAll(re)].map((m) => Number(m[1]));
    expect(found.length, `pin not found: ${re}`).toBeGreaterThan(0);
    return found;
  };

  // `@\S+[^\n]*` spans the SHA pin plus its trailing `# vX.Y.Z` comment; what is
  // being read here is the pnpm major from `with: version:`, not the action tag.
  const pnpmMajors = majorsOf(
    /pnpm\/action-setup@\S+[^\n]*\s+with:\s+version:\s*(\d+)/g,
  );
  const nodeMajors = majorsOf(/node-version:\s*(\d+)/g);

  it("every Node pin clears the floor of the highest pinned pnpm major", () => {
    // pnpm >= 11 → Node >= 22; pnpm 10 was fine on Node 20.
    const floor = Math.max(...pnpmMajors) >= 11 ? 22 : 20;
    expect(Math.min(...nodeMajors)).toBeGreaterThanOrEqual(floor);
  });

  it("sets up Node wherever it sets up pnpm", () => {
    expect(nodeMajors.length).toBe(pnpmMajors.length);
  });

  it("does not sit on a Node major GitHub has deprecated", () => {
    expect(Math.min(...nodeMajors)).toBeGreaterThanOrEqual(22);
  });

  // Separate axis from `node-version`: this is the runtime the *actions* are
  // built against (`runs.using` in their action.yml), not the Node the project
  // builds on. GitHub currently force-runs node20 actions on Node 24 and warns;
  // when that crutch is removed they stop working. These are the first majors
  // shipping `using: node24` — verified against each action.yml.
  const NODE24_FLOOR: Record<string, number> = {
    "actions/checkout": 5,
    "actions/setup-node": 5,
    "pnpm/action-setup": 5,
  };

  // Actions are pinned by commit SHA, so the human-readable major lives in the
  // trailing `# vX.Y.Z` comment — that comment is load-bearing, not decoration.
  it.each(Object.entries(NODE24_FLOOR))(
    "%s is pinned to a major that runs on Node 24",
    (action, floor) => {
      const found = [
        ...wf.matchAll(new RegExp(`${action}@[0-9a-f]{40} # v(\\d+)`, "g")),
      ];
      expect(found.length, `${action} not pinned in ${rel}`).toBeGreaterThan(0);
      // Every occurrence, not just the first: the same action is set up once per
      // job, and a stale pin in the second job is invisible to a first-match check.
      for (const m of found) expect(Number(m[1])).toBeGreaterThanOrEqual(floor);
    },
  );
});

// The builds are unsigned, and the release page actively teaches the recipient to
// strip Gatekeeper quarantine (open-on-mac.sh). Teaching someone to bypass the
// OS check while giving them no way to verify what they downloaded is the part
// that must not silently regress — INSTALL.md documents both commands.
describe("release ships integrity material", () => {
  const jobsBlock = code.slice(code.indexOf("\njobs:"));
  const integrity =
    jobsBlock.split(/^ {2}(?=\S)/m).find((b) => b.startsWith("integrity:")) ?? "";

  it("has an integrity job that runs after every bundle is built", () => {
    expect(integrity, "job `integrity` not found").not.toBe("");
    expect(integrity).toMatch(/needs:\s*(release\b|\[[^\]]*\brelease\b)/);
  });

  it("publishes SHA256SUMS covering the release assets", () => {
    expect(integrity).toContain("sha256sum");
    expect(integrity).toMatch(/gh release upload[^\n]*SHA256SUMS/);
  });

  it("attests provenance for the bundles", () => {
    // The one origin proof available to an unsigned app; it answers a different
    // question than code signing, so it is not a substitute — losing it silently
    // would still leave the download unverifiable.
    expect(integrity).toContain("actions/attest-build-provenance");
    expect(integrity).toMatch(/id-token:\s*write/);
  });

  it("publishes an SBOM", () => {
    expect(integrity).toMatch(/gh release upload[^\n]*sbom/i);
  });

  it("keeps the VirusTotal upload opt-in", () => {
    // Sending release assets to a third party must stay conditional on the owner
    // having added the secret — never on by default. See SECURITY.md.
    expect(integrity).toMatch(/if:\s*env\.VT_API_KEY != ''/);
  });
});

// Supply chain: a mutable tag is a promise the upstream owner can rewrite at any
// time, and these workflows hand `tauri-action` a token with `contents: write`.
// Whoever controls that tag controls what lands in the published release.
//
// Applies to every workflow, not just the two above — a scanner job that runs on
// `main` is as good a foothold as the release job.
describe("third-party actions are pinned by commit SHA", () => {
  const dir = ".github/workflows";
  const files = readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f));

  it("there are workflows to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s pins every action it uses", (file) => {
    const uses = [...codeOf(join(dir, file)).matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)]
      .map((m) => m[1])
      // Local reusable workflows are versioned by this repo's own history.
      .filter((ref) => !ref.startsWith("./"));

    for (const ref of uses) {
      expect(
        ref,
        `${file}: \`${ref}\` is not pinned to a 40-char commit SHA`,
      ).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it.each(files)("%s says which version each SHA is", (file) => {
    // Without the comment the pin is unreviewable and Dependabot has nothing to
    // bump against.
    for (const line of codeOf(join(dir, file)).split("\n")) {
      if (/^\s*(?:- )?uses:\s*\S+@[0-9a-f]{40}/.test(line)) {
        expect(line, `${file}: pin without a version comment`).toMatch(
          /@[0-9a-f]{40} # v?\d/,
        );
      }
    }
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

  // The version comes from package.json — the single source of truth. Reading it
  // from tauri.conf.json (as this step used to) now yields the literal string
  // "../package.json", because that file references the version instead of
  // holding it. See version.guard.test.ts for the full contract.
  it("names it from the real app version", () => {
    expect(step).toContain("package.json");
    expect(step).not.toContain("tauri.conf.json");
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
