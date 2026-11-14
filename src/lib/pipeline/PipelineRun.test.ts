import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipeReader } from "./pipeload";

// The schema with a real run on it (ADR 0069): vterm's release v1.34.0 as
// GitHub answered it, over the release workflow of this repository; and the
// security checks and the start form of a workflow.

const ROOT = process.cwd();
const ci = (f: string) => readFileSync(join(ROOT, "src", "lib", "ci", f), "utf8");
const RUN = JSON.parse(ci("ciparse.release-run.json")) as Record<string, unknown>;
const JOBS = ci("ciparse.release-jobs.json");
const RELEASE = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

const env = vi.hoisted(() => ({ calls: [] as { args: string[]; mirror: boolean }[], atCommit: true }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  gitRun: vi.fn(async (_s: string, _cwd: string, args: string[]) => {
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "rev-parse") return ok("/repo\n");
    if (args[0] === "remote") return ok("origin\thttps://github.com/BorisToboltsov/vterm.git (fetch)\n");
    if (args[0] === "show") return env.atCommit ? ok(RELEASE) : { stdout: "", stderr: "fatal: bad object", exitCode: 128 };
    return { stdout: "", stderr: "", exitCode: 1 };
  }),
  ciRun: vi.fn(async (_s: string, args: string[], _t: number, mirror: boolean) => {
    env.calls.push({ args, mirror });
    const endpoint = args.at(-1) ?? "";
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (/\/commits\/v4$/.test(endpoint)) return ok(JSON.stringify({ sha: "c".repeat(40) }));
    if (/\/jobs\?/.test(endpoint)) return ok(JOBS);
    if (/\/workflows\/release\.yml\/runs/.test(endpoint)) return ok(JSON.stringify({ workflow_runs: [RUN] }));
    return ok("");
  }),
}));

import PipelineView from "./PipelineView.svelte";
import { settings } from "../settings/settings.svelte";

/** The repository's files, as the connection would read them. */
const reader: PipeReader = {
  read: async (path) => readFileSync(join(ROOT, path.replace(/^\/repo\//, "")), "utf8"),
  list: async () => [],
};

beforeEach(() => {
  settings.language = "en";
  env.calls.length = 0;
  env.atCommit = true;
});

describe("a real run on the schema", () => {
  it("in time: the file's jobs in order, the called ones under their callers, the path that decided the length", async () => {
    render(PipelineView, { props: { path: "/repo/.github/workflows/release.yml", text: RELEASE, reader, sessionId: "s1" } });
    await fireEvent.click(await screen.findByTestId("pipeline-source-run"));
    const rows = await screen.findAllByTestId("timeline-row");
    expect(rows).toHaveLength(15);
    expect(rows[0]).toHaveTextContent("Тег = версия");
    expect(rows.filter((r) => r.dataset.critical === "true").map((r) => r.textContent?.trim().split(/\s{2,}/)[0])).toHaveLength(4);
    expect(screen.getByTestId("timeline-path")).toHaveTextContent(/Тег = версия → Фаззинг недоверенного входа 8 min 12 s → release \(macos-latest/);
    expect(screen.getByTestId("pipeline-run-note")).toHaveTextContent("of the file at the run's commit fb8e8d5");
    expect(screen.getByTestId("pipeline-run-note")).toHaveTextContent("13 of 13 jobs placed");
    // Only reads: the runs of this one file, its jobs.
    expect(env.calls.map((c) => [c.args.at(-1), c.mirror])).toEqual([
      ["repos/BorisToboltsov/vterm/actions/workflows/release.yml/runs?per_page=30", false],
      ["repos/BorisToboltsov/vterm/actions/runs/42701787236/jobs?per_page=100&filter=latest", false],
    ]);
  });

  it("in order: the graph, each job with its real state and length; a commit not here says so", async () => {
    env.atCommit = false;
    render(PipelineView, { props: { path: "/repo/.github/workflows/release.yml", text: RELEASE, reader, sessionId: "s1" } });
    await fireEvent.click(await screen.findByTestId("pipeline-source-run"));
    await screen.findAllByTestId("timeline-row");
    await fireEvent.click(screen.getByRole("radio", { name: "Order" }));
    await waitFor(() => expect(document.querySelector('[data-job="integrity"]')).toHaveAttribute("data-state", "ok"));
    expect(within(document.querySelector('[data-job="release"]') as HTMLElement).getByTestId("pipe-note")).toHaveTextContent("13:19");
    expect(screen.getByTestId("pipeline-run-note")).toHaveTextContent("is not here (not fetched)");
  });
});

const PR_PREVIEW = `name: PR preview
on:
  pull_request_target:
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: echo "\${{ github.event.pull_request.title }}"
`;

describe("the security of the file", () => {
  it("lists what lets someone else's code run, and pins actions by SHA in one edit", async () => {
    const onedit = vi.fn();
    render(PipelineView, { props: { path: "/repo/.github/workflows/pr.yml", text: PR_PREVIEW, reader, sessionId: "s1", onedit } });
    const section = await screen.findByTestId("pipeline-security");
    expect(section).toHaveTextContent("Security");
    const findings = screen.getAllByTestId("pipeline-finding");
    expect(findings[0]).toHaveTextContent("Code of a pull request runs with the repository's token");
    expect(findings[1]).toHaveTextContent("github.event.pull_request.title");
    const unpinned = findings.find((f) => f.textContent?.includes("Actions used by tag"))!;
    await fireEvent.click(within(unpinned).getByRole("button", { expanded: false }));
    await fireEvent.click(await screen.findByTestId("pipeline-pin"));
    await waitFor(() => expect(onedit).toHaveBeenCalledOnce());
    expect(onedit.mock.calls[0][0]).toContain(`uses: actions/checkout@${"c".repeat(40)} # v4`);
    expect(env.calls.at(-1)).toEqual({ args: ["gh", "api", "--hostname", "github.com", "repos/actions/checkout/commits/v4"], mirror: false });
  });
});

describe("starting a workflow by hand", () => {
  const DEPLOY = `on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
      version:
        required: true
jobs:
  go: { steps: [{ run: ./deploy.sh }] }
`;

  it("the file's form; a required input stops it; production is said in red before the start", async () => {
    render(PipelineView, { props: { path: "/repo/.github/workflows/deploy.yml", text: DEPLOY, reader, sessionId: "s1" } });
    const form = await screen.findByTestId("pipeline-start-form");
    await fireEvent.click(within(form).getByTestId("pipeline-start"));
    expect(within(form).getByText("Required")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await fireEvent.input(within(form).getByLabelText("version *"), { target: { value: "1.35.0" } });
    await fireEvent.change(within(form).getByLabelText("environment"), { target: { value: "production" } });
    await fireEvent.click(within(form).getByTestId("pipeline-start"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Set to production: environment");
    expect(dialog).toHaveTextContent("environment=production version=1.35.0");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(env.calls.find((c) => c.mirror)?.args).toEqual([
      "gh", "api", "--hostname", "github.com", "-X", "POST", "repos/BorisToboltsov/vterm/actions/workflows/deploy.yml/dispatches",
      "-f", "ref=main", "-f", "inputs[environment]=production", "-f", "inputs[version]=1.35.0",
    ]));
  });
});
