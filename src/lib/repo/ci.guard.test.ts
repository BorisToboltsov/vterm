// CI guard (v1.25.5): what the workflows share is set up in one place, and each
// concern has one tool.
//
// The same pnpm + Node + install and Rust + Tauri packages + cache steps were
// copied into nine jobs across four workflows, with Rust taken as "whatever
// `stable` is today": a pin raised in one copy and not the next, or a new clippy
// on an unchanged tree, turned a green run red. Now:
//   - pnpm, Node, Rust, the Tauri apt packages and the caches are set up only by
//     the composite actions in .github/actions/ (`setupOutsideActions`);
//   - the Rust version is one: rust-toolchain.toml names an exact release, the
//     action installs what it names, the Linux box image is built on it and on
//     the Node and pnpm of the action (`versionDrift`);
//   - the publishing release.yml asks nothing for a cache, and the actions cache
//     only when asked (`cachesIn`, `inputDefault`);
//   - one scanner per concern (`scannerOverlaps`).
//
// Comment lines are dropped before matching: a comment that still names a step
// would pass a file whose step was deleted. Every check is a function over text
// and shows on a planted violation that it catches what it exists for.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** File without comment lines. */
const codeOf = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const WORKFLOWS = readdirSync(join(ROOT, ".github/workflows"))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => `.github/workflows/${f}`);
const ACTIONS = readdirSync(join(ROOT, ".github/actions")).map((d) => `.github/actions/${d}/action.yml`);
const SETUP_WEB = ".github/actions/setup-web/action.yml";
const SETUP_RUST = ".github/actions/setup-rust/action.yml";

const code = (rel: string): string => codeOf(read(rel));

/** Lines of a workflow that set up a toolchain, a cache or the Tauri packages themselves. */
export function setupOutsideActions(text: string): string[] {
  const own = [
    /uses:\s*(?:pnpm\/action-setup|actions\/setup-node|dtolnay\/rust-toolchain|Swatinem\/rust-cache|actions\/cache)@/,
    /\brustup (?:toolchain install|default|override)\b/,
    /\blibwebkit2gtk-4\.1-dev\b/,
  ];
  return codeOf(text)
    .split("\n")
    .filter((line) => own.some((re) => re.test(line)))
    .map((line) => line.trim());
}

/** The exact release rust-toolchain.toml names, or null when it names a channel or nothing. */
export function toolchainChannel(toml: string): string | null {
  const m = /^channel\s*=\s*"([^"]*)"\s*$/m.exec(codeOf(toml));
  return m && /^\d+\.\d+\.\d+$/.test(m[1]) ? m[1] : null;
}

/** Where CI or the Linux box would run another Rust, Node or pnpm than the one pinned. */
export function versionDrift(files: { toml: string; setupRust: string; setupWeb: string; dockerfile: string; ci: string[] }): string[] {
  const problems: string[] = [];
  const channel = toolchainChannel(files.toml);
  if (!channel) problems.push("rust-toolchain.toml must name an exact release (x.y.z)");
  const rust = codeOf(files.setupRust);
  if (!rust.includes("rust-toolchain.toml") || !/rustup toolchain install "\$channel"/.test(rust))
    problems.push("setup-rust must install the channel it reads from rust-toolchain.toml");
  for (const text of files.ci) {
    for (const m of codeOf(text).matchAll(/^\s*(toolchain:\s*\S+|.*\bcargo \+\S+.*)$/gm))
      problems.push(`a workflow names a toolchain itself: ${m[1].trim()}`);
  }
  const docker = codeOf(files.dockerfile);
  const boxRust = /^FROM rust:(\S+?)-bookworm\b/m.exec(docker)?.[1];
  if (boxRust !== channel) problems.push(`Linux box is built on rust:${boxRust}, not ${channel}`);
  const web = codeOf(files.setupWeb);
  const node = /node-version:\s*(\d+)/.exec(web)?.[1];
  const pnpm = /pnpm\/action-setup@\S+[^\n]*\s+with:\s+version:\s*(\d+)/.exec(web)?.[1];
  const boxNode = /^FROM node:(\d+)-/m.exec(docker)?.[1];
  const boxPnpm = /pnpm@(\d+)/.exec(docker)?.[1];
  if (!node || boxNode !== node) problems.push(`Linux box runs Node ${boxNode}, CI ${node}`);
  if (!pnpm || boxPnpm !== pnpm) problems.push(`Linux box runs pnpm ${boxPnpm}, CI ${pnpm}`);
  return problems;
}

/** Lines that ask for a cache: a caching action, or a `cache`/`cache-key` input handed to one. */
export function cachesIn(text: string): string[] {
  return codeOf(text)
    .split("\n")
    .filter((line) => /^\s*(?:cache|cache-key):/.test(line) || /uses:\s*(?:Swatinem\/rust-cache|actions\/cache)@/.test(line))
    .map((line) => line.trim());
}

/** The `default:` of one input of a composite action, or undefined. */
export function inputDefault(action: string, name: string): string | undefined {
  const inputs = codeOf(action).split(/^inputs:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
  const block = inputs.split(/^ {2}(?=\S)/m).find((b) => b.startsWith(`${name}:`));
  return block ? /^ {4}default:\s*(.*?)\s*$/m.exec(block)?.[1] : undefined;
}

/** Where two scanners cover one concern, or a concern lost its scanner. */
export function scannerOverlaps(files: {
  ci: string[];
  security: string;
  codeql: string;
  auditToml: boolean;
  cargo: string;
}): string[] {
  const problems: string[] = [];
  for (const text of files.ci)
    if (/\bcargo[ -]audit\b/.test(codeOf(text))) problems.push("cargo audit runs beside cargo deny");
  if (files.auditToml) problems.push("audit.toml keeps a second list of exceptions");
  const security = codeOf(files.security);
  const scanners = /scanners:\s*(\S+)/.exec(security)?.[1].split(",") ?? [];
  if (scanners.includes("vuln")) problems.push("Trivy scans dependencies beside cargo deny and pnpm audit");
  if (!scanners.includes("secret") || !scanners.includes("misconfig")) problems.push("Trivy must scan secrets and configs");
  if (/--config p\/secrets\b/.test(security)) problems.push("Semgrep scans secrets beside Trivy");
  if (!/--config p\/rust\b/.test(security) || !/\bsrc-tauri\/src\//.test(security))
    problems.push("Semgrep must read the Rust backend");
  // `unsafe` is clippy's: every block carries a `// SAFETY:` reason, CI denies
  // warnings on all three OSes. Semgrep's rule flags every block, reason or not.
  if (!/--exclude-rule\s+rust\.lang\.security\.unsafe-usage\.unsafe-usage\b/.test(security))
    problems.push("Semgrep flags every unsafe block beside clippy");
  if (!/^undocumented_unsafe_blocks\s*=\s*"(?:warn|deny)"/m.test(files.cargo))
    problems.push("clippy must ask every unsafe block for its SAFETY reason");
  const codeql = codeOf(files.codeql);
  const matrix = /language:\s*\[([^\]]*)\]/.exec(codeql)?.[1] ?? "";
  if (/\brust\b/.test(matrix)) problems.push("CodeQL builds Rust on every pull request");
  const rustJob = codeql.split(/^ {2}(?=\S)/m).find((b) => /languages:\s*rust\b/.test(b)) ?? "";
  if (!/if:\s*github\.event_name != 'pull_request'/.test(rustJob))
    problems.push("CodeQL for Rust must run on main and on schedule only");
  return problems;
}

describe("shared CI steps live in .github/actions", () => {
  it.each(WORKFLOWS)("%s sets nothing up itself", (rel) => {
    expect(setupOutsideActions(read(rel))).toEqual([]);
  });

  it("the shared actions are the ones setting things up", () => {
    expect(setupOutsideActions(read(SETUP_WEB)).length).toBeGreaterThan(0);
    expect(setupOutsideActions(read(SETUP_RUST)).length).toBeGreaterThan(0);
  });

  it("catches its own violations", () => {
    expect(setupOutsideActions("      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0")).toHaveLength(1);
    expect(setupOutsideActions("        run: rustup default stable")).toHaveLength(1);
    expect(setupOutsideActions("          sudo apt-get install -y libwebkit2gtk-4.1-dev")).toHaveLength(1);
    expect(setupOutsideActions("      # pnpm/action-setup@x — in a comment only\n      - uses: $/.github/actions/setup-web")).toEqual([]);
  });
});

describe("one Rust, Node and pnpm for CI and the Linux box", () => {
  const files = {
    toml: read("rust-toolchain.toml"),
    setupRust: read(SETUP_RUST),
    setupWeb: read(SETUP_WEB),
    dockerfile: read("e2e/linux/Dockerfile"),
    ci: [...WORKFLOWS, ...ACTIONS].map(read),
  };

  it("rust-toolchain.toml pins a release that CI and the box both run", () => {
    expect(versionDrift(files)).toEqual([]);
  });

  it("catches its own violations", () => {
    expect(versionDrift({ ...files, toml: 'channel = "stable"' })).toContain(
      "rust-toolchain.toml must name an exact release (x.y.z)",
    );
    expect(versionDrift({ ...files, ci: ["      - uses: x\n        with:\n          toolchain: stable"] })).toEqual([
      "a workflow names a toolchain itself: toolchain: stable",
    ]);
    expect(versionDrift({ ...files, ci: ["        run: cargo +nightly fuzz run md"] })).toHaveLength(1);
    const channel = toolchainChannel(files.toml)!;
    expect(versionDrift({ ...files, dockerfile: files.dockerfile.replace(`rust:${channel}-`, "rust:1-") })).toEqual([
      `Linux box is built on rust:1, not ${channel}`,
    ]);
    expect(versionDrift({ ...files, dockerfile: files.dockerfile.replace("pnpm@", "pnpm@1") })).toHaveLength(1);
    expect(versionDrift({ ...files, setupRust: files.setupRust.replace('install "$channel"', "install stable") })).toHaveLength(1);
  });
});

describe("the release builds from a clean state", () => {
  it("release.yml asks nothing for a cache", () => {
    expect(cachesIn(read(".github/workflows/release.yml"))).toEqual([]);
  });

  it("the shared actions cache only when a job asks", () => {
    expect(inputDefault(read(SETUP_WEB), "cache")).toBe('"false"');
    expect(inputDefault(read(SETUP_RUST), "cache-key")).toBe('""');
  });

  it("catches its own violations", () => {
    expect(cachesIn('      - uses: $/.github/actions/setup-web\n        with:\n          cache: "true"')).toHaveLength(1);
    expect(cachesIn("          cache-key: release")).toHaveLength(1);
    expect(cachesIn("      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0")).toHaveLength(1);
    expect(cachesIn("      # cache: pnpm — said in a comment")).toEqual([]);
    const action = read(SETUP_WEB).replace(/(cache:[\s\S]*?default:\s*)"false"/, '$1"true"');
    expect(inputDefault(action, "cache")).toBe('"true"');
  });
});

describe("each concern has one scanner", () => {
  const files = {
    ci: [...WORKFLOWS, ...ACTIONS].map(read),
    security: read(".github/workflows/security.yml"),
    codeql: read(".github/workflows/codeql.yml"),
    auditToml: existsSync(join(ROOT, "src-tauri/.cargo/audit.toml")),
    cargo: read("src-tauri/Cargo.toml"),
  };

  it("no two scanners cover one concern, and none is left without one", () => {
    expect(scannerOverlaps(files)).toEqual([]);
  });

  it("catches its own violations", () => {
    expect(scannerOverlaps({ ...files, ci: ["        run: cargo audit"] })).toHaveLength(1);
    expect(scannerOverlaps({ ...files, auditToml: true })).toHaveLength(1);
    expect(scannerOverlaps({ ...files, security: files.security.replace("scanners: secret", "scanners: vuln,secret") })).toHaveLength(1);
    expect(scannerOverlaps({ ...files, security: files.security.replace("--config p/rust", "--config p/secrets") })).toHaveLength(2);
    expect(scannerOverlaps({ ...files, codeql: files.codeql.replace("[javascript-typescript, actions]", "[javascript-typescript, rust, actions]") })).toHaveLength(1);
    expect(scannerOverlaps({ ...files, codeql: files.codeql.replace("if: github.event_name != 'pull_request'", "") })).toHaveLength(1);
    expect(scannerOverlaps({ ...files, security: files.security.replace(/--exclude-rule\s+rust\.lang\.security\.unsafe-usage\.unsafe-usage/, "") })).toEqual([
      "Semgrep flags every unsafe block beside clippy",
    ]);
    expect(scannerOverlaps({ ...files, cargo: files.cargo.replace(/^undocumented_unsafe_blocks.*$/m, "") })).toEqual([
      "clippy must ask every unsafe block for its SAFETY reason",
    ]);
  });
});

// pnpm 11 needs Node >= 22.13 (it requires `node:sqlite`) and dies on the very
// first invocation — which is the setup-node step itself, since `cache: pnpm`
// runs `pnpm store path`. The pin is a floor, not a preference: bumping pnpm
// without bumping Node passes review, passes locally, and takes out all three
// platforms at once. Both pins live in setup-web now; whoever raises one must
// look at the other.
describe("toolchain pins in setup-web", () => {
  const wf = code(SETUP_WEB);

  const majorsOf = (re: RegExp): number[] => {
    const found = [...wf.matchAll(re)].map((m) => Number(m[1]));
    expect(found.length, `pin not found: ${re}`).toBeGreaterThan(0);
    return found;
  };

  // `@\S+[^\n]*` spans the SHA pin plus its trailing `# vX.Y.Z` comment; what is
  // being read here is the pnpm major from `with: version:`, not the action tag.
  const pnpmMajors = majorsOf(/pnpm\/action-setup@\S+[^\n]*\s+with:\s+version:\s*(\d+)/g);
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
});

// Separate axis from `node-version`: this is the runtime the *actions* are built
// against (`runs.using` in their action.yml), not the Node the project builds on.
// GitHub force-runs node20 actions on Node 24 and warns; when that crutch is
// removed they stop working. These are the first majors shipping `using: node24`
// — verified against each action.yml. Actions are pinned by commit SHA, so the
// human-readable major lives in the trailing `# vX.Y.Z` comment — that comment is
// load-bearing, not decoration.
describe("actions run on Node 24", () => {
  const NODE24_FLOOR: Record<string, number> = {
    "actions/checkout": 5,
    "actions/setup-node": 5,
    "pnpm/action-setup": 5,
  };
  const all = [...WORKFLOWS, ...ACTIONS].map(code).join("\n");

  it.each(Object.entries(NODE24_FLOOR))("%s is pinned to a major that runs on Node 24", (action, floor) => {
    const found = [...all.matchAll(new RegExp(`${action}@[0-9a-f]{40} # v(\\d+)`, "g"))];
    expect(found.length, `${action} is not used anywhere`).toBeGreaterThan(0);
    // Every occurrence, not just the first: a stale pin in a second job is
    // invisible to a first-match check.
    for (const m of found) expect(Number(m[1])).toBeGreaterThanOrEqual(floor);
  });
});
