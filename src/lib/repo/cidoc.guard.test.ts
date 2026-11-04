import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  callsOf,
  jobsOf,
  readTiming,
  readWorkflows,
  renderAll,
  requiredChecks,
  timingFromRun,
  TIMING_ROWS,
  triggersOf,
  type Timing,
} from "../../../scripts/ci-diagrams.mjs";

// The pipelines' documentation and its pictures (1.26.2).
//
// A picture of the pipelines goes stale silently: a job is added, the picture still
// shows the old set, and nothing fails. So the pictures are built from the workflows
// themselves (`scripts/ci-diagrams.mjs`), and this gate holds the rest:
//  - what lies in `docs/diagrams/` is exactly what the script gives for today's
//    workflows: a changed workflow or a hand edit is red until the pictures are rebuilt;
//  - the script refuses what its pictures would lie about: a workflow it does not
//    draw, a schedule that is neither the 1st nor weekly, a train off the schedule,
//    a release that is no longer a draft;
//  - `docs/CI.md` links every workflow, names every job and shows every picture —
//    a job can't be added without a word about it;
//  - the timing chart has a row for every job of a release, and no row for a job that
//    is gone. The minutes themselves are not checked: they age honestly, the picture
//    says which run they are from;
//  - the sections that moved here leave no pointer behind.
// Each check is a function over text, run against a planted violation too.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const DIAGRAMS = "docs/diagrams";
const CI_DOC = "docs/CI.md";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** The pictures on disk that are not what the script would write. */
export function stalePictures(rendered: Record<string, string>, onDisk: Record<string, string | undefined>): string[] {
  const names = new Set([...Object.keys(rendered), ...Object.keys(onDisk)]);
  return [...names].filter((n) => lf(rendered[n] ?? "") !== lf(onDisk[n] ?? "")).sort();
}

/** What `docs/CI.md` fails to say about the workflows and pictures. */
export function docViolations(doc: string, workflows: Record<string, string>, pictures: string[]): string[] {
  const out: string[] = [];
  for (const [file, yaml] of Object.entries(workflows)) {
    if (!doc.includes(`(../.github/workflows/${file})`)) out.push(`${file} is not linked`);
    for (const job of jobsOf(yaml)) {
      if (!doc.includes(`\`${job.id}\``)) out.push(`${file}: job ${job.id} is not named`);
    }
  }
  for (const picture of pictures) {
    if (!doc.includes(`(diagrams/${picture})`)) out.push(`${picture} is not shown`);
  }
  return out;
}

/** The relative links of a document (in `dir`) that lead to no file. */
export function brokenLinks(doc: string, dir: string, exists: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const path = target.split("#")[0];
    if (!exists(join(dir, path))) out.push(target);
  }
  return out;
}

/** Where the timing rows and a release's jobs disagree. */
export function timingViolations(timing: Timing, workflows: Record<string, string>): string[] {
  const jobs = ["ci.yml", "deep.yml", "release.yml"].flatMap((f) => jobsOf(workflows[f]).filter((j) => !j.calls));
  const out: string[] = [];
  for (const job of jobs) {
    const rows = timing.rows.filter((r) => r.job === job.id).length;
    if (rows !== job.runners) out.push(`${job.id}: ${job.runners} runners, ${rows} rows`);
  }
  for (const row of timing.rows) {
    if (!jobs.some((j) => j.id === row.job)) out.push(`${row.label}: no job ${row.job}`);
  }
  return out;
}

/** Links to sections that moved to docs/CI.md. */
export function strayPointers(text: string): string[] {
  return [...text.matchAll(/TESTS\.md#ci-на-github|#релизы-через-ci|INSTALL\.md#как-выкатить-релиз/g)].map((m) => m[0]);
}

const WORKFLOWS = readWorkflows();
const TIMING = readTiming();
const picturesOnDisk = () =>
  Object.fromEntries(
    readdirSync(join(ROOT, DIAGRAMS))
      .filter((f) => f.endsWith(".svg"))
      .map((f) => [f, read(join(DIAGRAMS, f))]),
  );
const RENDERED = renderAll({ workflows: WORKFLOWS, timing: TIMING });
const PICTURES = Object.keys(RENDERED);

const swap = (src: string, from: string | RegExp, to: string) => {
  const out = src.replace(from, to);
  expect(out, `the source no longer contains: ${from}`).not.toBe(src);
  return out;
};
const withWorkflow = (file: string, change: (yaml: string) => string) => ({ ...WORKFLOWS, [file]: change(WORKFLOWS[file]) });
const addJob = (yaml: string, id: string) => swap(yaml, /^jobs:\n/m, `jobs:\n  ${id}:\n    runs-on: ubuntu-latest\n`);

describe("cidoc guard", () => {
  it("the pictures are what the script gives for today's workflows", () => {
    // Red here means: run `pnpm ci:diagrams` and look at what changed.
    expect(stalePictures(RENDERED, picturesOnDisk())).toEqual([]);
  });

  it("the document links every workflow, names every job, shows every picture", () => {
    expect(docViolations(read(CI_DOC), WORKFLOWS, PICTURES)).toEqual([]);
  });

  it("the document's links lead somewhere", () => {
    expect(brokenLinks(read(CI_DOC), "docs", (p) => existsSync(join(ROOT, p)))).toEqual([]);
  });

  it("the chart has a row for every job of a release", () => {
    expect(timingViolations(TIMING, WORKFLOWS)).toEqual([]);
  });

  it("nothing still points at the sections that moved", () => {
    for (const file of ["README.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "docs/TESTS.md", "docs/INSTALL.md", "docs/ARCHITECTURE.md", "docs/ROADMAP.md"]) {
      expect(strayPointers(read(file)), file).toEqual([]);
    }
  });
});

describe("cidoc guard — what the script reads", () => {
  it("jobs, with the runners of an include matrix and whether they call a workflow", () => {
    const ci = jobsOf(WORKFLOWS["ci.yml"]);
    expect(ci.map((j) => [j.id, j.runners])).toEqual([["web", 1], ["rust", 3], ["deps", 1]]);
    // A list matrix is no set of runners to draw: analyze stays one block.
    expect(jobsOf(WORKFLOWS["codeql.yml"]).map((j) => j.runners)).toEqual([1, 1]);
    const release = jobsOf(WORKFLOWS["release.yml"]);
    expect(release.filter((j) => j.calls).map((j) => j.id)).toEqual(["verify", "deep"]);
    expect(release.find((j) => j.id === "release")?.runners).toBe(3);
  });

  it("triggers and calls, in the real files", () => {
    expect(triggersOf(WORKFLOWS["ci.yml"])).toEqual({ pr: true, main: true, tag: false, month: false, weekday: null, manual: false });
    expect(triggersOf(WORKFLOWS["deep.yml"])).toEqual({ pr: false, main: false, tag: false, month: true, weekday: null, manual: true });
    expect(triggersOf(WORKFLOWS["release.yml"])).toEqual({ pr: false, main: false, tag: true, month: false, weekday: null, manual: false });
    expect(triggersOf(WORKFLOWS["train.yml"])).toEqual({ pr: false, main: true, tag: false, month: false, weekday: 1, manual: true });
    expect(callsOf(WORKFLOWS["release.yml"])).toEqual(["ci.yml", "deep.yml"]);
    expect(callsOf("uses: ./.github/workflows/ci.yml")).toEqual(["ci.yml"]);
  });

  it("as many required checks as CI has runners", () => {
    expect(requiredChecks(WORKFLOWS["ci.yml"])).toBe(5);
    expect(RENDERED["ci-journey.svg"]).toContain("5 обязательных проверок");
    const one = "jobs:\n  web:\n    runs-on: x\n";
    const two = `${one}  rust:\n    runs-on: x\n`;
    const render = (ci: string) => renderAll({ workflows: { ...WORKFLOWS, "ci.yml": `${WORKFLOWS["ci.yml"].split("jobs:\n")[0]}${ci}` }, timing: TIMING })["ci-journey.svg"];
    expect(render(one)).toContain("1 обязательная проверка");
    expect(render(two)).toContain("2 обязательные проверки");
  });

  it("the chart's total is the run's, not a sum of rounded rows", () => {
    expect(RENDERED["ci-timing.svg"]).toContain(`весь прогон: ${Math.round(TIMING.total)} мин`);
    expect(RENDERED["ci-timing.svg"]).toContain(TIMING.tag);
  });

  it("the map names every job and workflow of the repository", () => {
    for (const [file, yaml] of Object.entries(WORKFLOWS)) {
      expect(RENDERED["ci-map.svg"]).toContain(file);
      for (const job of jobsOf(yaml)) expect(RENDERED["ci-map.svg"]).toContain(job.id);
    }
  });
});

describe("cidoc guard — catches what it exists for", () => {
  it("a job added to a workflow makes the map stale, and the required checks too", () => {
    const rendered = renderAll({ workflows: withWorkflow("ci.yml", (y) => addJob(y, "fresh")), timing: TIMING });
    expect(rendered["ci-map.svg"]).toContain("fresh");
    expect(stalePictures(rendered, picturesOnDisk())).toEqual(["ci-journey.svg", "ci-map.svg"]);
  });

  it("a removed trigger makes the map stale", () => {
    const rendered = renderAll({ workflows: withWorkflow("deep.yml", (y) => swap(y, /^ {2}workflow_dispatch:\n/m, "")), timing: TIMING });
    expect(stalePictures(rendered, picturesOnDisk())).toEqual(["ci-map.svg"]);
  });

  it("a picture edited by hand, or missing, or extra", () => {
    const disk = picturesOnDisk();
    expect(stalePictures(RENDERED, { ...disk, "ci-map.svg": `${disk["ci-map.svg"]}<!-- touched -->` })).toEqual(["ci-map.svg"]);
    expect(stalePictures(RENDERED, { ...disk, "ci-map.svg": undefined })).toEqual(["ci-map.svg"]);
    expect(stalePictures(RENDERED, { ...disk, "old.svg": "x" })).toEqual(["old.svg"]);
  });

  it("a workflow the map does not draw, and one it draws that is gone", () => {
    expect(() => renderAll({ workflows: { ...WORKFLOWS, "nightly.yml": "jobs:\n" }, timing: TIMING })).toThrow(/FLOWS/);
    const rest = Object.fromEntries(Object.entries(WORKFLOWS).filter(([f]) => f !== "codeql.yml"));
    expect(() => renderAll({ workflows: rest, timing: TIMING })).toThrow(/FLOWS/);
  });

  it("a release that is no longer a draft: the pictures say a person publishes", () => {
    const workflows = withWorkflow("release.yml", (y) => swap(y, "releaseDraft: true", "releaseDraft: false"));
    expect(() => renderAll({ workflows, timing: TIMING })).toThrow(/черновик/);
  });

  it("a schedule that is no longer the 1st: the pictures say it is", () => {
    const workflows = withWorkflow("deep.yml", (y) => swap(y, /cron: "(\S+ \S+) 1 \* \*"/, 'cron: "$1 15 * *"'));
    expect(() => renderAll({ workflows, timing: TIMING })).toThrow(/1-го числа/);
  });

  it("the train's day is read from train.yml, and a train off the schedule is refused", () => {
    expect(RENDERED["ci-map.svg"]).toContain("по понедельникам");
    expect(RENDERED["ci-journey.svg"]).toContain("по понедельникам");
    const friday = renderAll({ workflows: withWorkflow("train.yml", (y) => swap(y, 'cron: "0 6 * * 1"', 'cron: "0 6 * * 5"')), timing: TIMING });
    expect(friday["ci-journey.svg"]).toContain("по пятницам");
    expect(stalePictures(friday, picturesOnDisk())).toEqual(["ci-journey.svg", "ci-map.svg"]);
    const unscheduled = withWorkflow("train.yml", (y) => swap(y, /^ {2}schedule:\n {4}- cron: "0 6 \* \* 1".*\n/m, ""));
    expect(() => renderAll({ workflows: unscheduled, timing: TIMING })).toThrow(/по расписанию/);
    const daily = withWorkflow("train.yml", (y) => swap(y, 'cron: "0 6 * * 1"', 'cron: "0 6 * * *"'));
    expect(() => renderAll({ workflows: daily, timing: TIMING })).toThrow(/раз в неделю/);
  });

  it("a release that calls a workflow the map does not draw", () => {
    const workflows = withWorkflow("release.yml", (y) => `${y}\n# uses: ./.github/workflows/other.yml\n`);
    expect(() => renderAll({ workflows, timing: TIMING })).toThrow(/other\.yml/);
  });

  it("a document that forgets a workflow, a job or a picture", () => {
    const doc = read(CI_DOC);
    const noLink = doc.replaceAll("(../.github/workflows/deep.yml)", "");
    expect(docViolations(noLink, WORKFLOWS, PICTURES)).toContain("deep.yml is not linked");
    expect(docViolations(doc.replaceAll("`zizmor`", "zizmor"), WORKFLOWS, PICTURES)).toContain("security.yml: job zizmor is not named");
    expect(docViolations(swap(doc, "(diagrams/ci-timing.svg)", "(x.svg)"), WORKFLOWS, PICTURES)).toContain("ci-timing.svg is not shown");
    const added = withWorkflow("ci.yml", (y) => addJob(y, "fresh"));
    expect(docViolations(doc, added, PICTURES)).toContain("ci.yml: job fresh is not named");
  });

  it("a link that leads nowhere; an address or an anchor is not a file", () => {
    const seen = (p: string) => p === join("docs", "TESTS.md");
    const doc = "[a](TESTS.md#x) [b](gone.md) [c](https://x.y/z) [d](#here)";
    expect(brokenLinks(doc, "docs", seen)).toEqual(["gone.md"]);
  });

  it("a chart that misses a job, keeps a gone one, or has too few runners", () => {
    const added = withWorkflow("deep.yml", (y) => addJob(y, "soak"));
    expect(timingViolations(TIMING, added)).toContain("soak: 1 runners, 0 rows");
    const gone = { ...TIMING, rows: [...TIMING.rows, { job: "old", label: "Старая", group: null, start: 0, dur: 1 }] };
    expect(timingViolations(gone, WORKFLOWS)).toContain("Старая: no job old");
    const short = { ...TIMING, rows: TIMING.rows.filter((r) => r.label !== "Rust macOS") };
    expect(timingViolations(short, WORKFLOWS)).toContain("rust: 3 runners, 2 rows");
  });

  it("a pointer left behind", () => {
    expect(strayPointers("[x](docs/TESTS.md#ci-на-github) и [y](#релизы-через-ci)")).toHaveLength(2);
    expect(strayPointers("[x](docs/CI.md)")).toEqual([]);
  });
});

describe("cidoc guard — what comes from GitHub", () => {
  const job = (name: string, from: number, to: number) => ({
    name,
    startedAt: new Date(from * 60000).toISOString(),
    completedAt: new Date(to * 60000).toISOString(),
  });
  const NAMES = [
    "Тег = версия",
    "Гейты качества / Фронтенд (типы, тесты, сборка)",
    "Гейты качества / Rust (Linux)",
    "Гейты качества / Rust (Windows)",
    "Гейты качества / Rust (macOS)",
    "Гейты качества / Зависимости (cargo deny, pnpm audit)",
    "Глубокие проверки / Фаззинг недоверенного входа",
    "Глубокие проверки / E2E (tauri-driver)",
    "Глубокие проверки / Живые SFTP-тесты",
    "release (macos-latest, --target universal-apple-darwin)",
    "release (windows-latest)",
    "release (ubuntu-22.04)",
    "Целостность (суммы, provenance, SBOM)",
  ];
  const meta = { tag: "v1.0.0", date: "2026-01-02", id: 7 };
  const all = NAMES.map((n, i) => job(n, 10, 12 + i));

  it("every row found, in minutes from the first job, the total from the last end", () => {
    expect(TIMING_ROWS).toHaveLength(NAMES.length);
    const t = timingFromRun({ jobs: all }, meta);
    expect(t.rows[0]).toMatchObject({ job: "tag", start: 0, dur: 2 });
    expect(t.total).toBe(14);
    expect(t).toMatchObject({ tag: "v1.0.0", date: "2026-01-02", run: 7 });
    expect(timingViolations(t, WORKFLOWS)).toEqual([]);
  });

  it("a job the chart does not know is an error, not a gap; so is one that did not run", () => {
    expect(() => timingFromRun({ jobs: [...all, job("Новая джоба", 1, 2)] }, meta)).toThrow(/Новая джоба/);
    expect(() => timingFromRun({ jobs: all.slice(1) }, meta)).toThrow(/Тег = версия/);
  });

  it("a job that has not finished is left out", () => {
    const running = { name: NAMES[0], startedAt: new Date().toISOString(), completedAt: null };
    expect(() => timingFromRun({ jobs: [running, ...all.slice(1)] }, meta)).toThrow(/Тег = версия/);
  });
});
