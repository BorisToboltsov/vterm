import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../settings/settings.svelte";
import type { EditorDoc } from "../stores/workspaces.svelte";
import PipelinesTab from "./PipelinesTab.svelte";

const tree = vi.hoisted(() => ({ files: {} as Record<string, string>, asked: [] as (string | null)[] }));
vi.mock("../api", () => ({
  connectionFiles: (sessionId: string | null) => {
    tree.asked.push(sessionId);
    return {
      read: async (path: string) => {
        if (!(path in tree.files)) throw new Error("no such file");
        return tree.files[path];
      },
      list: async (dir: string) => {
        const prefix = `${dir}/`;
        const out = new Map<string, { name: string; path: string; isDir: boolean }>();
        for (const p of Object.keys(tree.files)) {
          if (!p.startsWith(prefix)) continue;
          const [name, ...rest] = p.slice(prefix.length).split("/");
          out.set(name, { name, path: prefix + name, isDir: rest.length > 0 });
        }
        if (!out.size) throw new Error("not a folder");
        return [...out.values()];
      },
    };
  },
}));

const doc = (targets: { path: string; isDir: boolean }[], source: "sftp" | "local" = "sftp"): EditorDoc => ({
  id: "d1",
  source,
  path: targets[0].path,
  name: "Pipelines",
  lang: { kind: "plain", label: "Pipelines" },
  content: "",
  baseContent: "",
  baseSha256: "",
  eol: "lf",
  encoding: "utf-8",
  mode: null,
  readOnly: true,
  writeAccess: "unknown",
  saveIssue: "none",
  loading: false,
  loadError: null,
  sudo: false,
  sudoPassword: "",
  gotoLine: null,
  pipelines: { targets },
});

beforeEach(() => {
  settings.language = "en";
  tree.asked = [];
  tree.files = {
    "/r/.github/workflows/ci.yml": "name: CI\non: { push: { branches: [main] }, pull_request: }\njobs:\n  test: { steps: [] }\n  e2e: { needs: test, uses: ./.github/workflows/e2e.yml }\n",
    "/r/.github/workflows/e2e.yml": "name: E2E\non: workflow_call\njobs:\n  smoke: { steps: [] }\n",
    "/r/.github/workflows/release.yml": "name: Release\non: { push: { tags: [v*] } }\njobs:\n  publish: { steps: [] }\n",
    "/r/.github/workflows/docs.yml": "name: Docs\non: { workflow_run: { workflows: [CI] } }\njobs:\n  site: { steps: [] }\n",
  };
});
afterEach(() => vi.useRealTimers());

describe("PipelinesTab", () => {
  it("maps the workflows of a folder through the tab's connection", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    expect(tree.asked).toContain("s1");
    const cards = screen.getAllByTestId("pipeline-card").map((c) => c.textContent);
    expect(cards.find((c) => c?.includes("E2E"))).toContain("called");
    expect(cards.find((c) => c?.includes("Docs"))).toContain("after CI");
    expect(screen.getByText(/Start: CI/)).toBeInTheDocument();
  });

  it("reads a local tab's files on this computer", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }], "local") } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    expect(tree.asked).toEqual([null]);
  });

  it("plays an event as lanes: a call under its caller, a pipeline after the one it waits for, the rest on the shelf", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    vi.useFakeTimers();
    await fireEvent.click(screen.getByTestId("pipelines-play"));
    const W = "/r/.github/workflows";
    const lanes = screen.getAllByTestId("pipeline-lane");
    expect(lanes.map((l) => l.dataset.lane)).toEqual([`${W}/ci.yml`, `${W}/ci.yml>e2e`, `${W}/ci.yml~${W}/docs.yml`]);
    expect(lanes[1].textContent).toContain("called from CI · e2e");
    expect(lanes[2].textContent).toContain("after CI");
    // The tag's pipeline does not run on a push: it waits on the shelf.
    expect(screen.getByText("Not started")).toBeInTheDocument();
    const shelved = screen.getAllByTestId("pipeline-card").filter((c) => c.dataset.shelved);
    expect(shelved.map((c) => c.textContent)).toEqual([expect.stringContaining("Release")]);
    const job = (key: string) => document.querySelector(`[data-job="${key}"]`) as HTMLElement;
    expect(job(`${W}/ci.yml#test`).dataset.state).toBe("wait");
    await vi.advanceTimersByTimeAsync(900);
    expect(job(`${W}/ci.yml#test`).dataset.state).toBe("run");
    expect(job(`${W}/ci.yml>e2e#smoke`).dataset.state).toBe("wait");
    expect(screen.getByTestId("pipelines-status").textContent).toContain("wave 1");
    expect(screen.getByText("Wave 1").className).toContain("text-accent");
    await vi.advanceTimersByTimeAsync(10000);
    for (const key of [`${W}/ci.yml#test`, `${W}/ci.yml>e2e#smoke`, `${W}/ci.yml~${W}/docs.yml#site`]) expect(job(key).dataset.state).toBe("ok");
    expect(screen.getByTestId("pipelines-status").textContent).toContain("done · waves: 3");
    expect(screen.getAllByTestId("pipeline-lane").map((l) => l.dataset.state)).toEqual(["ok", "ok", "ok"]);
    // The lanes stay after the run; the map takes the cards back.
    await fireEvent.click(screen.getByRole("button", { name: /Map/ }));
    expect(screen.queryAllByTestId("pipeline-lane")).toHaveLength(0);
    expect(screen.queryByTestId("pipelines-status")).toBeNull();
    expect(screen.getAllByTestId("pipeline-card").filter((c) => c.dataset.shelved)).toHaveLength(0);
  });

  it("stops at an approval in its lane and goes on once it is given", async () => {
    tree.files = {
      "/r/.github/workflows/train.yml": "name: Train\non: { push: { branches: [main] } }\njobs:\n  check: { steps: [] }\n  cut: { needs: check, environment: release, steps: [] }\n",
    };
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(1));
    vi.useFakeTimers();
    await fireEvent.click(screen.getByTestId("pipelines-play"));
    await vi.advanceTimersByTimeAsync(5000);
    const cut = () => document.querySelector('[data-job="/r/.github/workflows/train.yml#cut"]') as HTMLElement;
    expect(cut().dataset.state).toBe("gate");
    expect(screen.getByTestId("pipelines-status").textContent).toContain("waits for a person");
    await fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(cut().dataset.state).toBe("ok");
    expect(screen.getByTestId("pipelines-status").textContent).toContain("done · waves: 2");
  });

  it("stops a run and plays it again", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    vi.useFakeTimers();
    await fireEvent.click(screen.getByTestId("pipelines-play"));
    await vi.advanceTimersByTimeAsync(900);
    expect(screen.getByTestId("pipelines-play").textContent).toContain("Stop");
    await fireEvent.click(screen.getByTestId("pipelines-play"));
    expect(screen.getByTestId("pipelines-play").textContent).toContain("Play");
    expect(screen.queryByTestId("pipelines-status")).toBeNull();
    // Stopped, the lanes stay with nothing running.
    expect(screen.getAllByTestId("pipeline-lane")).toHaveLength(3);
    expect(document.querySelector('[data-job="/r/.github/workflows/ci.yml#test"]')?.getAttribute("data-state")).toBe("idle");
  });

  it("shows the lines and the jobs when stopped before the cards have landed", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    vi.useFakeTimers();
    await fireEvent.click(screen.getByTestId("pipelines-play"));
    // The glide hides the lines and holds the jobs at their lane's start.
    expect(document.querySelector(".pipe-links")?.classList.contains("hidden-links")).toBe(true);
    expect(screen.getAllByTestId("pipeline-lane-job")[0].classList.contains("entering")).toBe(true);
    await fireEvent.click(screen.getByTestId("pipelines-play"));
    expect(document.querySelector(".pipe-links")?.classList.contains("hidden-links")).toBe(false);
    expect(screen.getAllByTestId("pipeline-lane-job")[0].classList.contains("entering")).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".pipe-links")?.classList.contains("hidden-links")).toBe(false);
  });

  it("shows the tag's pipeline and nothing for a pull request's", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    const events = () => within(screen.getByTestId("pipelines-tab")).getAllByRole("button", { pressed: false });
    await fireEvent.click(events().find((b) => b.textContent?.includes("tag v1.0.0"))!);
    expect(screen.getByText(/Start: Release/)).toBeInTheDocument();
  });

  it("opens a pipeline's own graph and its file", async () => {
    const onOpenFile = vi.fn();
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]), onOpenFile } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    await fireEvent.click(screen.getAllByTestId("pipeline-card").find((c) => c.textContent?.includes("CI"))!);
    expect(await screen.findByTestId("pipeline-view")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Open file/ }));
    expect(onOpenFile).toHaveBeenCalledWith("/r/.github/workflows/ci.yml");
    await fireEvent.click(screen.getByRole("button", { name: "All pipelines" }));
    expect(screen.queryByTestId("pipeline-view")).toBeNull();
  });

  it("says when there are no pipelines and names what it could not read", async () => {
    tree.files = { "/r/src/a.c": "x" };
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/src", isDir: true }]) } });
    expect(await screen.findByText("No pipeline files here")).toBeInTheDocument();
  });

  it("reads again on asking", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    delete tree.files["/r/.github/workflows/docs.yml"];
    await fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(3));
  });
});
