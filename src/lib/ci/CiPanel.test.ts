import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The CI panel (ADR 0069) over vterm's own runs as GitHub answered them; one
// run turned failed, with a failing job and its log, to have something to show.

const here = (f: string) => readFileSync(join(process.cwd(), "src", "lib", "ci", f), "utf8");
const RUNS = JSON.parse(here("ciparse.runs.json")) as { workflow_runs: Record<string, unknown>[] };
RUNS.workflow_runs[2] = { ...RUNS.workflow_runs[2], conclusion: "failure", display_title: "feat: CI runs panel" };
const JOBS = JSON.parse(here("ciparse.release-jobs.json")) as { jobs: Record<string, unknown>[] };
JOBS.jobs[0] = { ...JOBS.jobs[0], conclusion: "failure" };
const LOG = "2026-11-09T21:21:56.1Z  FAIL  src/lib/ci/cirun.test.ts > jobKey\n2026-11-09T21:21:56.2Z  ❯ src/lib/ci/cirun.test.ts:48:31\n2026-11-09T21:21:56.3Z ##[error]Process completed with exit code 1.\n";

const env = vi.hoisted(() => ({
  calls: [] as { args: string[]; mirror: boolean }[],
  signedIn: true,
  remote: "origin\thttps://github.com/BorisToboltsov/vterm.git (fetch)\n",
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  gitRun: vi.fn(async (_s: string, _cwd: string, args: string[]) => {
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/r\n");
    if (args[0] === "remote") return ok(env.remote);
    if (args[0] === "rev-parse" && args.includes("HEAD:src/lib/ci/cirun.test.ts")) return ok("abc\n");
    return { stdout: "", stderr: "fatal", exitCode: 128 };
  }),
  ciRun: vi.fn(async (_s: string, args: string[], _t: number, mirror: boolean) => {
    env.calls.push({ args, mirror });
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[1] === "auth") return env.signedIn ? ok("") : { stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login", exitCode: 1 };
    const endpoint = args.find((a) => a.startsWith("repos/") || a.startsWith("projects/")) ?? "";
    if (args.includes("POST")) return ok("");
    if (/\/jobs\/\d+\/logs$/.test(endpoint)) return ok(LOG);
    if (/\/runs\/\d+\/jobs/.test(endpoint)) return ok(JSON.stringify(JOBS));
    if (/\/actions\/runs/.test(endpoint)) return ok(JSON.stringify(RUNS));
    return ok("[]");
  }),
}));

import CiPanel from "./CiPanel.svelte";
import { settings } from "../settings/settings.svelte";

beforeEach(() => {
  env.calls.length = 0;
  env.signedIn = true;
  env.remote = "origin\thttps://github.com/BorisToboltsov/vterm.git (fetch)\n";
  settings.ciForges = {};
});

const show = (props: Record<string, unknown> = {}) =>
  render(CiPanel, { props: { sessionId: "s1", visible: true, sessionReady: true, terminalCwd: "/r", ...props } });

describe("CI panel", () => {
  it("lists the runs of the terminal's repository; a failed run opens on its failed job and its log", async () => {
    const onOpenFile = vi.fn();
    show({ onOpenFile });
    await waitFor(() => expect(screen.getAllByTestId("ci-run")).toHaveLength(4));
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

  it("re-runs the failed jobs after a question, recorded as a write", async () => {
    show();
    await waitFor(() => expect(screen.getAllByTestId("ci-run")).toHaveLength(4));
    await fireEvent.click(screen.getAllByTestId("ci-run")[2]);
    await fireEvent.click(await screen.findByTestId("ci-rerun-failed"));
    expect(env.calls.some((c) => c.mirror)).toBe(false);
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Re-run failed" }));
    await waitFor(() => expect(env.calls.find((c) => c.mirror)?.args.at(-1)).toMatch(/\/actions\/runs\/\d+\/rerun-failed-jobs$/));
  });

  it("signed out: says so, and signs in in the tab's terminal", async () => {
    env.signedIn = false;
    const onTypeInTerminal = vi.fn();
    show({ onTypeInTerminal });
    expect(await screen.findByText("gh is not signed in to github.com")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("Sign in in the terminal"));
    expect(onTypeInTerminal).toHaveBeenCalledWith(["gh", "auth", "login", "--hostname", "github.com"]);
    // No list was asked for.
    expect(env.calls.filter((c) => c.args[1] === "api")).toEqual([]);
  });

  it("a host that says nothing is asked about once, then kept", async () => {
    env.remote = "origin\thttps://10.0.0.5/team/app.git (fetch)\n";
    show();
    expect(await screen.findByText("What runs on 10.0.0.5?")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "GitLab" }));
    expect(settings.ciForges).toEqual({ "10.0.0.5": "gitlab" });
    await waitFor(() => expect(env.calls[0]?.args).toEqual(["glab", "auth", "status", "--hostname", "10.0.0.5"]));
  });

  it("hidden, it asks nothing of the forge", async () => {
    show({ visible: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(env.calls).toEqual([]);
  });
});
