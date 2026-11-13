import { describe, expect, it } from "vitest";
import {
  globMatch,
  holdsPipelines,
  isPipelineDir,
  looksLikeGitlab,
  pipelineHomes,
  pipelineKindOf,
  repoPath,
  repoRootOf,
  workflowFiles,
  workflowsDirOf,
} from "./pipefiles";

describe("pipelineKindOf", () => {
  it("knows workflows by their folder, GitLab by its name", () => {
    expect(pipelineKindOf("/srv/app/.github/workflows/ci.yml")).toBe("github");
    expect(pipelineKindOf("/srv/app/.gitea/workflows/ci.yaml")).toBe("github");
    expect(pipelineKindOf("/srv/app/.forgejo/workflows/x.yml")).toBe("github");
    expect(pipelineKindOf("C:\\repo\\.github\\workflows\\ci.yml")).toBe("github");
    expect(pipelineKindOf("/srv/app/.gitlab-ci.yml")).toBe("gitlab");
    expect(pipelineKindOf("/srv/app/deploy.gitlab-ci.yml")).toBe("gitlab");
  });

  it("names nothing else", () => {
    expect(pipelineKindOf("/srv/app/.github/workflows/readme.md")).toBeNull();
    expect(pipelineKindOf("/srv/app/workflows/ci.yml")).toBeNull();
    expect(pipelineKindOf("/srv/app/.github/ci.yml")).toBeNull();
    expect(pipelineKindOf("/srv/app/ci/test.yml")).toBeNull();
  });
});

describe("looksLikeGitlab", () => {
  it("reads a config by what it holds", () => {
    expect(looksLikeGitlab("stages:\n  - build\n")).toBe(true);
    expect(looksLikeGitlab("include:\n  - local: a.yml\n")).toBe(true);
    expect(looksLikeGitlab("# tests\nrspec:\n  stage: test\n")).toBe(true);
    expect(looksLikeGitlab("rspec:\n\n  # run\n  script:\n    - rspec\n")).toBe(true);
  });

  it("does not take other YAML for it", () => {
    expect(looksLikeGitlab("apiVersion: v1\nkind: Pod\nspec:\n  containers: []\n")).toBe(false);
    expect(looksLikeGitlab("services:\n  web:\n    image: x\n")).toBe(false);
    expect(looksLikeGitlab("")).toBe(false);
  });
});

describe("folders", () => {
  it("knows a workflows folder and the folder over it", () => {
    expect(isPipelineDir("/a/.github/workflows")).toBe(true);
    expect(isPipelineDir("/a/.github")).toBe(true);
    expect(isPipelineDir("/a/.forgejo/")).toBe(true);
    expect(isPipelineDir("/a/workflows")).toBe(false);
    expect(isPipelineDir("/a/src")).toBe(false);
    expect(workflowsDirOf("/a/.github")).toBe("/a/.github/workflows");
    expect(workflowsDirOf("/a/.github/workflows")).toBe("/a/.github/workflows");
  });

  it("sees a repository with pipelines in a listing", () => {
    expect(holdsPipelines(["src", ".github"])).toBe(true);
    expect(holdsPipelines(["src", ".gitlab-ci.yml"])).toBe(true);
    expect(holdsPipelines(["src", "README.md"])).toBe(false);
  });

  it("lists the YAML of a workflows folder", () => {
    const entries = [
      { name: "b.yml", path: "/w/b.yml", isDir: false },
      { name: "a.yaml", path: "/w/a.yaml", isDir: false },
      { name: "notes.md", path: "/w/notes.md", isDir: false },
      { name: "old.yml", path: "/w/old.yml", isDir: true },
    ];
    expect(workflowFiles(entries)).toEqual(["/w/a.yaml", "/w/b.yml"]);
  });

  it("says where a repository keeps its pipelines", () => {
    const h = pipelineHomes("/r");
    expect(h.workflows).toEqual(["/r/.github/workflows", "/r/.gitea/workflows", "/r/.forgejo/workflows"]);
    expect(h.gitlab).toEqual(["/r/.gitlab-ci.yml", "/r/.gitlab-ci.yaml"]);
  });
});

describe("paths in the repository", () => {
  it("finds the root above the workflow, or beside the GitLab file", () => {
    expect(repoRootOf("/srv/app/.github/workflows/ci.yml")).toBe("/srv/app");
    expect(repoRootOf("/srv/app/.gitlab-ci.yml")).toBe("/srv/app");
    expect(repoRootOf("C:\\repo\\.github\\workflows\\ci.yml")).toBe("C:\\repo");
  });

  it("resolves a path the config names, and refuses one that leaves the root", () => {
    expect(repoPath("/srv/app", "/ci/test.yml")).toBe("/srv/app/ci/test.yml");
    expect(repoPath("/srv/app", "ci/test.yml")).toBe("/srv/app/ci/test.yml");
    expect(repoPath("/srv/app", "./.github/workflows/e2e.yml")).toBe("/srv/app/.github/workflows/e2e.yml");
    expect(repoPath("/srv/app", "$/.github/workflows/ci.yml")).toBe("/srv/app/.github/workflows/ci.yml");
    expect(repoPath("/srv/app", "ci/../deploy.yml")).toBe("/srv/app/deploy.yml");
    expect(repoPath("/srv", "../../etc/passwd")).toBeNull();
    expect(repoPath("/srv/app", "https://x/y.yml")).toBeNull();
    expect(repoPath("/srv/app", "  ")).toBeNull();
  });

  it("matches a glob within one folder", () => {
    expect(globMatch("*.yml", "a.yml")).toBe(true);
    expect(globMatch("*.yml", "a.yaml")).toBe(false);
    expect(globMatch("job-?.yml", "job-1.yml")).toBe(true);
    expect(globMatch("a.b", "aXb")).toBe(false);
  });
});
