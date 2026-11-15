import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The CI panel (ADR 0069, 0070) over vterm's own repository: its workflow files
// read from this checkout as the session's connection would read them, its runs
// as GitHub answered them — one run turned failed, with a failing job and its
// log, to have something to show.

const here = (f: string) => readFileSync(join(process.cwd(), "src", "lib", "ci", f), "utf8");
const RUNS = JSON.parse(here("ciparse.runs.json")) as { workflow_runs: Record<string, unknown>[] };
RUNS.workflow_runs[2] = { ...RUNS.workflow_runs[2], conclusion: "failure", display_title: "feat: CI runs panel" };
const CI_RUN = String(RUNS.workflow_runs[2].id);
const JOBS = JSON.parse(here("ciparse.release-jobs.json")) as { jobs: Record<string, unknown>[] };
JOBS.jobs[0] = { ...JOBS.jobs[0], conclusion: "failure" };
/** The jobs of CI #421: ci.yml's own, as the release ran them, the first one failed. */
const CI_JOBS = {
  jobs: JOBS.jobs
    .filter((j) => String(j.name).startsWith("Гейты качества / "))
    .map((j, i) => ({ ...j, name: String(j.name).replace("Гейты качества / ", ""), conclusion: i === 0 ? "failure" : "success" })),
};
const LOG = "2026-11-09T21:21:56.1Z  FAIL  src/lib/ci/cirun.test.ts > jobKey\n2026-11-09T21:21:56.2Z  ❯ src/lib/ci/cirun.test.ts:48:31\n2026-11-09T21:21:56.3Z ##[error]Process completed with exit code 1.\n";

const env = vi.hoisted(() => ({
  calls: [] as { args: string[]; mirror: boolean }[],
  reads: [] as string[],
  signedIn: true,
  remote: "origin\thttps://github.com/BorisToboltsov/vterm.git (fetch)\n",
}));

/** A path of the session's repository `/r` is this checkout's. */
const disk = (path: string) => join(process.cwd(), path.replace(/^\/r\/?/, ""));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  gitRun: vi.fn(async (_s: string, _cwd: string, args: string[]) => {
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/r\n");
    if (args[0] === "remote") return ok(env.remote);
    if (args[0] === "rev-parse" && args.includes("HEAD:src/lib/ci/cirun.test.ts")) return ok("abc\n");
    return { stdout: "", stderr: "fatal", exitCode: 128 };
  }),
  connectionFiles: vi.fn(() => ({
    read: async (path: string) => {
      env.reads.push(path);
      return readFileSync(disk(path), "utf8");
    },
    list: async (dir: string) => {
      env.reads.push(dir);
      return readdirSync(disk(dir)).map((name) => ({ name, path: `${dir}/${name}`, isDir: statSync(join(disk(dir), name)).isDirectory() }));
    },
  })),
  ciRun: vi.fn(async (_s: string, args: string[], _t: number, mirror: boolean) => {
    env.calls.push({ args, mirror });
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[1] === "auth") return env.signedIn ? ok("") : { stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login", exitCode: 1 };
    const endpoint = args.find((a) => a.startsWith("repos/") || a.startsWith("projects/")) ?? "";
    if (args.includes("POST")) return ok("");
    if (/\/jobs\/\d+\/logs$/.test(endpoint)) return ok(LOG);
    if (/\/runs\/\d+\/jobs/.test(endpoint)) return ok(JSON.stringify(endpoint.includes(`/runs/${CI_RUN}/`) ? CI_JOBS : JOBS));
    if (/\/actions\/runs/.test(endpoint)) return ok(JSON.stringify(RUNS));
    return ok("[]");
  }),
}));

import CiPanel from "./CiPanel.svelte";
import { settings } from "../settings/settings.svelte";

beforeEach(() => {
  env.calls.length = 0;
  env.reads.length = 0;
  env.signedIn = true;
  env.remote = "origin\thttps://github.com/BorisToboltsov/vterm.git (fetch)\n";
  settings.ciForges = {};
  settings.ciTab = "pipelines";
});

const show = (props: Record<string, unknown> = {}) =>
  render(CiPanel, { props: { sessionId: "s1", visible: true, sessionReady: true, terminalCwd: "/r", ...props } });

/** The runs' tab, once the panel has found the repository. */
async function runsTab() {
  await fireEvent.click(await screen.findByTestId("ci-tab-runs"));
  await waitFor(() => expect(screen.getAllByTestId("ci-run")).toHaveLength(4));
}

const jobReads = () => env.calls.filter((c) => /\/runs\/\d+\/jobs/.test(c.args.find((a) => a.startsWith("repos/")) ?? ""));
const pipe = (name: string) => screen.getAllByTestId("ci-pipe").find((el) => el.textContent?.includes(name))!;

describe("CI panel — the runs", () => {
  it("lists the runs of the terminal's repository; a failed run opens on its failed job and its log", async () => {
    const onOpenFile = vi.fn();
    show({ onOpenFile });
    await runsTab();
    await fireEvent.click(screen.getAllByTestId("ci-run")[2]);
    const detail = await screen.findByTestId("ci-run-detail");
    expect(within(detail).getByText("feat: CI runs panel")).toBeInTheDocument();
    // The failed job is opened by itself, its steps and the end of its log shown.
    const log = await screen.findByTestId("ci-log");
    await waitFor(() => expect(within(log).getByText("Process completed with exit code 1.")).toHaveClass("text-bad"));
    // The log names a file of the repository: "To line" takes there.
    await fireEvent.click(await within(log).findByText("To line 48"));
    expect(onOpenFile).toHaveBeenCalledWith("/r/src/lib/ci/cirun.test.ts", 48);
    // Reads only — nothing was recorded as a write.
    expect(env.calls.every((c) => !c.mirror)).toBe(true);
  });

  it("draws each run's jobs as the dots of its workflow, coloured once they were read", async () => {
    show();
    await runsTab();
    const ci = screen.getAllByTestId("ci-run")[2];
    await waitFor(() => expect(within(ci).getByTestId("pipe-dots").querySelector('[data-state="fail"]')).not.toBeNull());
    expect(within(ci).getByTestId("pipe-dots").querySelectorAll('[data-state="ok"]').length).toBeGreaterThan(0);
  });

  it("re-runs the failed jobs after a question, recorded as a write", async () => {
    show();
    await runsTab();
    await fireEvent.click(screen.getAllByTestId("ci-run")[2]);
    await fireEvent.click(await screen.findByTestId("ci-rerun-failed"));
    expect(env.calls.some((c) => c.mirror)).toBe(false);
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Re-run failed" }));
    await waitFor(() => expect(env.calls.find((c) => c.mirror)?.args.at(-1)).toMatch(/\/actions\/runs\/\d+\/rerun-failed-jobs$/));
  });

  it("keeps the tab picked last", async () => {
    const first = show();
    await runsTab();
    expect(settings.ciTab).toBe("runs");
    first.unmount();
    show();
    await waitFor(() => expect(screen.getAllByTestId("ci-run")).toHaveLength(4));
    expect(screen.getByTestId("ci-tab-runs")).toHaveAttribute("aria-checked", "true");
  });
});

describe("CI panel — the pipelines (ADR 0070)", () => {
  it("opens on the repository's pipeline files, each with its latest run and its dots", async () => {
    show();
    await waitFor(() => expect(screen.getAllByTestId("ci-pipe")).toHaveLength(6));
    expect(screen.getByTestId("ci-tab-pipelines")).toHaveAttribute("aria-checked", "true");
    // Read through the session's connection: the workflows folder and its files.
    expect(env.reads).toContain("/r/.github/workflows/ci.yml");
    // CI's latest run (#421, failed) coloured its dots once its jobs were read.
    await waitFor(() => expect(within(pipe("CI")).getByTestId("pipe-dots").querySelector('[data-state="fail"]')).not.toBeNull());
    expect(within(pipe("CI")).getByText("#421")).toBeInTheDocument();
    expect(within(pipe("Release")).getByText("—")).toBeInTheDocument();
  });

  it("reads the jobs of each pipeline's latest run once a run has ended", async () => {
    show();
    await waitFor(() => expect(jobReads()).toHaveLength(4));
    await fireEvent.click(screen.getByRole("button", { name: "Read the runs and the pipelines again" }));
    await waitFor(() => expect(env.calls.filter((c) => /\/actions\/runs\?/.test(c.args.join(" "))).length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(jobReads()).toHaveLength(4);
  });

  it("leads into the schema: the file, its event played, its latest run, its start form, the map", async () => {
    const onOpenPipeline = vi.fn();
    const onOpenSchema = vi.fn();
    const onPipelines = vi.fn();
    show({ onOpenPipeline, onOpenSchema, onPipelines });
    await waitFor(() => expect(screen.getAllByTestId("ci-pipe")).toHaveLength(6));
    await fireEvent.click(pipe("Train"));
    const detail = await screen.findByTestId("ci-pipe-detail");
    await fireEvent.click(within(detail).getByTestId("ci-pipe-schema"));
    expect(onOpenPipeline).toHaveBeenLastCalledWith("/r/.github/workflows/train.yml", null);
    await fireEvent.click(within(detail).getByTestId("ci-pipe-play"));
    expect(onOpenPipeline).toHaveBeenLastCalledWith("/r/.github/workflows/train.yml", "play");
    // Train has `workflow_dispatch`: it can be started — on the schema's own form.
    await fireEvent.click(await within(detail).findByTestId("ci-pipe-start"));
    expect(onOpenPipeline).toHaveBeenLastCalledWith("/r/.github/workflows/train.yml", "start");
    await fireEvent.click(within(detail).getByTestId("ci-pipe-last"));
    expect(onOpenSchema.mock.calls[0][0]).toBe("/r/.github/workflows/train.yml");
    expect(onOpenSchema.mock.calls[0][2]).toMatchObject({ workflow: "Train", number: 35 });
    await fireEvent.click(screen.getByTestId("ci-pipes-map"));
    expect(onPipelines).toHaveBeenCalledWith([{ path: "/r", isDir: true }]);
    // CI has no `workflow_dispatch`: nothing to start by hand.
    await fireEvent.click(within(detail).getByTestId("ci-pipe-back"));
    await fireEvent.click(pipe("CI"));
    expect(within(await screen.findByTestId("ci-pipe-detail")).queryByTestId("ci-pipe-start")).toBeNull();
  });

  it("«All runs» shows that pipeline's runs alone", async () => {
    show();
    await waitFor(() => expect(screen.getAllByTestId("ci-pipe")).toHaveLength(6));
    await fireEvent.click(pipe("Train"));
    await fireEvent.click(await screen.findByTestId("ci-pipe-allruns"));
    await waitFor(() => expect(screen.getAllByTestId("ci-run")).toHaveLength(1));
    expect(screen.getAllByTestId("ci-run")[0].textContent).toContain("Train");
  });

  it("signed out: the pipelines stand, a line says why there are no runs and signs in", async () => {
    env.signedIn = false;
    const onTypeInTerminal = vi.fn();
    show({ onTypeInTerminal });
    const note = await screen.findByTestId("ci-runs-note");
    expect(note.textContent).toContain("gh is not signed in to github.com");
    await waitFor(() => expect(screen.getAllByTestId("ci-pipe")).toHaveLength(6));
    expect(screen.queryByTestId("ci-pipe-start")).toBeNull();
    await fireEvent.click(within(note).getByText("Sign in in the terminal"));
    expect(onTypeInTerminal).toHaveBeenCalledWith(["gh", "auth", "login", "--hostname", "github.com"]);
    // No list was asked for — and the runs' tab says why.
    expect(env.calls.filter((c) => c.args[1] === "api")).toEqual([]);
    await fireEvent.click(screen.getByTestId("ci-tab-runs"));
    expect(await screen.findByText("gh is not signed in to github.com")).toBeInTheDocument();
  });

  it("a host that says nothing is asked about once, then kept", async () => {
    env.remote = "origin\thttps://10.0.0.5/team/app.git (fetch)\n";
    show();
    expect((await screen.findByTestId("ci-runs-note")).textContent).toContain("What runs on 10.0.0.5?");
    await fireEvent.click(screen.getByRole("button", { name: "GitLab" }));
    expect(settings.ciForges).toEqual({ "10.0.0.5": "gitlab" });
    await waitFor(() => expect(env.calls[0]?.args).toEqual(["glab", "auth", "status", "--hostname", "10.0.0.5"]));
  });

  it("hidden, it asks nothing of the forge and reads no file", async () => {
    show({ visible: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(env.calls).toEqual([]);
    expect(env.reads).toEqual([]);
  });
});
