// @vitest-environment node
// Release-train guard (1.32, ADR 0051): a release goes out by the schedule or as a
// hotfix — never as a side effect of an ordinary merge.
//
// Until 1.32 every PR raised the version itself and a tag followed whenever it felt
// right: thirty minors in a month, five drafts never published, versions jumping
// 1.1.11 → 1.17.1. Now:
//   - a PR writes into CHANGELOG «## Готовится» (subsections «Новое» / «Исправлено»)
//     and leaves the version alone — `prProblems`, run by ci.yml on every PR;
//   - once a week train.yml asks the script what to release: «Новое» → minor, only
//     «Исправлено» → patch, nothing → no release (`plan`); the cut gives the section its
//     number and date (`cut`) and goes to main as a PR through the ordinary CI;
//   - the tag goes only on the commit that raised the version (`tagDecision`), so a PR
//     merged after the release PR never rides in it;
//   - "what's new" in a release runs from the last *published* release (`notes`);
//   - the App key that lets the bot trigger CI and the build lives in the `release`
//     environment, in the two jobs that need it and install nothing (`trainProblems`).
// Every check is a function over text and is fed a planted violation below.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  body,
  bump,
  compare,
  cut,
  notes,
  plan,
  prProblems,
  tagDecision,
  unreleasedOf,
  versionsOf,
} from "../../../scripts/release-train.mjs";
import { changeEntries } from "../app/updates";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** File without comment lines: a comment that still names a step would pass a file whose step is gone. */
const codeOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Jobs of a workflow: id → block (keys at two spaces under `jobs:`). */
const jobsIn = (yaml: string) =>
  new Map(
    codeOf(yaml)
      .slice(codeOf(yaml).indexOf("\njobs:"))
      .split(/^ {2}(?=\S)/m)
      .slice(1)
      .map((block) => [block.slice(0, block.indexOf(":")), block] as const),
  );

/** Text of every `run:` script of a block. */
const runsOf = (block: string) =>
  block
    .split(/^ {6}- /m)
    .flatMap((step) => {
      const at = step.search(/^ {8}run:/m);
      return at < 0 ? [] : [step.slice(at)];
    });

const KEY = "RELEASE_APP_PRIVATE_KEY";

/** What train.yml must keep for the release to come out on schedule, and only then. */
export function trainProblems(yaml: string): string[] {
  const out: string[] = [];
  const code = codeOf(yaml);
  const on = code.slice(code.indexOf("\non:"), code.indexOf("\njobs:"));
  const cron = /cron:\s*"(\S+) (\S+) (\S+) (\S+) (\S+)"/.exec(on);
  if (!cron || cron[3] !== "*" || cron[4] !== "*" || !/^[0-6]$/.test(cron[5])) out.push("the schedule is not once a week");
  if (!/^\s+workflow_dispatch:/m.test(on)) out.push("no manual run");
  if (!/^\s+push:\s*\n\s+branches:\s*\[main\]/m.test(on)) out.push("does not see merges into main");

  const jobs = jobsIn(yaml);
  for (const [id, block] of jobs) {
    if (block.includes(KEY)) {
      if (!/^ {4}environment:\s*release\s*$/m.test(block)) out.push(`${id} reads the App key outside the release environment`);
      const need = /^ {4}needs:\s*(\S+)/m.exec(block)?.[1];
      if (!need || jobs.get(need)?.includes(KEY)) out.push(`${id} holds the App key without a keyless job deciding first`);
      if (/setup-web|pnpm install|npm (?:ci|install)/.test(block)) out.push(`${id} installs dependencies next to the App key`);
    }
    for (const m of block.matchAll(/persist-credentials:\s*(\S+)/g)) {
      if (m[1] !== "false") out.push(`${id} keeps a token in .git/config`);
    }
    if (/actions\/checkout@/.test(block) && !/persist-credentials:\s*false/.test(block)) out.push(`${id} checks out without persist-credentials: false`);
    for (const run of runsOf(block)) if (run.includes("${{")) out.push(`${id} substitutes an expression into a shell line`);
  }
  const cutJob = jobs.get("cut") ?? "";
  if (!/node scripts\/release-train\.mjs cut /.test(cutJob)) out.push("cut does not name the section with the script");
  if (!/node scripts\/set-version\.mjs /.test(cutJob)) out.push("cut does not raise the version with set-version");
  if (!/gh pr create --base main/.test(cutJob)) out.push("the cut does not go to main as a PR");
  if (!/gh pr merge "\$branch" --auto/.test(cutJob) || /--admin/.test(cutJob)) out.push("the release PR does not wait for the checks");
  if (!/needs\.plan\.outputs\.version != ''/.test(cutJob)) out.push("cut runs without a version to release");
  if (!/node scripts\/release-train\.mjs plan/.test(jobs.get("plan") ?? "")) out.push("plan does not ask the script");
  if (!/node scripts\/release-train\.mjs tag/.test(jobs.get("check") ?? "")) out.push("check does not ask the script");
  const tagJob = jobs.get("push-tag") ?? "";
  if (!/needs\.check\.outputs\.tag != ''/.test(tagJob)) out.push("push-tag runs without a tag to push");
  if (!/git tag "\$TAG" "\$SHA"/.test(tagJob)) out.push("the tag is not put on the commit check looked at");
  const tagging = [...jobs].filter(([, b]) => /git tag |refs\/tags\//.test(b)).map(([id]) => id);
  if (tagging.join() !== "push-tag") out.push(`tags are pushed by ${tagging.join(", ") || "nobody"}`);
  return out;
}

/** Workflows other than train.yml that read the App key. */
export const keyElsewhere = (workflows: Record<string, string>) =>
  Object.entries(workflows)
    .filter(([file, yaml]) => file !== "train.yml" && codeOf(yaml).includes(KEY))
    .map(([file]) => file);

/** What ci.yml must keep so that a merge cannot release a version. */
export function versionCheckProblems(ciYaml: string): string[] {
  const web = jobsIn(ciYaml).get("web") ?? "";
  const step = web.split(/^ {6}- /m).find((s) => s.includes("release-train.mjs check-pr")) ?? "";
  const out: string[] = [];
  if (!step) return ["the required web job does not check the version"];
  if (!/if:\s*github\.event_name == 'pull_request'/.test(step)) out.push("the check is not limited to PRs");
  if (!/node scripts\/release-train\.mjs check-pr "\$HEAD_REF" FETCH_HEAD/.test(step)) out.push("the check is not run against the PR base");
  if (!/HEAD_REF:\s*\$\{\{\s*github\.head_ref\s*\}\}/.test(step)) out.push("the branch does not come through env");
  return out;
}

const WORKFLOWS = Object.fromEntries(
  readdirSync(join(ROOT, ".github/workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => [f, read(`.github/workflows/${f}`)]),
);
const TRAIN = WORKFLOWS["train.yml"];
const CHANGELOG = read("CHANGELOG.md");
const VERSION: string = JSON.parse(read("package.json")).version;

const swap = (src: string, from: string | RegExp, to: string) => {
  const out = src.replace(from, to);
  expect(out, `the source no longer contains: ${from}`).not.toBe(src);
  return out;
};

// A small CHANGELOG in the real shape.
const LOG = `# Changelog — vterm

Вступление.

---

## Готовится

### Новое

- Плановые выпуски.
  Продолжение пункта.

### Исправлено

- Заметки релиза.

## v1.31.0 — 2026-11-04

- Экран ожидания.

## v1.30.0 — 2026-11-04

### Новое

- Пустые состояния.

---

## v1.29.0 — 2026-11-03

- Шапка списков.
`;
const withoutUnreleased = LOG.replace(/## Готовится[\s\S]*?(?=## v1\.31\.0)/, "");

describe("release-train guard — the repository", () => {
  it("train.yml releases weekly, by hand, and tags merges, with the key fenced in", () => {
    expect(trainProblems(TRAIN)).toEqual([]);
  });

  it("only train.yml reads the App key", () => {
    expect(keyElsewhere(WORKFLOWS)).toEqual([]);
  });

  it("every PR is checked against raising the version itself", () => {
    expect(versionCheckProblems(WORKFLOWS["ci.yml"])).toEqual([]);
  });

  it("«Готовится», if there is one, is well-formed and plannable", () => {
    expect(unreleasedOf(CHANGELOG)?.problems ?? []).toEqual([]);
    expect(() => plan({ changelog: CHANGELOG, version: VERSION, tags: [] })).not.toThrow();
  });

  it("the version in package.json is a released one: it has its own section", () => {
    expect(versionsOf(CHANGELOG)).toContain(VERSION);
  });

  it("the history inside the app never shows «Готовится»", () => {
    // Dev builds carry the unreleased section; the history lists versions only.
    expect(changeEntries(LOG).map((e) => e.version)).toEqual(["1.31.0", "1.30.0", "1.29.0"]);
    expect(changeEntries(LOG)[0].markdown).not.toContain("Плановые выпуски");
  });
});

describe("release-train guard — what to release", () => {
  it("versions bump and compare as numbers", () => {
    expect(bump("1.31.0", "minor")).toBe("1.32.0");
    expect(bump("1.31.4", "minor")).toBe("1.32.0");
    expect(bump("1.31.4", "patch")).toBe("1.31.5");
    expect(compare("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(() => bump("1.31", "minor")).toThrow(/major\.minor\.patch/);
  });

  it("anything new is a minor; fixes alone are a patch; nothing is no release", () => {
    expect(plan({ changelog: LOG, version: "1.31.0", tags: [] })).toMatchObject({ release: true, version: "1.32.0", kind: "minor", minor: 1, patch: 1 });
    const fixes = LOG.replace(/### Новое\n\n- Плановые выпуски\.\n {2}Продолжение пункта\.\n\n/, "");
    expect(plan({ changelog: fixes, version: "1.31.0", tags: [] })).toMatchObject({ release: true, version: "1.31.1", kind: "patch" });
    expect(plan({ changelog: withoutUnreleased, version: "1.31.0", tags: [] })).toMatchObject({ release: false });
    const empty = LOG.replace(/- Плановые выпуски\.\n {2}Продолжение пункта\.\n|- Заметки релиза\.\n/g, "");
    expect(plan({ changelog: empty, version: "1.31.0", tags: [] })).toMatchObject({ release: false });
  });

  it("refuses a version that is already a tag: the hotfix is not back in main", () => {
    expect(() => plan({ changelog: LOG, version: "1.31.0", tags: ["v1.32.0"] })).toThrow(/хотфикс/);
  });

  it("refuses a section it cannot read rather than guessing", () => {
    expect(() => plan({ changelog: swap(LOG, "### Исправлено", "### Изменено"), version: "1.31.0", tags: [] })).toThrow(/Изменено/);
    expect(() => plan({ changelog: swap(LOG, "## Готовится\n\n", "## Готовится\n\n- Без подсекции.\n\n"), version: "1.31.0", tags: [] })).toThrow(/вне подсекции/);
  });

  it("«Готовится» stands first and once", () => {
    const below = withoutUnreleased.replace("## v1.29.0", "## Готовится\n\n### Новое\n\n- x\n\n## v1.29.0");
    expect(unreleasedOf(below)?.problems.join()).toMatch(/первая/);
    const twice = LOG.replace("## v1.31.0", "## Готовится\n\n## v1.31.0");
    expect(unreleasedOf(twice)?.problems.join()).toMatch(/дважды/);
    expect(unreleasedOf(withoutUnreleased)).toBeNull();
  });
});

describe("release-train guard — the cut", () => {
  it("numbers and dates the section and keeps every other line", () => {
    const out = cut(LOG, "1.32.0", "2026-11-09");
    expect(out).toContain("## v1.32.0 — 2026-11-09\n\n### Новое\n\n- Плановые выпуски.\n  Продолжение пункта.\n\n### Исправлено\n\n- Заметки релиза.\n\n## v1.31.0");
    expect(out).not.toContain("Готовится");
    expect(out.replace(/## v1\.32\.0 — 2026-11-09/, "## Готовится")).toBe(LOG);
    // The section is now one the app's history shows.
    expect(changeEntries(out)[0]).toMatchObject({ version: "1.32.0" });
    expect(plan({ changelog: out, version: "1.32.0", tags: [] })).toMatchObject({ release: false });
  });

  it("drops a subsection that stayed empty", () => {
    const fixesOnly = LOG.replace(/- Плановые выпуски\.\n {2}Продолжение пункта\.\n\n/, "");
    const out = cut(fixesOnly, "1.31.1", "2026-11-09");
    expect(out).toContain("## v1.31.1 — 2026-11-09\n\n### Исправлено\n\n- Заметки релиза.\n\n## v1.31.0");
  });

  it("refuses what would make a wrong section", () => {
    expect(() => cut(withoutUnreleased, "1.32.0", "2026-11-09")).toThrow(/Готовится/);
    expect(() => cut(LOG, "1.31.0", "2026-11-09")).toThrow(/уже есть/);
    expect(() => cut(LOG, "1.32.0", "9 ноября")).toThrow(/дата/);
  });
});

describe("release-train guard — what's new", () => {
  it("one section when the last published release is the one before", () => {
    expect(notes(LOG, "v1.31.0", "v1.30.0")).toBe("## Что нового в v1.31.0\n\n- Экран ожидания.");
    expect(notes(LOG, "v1.31.0", null)).toBe("## Что нового в v1.31.0\n\n- Экран ожидания.");
  });

  it("every section after the last published release, a skipped draft included", () => {
    const text = notes(LOG, "v1.31.0", "v1.29.0");
    expect(text).toBe("## Что нового с v1.29.0\n\n### v1.31.0 — 2026-11-04\n\n- Экран ожидания.\n\n### v1.30.0 — 2026-11-04\n\n#### Новое\n\n- Пустые состояния.");
    expect(text).not.toContain("---");
    expect(text).not.toContain("Шапка списков");
  });

  it("a published release that is this one or newer adds nothing", () => {
    expect(notes(LOG, "v1.30.0", "v1.30.0")).toBe("## Что нового в v1.30.0\n\n### Новое\n\n- Пустые состояния.");
    expect(notes(LOG, "v1.30.0", "v1.31.0")).toBe("## Что нового в v1.30.0\n\n### Новое\n\n- Пустые состояния.");
  });

  it("a tag with no section points at the CHANGELOG instead of failing the release", () => {
    expect(notes(LOG, "v1.40.0", null)).toMatch(/CHANGELOG\.md\]\(https:/);
  });

  it("the body is what's new and then how to run it", () => {
    const text = body(LOG, "v1.31.0", "v1.30.0");
    expect(text.indexOf("Что нового")).toBeLessThan(text.indexOf("Assets"));
    expect(text).toContain("vterm v1.31.0");
  });
});

describe("release-train guard — a PR does not release", () => {
  const base = { version: "1.31.0", changelog: withoutUnreleased };

  it("an ordinary PR adds to «Готовится» and passes", () => {
    expect(prProblems({ branch: "feat/x", base, head: { version: "1.31.0", changelog: LOG } })).toEqual([]);
  });

  it("an ordinary PR that raises the version or numbers a section is stopped", () => {
    const raised = { version: "1.32.0", changelog: LOG };
    expect(prProblems({ branch: "feat/x", base, head: raised }).join()).toMatch(/1\.31\.0 → 1\.32\.0/);
    const numbered = { version: "1.31.0", changelog: withoutUnreleased.replace("## v1.31.0", "## v1.32.0 — 2026-11-09\n\n- x\n\n## v1.31.0") };
    expect(prProblems({ branch: "feat/x", base, head: numbered }).join()).toMatch(/v1\.32\.0/);
  });

  it("the release PR and a hotfix may raise it", () => {
    const released = { version: "1.32.0", changelog: cut(LOG, "1.32.0", "2026-11-09") };
    expect(prProblems({ branch: "release/v1.32.0", base, head: released })).toEqual([]);
    expect(prProblems({ branch: "hotfix/1.31.1", base, head: { ...released, version: "1.31.1" } })).toEqual([]);
  });

  it("a malformed «Готовится» is stopped on any branch", () => {
    const bad = { version: "1.31.0", changelog: swap(LOG, "### Новое", "### Прочее") };
    expect(prProblems({ branch: "hotfix/1.31.1", base, head: bad }).join()).toMatch(/Прочее/);
  });
});

describe("release-train guard — the tag", () => {
  const changelog = cut(LOG, "1.32.0", "2026-11-09");

  it("goes on the commit that raised the version", () => {
    expect(tagDecision({ version: "1.32.0", parentVersion: "1.31.0", tagged: false, changelog }).tag).toBe("v1.32.0");
  });

  it("not on a later commit, and not twice", () => {
    expect(tagDecision({ version: "1.32.0", parentVersion: "1.32.0", tagged: false, changelog }).tag).toBeNull();
    // A hotfix merged back: its tag was pushed by hand from hotfix/*.
    expect(tagDecision({ version: "1.32.0", parentVersion: "1.31.0", tagged: true, changelog }).tag).toBeNull();
  });

  it("refuses a raised version with no section", () => {
    expect(() => tagDecision({ version: "1.33.0", parentVersion: "1.32.0", tagged: false, changelog })).toThrow(/1\.33\.0/);
  });
});

describe("release-train guard — catches what it exists for", () => {
  // Comment-free text: a job block cut from it is a substring of it.
  const T = codeOf(TRAIN);
  const job = (id: string) => jobsIn(T).get(id) ?? "";

  it("a schedule that is not weekly, no manual run, no merges", () => {
    expect(trainProblems(swap(T, /cron: "0 6 \* \* 1"/, 'cron: "0 6 1 * *"'))).toContain("the schedule is not once a week");
    expect(trainProblems(swap(T, /^ {2}workflow_dispatch:\n/m, ""))).toContain("no manual run");
    expect(trainProblems(swap(T, /^ {2}push:\n {4}branches: \[main\]\n/m, ""))).toContain("does not see merges into main");
  });

  it("the key outside its environment, without a deciding job, or next to an install", () => {
    expect(trainProblems(swap(T, job("cut"), job("cut").replace(/^ {4}environment: release\n/m, "")))).toContain("cut reads the App key outside the release environment");
    expect(trainProblems(swap(T, job("push-tag"), job("push-tag").replace(/^ {4}needs: check\n/m, "")))).toContain("push-tag holds the App key without a keyless job deciding first");
    const installs = job("cut").replace("      - name: Версия, секция", "      - uses: $/.github/actions/setup-web\n\n      - name: Версия, секция");
    expect(trainProblems(swap(T, job("cut"), installs))).toContain("cut installs dependencies next to the App key");
    expect(keyElsewhere({ ...WORKFLOWS, "ci.yml": `${WORKFLOWS["ci.yml"]}\n        env:\n          K: \${{ secrets.${KEY} }}\n` })).toEqual(["ci.yml"]);
  });

  it("a token left in .git/config, an expression in a shell line", () => {
    expect(trainProblems(T.replace("persist-credentials: false", "persist-credentials: true"))).toContain("plan keeps a token in .git/config");
    expect(trainProblems(swap(T, 'branch="release/v$VERSION"', 'branch="release/v${{ needs.plan.outputs.version }}"'))).toContain("cut substitutes an expression into a shell line");
  });

  it("a cut that skips the PR, the checks or the script", () => {
    expect(trainProblems(swap(T, "--auto --squash", "--admin --squash"))).toContain("the release PR does not wait for the checks");
    expect(trainProblems(swap(T, "gh pr create --base main", "git push origin HEAD:main #"))).toContain("the cut does not go to main as a PR");
    expect(trainProblems(swap(T, "node scripts/release-train.mjs cut ", "sed -i s/Готовится/v/ "))).toContain("cut does not name the section with the script");
  });

  it("a tag from anywhere but push-tag, or on another commit", () => {
    const tagged = job("cut").replace('git switch -c "$branch"', 'git switch -c "$branch"\n          git tag "v$VERSION"');
    expect(trainProblems(swap(T, job("cut"), tagged))).toContain("tags are pushed by cut, push-tag");
    expect(trainProblems(swap(T, 'git tag "$TAG" "$SHA"', 'git tag "$TAG" origin/main'))).toContain("the tag is not put on the commit check looked at");
  });

  it("a PR check that is gone, runs everywhere or ignores the base", () => {
    const ci = WORKFLOWS["ci.yml"];
    expect(versionCheckProblems(ci.replace(/release-train\.mjs check-pr/g, "true"))).toEqual(["the required web job does not check the version"]);
    expect(versionCheckProblems(swap(ci, "if: github.event_name == 'pull_request'\n        env:\n          BASE_SHA", "env:\n          BASE_SHA"))).toContain("the check is not limited to PRs");
    expect(versionCheckProblems(swap(ci, 'check-pr "$HEAD_REF" FETCH_HEAD', 'check-pr "$HEAD_REF" HEAD'))).toContain("the check is not run against the PR base");
  });
});
