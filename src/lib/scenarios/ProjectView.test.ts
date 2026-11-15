import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A project view (ADR 0071) over a mocked connection: an Ansible project read,
// a check typed into the terminal and watched through its events, an apply
// asked about on prod; a Terraform project planned, read, and applied.

const here = (f: string) => readFileSync(join(process.cwd(), "src", "lib", "scenarios", f), "utf8");
const EVENTS = here("ansibleevents.check.out");
const PLAN = here("tfplan.fixture.json");

const env = vi.hoisted(() => ({
  listing: [] as { name: string; isDir: boolean }[],
  texts: {} as Record<string, string>,
  events: "",
  planSizes: [] as number[],
  cleaned: [] as string[],
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  connectionFiles: vi.fn(() => ({
    list: async () => env.listing.map((e) => ({ ...e, path: e.name })),
    read: async (path: string) => {
      const name = path.split("/").pop() ?? path;
      if (!(name in env.texts)) throw new Error(`no ${path}`);
      return env.texts[name];
    },
  })),
  iacRun: vi.fn(async (_s: string, args: string[]) => {
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "ansible-playbook") return ok("ansible-playbook [core 2.17.4]\n");
    if (args[0] === "ansible-inventory")
      return ok(JSON.stringify({ _meta: { hostvars: { local: { ansible_host: "db.lan" } } }, db: { hosts: ["local"] } }));
    if (args[0] === "terraform" && args[1] === "version") return ok('{"terraform_version":"1.9.8"}');
    if (args.includes("show")) return ok(PLAN);
    return { stdout: "", stderr: "", exitCode: 1 };
  }),
  iacTemp: vi.fn(async () => "/tmp/vterm-iac.v1"),
  iacRead: vi.fn(async (_s: string, path: string, offset: number) => {
    if (path.endsWith(".tfplan")) {
      const size = env.planSizes.shift() ?? 50;
      return { exists: true, size, text: "", read: 0 };
    }
    const rest = env.events.slice(offset);
    return { exists: true, size: env.events.length, text: rest, read: rest.length };
  }),
  iacCleanup: vi.fn(async (_s: string, dir: string) => void env.cleaned.push(dir)),
}));

import type { EditorDoc } from "../stores/workspaces.svelte";
import { forgetScenarios } from "../stores/scenarios.svelte";
import type { ServerProfile } from "../types";
import ProjectView from "./ProjectView.svelte";

const db: ServerProfile = {
  id: "db",
  alias: "db-1",
  host: "db.lan",
  port: 22,
  username: "deploy",
  authMethod: "key",
  keyPath: null,
  hasSavedPassword: false,
  group: null,
  tags: [],
  prod: true,
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
};

const doc = (kind: "ansible" | "terraform", root: string, ask?: EditorDoc["project"] extends infer P ? (P extends { ask?: infer A } ? A : never) : never): EditorDoc => ({
  id: "d1",
  source: "sftp",
  path: root,
  name: "x",
  lang: { kind: "plain", label: "x" },
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
  project: { kind, root, ask, askSeq: ask ? 1 : 0 },
});

function show(kind: "ansible" | "terraform", root: string, extra: Record<string, unknown> = {}) {
  const onTypeLine = vi.fn();
  const onTypeArgv = vi.fn();
  const onShowTerminal = vi.fn();
  const onOpenFile = vi.fn();
  const onAsk = vi.fn();
  const r = render(ProjectView, {
    props: {
      sessionId: "s1",
      local: false,
      doc: doc(kind, root),
      servers: [db],
      connected: new Set<string>(),
      shell: "posix",
      serverId: null,
      prod: false,
      onTypeLine,
      onTypeArgv,
      onShowTerminal,
      onOpenFile,
      onAsk,
      ...extra,
    },
  });
  return { onTypeLine, onTypeArgv, onShowTerminal, onOpenFile, onAsk, ...r };
}

beforeEach(() => {
  env.cleaned.length = 0;
  env.planSizes = [];
  forgetScenarios("s1");
});

describe("an Ansible project", () => {
  beforeEach(() => {
    env.listing = [
      { name: "ansible.cfg", isDir: false },
      { name: "site.yml", isDir: false },
      { name: "hosts", isDir: false },
    ];
    env.texts = {
      "ansible.cfg": "[defaults]\ninventory = hosts\n",
      "site.yml": "- name: Local play\n  hosts: all\n  become: true\n  tasks:\n    - name: t\n      tags: [deploy]\n",
    };
    env.events = "";
  });

  it("shows its playbooks and its hosts matched to the catalog, prod marked", async () => {
    const { onOpenFile } = show("ansible", "/srv/infra");
    expect(await screen.findByText("site.yml")).toBeInTheDocument();
    expect(screen.getByText("Read by ansible-inventory: groups, group_vars and plugins as Ansible sees them.")).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("site.yml"));
    expect(onOpenFile).toHaveBeenCalledWith("/srv/infra/site.yml");
  });

  it("types a check into the terminal and fills the run from Ansible's events", async () => {
    const { onTypeLine } = show("ansible", "/srv/infra");
    await fireEvent.click(await screen.findByTestId("project-check"));
    const dialog = await screen.findByTestId("ansible-run-dialog");
    expect(within(dialog).getByTestId("ansible-command").textContent).toContain("ansible-playbook site.yml -i /srv/infra/hosts --check --diff -K");
    await fireEvent.click(within(dialog).getByTestId("ansible-run-go"));
    await waitFor(() => expect(onTypeLine).toHaveBeenCalled());
    const line = onTypeLine.mock.calls[0][0] as string;
    expect(line).toMatch(/^cd \/srv\/infra && env ANSIBLE_CALLBACK_PLUGINS=\/tmp\/vterm-iac\.v1:/);
    expect(line).toContain("VTERM_EVENTS=/tmp/vterm-iac.v1/events.out ansible-playbook site.yml -i /srv/infra/hosts --check --diff -K");
    // The run's events arrive while Ansible goes on in the terminal.
    env.events = EVENTS;
    await waitFor(() => expect(screen.getAllByTestId("ansible-cell").length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("ansible-run-state")).toHaveTextContent("ended"), { timeout: 3000 });
    expect(screen.getByTestId("ansible-recap")).toHaveTextContent("local");
    await fireEvent.click(screen.getAllByTestId("ansible-cell")[1]);
    expect(screen.getByTestId("ansible-cell-detail")).toHaveTextContent("+++ after: /srv/app/out.txt");
    expect(env.cleaned).toEqual(["/tmp/vterm-iac.v1"]);
  });

  it("asks before an apply, in red on prod", async () => {
    const { onTypeLine } = show("ansible", "/srv/infra");
    await fireEvent.click(await screen.findByTestId("project-run"));
    const dialog = await screen.findByTestId("ansible-run-dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Prod among the hosts: local");
    await fireEvent.click(within(dialog).getByTestId("ansible-run-go"));
    expect(await screen.findByText("Apply site.yml?")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onTypeLine).toHaveBeenCalled());
    expect(onTypeLine.mock.calls[0][0]).not.toContain("--check");
  });

  it("refuses a shell that is not POSIX, saying so", async () => {
    const { onTypeLine } = show("ansible", "/srv/infra", { shell: "powershell" });
    await fireEvent.click(await screen.findByTestId("project-check"));
    await fireEvent.click(within(await screen.findByTestId("ansible-run-dialog")).getByTestId("ansible-run-go"));
    await new Promise((r) => setTimeout(r, 20));
    expect(onTypeLine).not.toHaveBeenCalled();
  });
});

describe("a Terraform project", () => {
  beforeEach(() => {
    env.listing = [
      { name: "main.tf", isDir: false },
      { name: "prod.tfvars", isDir: false },
    ];
    env.texts = { "main.tf": 'resource "hcloud_server" "web" {\n  count = 2\n}\nvariable "x" {\n}\n' };
  });

  it("says it is not initialized, plans with the values picked, reads the plan and applies it after asking", async () => {
    const { onTypeArgv } = show("terraform", "/srv/tf", { prod: true });
    expect(await screen.findByText("The project is not initialized (.terraform is missing).")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "terraform init" }));
    expect(onTypeArgv).toHaveBeenLastCalledWith(["terraform", "-chdir=/srv/tf", "init", "-input=false"]);
    expect(screen.getByText(/hcloud_server\.web\[…\]/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("checkbox"));
    env.planSizes = [0, 80, 80];
    await fireEvent.click(screen.getByTestId("project-plan"));
    await waitFor(() =>
      expect(onTypeArgv).toHaveBeenLastCalledWith([
        "terraform",
        "-chdir=/srv/tf",
        "plan",
        "-input=false",
        "-out=/tmp/vterm-iac.v1/plan.tfplan",
        "-var-file=prod.tfvars",
      ]),
    );
    const view = await screen.findByTestId("tf-plan-view");
    await waitFor(() => expect(within(view).getByText("hcloud_firewall.base")).toBeInTheDocument(), { timeout: 5000 });
    await fireEvent.click(within(view).getByText("hcloud_firewall.base"));
    expect(within(view).getAllByText("(sensitive)").length).toBe(2);
    await fireEvent.click(within(view).getByTestId("tf-apply"));
    expect(await screen.findByText("Something is destroyed or replaced.")).toBeInTheDocument();
    expect(screen.getByText("The project's host is prod.")).toBeInTheDocument();
    await fireEvent.click(screen.getAllByRole("button", { name: "Apply this plan…" }).at(-1)!);
    expect(onTypeArgv).toHaveBeenLastCalledWith(["terraform", "-chdir=/srv/tf", "apply", "-input=false", "/tmp/vterm-iac.v1/plan.tfplan"]);
    expect(await within(view).findByText(/The plan was applied in the terminal/)).toBeInTheDocument();
  });
});
