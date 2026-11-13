import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureDiag } from "../api/diag";
import { settings } from "../settings/settings.svelte";
import PipelineView from "./PipelineView.svelte";
import type { PipeReader } from "./pipeload";

const clip = vi.hoisted(() => ({ text: "" }));
vi.mock("../app/clipboard", () => ({
  writeClipboard: vi.fn(async (text: string) => {
    clip.text = text;
  }),
  readClipboard: vi.fn(async () => ""),
}));

const reader = (files: Record<string, string> = {}): PipeReader => ({
  read: async (path) => {
    if (!(path in files)) throw new Error("no such file");
    return files[path];
  },
  list: async () => [],
});

const CI = `on:
  push: { branches: [main] }
  pull_request:
jobs:
  lint: { steps: [{ run: pnpm lint }] }
  test:
    strategy: { matrix: { os: [a, b] } }
    steps: []
  build: { needs: [lint, test], steps: [] }
  deploy:
    needs: build
    if: github.event_name == 'push'
    environment: production
    steps: [{ run: ./deploy.sh }]
  ghost: { needs: nope, steps: [] }
`;

beforeEach(() => {
  settings.language = "en";
  clip.text = "";
});
afterEach(() => vi.useRealTimers());

async function view(props: Partial<{ text: string; cursorLine: number | null; files: Record<string, string>; path: string }> = {}) {
  const onjump = vi.fn();
  const onselectjob = vi.fn();
  const r = render(PipelineView, {
    props: {
      path: props.path ?? "/r/.github/workflows/ci.yml",
      text: props.text ?? CI,
      reader: reader(props.files),
      sessionId: "s1",
      cursorLine: props.cursorLine ?? null,
      onjump,
      onselectjob,
    },
  });
  await screen.findByTestId("pipeline-status");
  return { ...r, onjump, onselectjob };
}

describe("PipelineView", () => {
  it("draws the jobs and says what the event does", async () => {
    await view();
    // The events stand in the graph, linked to the jobs the workflow starts with.
    expect(screen.getAllByTestId("pipeline-event")[0]).toHaveAttribute("aria-pressed", "true");
    // Two events, three jobs to start with (a need naming no job waits for nothing).
    expect(document.querySelectorAll(".pipe-edge.trigger").length).toBe(6);
    expect(screen.getAllByTestId("pipeline-event").map((b) => b.textContent?.trim())).toEqual(["push · main", "pull request → main"]);
    // A need that names no job is a problem of the file, not a reason to skip.
    expect(screen.getByTestId("pipeline-status").textContent).toContain("5 of 5 will start");
    expect(document.querySelector('[data-job="deploy"]')?.getAttribute("data-state")).toBe("idle");
    expect(screen.getByText(/needs «nope» — no such job/)).toBeInTheDocument();
    expect(screen.getByText(/files: 1 of 1 read/)).toBeInTheDocument();
  });

  it("plays another event: the job its if leaves out is left out", async () => {
    await view();
    await fireEvent.click(screen.getAllByTestId("pipeline-event")[1]);
    expect(document.querySelector('[data-job="deploy"]')?.getAttribute("data-state")).toBe("skip");
    expect(screen.getByText(/if: github.event_name == 'push' — false/)).toBeInTheDocument();
  });

  it("plays the order wave by wave and stops at an environment", async () => {
    await view();
    vi.useFakeTimers();
    await fireEvent.click(screen.getByTestId("pipeline-play"));
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector('[data-job="lint"]')?.getAttribute("data-state")).toBe("run");
    expect(screen.getByTestId("pipeline-status").textContent).toContain("wave 1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('[data-job="build"]')?.getAttribute("data-state")).toBe("ok");
    expect(document.querySelector('[data-job="deploy"]')?.getAttribute("data-state")).toBe("gate");
    expect(screen.getByTestId("pipeline-status").textContent).toContain("waits for a person");
    await fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.querySelector('[data-job="deploy"]')?.getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("pipeline-status").textContent).toContain("done · waves: 3");
    // Done: the button plays again; while playing, it stops.
    expect(screen.getByTestId("pipeline-play").textContent).toContain("Play");
    await fireEvent.click(screen.getByTestId("pipeline-play"));
    expect(screen.getByTestId("pipeline-play").textContent).toContain("Stop");
    await fireEvent.click(screen.getByTestId("pipeline-play"));
    expect(screen.getByTestId("pipeline-play").textContent).toContain("Play");
  });

  it("shows the job picked and jumps to it in the code", async () => {
    const { onjump, onselectjob } = await view();
    await fireEvent.click(within(document.querySelector('[data-job="deploy"]') as HTMLElement).getByText("deploy"));
    expect(screen.getByText("if: github.event_name == 'push'")).toBeInTheDocument();
    expect(screen.getByText(/will start once approved/)).toBeInTheDocument();
    expect(onselectjob).toHaveBeenLastCalledWith(expect.objectContaining({ line: 10 }));
    await fireEvent.click(screen.getByRole("button", { name: /Open in code/ }));
    expect(onjump).toHaveBeenCalledWith("/r/.github/workflows/ci.yml", 10);
    await fireEvent.click(screen.getByText(/needs «nope» — no such job/));
    expect(onjump).toHaveBeenLastCalledWith("/r/.github/workflows/ci.yml", 15);
  });

  it("picks the job the editor's cursor is in", async () => {
    const { onselectjob } = await view({ cursorLine: 8 });
    await waitFor(() => expect(onselectjob).toHaveBeenLastCalledWith(expect.objectContaining({ line: 6 })));
  });

  it("opens a matrix into its copies", async () => {
    await view();
    await fireEvent.click(screen.getByRole("button", { name: "Show copies" }));
    expect(screen.getByRole("button", { name: "Hide copies" })).toHaveAttribute("aria-expanded", "true");
    expect(within(document.querySelector('[data-job="test"]') as HTMLElement).getByText("a")).toBeInTheDocument();
  });

  it("copies the schema as Mermaid", async () => {
    await view();
    await fireEvent.click(screen.getByRole("button", { name: "Copy as Mermaid" }));
    await waitFor(() => expect(clip.text).toContain("flowchart LR"));
  });

  it("shows GitLab stages, the default branch, and a pipeline GitLab refuses", async () => {
    await view({
      path: "/r/.gitlab-ci.yml",
      text: "stages: [build, deploy]\nb:\n  stage: build\n  rules: [{ if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH }]\n  script: [x]\nd:\n  stage: deploy\n  needs: [b]\n  script: [x]\n",
    });
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Stages" })).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByRole("radio", { name: "Needs" }));
    expect(screen.getByRole("radio", { name: "Needs" })).toHaveAttribute("aria-checked", "true");
    const branch = screen.getByLabelText("Default branch") as HTMLInputElement;
    await fireEvent.input(branch, { target: { value: "trunk" } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-event")[0].textContent).toContain("push · trunk"));
    expect(screen.getByTestId("pipeline-status").textContent).toContain("2 of 2 will start");
    await fireEvent.input(screen.getByLabelText("Branch or tag"), { target: { value: "dev" } });
    await waitFor(() => expect(screen.getByText("GitLab will refuse this pipeline")).toBeInTheDocument());
    expect(screen.getByTestId("pipeline-play")).toBeDisabled();
  });

  it("writes down an include it could not read and lists it", async () => {
    const heard = captureDiag();
    await view({ path: "/r/.gitlab-ci.yml", text: "include: ci/gone.yml\nj:\n  script: [x]\n" });
    await waitFor(() => expect(heard.events().some((e) => e.level === "warn" && e.fields?.path === "/r/ci/gone.yml")).toBe(true));
    heard.stop();
    await fireEvent.click(screen.getByText(/files: 1 of 2 read/));
    expect(screen.getByText(/— not read$/)).toBeInTheDocument();
  });

  it("takes a branch typed for the event", async () => {
    await view();
    const ref = screen.getByLabelText("Branch or tag") as HTMLInputElement;
    await fireEvent.input(ref, { target: { value: "feature/x" } });
    await waitFor(() => expect(screen.getByText(/The pipeline won't start/)).toBeInTheDocument());
    expect(screen.getByTestId("pipeline-status").textContent).toContain("won't start");
  });
});
