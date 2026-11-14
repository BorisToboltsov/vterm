import { describe, expect, it } from "vitest";
import { forgeOf, isKnown, parseRemotes, pickRepo, reposOf, repoWebUrl, sanitizeForges } from "./forge";
import {
  authArgs,
  cancelArgs,
  dispatchArgs,
  enc,
  jobsArgs,
  logArgs,
  pinArgs,
  pipelineArgs,
  rerunArgs,
  runArgs,
  runsArgs,
} from "./ciapi";

// vterm itself: a GitHub origin and a GitLab on a LAN address.
const REMOTE_V = [
  "gitlab\thttps://192.168.20.80/boris/vterm (fetch)",
  "gitlab\thttps://192.168.20.80/boris/vterm (push)",
  "origin\thttps://github.com/BorisToboltsov/vterm.git (fetch)",
  "origin\thttps://github.com/BorisToboltsov/vterm.git (push)",
].join("\n");

describe("where the runs live", () => {
  it("each remote once, origin first; the forge from the host or the remote's name", () => {
    const repos = reposOf(parseRemotes(REMOTE_V), {});
    expect(repos).toEqual([
      { remote: "origin", host: "github.com", path: "BorisToboltsov/vterm", forge: "github" },
      { remote: "gitlab", host: "192.168.20.80", path: "boris/vterm", forge: "gitlab" },
    ]);
    expect(repoWebUrl(repos[1])).toBe("https://192.168.20.80/boris/vterm");
  });

  it("a host that says nothing is unknown until the user says — then always that", () => {
    expect(forgeOf("git.example.org", "origin", {})).toBeNull();
    expect(forgeOf("git.example.org", "origin", { "git.example.org": "gitlab" })).toBe("gitlab");
    expect(forgeOf("github.corp.example", "origin", {})).toBe("github");
    expect(forgeOf("gitlab.example.org", "upstream", {})).toBe("gitlab");
    // A word inside another is not the forge's name.
    expect(forgeOf("mygithubby.org", "origin", {})).toBeNull();
  });

  it("the picked remote while it is there, else the first known", () => {
    const repos = reposOf(parseRemotes(REMOTE_V), {});
    expect(pickRepo(repos, "gitlab")?.remote).toBe("gitlab");
    expect(pickRepo(repos, "gone")?.remote).toBe("origin");
    const unknown = reposOf(parseRemotes("o\tgit@git.example.org:a/b.git (fetch)"), {});
    expect(isKnown(pickRepo(unknown, null))).toBe(false);
    expect(pickRepo([], null)).toBeNull();
  });

  it("the user's word by host, cleaned on the way in", () => {
    expect(sanitizeForges({ "Git.Example.org": "gitlab", bad: "bitbucket", "x y": "github" })).toEqual({ "git.example.org": "gitlab" });
    expect(sanitizeForges(null)).toEqual({});
  });
});

describe("the calls", () => {
  const gh = { remote: "origin", host: "github.com", path: "BorisToboltsov/vterm", forge: "github" as const };
  const gl = { remote: "gitlab", host: "192.168.20.80", path: "boris/vterm", forge: "gitlab" as const };

  it("encode what the backend's policy lets through: a slash in a branch, a project path as one segment", () => {
    expect(enc("feat/ci-runs")).toBe("feat%2Fci-runs");
    expect(enc("v1.0_rc-1")).toBe("v1.0_rc-1");
    expect(enc("ветка")).toMatch(/^(%[0-9A-F]{2})+$/);
  });

  it("GitHub", () => {
    expect(authArgs(gh)).toEqual(["gh", "auth", "status", "--hostname", "github.com"]);
    expect(runsArgs(gh, { branch: "feat/x" })).toEqual(["gh", "api", "--hostname", "github.com", "repos/BorisToboltsov/vterm/actions/runs?per_page=30&branch=feat%2Fx"]);
    expect(runsArgs(gh, { workflow: "ci.yml" })[4]).toBe("repos/BorisToboltsov/vterm/actions/workflows/ci.yml/runs?per_page=30");
    expect(runArgs(gh, "9")[4]).toBe("repos/BorisToboltsov/vterm/actions/runs/9");
    expect(jobsArgs(gh, "9")[4]).toBe("repos/BorisToboltsov/vterm/actions/runs/9/jobs?per_page=100&filter=latest");
    expect(logArgs(gh, "5")[4]).toBe("repos/BorisToboltsov/vterm/actions/jobs/5/logs");
    expect(rerunArgs(gh, "9", true)).toEqual(["gh", "api", "--hostname", "github.com", "-X", "POST", "repos/BorisToboltsov/vterm/actions/runs/9/rerun-failed-jobs"]);
    expect(rerunArgs(gh, "9", false).at(-1)).toBe("repos/BorisToboltsov/vterm/actions/runs/9/rerun");
    expect(cancelArgs(gh, "9").at(-1)).toBe("repos/BorisToboltsov/vterm/actions/runs/9/cancel");
    expect(dispatchArgs(gh, "deploy.yml", "main", { environment: "staging" })).toEqual([
      "gh", "api", "--hostname", "github.com", "-X", "POST", "repos/BorisToboltsov/vterm/actions/workflows/deploy.yml/dispatches",
      "-f", "ref=main", "-f", "inputs[environment]=staging",
    ]);
    expect(pinArgs("actions/checkout", "v4")).toEqual(["gh", "api", "--hostname", "github.com", "repos/actions/checkout/commits/v4"]);
  });

  it("GitLab", () => {
    expect(runsArgs(gl, { branch: "main" })).toEqual(["glab", "api", "--hostname", "192.168.20.80", "projects/boris%2Fvterm/pipelines?per_page=30&ref=main"]);
    expect(jobsArgs(gl, "77")[4]).toBe("projects/boris%2Fvterm/pipelines/77/jobs?per_page=100");
    expect(logArgs(gl, "3")[4]).toBe("projects/boris%2Fvterm/jobs/3/trace");
    expect(rerunArgs(gl, "77", true).at(-1)).toBe("projects/boris%2Fvterm/pipelines/77/retry");
    expect(pipelineArgs(gl, "main", { DEPLOY: "staging" })).toEqual([
      "glab", "api", "--hostname", "192.168.20.80", "-X", "POST", "projects/boris%2Fvterm/pipeline",
      "-f", "ref=main", "-F", 'variables=[{"key":"DEPLOY","value":"staging"}]',
    ]);
    expect(pipelineArgs(gl, "main", {})).not.toContain("-F");
  });
});
