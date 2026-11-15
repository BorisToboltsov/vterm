import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Scenarios panel (ADR 0071, 0072): one library — «Mine» with the shipped
// recipes and playbooks written into it, the folders the user added, the
// projects pinned or found — a recipe picked, checked and run on servers of the
// catalog, prod asked about; a playbook sent to where it runs; the runs tab.

const env = vi.hoisted(() => ({
  runs: [] as { sid: string; mode: string }[],
  saved: [] as string[],
  deleted: [] as string[],
  folder: null as string | null,
  listing: [] as { name: string; isDir: boolean }[],
  mine: [] as { name: string; text: string }[],
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  recipesScan: vi.fn(async (sources: string[]) => ({
    dir: "/data/scripts",
    files: [
      ...env.mine.map((f) => ({ path: `/data/scripts/${f.name}`, dir: "/data/scripts", name: f.name, text: f.text, modified: 0 })),
      { path: "/repo/plain.sh", dir: "/repo", name: "plain.sh", text: "echo hi\n", modified: 0 },
    ],
    folders: sources.includes("/repo")
      ? [
          { path: "/repo", source: "/repo", entries: [{ name: "plain.sh", isDir: false }] },
          { path: "/repo/tf", source: "/repo", entries: [{ name: "main.tf", isDir: false }] },
        ]
      : [],
    unreadable: ["/gone"],
    skipped: 0,
  })),
  recipeRun: vi.fn(async (sid: string, r: { mode: string }) => {
    env.runs.push({ sid, mode: r.mode });
    return r.mode === "check" ? { stdout: "would change\n", stderr: "", exitCode: 1 } : { stdout: "done\n", stderr: "", exitCode: 0 };
  }),
  recipeSave: vi.fn(async (name: string, text: string) => {
    env.saved.push(name);
    env.mine.push({ name, text });
    return `/data/scripts/${name}`;
  }),
  recipeDelete: vi.fn(async (path: string) => {
    env.deleted.push(path);
    env.mine = env.mine.filter((f) => `/data/scripts/${f.name}` !== path);
  }),
  pickRecipeFolder: vi.fn(async () => env.folder),
  connectionFiles: vi.fn(() => ({ list: async () => env.listing.map((e) => ({ ...e, path: e.name })), read: async () => "" })),
  hostOs: vi.fn(async () => "macos"),
}));

import { resolve, type MessageKey } from "../i18n";
import { settings } from "../settings/settings.svelte";
import type { ServerProfile } from "../types";
import ScenariosPanel from "./ScenariosPanel.svelte";
import { clearRecipeRuns } from "../stores/scenarios.svelte";
import { shippedIn, SHIPPED_FILES, textHash } from "./recipelib";

const en = (k: string) => resolve("en", k as MessageKey);
const shipped = (f: string) => ({ name: f, text: shippedIn(f, en) });

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
  const onRunPlaybook = vi.fn();
  const onAsk = vi.fn();
  render(ScenariosPanel, {
    props: { visible: true, servers, connected: new Set(["web-1"]), ensureSession: ensure, onEditRecipe, onOpenProject, onRunPlaybook, onAsk, ...props },
  });
  return { ensure, onEditRecipe, onOpenProject, onRunPlaybook, onAsk };
}

beforeEach(() => {
  env.runs.length = 0;
  env.saved.length = 0;
  env.deleted.length = 0;
  env.folder = null;
  env.listing = [];
  env.mine = [
    { name: "mine.sh", text: "# vterm:\n#   name: Greet\n#   check: true\n#   params:\n#     WHO: { label: Who, required: true }\n" },
    shipped("install-docker.sh"),
    shipped("install-docker.yml"),
  ];
  // Written before: the shipped files the folder does not hold were deleted by the user.
  settings.scenarioSeeded = Object.fromEntries(SHIPPED_FILES.map((f) => [f, { hash: textHash(shippedIn(f, en)), lang: "en" }]));
  settings.scenarioTab = "library";
  settings.playbookNode = null;
  clearRecipeRuns();
  settings.scenarioSources = ["/repo"];
  settings.scenarioProjects = [{ kind: "ansible", root: "/srv/infra/ansible", serverId: "web-1" }];
});

describe("Scenarios panel", () => {
  it("lists projects pinned and found, «Mine» with recipes and playbooks, a source folder; no «Built-in»; names what it could not read", async () => {
    show();
    await screen.findByText("Greet");
    expect(screen.getAllByText("Install Docker")).toHaveLength(2);
    expect(screen.getByText("install-docker.yml")).toBeInTheDocument();
    expect(screen.getAllByTestId("playbook-row")).toHaveLength(1);
    expect(screen.getByText("plain.sh")).toBeInTheDocument();
    expect(screen.getByText("ansible")).toBeInTheDocument();
    expect(screen.getByText("tf")).toBeInTheDocument();
    expect(screen.getByText("found in repo")).toBeInTheDocument();
    expect(screen.queryByText("Built-in")).toBeNull();
    expect(screen.getByText("Not read: /gone")).toBeInTheDocument();
    expect(screen.getByText("no header")).toBeInTheDocument();
    expect(env.saved).toEqual([]);
    // The filter narrows every group.
    await fireEvent.input(screen.getByTestId("scenarios-filter"), { target: { value: "docker" } });
    expect(screen.queryByText("Greet")).toBeNull();
    expect(screen.getAllByText("Install Docker")).toHaveLength(2);
  });

  it("with no project anywhere, the group stays and says how to get one", async () => {
    settings.scenarioProjects = [];
    settings.scenarioSources = [];
    show();
    expect(await screen.findByTestId("projects-empty")).toHaveTextContent("Pin a project folder");
  });

  it("checks a recipe of «Mine» on the servers picked, then runs it; prod is asked about first", async () => {
    show();
    await screen.findByText("Greet");
    await fireEvent.click(screen.getAllByTestId("recipe-row").find((r) => r.textContent?.includes("Install Docker"))!);
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
    await fireEvent.click(await screen.findByText("Greet"));
    const detail = await screen.findByTestId("recipe-detail");
    await fireEvent.click(within(within(detail).getAllByTestId("target-row")[0]).getByRole("checkbox"));
    await fireEvent.click(within(detail).getByTestId("recipe-run"));
    expect(within(detail).getByRole("alert")).toHaveTextContent("«Who» is needed");
    await fireEvent.input(within(detail).getByLabelText(/Who/), { target: { value: "me" } });
    await fireEvent.click(within(detail).getByLabelText("sudo with a password"));
    await fireEvent.click(within(detail).getByTestId("recipe-run"));
    expect(within(detail).getByRole("alert")).toHaveTextContent("Enter the sudo password");
  });

  it("every recipe of «Mine» is edited and deleted, the shipped ones too; a folder's is copied into «Mine»", async () => {
    const { onEditRecipe } = show();
    await screen.findByText("Greet");
    await fireEvent.click(screen.getAllByTestId("recipe-row").find((r) => r.textContent?.includes("Install Docker"))!);
    expect(screen.queryByRole("button", { name: "Copy into «Mine»" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Open in the editor" }));
    expect(onEditRecipe).toHaveBeenCalledWith("/data/scripts/install-docker.sh");
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete install-docker.sh?")).toBeInTheDocument();
    await fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() => expect(env.deleted).toEqual(["/data/scripts/install-docker.sh"]));
    // A folder's recipe: edited where it is, copied into «Mine», never deleted.
    await fireEvent.click(await screen.findByText("plain.sh"));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Copy into «Mine»" }));
    await waitFor(() => expect(env.saved).toEqual(["plain.sh"]));
  });

  it("a playbook goes to where it runs: this computer, or the server picked, which is remembered", async () => {
    const { onRunPlaybook, onEditRecipe } = show();
    await screen.findByText("Greet");
    await fireEvent.click(screen.getByTestId("playbook-row"));
    const detail = await screen.findByTestId("playbook-detail");
    expect(within(detail).getByText("Plays")).toBeInTheDocument();
    expect(within(detail).getByText("as root (become)")).toBeInTheDocument();
    await fireEvent.click(within(detail).getByTestId("playbook-check"));
    expect(onRunPlaybook).toHaveBeenCalledWith("/data/scripts/install-docker.yml", null, "check");
    await fireEvent.change(within(detail).getByTestId("playbook-node"), { target: { value: "web-1" } });
    expect(settings.playbookNode).toBe("web-1");
    expect(within(detail).getByText(/copied into a temporary folder/)).toBeInTheDocument();
    await fireEvent.click(within(detail).getByTestId("playbook-run"));
    expect(onRunPlaybook).toHaveBeenLastCalledWith("/data/scripts/install-docker.yml", "web-1", "run");
    await fireEvent.click(within(detail).getByRole("button", { name: "Open in the editor" }));
    expect(onEditRecipe).toHaveBeenCalledWith("/data/scripts/install-docker.yml");
  });

  it("opens a pinned project and unpins it; pins a found one", async () => {
    const { onOpenProject } = show();
    await fireEvent.click(await screen.findByText("ansible"));
    const card = screen.getByTestId("project-card");
    await fireEvent.click(within(card).getByRole("button", { name: "Open the project" }));
    expect(onOpenProject).toHaveBeenCalledWith({ kind: "ansible", root: "/srv/infra/ansible", serverId: "web-1" });
    await fireEvent.click(within(card).getByRole("button", { name: "Unpin" }));
    expect(settings.scenarioProjects).toEqual([]);
    await fireEvent.click(screen.getByText("tf"));
    await fireEvent.click(within(screen.getByTestId("project-card")).getByRole("button", { name: "Pin to the Scenarios panel" }));
    expect(settings.scenarioProjects).toEqual([{ kind: "terraform", root: "/repo/tf", serverId: null }]);
  });

  it("adds a project folder of this computer — only one that is a project", async () => {
    settings.scenarioProjects = [];
    show();
    await screen.findByText("Greet");
    env.folder = "/home/me/notes";
    env.listing = [{ name: "todo.txt", isDir: false }];
    await fireEvent.click(screen.getByTestId("scenarios-add"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Add a project folder…" }));
    await waitFor(() => expect(env.listing).toHaveLength(1));
    expect(settings.scenarioProjects).toEqual([]);
    env.folder = "/home/me/infra";
    env.listing = [{ name: "ansible.cfg", isDir: false }];
    await fireEvent.click(screen.getByTestId("scenarios-add"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Add a project folder…" }));
    await waitFor(() => expect(settings.scenarioProjects).toEqual([{ kind: "ansible", root: "/home/me/infra", serverId: null }]));
  });

  it("brings back the shipped ones «Mine» lacks", async () => {
    show();
    await screen.findByText("Greet");
    await fireEvent.click(screen.getByTestId("scenarios-add"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Bring back the shipped recipes and playbooks" }));
    await waitFor(() => expect(env.saved).toEqual(SHIPPED_FILES.filter((f) => !["install-docker.sh", "install-docker.yml"].includes(f))));
  });

  it("makes a new recipe and a new playbook from a name and opens them", async () => {
    const { onEditRecipe } = show();
    await fireEvent.click(screen.getByTestId("scenarios-add"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "New recipe…" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name");
    await fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Restart nginx" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onEditRecipe).toHaveBeenCalledWith("/data/scripts/restart-nginx.sh"));
    await fireEvent.click(screen.getByTestId("scenarios-add"));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "New playbook…" }));
    const dialog = await screen.findByRole("dialog", { name: "New playbook" });
    await fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Install Docker" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    // The name is taken in «Mine»: the next free one.
    await waitFor(() => expect(onEditRecipe).toHaveBeenCalledWith("/data/scripts/install-docker-2.yml"));
  });

  it("shows the runs, server by server, and sends a failure to the assistant", async () => {
    const { recipeRun } = await import("../api");
    vi.mocked(recipeRun).mockResolvedValueOnce({ stdout: "", stderr: "boom\n", exitCode: 3 });
    const { onAsk } = show();
    await fireEvent.click(await screen.findByText("Greet"));
    const detail = await screen.findByTestId("recipe-detail");
    await fireEvent.click(within(within(detail).getAllByTestId("target-row")[0]).getByRole("checkbox"));
    await fireEvent.input(within(detail).getByLabelText(/Who/), { target: { value: "me" } });
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
