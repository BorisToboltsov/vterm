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

  it("plays an event across the map, and a call with it", async () => {
    render(PipelinesTab, { props: { sessionId: "s1", doc: doc([{ path: "/r/.github/workflows", isDir: true }]) } });
    await waitFor(() => expect(screen.getAllByTestId("pipeline-card")).toHaveLength(4));
    vi.useFakeTimers();
    await fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    await vi.advanceTimersByTimeAsync(10000);
    const e2e = screen.getAllByTestId("pipeline-card").find((c) => c.textContent?.includes("E2E"))!;
    expect(e2e.className).toContain("border-ok");
    const docs = screen.getAllByTestId("pipeline-card").find((c) => c.textContent?.includes("Docs"))!;
    expect(docs.className).toContain("border-ok");
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
