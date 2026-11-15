import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Scenarios panel (ADR 0071): the library, a recipe picked, a check and a
// run on servers of the catalog, prod asked about, the runs tab.

const env = vi.hoisted(() => ({
  runs: [] as { sid: string; mode: string }[],
  saved: [] as string[],
  deleted: [] as string[],
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  recipesScan: vi.fn(async () => ({
    dir: "/data/scripts",
    files: [
      { path: "/data/scripts/mine.sh", dir: "/data/scripts", name: "mine.sh", text: "# vterm:\n#   name: Mine\n#   check: true\n#   params:\n#     WHO: { label: Who, required: true }\n", modified: 0 },
      { path: "/repo/plain.sh", dir: "/repo", name: "plain.sh", text: "echo hi\n", modified: 0 },
    ],
    unreadable: ["/gone"],
    skipped: 0,
  })),
  recipeRun: vi.fn(async (sid: string, r: { mode: string }) => {
    env.runs.push({ sid, mode: r.mode });
    return r.mode === "check" ? { stdout: "would change\n", stderr: "", exitCode: 1 } : { stdout: "done\n", stderr: "", exitCode: 0 };
  }),
  recipeSave: vi.fn(async (name: string) => {
    env.saved.push(name);
    return `/data/scripts/${name}`;
  }),
  recipeDelete: vi.fn(async (path: string) => void env.deleted.push(path)),
}));

import { settings } from "../settings/settings.svelte";
import type { ServerProfile } from "../types";
import ScenariosPanel from "./ScenariosPanel.svelte";
import { clearRecipeRuns } from "../stores/scenarios.svelte";

const server = (id: string, prod = false): ServerProfile => ({
  id,
  alias: id,
  host: `${id}.lan`,
  port: 22,
  username: "deploy",
  authMethod: "key",
  keyPath: null,
  hasSavedPassword: false,
  group: "web",
  tags: [],
  prod,
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
});

const servers = [server("web-1"), server("db-1", true)];

function show(props: Record<string, unknown> = {}) {
  const ensure = vi.fn(async (id: string) => `s-${id}`);
  const onEditRecipe = vi.fn();
  const onOpenProject = vi.fn();
  const onAsk = vi.fn();
  render(ScenariosPanel, {
    props: { visible: true, servers, connected: new Set(["web-1"]), ensureSession: ensure, onEditRecipe, onOpenProject, onAsk, ...props },
  });
  return { ensure, onEditRecipe, onOpenProject, onAsk };
}

beforeEach(() => {
  env.runs.length = 0;
  env.saved.length = 0;
  env.deleted.length = 0;
  settings.scenarioTab = "library";
  clearRecipeRuns();
  settings.scenarioSources = ["/repo"];
  settings.scenarioProjects = [{ kind: "ansible", root: "/srv/infra/ansible", serverId: "web-1" }];
});

describe("Scenarios panel", () => {
  it("lists projects, the user's recipes, a source folder and the built-in ones; names what it could not read", async () => {
    show();
    await screen.findByText("mine.sh");
    expect(screen.getByText("plain.sh")).toBeInTheDocument();
    expect(screen.getByText("Install Docker")).toBeInTheDocument();
    expect(screen.getByText("ansible")).toBeInTheDocument();
    expect(screen.getByText("Not read: /gone")).toBeInTheDocument();
    expect(screen.getByText("no header")).toBeInTheDocument();
    // The filter narrows every group.
    await fireEvent.input(screen.getByTestId("scenarios-filter"), { target: { value: "docker" } });
    expect(screen.queryByText("mine.sh")).toBeNull();
    expect(screen.getByText("Install Docker")).toBeInTheDocument();
  });

  it("checks a recipe on the servers picked, then runs it; prod is asked about first", async () => {
    show();
    await fireEvent.click(await screen.findByText("Install Docker"));
    const detail = await screen.findByTestId("recipe-detail");
    // Nothing picked: said, not run.
    await fireEvent.click(within(detail).getByTestId("recipe-check"));
    expect(within(detail).getByRole("alert")).toHaveTextContent("Pick at least one server");
    const rows = within(detail).getAllByTestId("target-row");
    await fireEvent.click(within(rows[0]).getByRole("checkbox"));
    await fireEvent.click(within(rows[1]).getByRole("checkbox"));
    expect(within(detail).getByText(/Prod among the servers: db-1/)).toBeInTheDocument();
    await fireEvent.click(within(detail).getByTestId("recipe-check"));
    await waitFor(() => expect(env.runs).toHaveLength(2));
    expect(env.runs.every((r) => r.mode === "check")).toBe(true);
    await waitFor(() => expect(within(detail).getAllByText(/would change/).length).toBeGreaterThan(0));
    // A run on prod asks first.
    await fireEvent.click(within(detail).getByTestId("recipe-run"));
    expect(await screen.findByText("Run «Install Docker» on prod?")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(env.runs.filter((r) => r.mode === "apply")).toHaveLength(2));
  });

  it("asks for a required value and a sudo password before a run", async () => {
    show();
    await fireEvent.click(await screen.findByText("mine.sh"));
    const detail = await screen.findByTestId("recipe-detail");
    await fireEvent.click(within(within(detail).getAllByTestId("target-row")[0]).getByRole("checkbox"));
    await fireEvent.click(within(detail).getByTestId("recipe-run"));
    expect(within(detail).getByRole("alert")).toHaveTextContent("«Who» is needed");
    await fireEvent.input(within(detail).getByLabelText(/Who/), { target: { value: "me" } });
    await fireEvent.click(within(detail).getByLabelText("sudo with a password"));
    await fireEvent.click(within(detail).getByTestId("recipe-run"));
    expect(within(detail).getByRole("alert")).toHaveTextContent("Enter the sudo password");
  });

  it("copies a built-in recipe into «Mine», opens the user's in the editor, deletes after asking", async () => {
    const { onEditRecipe } = show();
    await fireEvent.click(await screen.findByText("Install Docker"));
    await fireEvent.click(screen.getByRole("button", { name: "Copy into «Mine»" }));
    await waitFor(() => expect(env.saved).toEqual(["install-docker.sh"]));
    await fireEvent.click(await screen.findByText("mine.sh"));
    await fireEvent.click(screen.getByRole("button", { name: "Open in the editor" }));
    expect(onEditRecipe).toHaveBeenCalledWith("/data/scripts/mine.sh");
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete mine.sh?")).toBeInTheDocument();
    await fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() => expect(env.deleted).toEqual(["/data/scripts/mine.sh"]));
  });

  it("opens a pinned project and unpins it", async () => {
    const { onOpenProject } = show();
    await fireEvent.click(await screen.findByText("ansible"));
    const card = screen.getByTestId("project-card");
    await fireEvent.click(within(card).getByRole("button", { name: "Open the project" }));
    expect(onOpenProject).toHaveBeenCalledWith({ kind: "ansible", root: "/srv/infra/ansible", serverId: "web-1" });
    await fireEvent.click(within(card).getByRole("button", { name: "Unpin" }));
    expect(settings.scenarioProjects).toEqual([]);
  });

  it("makes a new recipe from its name and opens it", async () => {
    const { onEditRecipe } = show();
    await fireEvent.click(screen.getByTestId("scenarios-add"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "New recipe…" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Restart nginx" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onEditRecipe).toHaveBeenCalledWith("/data/scripts/restart-nginx.sh"));
  });

  it("shows the runs, server by server, and sends a failure to the assistant", async () => {
    const { recipeRun } = await import("../api");
    vi.mocked(recipeRun).mockResolvedValueOnce({ stdout: "", stderr: "boom\n", exitCode: 3 });
    const { onAsk } = show();
    await fireEvent.click(await screen.findByText("Install Docker"));
    const detail = await screen.findByTestId("recipe-detail");
    await fireEvent.click(within(within(detail).getAllByTestId("target-row")[0]).getByRole("checkbox"));
    await fireEvent.click(within(detail).getByTestId("recipe-check"));
    await fireEvent.click(screen.getByTestId("scenarios-runs-tab"));
    const runs = (await screen.findByTestId("scenarios-runs")).querySelector("section")!;
    await waitFor(() => expect(within(runs).getByText(/failed · boom/)).toBeInTheDocument());
    await fireEvent.click(within(runs).getByRole("button", { name: "Output" }));
    expect(within(runs).getByText("exit 3")).toBeInTheDocument();
    await fireEvent.click(within(runs).getByRole("button", { name: "Ask the assistant" }));
    expect(onAsk).toHaveBeenCalledWith("s-web-1", expect.stringContaining("Exit code: 3"));
  });
});
