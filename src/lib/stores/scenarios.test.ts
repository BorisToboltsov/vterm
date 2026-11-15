import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Scenarios store (ADR 0071, 0072) over a mocked backend: the library with
// the shipped files written into «Mine» once, a recipe run on several servers, a
// playbook run watched through its events — a playbook of the library carried
// to a server — a plan read once saved, and the folders of those runs removed.

const env = vi.hoisted(() => ({
  runs: [] as { sid: string; mode: string; script: string; elevation: string; cancelId: string }[],
  /** sids whose own sudo password does not work: the run asks for one first. */
  sudoWants: new Set<string>(),
  checks: [] as { sid: string; password: string | null; remember: boolean }[],
  answer: (_sid: string, _mode: string): { stdout: string; stderr: string; exitCode: number } => ({ stdout: "", stderr: "", exitCode: 0 }),
  cancelled: [] as string[],
  cleaned: [] as string[],
  temps: [] as { files: { name: string; text: string }[] }[],
  reads: [] as { path: string; offset: number }[],
  file: "",
  planSizes: [] as number[],
  iac: [] as string[][],
  showAnswer: { stdout: "", stderr: "", exitCode: 0 },
  scanSources: [] as string[][],
  listing: [] as { name: string; isDir: boolean }[],
  texts: {} as Record<string, string>,
  iacAnswer: (_args: string[]): { stdout: string; stderr: string; exitCode: number } => ({ stdout: "", stderr: "", exitCode: 127 }),
  writes: [] as string[],
  dirs: [] as string[],
  gate: Promise.resolve() as Promise<void>,
  mine: new Map<string, string>(),
  sourceFiles: [] as { path: string; dir: string; name: string; text: string; modified: number }[],
  folders: [] as { path: string; source: string; entries: { name: string; isDir: boolean }[] }[],
  saves: [] as { name: string; replace: boolean }[],
  localTexts: {} as Record<string, string>,
}));

vi.mock("../api", () => ({
  recipeRun: vi.fn(async (sid: string, r: { mode: string; script: string; elevation: string; cancelId: string }) => {
    if (r.elevation === "sudoPassword" && env.sudoWants.has(sid)) throw "sudo-password: nothing";
    env.runs.push({ sid, ...r });
    await env.gate;
    return env.answer(sid, r.mode);
  }),
  sftpCancel: vi.fn(async (id: string) => void env.cancelled.push(id)),
  sudoCheck: vi.fn(async (sid: string, password: string | null, remember: boolean) => {
    env.checks.push({ sid, password, remember });
    if (password === "pw") env.sudoWants.delete(sid);
    else throw "sudo-rejected: sudo did not accept the password";
    return { via: "typed", rememberFailed: false };
  }),
  iacCleanup: vi.fn(async (_sid: string, dir: string) => void env.cleaned.push(dir)),
  iacTemp: vi.fn(async (_sid: string, files: { name: string; text: string }[]) => {
    env.temps.push({ files });
    return `/tmp/vterm-iac.t${env.temps.length}`;
  }),
  iacRead: vi.fn(async (_sid: string, path: string, offset: number) => {
    env.reads.push({ path, offset });
    if (path.endsWith(".tfplan")) {
      const size = env.planSizes.shift() ?? 0;
      return { exists: size > 0, size, text: "", read: 0 };
    }
    const rest = env.file.slice(offset);
    const cut = rest.lastIndexOf("\n") + 1;
    return { exists: true, size: env.file.length, text: rest.slice(0, cut), read: cut };
  }),
  iacRun: vi.fn(async (_sid: string, args: string[]) => {
    env.iac.push(args);
    if (args.includes("show")) return env.showAnswer;
    return env.iacAnswer(args);
  }),
  recipesScan: vi.fn(async (sources: string[]) => {
    env.scanSources.push(sources);
    const own = [...env.mine].sort().map(([name, text]) => ({ path: `/data/scripts/${name}`, dir: "/data/scripts", name, text, modified: 0 }));
    return { dir: "/data/scripts", files: [...own, ...env.sourceFiles], folders: env.folders, unreadable: [], skipped: 0 };
  }),
  recipeSave: vi.fn(async (name: string, text: string, replace: boolean) => {
    if (!replace && env.mine.has(name)) throw new Error("dest-exists");
    env.saves.push({ name, replace });
    env.mine.set(name, text);
    return `/data/scripts/${name}`;
  }),
  recipeDelete: vi.fn(async (path: string) => void env.mine.delete(path.split("/").pop() ?? path)),
  readLocalText: vi.fn(async (path: string) => {
    if (!(path in env.localTexts)) throw new Error(`no ${path}`);
    return { content: env.localTexts[path], encoding: "utf-8", eol: "lf", sha256: "" };
  }),
  connectionFiles: vi.fn(() => ({
    list: async () => env.listing.map((e) => ({ ...e, path: e.name })),
    read: async (path: string) => {
      const name = path.split("/").pop() ?? path;
      if (!(path in env.texts) && !(name in env.texts)) throw new Error(`no ${path}`);
      return env.texts[path] ?? env.texts[name];
    },
  })),
  localMkdir: vi.fn(async (p: string) => void env.dirs.push(p)),
  sftpMkdir: vi.fn(async (_s: string, p: string) => void env.dirs.push(p)),
  writeLocalText: vi.fn(async (p: string) => void env.writes.push(p)),
  sftpWriteText: vi.fn(async (_s: string, p: string) => void env.writes.push(p)),
}));

import { captureDiag } from "../api/diag";
import { libraryRecipe, shippedText, SHIPPED_FILES } from "../scenarios/recipelib";
import { settings } from "../settings/settings.svelte";
import type { ServerProfile } from "../types";
import {
  ansibleWatch,
  clearRecipeRuns,
  deleteRecipe,
  endAnsibleWatch,
  forgetScenarios,
  library,
  loadAnsibleProject,
  loadLibrary,
  loadLibraryPlaybook,
  projectKindOf,
  restoreShipped,
  loadTfProject,
  planApplied,
  planWatch,
  pollAnsible,
  pollPlan,
  prepareAnsibleRun,
  preparePlan,
  recipeRuns,
  saveRecipe,
  scaffoldAnsibleProject,
  startRecipeRun,
  stopRecipeRun,
  watchAnsibleRun,
} from "./scenarios.svelte";

const server = (id: string, prod = false): ServerProfile => ({
  id,
  alias: id,
  host: `${id}.lan`,
  port: 22,
  username: "deploy",
  authMethod: "key",
  keyPath: null,
  hasSavedPassword: false,
  hasSavedSudo: false,
  logins: [],
  defaultLogin: "",
  askLogin: false,
  group: null,
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

const docker = libraryRecipe("own", "install-docker.sh", "/data/scripts", "/data/scripts/install-docker.sh", shippedText("install-docker.sh"));
const settle = () => new Promise((r) => setTimeout(r, 0));
async function untilDone(id: string) {
  for (let i = 0; i < 50 && recipeRuns().find((r) => r.id === id)?.endedAt === null; i++) await settle();
}

beforeEach(() => {
  env.runs.length = 0;
  env.sudoWants.clear();
  env.checks.length = 0;
  env.cancelled.length = 0;
  env.cleaned.length = 0;
  env.temps.length = 0;
  env.reads.length = 0;
  env.iac.length = 0;
  env.file = "";
  env.planSizes = [];
  env.answer = () => ({ stdout: "", stderr: "", exitCode: 0 });
  clearRecipeRuns();
});

describe("a recipe run", () => {
  it("checks every server, then applies only where the check says something would change", async () => {
    env.answer = (sid, mode) =>
      mode === "check" ? (sid === "s-a" ? { stdout: "already so: Docker 27\n", stderr: "", exitCode: 0 } : { stdout: "would install\n", stderr: "", exitCode: 1 }) : { stdout: "installed\n", stderr: "", exitCode: 0 };
    const ensure = vi.fn(async (id: string) => `s-${id}`);
    const id = await startRecipeRun(
      { recipe: docker, name: "Install Docker", values: { DOCKER_USER: "deploy" }, servers: [{ server: server("a"), prod: false }, { server: server("b"), prod: false }], mode: "apply", elevation: "sudoPassword", password: "pw" },
      ensure,
    );
    await untilDone(id);
    const run = recipeRuns().find((r) => r.id === id)!;
    expect(run.hosts.map((h) => [h.alias, h.state, h.summary])).toEqual([
      ["a", "skipped", "already so: Docker 27"],
      ["b", "ok", "installed"],
    ]);
    expect(env.runs.map((r) => [r.sid, r.mode])).toEqual([
      ["s-a", "check"],
      ["s-b", "check"],
      ["s-b", "apply"],
    ]);
    // The parameters are exported at the top of the script; the password never
    // rides the run — each server's sudo had its own here (ADR 0073).
    expect(env.runs[0].script).toContain("export DOCKER_USER='deploy'");
    expect(env.runs[0].script).toContain("export VTERM_MODE='check'");
    expect(Object.keys(env.runs[0])).not.toContain("password");
    expect(env.checks).toEqual([]);
    expect(env.runs[0].cancelId).toBe(`recipe:${id}:a`);
  });

  it("the typed sudo password goes only to the servers whose own does not work, never remembered", async () => {
    env.sudoWants.add("s-b");
    const id = await startRecipeRun(
      { recipe: docker, name: "x", values: { DOCKER_USER: "u" }, servers: [{ server: server("a"), prod: false }, { server: server("b"), prod: false }], mode: "apply", elevation: "sudoPassword", password: "pw" },
      async (s) => `s-${s}`,
    );
    await untilDone(id);
    expect(env.checks).toEqual([{ sid: "s-b", password: "pw", remember: false }]);
    expect(recipeRuns()[0].hosts.map((h) => h.state)).toEqual(["skipped", "skipped"]);
  });

  it("where sudo wants a password and none was typed, the host says so in words, not a marker", async () => {
    env.sudoWants.add("s-a");
    const id = await startRecipeRun(
      { recipe: docker, name: "x", values: { DOCKER_USER: "u" }, servers: [{ server: server("a"), prod: false }], mode: "apply", elevation: "sudoPassword", password: null },
      async (s) => `s-${s}`,
    );
    await untilDone(id);
    expect(recipeRuns()[0].hosts[0]).toMatchObject({ state: "failed", summary: "sudo password needed" });
    expect(env.checks).toEqual([]);
  });

  it("a check only says, and a server that could not be reached or answered badly is a failure", async () => {
    env.answer = () => ({ stdout: "", stderr: "sudo: a password is required\n", exitCode: 1 });
    const ensure = vi.fn(async (id: string) => {
      if (id === "gone") throw new Error("the session did not connect");
      return `s-${id}`;
    });
    const id = await startRecipeRun(
      { recipe: docker, name: "x", values: {}, servers: [{ server: server("a"), prod: true }, { server: server("gone"), prod: false }], mode: "check", elevation: "sudo", password: null },
      ensure,
    );
    await untilDone(id);
    const run = recipeRuns().find((r) => r.id === id)!;
    expect(run.hosts.map((h) => [h.state, h.prod])).toEqual([
      ["change", true],
      ["failed", false],
    ]);
    expect(run.hosts[1].summary).toContain("did not connect");
  });

  it("a check that could not tell, and an apply that failed, are failures; a stop is a stop", async () => {
    env.answer = (_sid, mode) => (mode === "check" ? { stdout: "", stderr: "not supported\n", exitCode: 3 } : { stdout: "", stderr: "", exitCode: 0 });
    const id = await startRecipeRun(
      { recipe: docker, name: "x", values: {}, servers: [{ server: server("a"), prod: false }], mode: "apply", elevation: "user", password: null },
      async (s) => `s-${s}`,
    );
    await untilDone(id);
    expect(recipeRuns()[0].hosts[0]).toMatchObject({ state: "failed", summary: "not supported", exit: 3 });

    const { recipeRun } = await import("../api");
    vi.mocked(recipeRun).mockImplementationOnce(async () => {
      throw new Error("cancelled: stopped by the user");
    });
    const id2 = await startRecipeRun(
      { recipe: docker, name: "x", values: {}, servers: [{ server: server("a"), prod: false }], mode: "check", elevation: "user", password: null },
      async (s) => `s-${s}`,
    );
    await untilDone(id2);
    expect(recipeRuns()[0].hosts[0].state).toBe("stopped");
  });

  it("stops: the waiting servers do not start, the running ones are signalled", async () => {
    let release!: () => void;
    env.gate = new Promise<void>((r) => (release = r));
    const servers = Array.from({ length: 8 }, (_, i) => ({ server: server(`h${i}`), prod: false }));
    const id = await startRecipeRun({ recipe: docker, name: "x", values: {}, servers, mode: "check", elevation: "user", password: null }, async (s) => `s-${s}`);
    await settle();
    stopRecipeRun(id);
    const run = recipeRuns().find((r) => r.id === id)!;
    expect(run.stopping).toBe(true);
    expect(run.hosts.slice(6).every((h) => h.state === "stopped")).toBe(true);
    expect(env.cancelled).toContain(`recipe:${id}:h0`);
    release();
    env.gate = Promise.resolve();
    await untilDone(id);
    // Finished runs go on request; a run still going would stay.
    clearRecipeRuns();
    expect(recipeRuns()).toEqual([]);
  });
});

describe("the library", () => {
  beforeEach(() => {
    env.mine.clear();
    env.mine.set("a.sh", "# vterm:\n#   name: A\n");
    env.sourceFiles = [];
    env.folders = [];
    env.saves.length = 0;
    settings.scenarioSeeded = {};
    settings.scenarioSources = [];
    settings.language = "ru";
  });

  it("writes the shipped recipes and playbooks into «Mine» once, in the reader's language", async () => {
    const diag = captureDiag();
    await loadLibrary();
    expect(env.saves.map((w) => w.name)).toEqual(SHIPPED_FILES);
    expect(library().own.map((r) => r.file)).toEqual(["a.sh", ...SHIPPED_FILES].sort());
    const docker = library().own.find((r) => r.file === "install-docker.sh")!;
    expect(docker.kind === "recipe" && docker.meta?.name).toBe("Установить Docker");
    const book = library().own.find((r) => r.file === "install-docker.yml")!;
    expect(book.kind).toBe("playbook");
    expect(Object.keys(settings.scenarioSeeded).sort()).toEqual([...SHIPPED_FILES].sort());
    expect(diag.events().find((e) => e.text === "the shipped recipes were written into Mine")?.fields).toMatchObject({ written: 13, fresh: 13 });
    diag.stop();
    // Read again: nothing written; one deleted stays deleted, one changed stays as changed.
    env.saves.length = 0;
    env.mine.delete("swap-file.sh");
    env.mine.set("cleanup-disk.sh", "#!/bin/sh\n# mine\n");
    await loadLibrary();
    expect(env.saves).toEqual([]);
    expect(env.mine.has("swap-file.sh")).toBe(false);
    expect(env.mine.get("cleanup-disk.sh")).toBe("#!/bin/sh\n# mine\n");
    // «Bring back» writes only what is missing.
    expect(await restoreShipped()).toBe(1);
    expect(env.saves).toEqual([{ name: "swap-file.sh", replace: false }]);
    expect(env.mine.get("cleanup-disk.sh")).toBe("#!/bin/sh\n# mine\n");
    expect(await restoreShipped()).toBe(0);
  });

  it("a name another window wrote meanwhile is that window's write, not a failure", async () => {
    const { recipeSave } = await import("../api");
    vi.mocked(recipeSave).mockRejectedValueOnce(new Error("dest-exists"));
    await loadLibrary();
    expect(library().own.length).toBeGreaterThan(1);
    expect(Object.keys(settings.scenarioSeeded)).toHaveLength(SHIPPED_FILES.length);
  });

  it("reads the sources of the settings: their recipes and playbooks, and the projects in them", async () => {
    settings.scenarioSeeded = Object.fromEntries(SHIPPED_FILES.map((f) => [f, { hash: "gone", lang: "ru" }]));
    settings.scenarioSources = ["/repo"];
    env.sourceFiles = [
      { path: "/repo/deploy.yml", dir: "/repo", name: "deploy.yml", text: "- name: Deploy\n  hosts: web\n", modified: 0 },
      { path: "/repo/vars.yml", dir: "/repo", name: "vars.yml", text: "port: 80\n", modified: 0 },
    ];
    env.folders = [
      { path: "/repo", source: "/repo", entries: [{ name: "deploy.yml", isDir: false }] },
      { path: "/repo/infra", source: "/repo", entries: [{ name: "ansible.cfg", isDir: false }] },
    ];
    await loadLibrary();
    expect(env.scanSources.at(-1)).toEqual(["/repo"]);
    expect(env.saves).toEqual([]);
    expect(library().own.map((r) => r.file)).toEqual(["a.sh"]);
    expect(library().sources.map((r) => [r.kind, r.file])).toEqual([["playbook", "deploy.yml"]]);
    expect(library().notPlaybooks).toBe(1);
    expect(library().projects).toEqual([{ kind: "ansible", root: "/repo/infra", source: "/repo" }]);
    expect(await saveRecipe("b.sh", "x")).toBe("/data/scripts/b.sh");
    await deleteRecipe("/data/scripts/b.sh");
    expect(env.mine.has("b.sh")).toBe(false);
  });

  it("tells whether a folder of this computer is a project", async () => {
    env.listing = [{ name: "main.tf", isDir: false }];
    expect(await projectKindOf("/srv/tf")).toBe("terraform");
    env.listing = [{ name: "notes.txt", isDir: false }];
    expect(await projectKindOf("/srv/x")).toBeNull();
  });
});

describe("a playbook run", () => {
  const EVENTS = readFileSync(join(process.cwd(), "src", "lib", "scenarios", "ansibleevents.check.out"), "utf8");

  it("is prepared with the collector and the catalog's inventory, and watched until Ansible's recap", async () => {
    const dir = await prepareAnsibleRun("s1", "all: {}\n");
    expect(env.temps[0].files.map((f) => f.name)).toEqual(["vterm_events.py", "vterm-inventory.yml"]);
    expect(env.temps[0].files[0].text).toContain("CALLBACK_NEEDS_ENABLED = False");
    const diag = captureDiag();
    watchAnsibleRun({ sessionId: "s1", root: "/p", playbook: "site.yml", tempDir: dir, check: true, limit: [] });
    // Half the file first: a line cut at the end waits.
    env.file = EVENTS.slice(0, EVENTS.length / 2);
    expect(await pollAnsible("s1")).toBe(true);
    expect(ansibleWatch("s1")?.run.plays).toHaveLength(1);
    env.file = EVENTS;
    expect(await pollAnsible("s1")).toBe(false);
    expect(ansibleWatch("s1")).toMatchObject({ ended: true, cleaned: true });
    // The events are in memory: the folder goes at once.
    expect(env.cleaned).toEqual([dir]);
    expect(env.reads[1].offset).toBe(env.reads[0].offset + EVENTS.slice(0, EVENTS.length / 2).lastIndexOf("\n") + 1);
    expect(diag.events().map((e) => e.text)).toEqual(["playbook run started", "playbook run ended"]);
    diag.stop();
    // Ended: no more reads, and a tab closing removes nothing twice.
    expect(await pollAnsible("s1")).toBe(false);
    forgetScenarios("s1");
    expect(env.cleaned).toEqual([dir]);
    expect(ansibleWatch("s1")).toBeNull();
  });

  it("stops being watched on request; a new run removes the previous folder", async () => {
    const first = await prepareAnsibleRun("s2", null);
    watchAnsibleRun({ sessionId: "s2", root: "/p", playbook: "site.yml", tempDir: first, check: false, limit: ["web"] });
    const second = await prepareAnsibleRun("s2", null);
    expect(env.cleaned).toEqual([first]);
    watchAnsibleRun({ sessionId: "s2", root: "/p", playbook: "site.yml", tempDir: second, check: false, limit: [] });
    endAnsibleWatch("s2");
    expect(ansibleWatch("s2")?.ended).toBe(true);
    expect(env.cleaned).toEqual([first, second]);
  });

  it("a playbook of the library is read on this computer and Ansible asked where it runs; carried, it travels in the run's folder", async () => {
    env.localTexts["/data/scripts/web.yml"] = "# Web\n- name: Web\n  hosts: all\n  become: true\n";
    env.localTexts["/data/scripts/vars.yml"] = "port: 80\n";
    const before = env.iacAnswer;
    env.iacAnswer = (args) =>
      args[0] === "ansible-playbook" ? { stdout: "ansible-playbook [core 2.17.4]\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 127 };
    const ov = await loadLibraryPlaybook("s9", "/data/scripts/web.yml");
    expect(ov).toMatchObject({ root: "/data/scripts", installed: true, version: "ansible-playbook [core 2.17.4]", inventories: [], inventory: null });
    expect(ov.library?.path).toBe("/data/scripts/web.yml");
    expect(ov.playbooks.map((p) => [p.file, p.book.plays[0].become])).toEqual([["web.yml", true]]);
    await prepareAnsibleRun("s9", null, { file: "web.yml", text: ov.library!.text });
    expect(env.temps.at(-1)!.files.map((f) => f.name)).toEqual(["vterm_events.py", "web.yml"]);
    expect(env.temps.at(-1)!.files[1].text).toBe(ov.library!.text);
    await expect(loadLibraryPlaybook("s9", "/data/scripts/vars.yml")).rejects.toThrow(/not a playbook/);
    env.iacAnswer = () => ({ stdout: "", stderr: "", exitCode: 127 });
    expect((await loadLibraryPlaybook("s9", "/data/scripts/web.yml")).installed).toBe(false);
    env.iacAnswer = before;
  });

  it("a read that fails is said in the watch, and the watch goes on", async () => {
    const { iacRead } = await import("../api");
    vi.mocked(iacRead).mockRejectedValueOnce(new Error("no session"));
    watchAnsibleRun({ sessionId: "s3", root: "/p", playbook: "x.yml", tempDir: "/tmp/vterm-iac.x", check: true, limit: [] });
    expect(await pollAnsible("s3")).toBe(true);
    expect(ansibleWatch("s3")?.error).toContain("no session");
    forgetScenarios("s3");
    expect(env.cleaned).toEqual(["/tmp/vterm-iac.x"]);
  });
});

describe("a plan", () => {
  const PLAN = readFileSync(join(process.cwd(), "src", "lib", "scenarios", "tfplan.fixture.json"), "utf8");

  it("is read once the saved file stops growing, and is spent once applied", async () => {
    const path = await preparePlan("t1", "/srv/tf", ["prod.tfvars"]);
    expect(path).toBe("/tmp/vterm-iac.t1/plan.tfplan");
    env.planSizes = [0, 100, 200, 200];
    env.showAnswer = { stdout: PLAN, stderr: "", exitCode: 0 };
    expect(await pollPlan("t1")).toBe(true);
    expect(await pollPlan("t1")).toBe(true);
    expect(await pollPlan("t1")).toBe(true);
    expect(await pollPlan("t1")).toBe(false);
    expect(planWatch("t1")).toMatchObject({ phase: "ready", varFiles: ["prod.tfvars"] });
    expect(planWatch("t1")?.plan?.counts.create).toBe(2);
    expect(env.iac.at(-1)).toEqual(["terraform", "-chdir=/srv/tf", "show", "-json", path]);
    planApplied("t1");
    expect(planWatch("t1")?.phase).toBe("applied");
    expect(await pollPlan("t1")).toBe(false);
    forgetScenarios("t1");
    expect(env.cleaned).toEqual(["/tmp/vterm-iac.t1"]);
  });

  it("a plan Terraform would not show is a failure, said", async () => {
    await preparePlan("t2", "/srv/tf", []);
    env.planSizes = [10, 10];
    env.showAnswer = { stdout: "", stderr: "Error: plan was made by another version\n", exitCode: 1 };
    await pollPlan("t2");
    await pollPlan("t2");
    expect(planWatch("t2")).toMatchObject({ phase: "failed", error: "Error: plan was made by another version" });
    // A new plan replaces the old folder.
    await preparePlan("t2", "/srv/tf", []);
    expect(env.cleaned).toContain("/tmp/vterm-iac.t1");
  });
});

describe("reading a project", () => {
  it("an Ansible project: its playbooks, inventory by Ansible, what it needs", async () => {
    env.listing = [
      { name: "ansible.cfg", isDir: false },
      { name: "site.yml", isDir: false },
      { name: "web.yml", isDir: false },
      { name: "requirements.yml", isDir: false },
      { name: "vars.yml", isDir: false },
      { name: "inventory", isDir: true },
    ];
    env.texts = {
      "ansible.cfg": "[defaults]\ninventory = inventory/prod.ini\n",
      "site.yml": "- import_playbook: web.yml\n",
      "web.yml": "- hosts: web\n  roles: [nginx]\n  tasks:\n    - name: t\n      tags: [deploy]\n",
      "requirements.yml": "collections:\n  - name: community.postgresql\n  - ansible.posix\n",
      "vars.yml": "a: 1\n",
    };
    env.iacAnswer = (args) => {
      if (args[0] === "ansible-playbook") return { stdout: "ansible-playbook [core 2.17.4]\n  config file = x\n", stderr: "", exitCode: 0 };
      if (args[0] === "ansible-inventory") return { stdout: JSON.stringify({ _meta: { hostvars: {} }, web: { hosts: ["web-1"] } }), stderr: "", exitCode: 0 };
      if (args[0] === "ansible-galaxy") return { stdout: JSON.stringify({ "/c": { "ansible.posix": {} } }), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const ov = await loadAnsibleProject("s1", false, "/srv/infra");
    expect(ov.playbooks.map((p) => p.file)).toEqual(["site.yml", "web.yml"]);
    expect(ov.unreadable).toEqual(["vars.yml"]);
    expect(ov.config).toBe("/srv/infra/ansible.cfg");
    expect(ov.inventories).toEqual(["/srv/infra/inventory/prod.ini"]);
    expect(ov.inventory?.groups).toEqual([{ name: "web", hosts: ["web-1"] }]);
    expect(ov.inventorySource).toBe("ansible");
    expect(ov.version).toBe("ansible-playbook [core 2.17.4]");
    expect(ov.missing).toEqual(["community.postgresql"]);
    expect(env.iac.find((a) => a[0] === "ansible-inventory")).toEqual([
      "ansible-inventory",
      "--list",
      "-i",
      "/srv/infra/inventory/prod.ini",
    ]);
  });

  it("without Ansible on the host: the INI inventory read by hand, and said so", async () => {
    env.listing = [
      { name: "site.yml", isDir: false },
      { name: "hosts", isDir: false },
    ];
    env.texts = { "site.yml": "- hosts: all\n", hosts: "[db]\ndb-1 ansible_host=10.0.0.5\n" };
    env.iacAnswer = () => ({ stdout: "", stderr: "ansible-playbook: not found", exitCode: 127 });
    const ov = await loadAnsibleProject("s1", true, "/p");
    expect(ov.installed).toBe(false);
    expect(ov.inventorySource).toBe("file");
    expect(ov.inventory?.hosts[0]).toMatchObject({ name: "db-1", address: "10.0.0.5" });
  });

  it("an inventory Ansible would not read is said, not shown as empty", async () => {
    env.listing = [{ name: "site.yml", isDir: false }, { name: "hosts", isDir: false }];
    env.texts = { "site.yml": "- hosts: all\n" };
    env.iacAnswer = (args) =>
      args[0] === "ansible-playbook" ? { stdout: "ansible-playbook [core 2.17]\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "[WARNING]: Unable to parse /p/hosts\n", exitCode: 1 };
    const ov = await loadAnsibleProject("s1", false, "/p");
    expect(ov.inventory).toBeNull();
    expect(ov.inventoryError).toContain("Unable to parse");
  });

  it("a Terraform project: from its text, the lock file, and terraform's version", async () => {
    env.listing = [
      { name: "main.tf", isDir: false },
      { name: ".terraform.lock.hcl", isDir: false },
      { name: "prod.tfvars", isDir: false },
      { name: ".terraform", isDir: true },
    ];
    env.texts = {
      "main.tf": 'resource "a" "b" {\n}\nterraform {\n  backend "s3" {\n  }\n}\n',
      ".terraform.lock.hcl": 'provider "registry.terraform.io/hashicorp/random" {\n  version = "3.6.0"\n}\n',
    };
    env.iacAnswer = () => ({ stdout: '{"terraform_version":"1.9.8"}', stderr: "", exitCode: 0 });
    const ov = await loadTfProject("t1", false, "/srv/tf");
    expect(ov).toMatchObject({ version: "1.9.8", installed: true, initialized: true, varFiles: ["prod.tfvars"], locked: { "hashicorp/random": "3.6.0" } });
    expect(ov.project.backend).toBe("s3");
    env.iacAnswer = () => ({ stdout: "Terraform v1.5.0\n", stderr: "", exitCode: 0 });
    expect((await loadTfProject("t1", false, "/srv/tf")).version).toBe("Terraform v1.5.0");
  });
});

describe("a new project", () => {
  it("makes the folder first, then its folders and files, through the connection", async () => {
    env.dirs.length = 0;
    env.writes.length = 0;
    const root = await scaffoldAnsibleProject("s1", false, "/home/u", " infra ", "all: {}\n");
    expect(root).toBe("/home/u/infra");
    expect(env.dirs[0]).toBe("/home/u/infra");
    expect(env.dirs).toContain("/home/u/infra/roles/common/tasks");
    expect(env.writes).toContain("/home/u/infra/inventory/vterm.yml");
    expect(env.writes).toContain("/home/u/infra/roles/common/tasks/main.yml");
  });
});
