import { beforeAll, describe, expect, it } from "vitest";
import { cachedReader, loadGroup, loadPipeline, MAX_FILES, type PipeReader, type ReaderEntry } from "./pipeload";
import { loadYaml, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

/** A reader over an in-memory tree: files by path, folders listed from them. */
function fakeReader(files: Record<string, string>, refuse: string[] = []): PipeReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(path) {
      reads.push(path);
      if (refuse.includes(path) || !(path in files)) throw new Error(`no such file: ${path}`);
      return files[path];
    },
    async list(dir) {
      if (refuse.includes(dir)) throw new Error("denied");
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Map<string, ReaderEntry>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [name, ...deeper] = rest.split("/");
        names.set(name, { name, path: prefix + name, isDir: deeper.length > 0 });
      }
      if (names.size === 0) throw new Error("not a folder");
      return [...names.values()];
    },
  };
}

describe("loadPipeline — GitLab", () => {
  it("merges local includes under the main file, globs too", async () => {
    const reader = fakeReader({
      "/r/ci/test.yml": "include: ci/common.yml\nrspec:\n  stage: test\n  script: [rspec]\n",
      "/r/ci/common.yml": ".base:\n  image: ruby\n",
      "/r/ci/jobs/a.yml": "ja:\n  script: [a]\n",
      "/r/ci/jobs/b.yml": "jb:\n  script: [b]\n",
      "/r/ci/jobs/notes.md": "x",
    });
    const main = `include:
  - local: /ci/test.yml
  - local: ci/jobs/*.yml
  - project: infra/ci
    file: /deploy.yml
  - local: /ci/missing.yml
rspec:
  extends: .base
  variables: { X: "1" }
`;
    const p = await loadPipeline(Y, reader, "/r/.gitlab-ci.yml", main);
    expect(p.kind).toBe("gitlab");
    expect(p.jobs.map((j) => j.id)).toEqual(["rspec", "ja", "jb"]);
    const rspec = p.jobs[0];
    expect(rspec.steps).toEqual(["rspec"]);
    expect(rspec.vars).toEqual({ X: "1" });
    // The job is written in two files: its lines are the main file's, which wins.
    expect(rspec.span.file).toBe("/r/.gitlab-ci.yml");
    expect(p.jobs[1].span.file).toBe("/r/ci/jobs/a.yml");
    expect(p.files.map((f) => `${f.state}:${f.path}`)).toEqual([
      "read:/r/.gitlab-ci.yml",
      "read:/r/ci/test.yml",
      "read:/r/ci/common.yml",
      "read:/r/ci/jobs/a.yml",
      "read:/r/ci/jobs/b.yml",
      "external:project: infra/ci (/deploy.yml)",
      "failed:/r/ci/missing.yml",
    ]);
    expect(p.problems.map((x) => x.code)).toEqual(["includeExternal", "includeFailed"]);
  });

  it("reads a child pipeline of the repository and names one it could not", async () => {
    const reader = fakeReader({ "/r/ci/child.yml": "c1:\n  script: [x]\nc2:\n  needs: [c1]\n  script: [y]\n" });
    const p = await loadPipeline(
      Y,
      reader,
      "/r/.gitlab-ci.yml",
      "child:\n  trigger:\n    include: ci/child.yml\nother:\n  trigger:\n    include: ci/gone.yml\n",
    );
    expect(p.jobs[0].call?.pipeline?.jobs.map((j) => j.id)).toEqual(["c1", "c2"]);
    expect(p.jobs[1].call?.missing).toBe("unread");
    expect(p.problems.map((x) => x.code)).toEqual(["callFailed"]);
  });

  it("reports a YAML error of an included file there, and a file that is not a map", async () => {
    const reader = fakeReader({ "/r/a.yml": "x: [1\n", "/r/b.yml": "- 1\n" });
    const p = await loadPipeline(Y, reader, "/r/.gitlab-ci.yml", "include: [a.yml, b.yml]\nj:\n  script: [x]\n");
    expect(p.problems.map((x) => `${x.code}@${x.file}`)).toEqual(["yaml@/r/a.yml", "notMap@/r/b.yml"]);
  });

  it("stops at include depth and at the file budget", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`/r/d${i}.yml`] = `include: d${i + 1}.yml\nj${i}:\n  script: [x]\n`;
    const deep = await loadPipeline(Y, fakeReader(files), "/r/.gitlab-ci.yml", "include: d0.yml\n");
    expect(deep.problems.map((x) => x.code)).toContain("includeDeep");

    const many: Record<string, string> = {};
    const list: string[] = [];
    for (let i = 0; i < MAX_FILES + 3; i++) {
      many[`/r/f${i}.yml`] = `j${i}:\n  script: [x]\n`;
      list.push(`f${i}.yml`);
    }
    const wide = await loadPipeline(Y, fakeReader(many), "/r/.gitlab-ci.yml", `include: [${list.join(", ")}]\n`);
    expect(wide.jobs).toHaveLength(MAX_FILES);
    expect(wide.problems.filter((x) => x.code === "tooManyFiles")).toHaveLength(3);
  });

  it("names a glob folder that cannot be listed", async () => {
    const p = await loadPipeline(Y, fakeReader({}, ["/r/ci"]), "/r/.gitlab-ci.yml", "include: ci/*.yml\nj:\n  script: [x]\n");
    expect(p.problems.map((x) => x.code)).toEqual(["includeFailed"]);
  });
});

describe("loadPipeline — GitHub", () => {
  it("reads reusable workflows and composite actions of the repository", async () => {
    const reader = fakeReader({
      "/r/.github/workflows/e2e.yml": "on: workflow_call\njobs:\n  smoke: { steps: [] }\n  ui: { needs: smoke, steps: [] }\n",
      "/r/.github/actions/setup/action.yaml": "runs:\n  using: composite\n  steps:\n    - name: Install\n",
    });
    const p = await loadPipeline(
      Y,
      reader,
      "/r/.github/workflows/ci.yml",
      `on: push
jobs:
  build:
    steps:
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/gone
      - run: make
  e2e:
    uses: ./.github/workflows/e2e.yml
  lost:
    uses: ./.github/workflows/lost.yml
`,
    );
    expect(p.jobs[0].steps).toEqual(["uses: ./.github/actions/setup", "↳ Install", "uses: ./.github/actions/setup", "↳ Install", "uses: ./.github/actions/gone", "make"]);
    expect(reader.reads.filter((r) => r.includes("setup"))).toEqual(["/r/.github/actions/setup/action.yml", "/r/.github/actions/setup/action.yaml"]);
    expect(p.jobs[1].call?.pipeline?.jobs.map((j) => j.id)).toEqual(["smoke", "ui"]);
    expect(p.jobs[2].call?.missing).toBe("unread");
    expect(p.problems.map((x) => x.code)).toEqual(["callFailed"]);
    expect(p.files.some((f) => f.state === "failed" && f.path === "/r/.github/actions/gone")).toBe(true);
  });

  it("treats a path GitHub names as GitHub, and can be told the kind", async () => {
    const reader = fakeReader({});
    expect((await loadPipeline(Y, reader, "/r/.github/workflows/a.yml", "on: push\njobs:\n  a: { steps: [] }\n")).kind).toBe("github");
    expect((await loadPipeline(Y, reader, "/r/ci/x.yml", "a:\n  script: [x]\n")).kind).toBe("gitlab");
    expect((await loadPipeline(Y, reader, "/r/x.yml", "on: push\njobs:\n  a: { steps: [] }\n", "github")).kind).toBe("github");
  });
});

describe("loadGroup", () => {
  const files = {
    "/r/.github/workflows/ci.yml": "name: CI\non: push\njobs:\n  a: { steps: [] }\n",
    "/r/.github/workflows/nightly.yaml": "on: { schedule: [{ cron: '0 3 * * *' }] }\njobs:\n  b: { steps: [] }\n",
    "/r/.github/workflows/notes.md": "x",
    "/r/.gitlab-ci.yml": "j:\n  script: [x]\n",
    "/r/src/main.c": "int main;",
  };

  it("finds the pipelines of a repository, a home and a workflows folder", async () => {
    const reader = fakeReader(files);
    const all = await loadGroup(Y, reader, [{ path: "/r", isDir: true }]);
    expect(all.pipelines.map((p) => p.file)).toEqual(["/r/.github/workflows/ci.yml", "/r/.github/workflows/nightly.yaml", "/r/.gitlab-ci.yml"]);
    const home = await loadGroup(Y, reader, [{ path: "/r/.github", isDir: true }]);
    expect(home.pipelines).toHaveLength(2);
    const dir = await loadGroup(Y, reader, [{ path: "/r/.github/workflows", isDir: true }]);
    expect(dir.pipelines.map((p) => p.name)).toEqual(["CI", "nightly.yaml"]);
  });

  it("takes chosen files once and leaves out what is not a pipeline", async () => {
    const reader = fakeReader(files);
    const g = await loadGroup(Y, reader, [
      { path: "/r/.github/workflows/ci.yml", isDir: false },
      { path: "/r/.github/workflows/ci.yml", isDir: false },
      { path: "/r/src/main.c", isDir: false },
    ]);
    expect(g.pipelines).toHaveLength(1);
    expect(g.failed).toEqual([]);
  });

  it("names what it could not list or read", async () => {
    const reader = fakeReader({ ...files, "/r/.github/workflows/gone.yml": "" }, ["/r/src", "/r/.github/workflows/gone.yml"]);
    const g = await loadGroup(Y, reader, [
      { path: "/r/src", isDir: true },
      { path: "/r/.github/workflows/gone.yml", isDir: false },
    ]);
    expect(g.failed.map((f) => f.path)).toEqual(["/r/src", "/r/.github/workflows/gone.yml"]);
  });

  it("does not count a repository's empty .github as a failure", async () => {
    const reader = fakeReader({ "/r/.github/CODEOWNERS": "*", "/r/.gitlab-ci.yml": "j:\n  script: [x]\n" });
    const g = await loadGroup(Y, reader, [{ path: "/r", isDir: true }]);
    expect(g.pipelines.map((p) => p.file)).toEqual(["/r/.gitlab-ci.yml"]);
    expect(g.failed).toEqual([]);
  });
});

describe("cachedReader", () => {
  it("asks the connection once per path, a refusal too", async () => {
    const base = fakeReader({ "/r/a.yml": "a: 1", "/r/d/x.yml": "x" });
    const reader = cachedReader(base);
    expect(await reader.read("/r/a.yml")).toBe("a: 1");
    expect(await reader.read("/r/a.yml")).toBe("a: 1");
    await expect(reader.read("/r/gone.yml")).rejects.toThrow();
    await expect(reader.read("/r/gone.yml")).rejects.toThrow();
    expect(base.reads).toEqual(["/r/a.yml", "/r/gone.yml"]);
    const first = await reader.list("/r/d");
    expect(await reader.list("/r/d")).toBe(first);
  });
});
