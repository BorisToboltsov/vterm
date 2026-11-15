// Scenarios (ADR 0071): the recipe library, the runs of recipes on servers of
// the catalog, and — per session that is the host of a project — the playbook
// run being watched and the Terraform plan being read. The one owner of the
// backend's scenario commands (`vterm/owned-imports`): a recipe reaches a
// server, and a project's checks run, only through here.
//
// What a run does on a server is the server's answer; what is shown of it is
// the store's: the per-host state, the line that tells it, the whole output on
// request. `ansible-playbook` and `terraform plan/apply` run in the tab's
// terminal — the page types them; this store only watches what they leave in
// the run's temporary folder, and removes that folder when it is done with it.

import {
  connectionFiles,
  localMkdir,
  sftpMkdir,
  sftpWriteText,
  writeLocalText,
  iacCleanup,
  iacRead,
  iacRun,
  iacTemp,
  recipeDelete,
  recipeRun,
  recipeSave,
  recipesScan,
  sftpCancel,
  type Elevation,
  type RecipeScan,
} from "../api";
import { diag, orNull, swallow, swallowed } from "../api/diag";
import { parentOf, joinPath } from "../files/fspath";
import { loadYaml, parseYaml } from "../pipeline/yamldoc";
import { settings } from "../settings/settings.svelte";
import { readPlaybook, readRequirements, installedCollections, type Playbook } from "../scenarios/ansibleplay";
import { COLLECTOR_FILE, EVENTS_FILE, CATALOG_INVENTORY_FILE } from "../scenarios/ansibleargv";
import { emptyRun, feedRun, runEnded, type AnsibleRun } from "../scenarios/ansibleevents";
import { parseIniInventory, parseInventoryJson, type Inventory } from "../scenarios/inventory";
import { cfgInventory, inventoryCandidates, playbookCandidate, type ProjectKind } from "../scenarios/project";
import { builtinRecipes, userRecipes, type LibraryRecipe } from "../scenarios/recipelib";
import { checkVerdict, recipeScript, summaryLine, type RecipeMode } from "../scenarios/recipe";
import { lockedProviders, readProject, varFiles, type TfProject } from "../scenarios/tfproject";
import { parsePlan, showArgv, type TfPlan } from "../scenarios/tfplan";
import { SCAFFOLD_DIRS, scaffoldFiles } from "../scenarios/scaffold";
import COLLECTOR from "../scenarios/vterm_events.py?raw";
import type { ServerProfile } from "../types";

const SOURCE = "scenarios";
/** How many servers a recipe runs on at once. */
export const PARALLEL = 6;
/** A check answers quickly; an apply may install things. */
const CHECK_SECS = 180;
const APPLY_SECS = 1800;
/** The most of a host's output kept for the run's view. */
const OUTPUT_MAX = 64 * 1024;

// ── The library ───────────────────────────────────────────────────────────────

let scan = $state.raw<RecipeScan | null>(null);
let scanning = $state(false);
let scanError = $state<string | null>(null);
const builtins = builtinRecipes();

/** Built-in recipes, then the user's (the app's folder, then each source). */
export function library(): { builtin: LibraryRecipe[]; own: LibraryRecipe[]; sources: LibraryRecipe[]; scan: RecipeScan | null } {
  const mine = scan ? userRecipes(scan) : [];
  return { builtin: builtins, own: mine.filter((r) => r.origin === "own"), sources: mine.filter((r) => r.origin === "source"), scan };
}

export const libraryLoading = (): boolean => scanning;
export const libraryError = (): string | null => scanError;

/** Read the library again: the app's folder and the sources of the settings. */
export async function loadLibrary(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    scan = await recipesScan(settings.scenarioSources);
    scanError = null;
  } catch (e) {
    scanError = String(e);
  } finally {
    scanning = false;
  }
}

/** Save a recipe into the app's folder and read the library again; its path. */
export async function saveRecipe(name: string, text: string, replace = false): Promise<string> {
  const path = await recipeSave(name, text, replace);
  await loadLibrary();
  return path;
}

/** Delete a recipe of the app's folder and read the library again. */
export async function deleteRecipe(path: string): Promise<void> {
  await recipeDelete(path);
  await loadLibrary();
}

// ── Runs of a recipe ──────────────────────────────────────────────────────────

export type HostState =
  | "waiting"
  | "connecting"
  | "checking"
  | "running"
  | "same"
  | "change"
  | "ok"
  | "skipped"
  | "failed"
  | "stopped";

export interface RunHost {
  serverId: string;
  alias: string;
  prod: boolean;
  sessionId: string | null;
  state: HostState;
  /** The line the answer is told by. */
  summary: string;
  output: string;
  exit: number | null;
  cancelId: string;
}

export interface RecipeRunRecord {
  id: string;
  recipeId: string;
  name: string;
  mode: RecipeMode;
  startedAt: number;
  endedAt: number | null;
  stopping: boolean;
  hosts: RunHost[];
}

let runs = $state.raw<RecipeRunRecord[]>([]);

/** The recipe runs of this app's life, newest first. */
export const recipeRuns = (): RecipeRunRecord[] => runs;

/** A host's run is over. */
export const hostDone = (s: HostState): boolean => ["same", "change", "ok", "skipped", "failed", "stopped"].includes(s);

function patchRun(id: string, f: (r: RecipeRunRecord) => RecipeRunRecord): void {
  runs = runs.map((r) => (r.id === id ? f(r) : r));
}

function patchHost(runId: string, serverId: string, patch: Partial<RunHost>): void {
  patchRun(runId, (r) => ({ ...r, hosts: r.hosts.map((h) => (h.serverId === serverId ? { ...h, ...patch } : h)) }));
}

const runOf = (id: string) => runs.find((r) => r.id === id) ?? null;

export interface RecipeRunSpec {
  recipe: LibraryRecipe;
  /** The name the run is shown and recorded under (built-in ones in the reader's language). */
  name: string;
  values: Record<string, string>;
  servers: { server: ServerProfile; prod: boolean }[];
  mode: RecipeMode;
  elevation: Elevation;
  /** The sudo password, kept only for this run. */
  password: string | null;
}

/** The session of a server: one already open, or one the page opens for the run. */
export type EnsureSession = (serverId: string) => Promise<string>;

const tail = (s: string): string => (s.length > OUTPUT_MAX ? s.slice(s.length - OUTPUT_MAX) : s);

async function runOnHost(runId: string, host: RunHost, spec: RecipeRunSpec, ensure: EnsureSession): Promise<void> {
  const meta = spec.recipe.meta!;
  const stopped = () => runOf(runId)?.stopping === true;
  patchHost(runId, host.serverId, { state: "connecting" });
  let sid: string;
  try {
    sid = await ensure(host.serverId);
  } catch (e) {
    patchHost(runId, host.serverId, { state: "failed", summary: String(e) });
    return;
  }
  if (stopped()) {
    patchHost(runId, host.serverId, { state: "stopped", sessionId: sid });
    return;
  }
  const exec = (mode: RecipeMode) =>
    recipeRun(sid, {
      name: spec.name,
      mode,
      script: recipeScript(spec.recipe.text, meta, spec.values, mode),
      elevation: spec.elevation,
      password: spec.password,
      timeoutSecs: mode === "check" ? CHECK_SECS : APPLY_SECS,
      cancelId: host.cancelId,
    });
  try {
    if (spec.mode === "check" || meta.check) {
      patchHost(runId, host.serverId, { state: "checking", sessionId: sid });
      const out = await exec("check");
      const verdict = checkVerdict(out.exitCode);
      const said = { summary: summaryLine(out.stdout, out.stderr), output: tail(out.stdout + out.stderr), exit: out.exitCode };
      if (spec.mode === "check") {
        patchHost(runId, host.serverId, { ...said, state: verdict === "error" ? "failed" : verdict });
        return;
      }
      if (verdict === "same") {
        patchHost(runId, host.serverId, { ...said, state: "skipped" });
        return;
      }
      if (verdict === "error") {
        patchHost(runId, host.serverId, { ...said, state: "failed" });
        return;
      }
      if (stopped()) {
        patchHost(runId, host.serverId, { ...said, state: "stopped" });
        return;
      }
    }
    patchHost(runId, host.serverId, { state: "running", sessionId: sid });
    const out = await exec("apply");
    patchHost(runId, host.serverId, {
      state: out.exitCode === 0 ? "ok" : "failed",
      summary: summaryLine(out.stdout, out.stderr),
      output: tail(out.stdout + out.stderr),
      exit: out.exitCode,
    });
  } catch (e) {
    const text = String(e);
    patchHost(runId, host.serverId, /cancelled/.test(text) ? { state: "stopped" } : { state: "failed", summary: text });
  }
}

/**
 * Run a recipe on servers of the catalog: a check, an apply after a check that
 * says it would change something, or an apply alone for a recipe that cannot
 * check. `PARALLEL` servers at a time; each one's session comes from `ensure`.
 */
export async function startRecipeRun(spec: RecipeRunSpec, ensure: EnsureSession): Promise<string> {
  const id = crypto.randomUUID();
  const record: RecipeRunRecord = {
    id,
    recipeId: spec.recipe.id,
    name: spec.name,
    mode: spec.mode,
    startedAt: Date.now(),
    endedAt: null,
    stopping: false,
    hosts: spec.servers.map(({ server, prod }) => ({
      serverId: server.id,
      alias: server.alias,
      prod,
      sessionId: null,
      state: "waiting",
      summary: "",
      output: "",
      exit: null,
      cancelId: `recipe:${id}:${server.id}`,
    })),
  };
  runs = [record, ...runs];
  diag.info(SOURCE, "recipe run started", { recipe: spec.name, mode: spec.mode, servers: spec.servers.length });
  const queue = [...record.hosts];
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) await runOnHost(id, h, spec, ensure);
  };
  void Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker)).then(() => {
    const done = runOf(id);
    patchRun(id, (r) => ({ ...r, endedAt: Date.now() }));
    const failed = done?.hosts.filter((h) => h.state === "failed").length ?? 0;
    diag[failed ? "warn" : "info"](SOURCE, failed ? "recipe run ended with failures" : "recipe run ended", {
      recipe: spec.name,
      mode: spec.mode,
      servers: spec.servers.length,
      failed,
    });
  });
  return id;
}

/** Stop a run: the hosts not started yet do not start, the running ones are signalled. */
export function stopRecipeRun(id: string): void {
  const run = runOf(id);
  if (!run || run.endedAt !== null) return;
  patchRun(id, (r) => ({ ...r, stopping: true }));
  for (const h of run.hosts) {
    if (h.state === "waiting") patchHost(id, h.serverId, { state: "stopped" });
    else if (!hostDone(h.state)) void sftpCancel(h.cancelId).catch(swallow(SOURCE, "a recipe run was not told to stop", "warn"));
  }
}

/** Forget the finished runs. */
export function clearRecipeRuns(): void {
  runs = runs.filter((r) => r.endedAt === null);
}

// ── An Ansible project ────────────────────────────────────────────────────────

export interface PlaybookEntry {
  file: string;
  book: Playbook;
}

export interface AnsibleOverview {
  root: string;
  /** The project's `ansible.cfg`, when it has one. */
  config: string | null;
  playbooks: PlaybookEntry[];
  /** YAML files at the top that did not read as playbooks. */
  unreadable: string[];
  /** The inventory paths the project names (absolute). */
  inventories: string[];
  inventory: Inventory | null;
  /** Read by `ansible-inventory` itself, or from a file by hand. */
  inventorySource: "ansible" | "file" | null;
  inventoryError: string | null;
  /** `ansible-playbook --version`'s first line; null when it is not installed (`installed: false`). */
  version: string | null;
  installed: boolean;
  requirements: { collections: string[]; roles: string[] };
  /** Collections asked for and not installed; null — not known. */
  missing: string[] | null;
}

const READ_MAX = 512 * 1024;
const MAX_PLAYBOOKS = 16;

/** Read an Ansible project: its playbooks, inventory, what it needs and whether Ansible is there. */
export async function loadAnsibleProject(sessionId: string, local: boolean, root: string): Promise<AnsibleOverview> {
  const files = connectionFiles(local ? null : sessionId, READ_MAX);
  const entries = await files.list(root);
  const names = entries.map((e) => e.name);
  const Y = await loadYaml();
  const config = names.includes("ansible.cfg") ? joinPath(root, "ansible.cfg") : null;
  const cfgText = config ? await files.read(config).catch(orNull(SOURCE, "ansible.cfg was not read")) : null;
  const playbooks: PlaybookEntry[] = [];
  const unreadable: string[] = [];
  for (const e of entries.filter((x) => !x.isDir && playbookCandidate(x.name)).slice(0, MAX_PLAYBOOKS)) {
    const text = await files.read(joinPath(root, e.name)).catch(orNull(SOURCE, "a playbook was not read"));
    const book = text === null ? null : readPlaybook(parseYaml(Y, text).value);
    if (book) playbooks.push({ file: e.name, book });
    else if (!/^(requirements|galaxy)\.ya?ml$/i.test(e.name)) unreadable.push(e.name);
  }
  playbooks.sort((a, b) => (a.file === "site.yml" ? -1 : b.file === "site.yml" ? 1 : a.file.localeCompare(b.file)));
  const reqFile = names.find((n) => /^requirements\.ya?ml$/i.test(n));
  const reqText = reqFile ? await files.read(joinPath(root, reqFile)).catch(orNull(SOURCE, "requirements.yml was not read")) : null;
  const requirements = reqText ? readRequirements(parseYaml(Y, reqText).value) : { collections: [], roles: [] };

  const inventories = inventoryCandidates(entries, cfgText ? cfgInventory(cfgText) : []).map((p) =>
    p.startsWith("/") ? p : joinPath(root, p.replace(/^\.\//, "")),
  );
  const out: AnsibleOverview = {
    root,
    config,
    playbooks,
    unreadable,
    inventories,
    inventory: null,
    inventorySource: null,
    inventoryError: null,
    version: null,
    installed: false,
    requirements,
    missing: null,
  };

  const version = await iacRun(sessionId, ["ansible-playbook", "--version"], config).catch(orNull(SOURCE, "ansible-playbook --version did not run"));
  out.installed = version !== null && version.exitCode === 0;
  out.version = out.installed ? (version!.stdout.split("\n")[0] ?? "").trim() : null;

  if (inventories.length && out.installed) {
    const args = ["ansible-inventory", "--list", ...inventories.flatMap((p) => ["-i", p])];
    const res = await iacRun(sessionId, args, config, 60).catch((e: unknown) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
    out.inventory = res.exitCode === 0 ? parseInventoryJson(res.stdout) : null;
    out.inventorySource = out.inventory ? "ansible" : null;
    if (!out.inventory) out.inventoryError = summaryLine(res.stderr, res.stdout) || `exit ${res.exitCode}`;
  } else if (inventories.length) {
    // No Ansible on this host: the first INI file, read by hand and said so.
    for (const p of inventories) {
      // A path that is a folder, or gone: the next one is tried.
      const text = await files.read(p).catch(orNull(SOURCE, "an inventory file was not read"));
      if (text === null) continue;
      // JSON or YAML (a key alone on its line) is Ansible's to read, not ours.
      if (/^\s*\{/.test(text) || /^[\w.-]+:\s*$/m.test(text)) continue;
      out.inventory = parseIniInventory(text);
      out.inventorySource = "file";
      break;
    }
  }
  if (out.installed && requirements.collections.length) {
    const res = await iacRun(sessionId, ["ansible-galaxy", "collection", "list", "--format", "json"], config).catch(
      orNull(SOURCE, "the installed collections were not read"),
    );
    const have = res && res.exitCode === 0 ? installedCollections(res.stdout) : null;
    out.missing = have ? requirements.collections.filter((c) => !have.has(c)) : null;
  }
  diag.debug(SOURCE, "an Ansible project was read", {
    playbooks: playbooks.length,
    hosts: out.inventory?.hosts.length ?? 0,
    installed: out.installed,
  });
  return out;
}

export interface AnsibleWatch {
  sessionId: string;
  root: string;
  playbook: string;
  tempDir: string;
  offset: number;
  run: AnsibleRun;
  check: boolean;
  limit: string[];
  startedAt: number;
  /** The watch ended: Ansible wrote its recap, or the user stopped watching. */
  ended: boolean;
  /** The run's folder was removed (the events are kept in memory). */
  cleaned: boolean;
  error: string | null;
}

let watches = $state.raw<Record<string, AnsibleWatch>>({});

/** The playbook run watched on a session (the host of the project), if any. */
export const ansibleWatch = (sessionId: string): AnsibleWatch | null => watches[sessionId] ?? null;

function putWatch(sid: string, w: AnsibleWatch | null): void {
  const next = { ...watches };
  if (w) next[sid] = w;
  else delete next[sid];
  watches = next;
}

/**
 * Make the temporary folder of a playbook run on the session's host: vterm's
 * event collector, and the inventory of servers picked from the catalog when
 * there are any. Its path; the folder of the run watched before is removed.
 */
export async function prepareAnsibleRun(sessionId: string, catalogInventory: string | null): Promise<string> {
  const before = watches[sessionId];
  if (before) {
    putWatch(sessionId, null);
    if (!before.cleaned) void iacCleanup(sessionId, before.tempDir).catch(swallow(SOURCE, "the folder of the previous run was not removed", "warn"));
  }
  const files = [{ name: COLLECTOR_FILE, text: COLLECTOR }];
  if (catalogInventory) files.push({ name: CATALOG_INVENTORY_FILE, text: catalogInventory });
  return iacTemp(sessionId, files);
}

/** Start watching a run the page has just typed into the terminal. */
export function watchAnsibleRun(w: Omit<AnsibleWatch, "offset" | "run" | "startedAt" | "ended" | "cleaned" | "error">): void {
  putWatch(w.sessionId, { ...w, offset: 0, run: emptyRun(), startedAt: Date.now(), ended: false, cleaned: false, error: null });
  diag.info(SOURCE, "playbook run started", { check: w.check, limit: w.limit.length }, { sid: w.sessionId });
}

/** Read what the collector wrote since the last read. True while the run goes on. */
export async function pollAnsible(sessionId: string): Promise<boolean> {
  const w = watches[sessionId];
  if (!w || w.ended) return false;
  try {
    const chunk = await iacRead(sessionId, `${w.tempDir}/${EVENTS_FILE}`, w.offset);
    const cur = watches[sessionId];
    if (!cur || cur.tempDir !== w.tempDir) return false;
    if (!chunk.read) return true;
    const run = feedRun(cur.run, chunk.text);
    const ended = runEnded(run);
    putWatch(sessionId, { ...cur, run, offset: cur.offset + chunk.read, ended, error: null });
    if (ended) {
      diag.info(SOURCE, "playbook run ended", { hosts: Object.keys(run.stats ?? {}).length }, { sid: sessionId });
      cleanWatch(sessionId);
    }
    return !ended;
  } catch (e) {
    const cur = watches[sessionId];
    if (cur) putWatch(sessionId, { ...cur, error: String(e) });
    return true;
  }
}

/** Stop watching a run (Ansible was interrupted, or the user is done with it). */
export function endAnsibleWatch(sessionId: string): void {
  const w = watches[sessionId];
  if (w && !w.ended) putWatch(sessionId, { ...w, ended: true });
  cleanWatch(sessionId);
}

/**
 * Remove a finished run's folder at once: what it held is in memory now, and
 * task results may carry values of the servers — they do not wait on the disk
 * of the host for the tab to close.
 */
function cleanWatch(sessionId: string): void {
  const w = watches[sessionId];
  if (!w || w.cleaned) return;
  putWatch(sessionId, { ...w, cleaned: true });
  void iacCleanup(sessionId, w.tempDir).catch(swallow(SOURCE, "the folder of a finished playbook run was not removed", "warn"));
}

// ── A Terraform project ───────────────────────────────────────────────────────

export interface TfOverview {
  root: string;
  project: TfProject;
  /** Pinned versions of the lock file: address → version. */
  locked: Record<string, string>;
  varFiles: string[];
  initialized: boolean;
  /** `terraform version`'s; null when it is not installed. */
  version: string | null;
  installed: boolean;
}

const MAX_TF_FILES = 40;

/** Read a Terraform project from its text, and whether Terraform is there. */
export async function loadTfProject(sessionId: string, local: boolean, root: string): Promise<TfOverview> {
  const files = connectionFiles(local ? null : sessionId, READ_MAX);
  const entries = await files.list(root);
  const tf = entries.filter((e) => !e.isDir && /\.tf$/i.test(e.name)).slice(0, MAX_TF_FILES);
  const unread = (what: string) => (e: unknown) => {
    swallowed(SOURCE, what, e);
    return "";
  };
  const texts = await Promise.all(tf.map((e) => files.read(joinPath(root, e.name)).catch(unread("a .tf file was not read"))));
  const lockName = entries.find((e) => e.name === ".terraform.lock.hcl");
  const lock = lockName ? await files.read(joinPath(root, lockName.name)).catch(unread("the lock file was not read")) : "";
  const v = await iacRun(sessionId, ["terraform", "version", "-json"], null).catch(orNull(SOURCE, "terraform version did not run"));
  let version: string | null = null;
  if (v && v.exitCode === 0) {
    try {
      version = String((JSON.parse(v.stdout) as { terraform_version?: string }).terraform_version ?? "") || null;
    } catch {
      version = v.stdout.split("\n")[0]?.trim() || null;
    }
  }
  return {
    root,
    project: readProject(texts),
    locked: lockedProviders(lock),
    varFiles: varFiles(entries.filter((e) => !e.isDir).map((e) => e.name)),
    initialized: entries.some((e) => e.isDir && e.name === ".terraform"),
    version,
    installed: v !== null && v.exitCode === 0,
  };
}

export type PlanPhase = "planning" | "reading" | "ready" | "failed" | "applied";

export interface PlanWatch {
  sessionId: string;
  root: string;
  tempDir: string;
  planPath: string;
  varFiles: string[];
  phase: PlanPhase;
  plan: TfPlan | null;
  error: string | null;
  /** The plan file's size at the last look: it is read once it stops growing. */
  lastSize: number | null;
}

let plans = $state.raw<Record<string, PlanWatch>>({});

/** The plan of a session (the host of a Terraform project), if any. */
export const planWatch = (sessionId: string): PlanWatch | null => plans[sessionId] ?? null;

function putPlan(sid: string, p: PlanWatch | null): void {
  const next = { ...plans };
  if (p) next[sid] = p;
  else delete next[sid];
  plans = next;
}

/** A folder for a new plan on the session's host; the path the plan is saved to. */
export async function preparePlan(sessionId: string, root: string, chosen: string[]): Promise<string> {
  const before = plans[sessionId];
  if (before) void iacCleanup(sessionId, before.tempDir).catch(swallow(SOURCE, "the folder of the previous plan was not removed", "warn"));
  const tempDir = await iacTemp(sessionId, []);
  const planPath = `${tempDir}/plan.tfplan`;
  putPlan(sessionId, { sessionId, root, tempDir, planPath, varFiles: chosen, phase: "planning", plan: null, error: null, lastSize: null });
  diag.info(SOURCE, "terraform plan started", { files: chosen.length }, { sid: sessionId });
  return planPath;
}

/** Look for the saved plan; once its size holds, read it. True while it is awaited. */
export async function pollPlan(sessionId: string): Promise<boolean> {
  const p = plans[sessionId];
  if (!p || p.phase !== "planning") return false;
  // Past the end: only whether it is there, and its size.
  const probe = await iacRead(sessionId, p.planPath, Number.MAX_SAFE_INTEGER).catch(orNull(SOURCE, "the plan file was not looked for"));
  if (!probe || !probe.exists || probe.size === 0) return true;
  if (probe.size !== p.lastSize) {
    putPlan(sessionId, { ...p, lastSize: probe.size });
    return true;
  }
  putPlan(sessionId, { ...p, phase: "reading" });
  const res = await iacRun(sessionId, showArgv(p.root, p.planPath), null, 120).catch((e: unknown) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
  const cur = plans[sessionId];
  if (!cur || cur.planPath !== p.planPath) return false;
  const plan = res.exitCode === 0 ? parsePlan(res.stdout) : null;
  if (!plan || plan.errored) {
    putPlan(sessionId, { ...cur, phase: "failed", error: summaryLine(res.stderr, res.stdout) || `exit ${res.exitCode}` });
    diag.warn(SOURCE, "a saved terraform plan was not read", { exit: res.exitCode }, { sid: sessionId });
    return false;
  }
  putPlan(sessionId, { ...cur, phase: "ready", plan, error: null });
  const { create, update, replace, delete: destroy } = plan.counts;
  diag.info(SOURCE, "terraform plan read", { create, update, replace, destroy }, { sid: sessionId });
  return false;
}

/** The saved plan was typed into the terminal to apply: it is spent. */
export function planApplied(sessionId: string): void {
  const p = plans[sessionId];
  if (p) putPlan(sessionId, { ...p, phase: "applied" });
}

// ── A new project ─────────────────────────────────────────────────────────────

/**
 * Write a new Ansible project into `parent/name` through the connection (SFTP
 * of the session, or this computer): the folder must not exist yet — making it
 * is the first step, and it fails on one that does. Its path.
 */
export async function scaffoldAnsibleProject(sessionId: string, local: boolean, parent: string, name: string, inventory: string): Promise<string> {
  const root = joinPath(parent, name.trim());
  const mkdir = (p: string) => (local ? localMkdir(p) : sftpMkdir(sessionId, p));
  await mkdir(root);
  for (const d of SCAFFOLD_DIRS) await mkdir(joinPath(root, d));
  for (const f of scaffoldFiles(inventory)) {
    const path = f.path.split("/").reduce((acc, part) => joinPath(acc, part), root);
    if (local) await writeLocalText(path, f.text, "lf", null);
    else await sftpWriteText(sessionId, path, f.text, "lf", null, {});
  }
  diag.info(SOURCE, "a new Ansible project was written", { files: scaffoldFiles(inventory).length }, { sid: sessionId });
  return root;
}

// ── The end of a session ──────────────────────────────────────────────────────

/**
 * A tab closes (`closeTabFully`): its watched run and its plan go, and their
 * temporary folders are removed while the session can still be reached — the
 * events may hold values of the servers, a plan the secrets of the
 * infrastructure.
 */
export function forgetScenarios(sessionId: string): void {
  const w = watches[sessionId];
  const p = plans[sessionId];
  if (w) {
    putWatch(sessionId, null);
    if (!w.cleaned) void iacCleanup(sessionId, w.tempDir).catch(swallow(SOURCE, "the folder of a playbook run was not removed", "warn"));
  }
  if (p) {
    putPlan(sessionId, null);
    void iacCleanup(sessionId, p.tempDir).catch(swallow(SOURCE, "the folder of a plan was not removed", "warn"));
  }
}

/** The project kind and folder a file belongs to, for the editor's run buttons: its folder. */
export const projectRootOf = (path: string): string => parentOf(path);

export type { ProjectKind };
