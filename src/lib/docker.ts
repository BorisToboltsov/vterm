// Pure Docker logic for the Docker panel (Phase 35). Everything here is
// DOM/network free so it unit-tests cleanly: argument builders (what to run) and
// parsers (how to read the output). The backend (`container.rs` + `container_run`)
// is a dumb executor — this file owns the contract. See INVARIANTS ("чистая
// логика в .ts"), mirrors `git.ts`.
//
// Output is made machine-readable with a custom `--format` using a US (0x1f)
// field separator and newline records — robust to spaces/commas in values
// (ports, image names), the same trick `git.ts` uses. `{{json .}}` is avoided
// because its `Labels`/`Ports` fields are themselves comma-joined and ambiguous.

const US = "\x1f";

/** Compose label keys used to group containers into projects. */
const LABEL_PROJECT = "com.docker.compose.project";
const LABEL_SERVICE = "com.docker.compose.service";
const LABEL_WORKDIR = "com.docker.compose.project.working_dir";

// ── Argument builders ────────────────────────────────────────────────────────

/**
 * `docker version` reduced to the server (daemon) version — exit 0 with a
 * version string when the daemon is reachable, non-zero when docker is missing
 * or the daemon is down (see {@link parseAvailability}).
 */
export function versionArgs(): string[] {
  return ["docker", "version", "--format", "{{.Server.Version}}"];
}

/** All containers (running + stopped), US-delimited fields incl. compose labels. */
export function psArgs(): string[] {
  const fmt = [
    "{{.ID}}",
    "{{.Names}}",
    "{{.Image}}",
    "{{.State}}",
    "{{.Status}}",
    "{{.Ports}}",
    `{{.Label "${LABEL_PROJECT}"}}`,
    `{{.Label "${LABEL_SERVICE}"}}`,
    `{{.Label "${LABEL_WORKDIR}"}}`,
    "{{.CreatedAt}}",
    "{{.RunningFor}}",
  ].join(US);
  return ["docker", "ps", "-a", "--format", fmt];
}

export function imagesArgs(): string[] {
  const fmt = ["{{.ID}}", "{{.Repository}}", "{{.Tag}}", "{{.Size}}", "{{.CreatedSince}}"].join(US);
  return ["docker", "images", "--format", fmt];
}

export function networksArgs(): string[] {
  const fmt = ["{{.ID}}", "{{.Name}}", "{{.Driver}}", "{{.Scope}}"].join(US);
  return ["docker", "network", "ls", "--format", fmt];
}

export function volumesArgs(): string[] {
  const fmt = ["{{.Name}}", "{{.Driver}}"].join(US);
  return ["docker", "volume", "ls", "--format", fmt];
}

/** One-shot resource snapshot for the visible containers (no streaming). */
export function statsArgs(): string[] {
  const fmt = [
    "{{.ID}}",
    "{{.Name}}",
    "{{.CPUPerc}}",
    "{{.MemUsage}}",
    "{{.MemPerc}}",
    "{{.NetIO}}",
    "{{.BlockIO}}",
    "{{.PIDs}}",
  ].join(US);
  return ["docker", "stats", "--no-stream", "--format", fmt];
}

/** Log snapshot (not `-f` — the panel polls; live follow lives in a terminal). */
export function logsArgs(id: string, tail = 200): string[] {
  return ["docker", "logs", "--tail", String(tail), "--timestamps", id];
}

/** Aggregated log snapshot for a whole compose project. */
export function composeLogsArgs(project: string, tail = 200): string[] {
  return ["docker", "compose", "-p", project, "logs", "--tail", String(tail), "--timestamps", "--no-color"];
}

/** Full `docker inspect` (pretty JSON) of a container/image (read-only detail). */
export function inspectArgs(id: string): string[] {
  return ["docker", "inspect", id];
}

// Lifecycle actions (ids may be several). start/stop/restart are reversible;
// remove/prune are destructive (see {@link isDestructive}).
export function startArgs(ids: string[]): string[] {
  return ["docker", "start", ...ids];
}
export function stopArgs(ids: string[]): string[] {
  return ["docker", "stop", ...ids];
}
export function restartArgs(ids: string[]): string[] {
  return ["docker", "restart", ...ids];
}
export function removeArgs(ids: string[], force = false): string[] {
  return force ? ["docker", "rm", "-f", ...ids] : ["docker", "rm", ...ids];
}
export function removeImageArgs(ids: string[], force = false): string[] {
  return force ? ["docker", "rmi", "-f", ...ids] : ["docker", "rmi", ...ids];
}
export function removeVolumeArgs(names: string[]): string[] {
  return ["docker", "volume", "rm", ...names];
}
export function removeNetworkArgs(ids: string[]): string[] {
  return ["docker", "network", "rm", ...ids];
}

// Prune (bulk reclamation) — always destructive.
export function pruneContainersArgs(): string[] {
  return ["docker", "container", "prune", "-f"];
}
export function pruneImagesArgs(): string[] {
  return ["docker", "image", "prune", "-f"];
}
export function pruneVolumesArgs(): string[] {
  return ["docker", "volume", "prune", "-f"];
}
export function pruneNetworksArgs(): string[] {
  return ["docker", "network", "prune", "-f"];
}
export function pruneSystemArgs(): string[] {
  return ["docker", "system", "prune", "-f"];
}

// Compose group actions. `workdir` (from the project label) lets a stopped
// project be reconstructed; when null, compose infers files from running
// containers. `-p` scopes every op to the one project.
export function composeUpArgs(project: string, workdir: string | null): string[] {
  const base = ["docker", "compose"];
  if (workdir) base.push("--project-directory", workdir);
  base.push("-p", project, "up", "-d");
  return base;
}
export function composeDownArgs(project: string, workdir: string | null): string[] {
  const base = ["docker", "compose"];
  if (workdir) base.push("--project-directory", workdir);
  base.push("-p", project, "down");
  return base;
}
export function composeRestartArgs(project: string): string[] {
  return ["docker", "compose", "-p", project, "restart"];
}

/**
 * Interactive shell command written into a real terminal tab (Phase 35, point 5).
 * NOT run via `container_run` — it's a PTY command string, so the user gets a
 * live TTY inside the container. Prefers bash, falls back to sh on minimal
 * images (the user picked `exec bash || exec sh`).
 */
export function execShellCommand(id: string): string {
  return `docker exec -it ${id} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
}

// ── Registry auth (Phase 36) ─────────────────────────────────────────────────

/**
 * A stored registry credential — the non-secret half. The password lives only in
 * the OS keychain (scoped by `url`), never here and never in the profile/settings
 * JSON, so it can't leak through a backup export. An empty `url` means Docker Hub.
 */
export interface DockerRegistry {
  /** Registry host (e.g. `ghcr.io`, `registry.example.com`); "" = Docker Hub. */
  url: string;
  username: string;
}

/** Human label for a registry entry — the bare Docker Hub gets a friendly name. */
export function registryLabel(url: string): string {
  return url.trim() || "Docker Hub";
}

/**
 * Coerce persisted/imported JSON into a clean `DockerRegistry[]`: keep only
 * object rows with string url/username, trim them, drop entries with no username
 * (a registry login needs one), and de-duplicate by url (last wins). Secrets are
 * never part of this — they live in the keychain.
 */
export function sanitizeDockerRegistries(raw: unknown): DockerRegistry[] {
  if (!Array.isArray(raw)) return [];
  const byUrl = new Map<string, DockerRegistry>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const url = typeof (r as DockerRegistry).url === "string" ? (r as DockerRegistry).url.trim() : "";
    const username =
      typeof (r as DockerRegistry).username === "string" ? (r as DockerRegistry).username.trim() : "";
    if (!username) continue;
    byUrl.set(url, { url, username });
  }
  return [...byUrl.values()];
}

/**
 * Argument vector for `docker login`, built with `--password-stdin` so the secret
 * is NEVER placed on the command line (where it would show up in `ps` and could
 * leak into the recording). The backend (`docker_login`) feeds the password on
 * stdin and never mirrors this command. An empty `registry` logs into Docker Hub.
 */
export function loginArgs(registry: string, username: string): string[] {
  const args = ["docker", "login"];
  if (registry.trim()) args.push(registry.trim());
  args.push("-u", username, "--password-stdin");
  return args;
}

/** Argument vector for `docker logout` (empty `registry` = Docker Hub). */
export function logoutArgs(registry: string): string[] {
  const args = ["docker", "logout"];
  if (registry.trim()) args.push(registry.trim());
  return args;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  /** Normalized lifecycle state: running · exited · paused · created · restarting · dead. */
  state: string;
  /** Human status line (e.g. "Up 2 hours", "Exited (0) 3 min ago"). */
  status: string;
  /** Port mappings string as docker renders it (may be empty). */
  ports: string;
  /** Compose project name, or "" for a standalone container. */
  project: string;
  /** Compose service name within the project, or "". */
  service: string;
  /** Compose project working directory (for `up`/`down`), or null. */
  workdir: string | null;
  createdAt: string;
  runningFor: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
}

export interface DockerStat {
  id: string;
  name: string;
  cpu: string;
  mem: string;
  memPerc: string;
  netIo: string;
  blockIo: string;
  pids: string;
}

/** A compose project (`project` === "" is the synthetic standalone bucket). */
export interface ComposeGroup {
  project: string;
  workdir: string | null;
  containers: DockerContainer[];
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Split a US-delimited, newline-record blob into non-empty field rows. */
function rows(raw: string): string[][] {
  const out: string[][] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    out.push(line.split(US));
  }
  return out;
}

export function parsePs(raw: string): DockerContainer[] {
  return rows(raw).map((f) => ({
    id: f[0] ?? "",
    name: f[1] ?? "",
    image: f[2] ?? "",
    state: normalizeState(f[3] ?? ""),
    status: f[4] ?? "",
    ports: f[5] ?? "",
    project: f[6] ?? "",
    service: f[7] ?? "",
    workdir: f[8] ? f[8] : null,
    createdAt: f[9] ?? "",
    runningFor: f[10] ?? "",
  }));
}

/** Canonicalize the state token (defensive — docker already lowercases it). */
export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

export function parseImages(raw: string): DockerImage[] {
  return rows(raw)
    // `<none>:<none>` dangling rows keep their id; skip fully-empty repo+id noise.
    .filter((f) => (f[0] ?? "").length > 0)
    .map((f) => ({
      id: f[0] ?? "",
      repository: f[1] ?? "",
      tag: f[2] ?? "",
      size: f[3] ?? "",
      created: f[4] ?? "",
    }));
}

export function parseNetworks(raw: string): DockerNetwork[] {
  return rows(raw).map((f) => ({
    id: f[0] ?? "",
    name: f[1] ?? "",
    driver: f[2] ?? "",
    scope: f[3] ?? "",
  }));
}

export function parseVolumes(raw: string): DockerVolume[] {
  return rows(raw).map((f) => ({ name: f[0] ?? "", driver: f[1] ?? "" }));
}

export function parseStats(raw: string): DockerStat[] {
  return rows(raw).map((f) => ({
    id: f[0] ?? "",
    name: f[1] ?? "",
    cpu: f[2] ?? "",
    mem: f[3] ?? "",
    memPerc: f[4] ?? "",
    netIo: f[5] ?? "",
    blockIo: f[6] ?? "",
    pids: f[7] ?? "",
  }));
}

/**
 * Group containers by compose project. Standalone containers (no project label)
 * collect under a synthetic group with `project === ""`, sorted last. Within a
 * group, containers keep docker's order (roughly service order). The workdir is
 * taken from the first container in the project that reports one.
 */
export function groupByCompose(containers: DockerContainer[]): ComposeGroup[] {
  const byProject = new Map<string, ComposeGroup>();
  for (const c of containers) {
    const key = c.project;
    let g = byProject.get(key);
    if (!g) {
      g = { project: key, workdir: null, containers: [] };
      byProject.set(key, g);
    }
    if (!g.workdir && c.workdir) g.workdir = c.workdir;
    g.containers.push(c);
  }
  return [...byProject.values()].sort((a, b) => {
    // Standalone bucket ("") sorts last; real projects alphabetically.
    if (a.project === "") return 1;
    if (b.project === "") return -1;
    return a.project.localeCompare(b.project);
  });
}

export type DockerAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: "missing" | "daemon" | "denied" | "unknown"; detail: string };

/**
 * Classify the outcome of {@link versionArgs}: reachable daemon (with version),
 * or why not — docker binary missing, daemon down, or permission denied (user
 * not in the `docker` group). Drives the panel's empty/error state.
 */
export function parseAvailability(stdout: string, stderr: string, exitCode: number): DockerAvailability {
  if (exitCode === 0 && stdout.trim()) {
    return { ok: true, version: stdout.trim() };
  }
  const err = `${stderr}\n${stdout}`;
  if (/not found|command not found|no such file|not recognized|executable file not found/i.test(err)) {
    return { ok: false, reason: "missing", detail: stderr.trim() || stdout.trim() };
  }
  if (/permission denied|dial unix.*permission/i.test(err)) {
    return { ok: false, reason: "denied", detail: stderr.trim() || stdout.trim() };
  }
  if (/cannot connect to the docker daemon|is the docker daemon running|dial unix/i.test(err)) {
    return { ok: false, reason: "daemon", detail: stderr.trim() || stdout.trim() };
  }
  return { ok: false, reason: "unknown", detail: stderr.trim() || stdout.trim() };
}

// ── Destructive-op classifier (prod confirmation) ────────────────────────────

/**
 * Whether an argument vector performs a destructive/irreversible docker action,
 * so the UI can require confirmation on prod-tagged servers. Bias: over-flag.
 * A safety net, not a security boundary (the prod gate + confirm dialog are).
 * `args[0]` is the program (`docker`).
 */
export function isDestructive(args: string[]): boolean {
  // Skip the leading program token.
  const [cmd, ...rest] = args[0] === "docker" ? args.slice(1) : args;
  switch (cmd) {
    case "rm":
    case "rmi":
      return true;
    case "container":
    case "image":
    case "volume":
    case "network":
    case "system":
      return rest[0] === "prune" || rest[0] === "rm";
    case "compose":
      return rest.includes("down");
    default:
      return false;
  }
}

/**
 * Whether an op warrants a confirmation dialog (Phase 36, point 3). Broader than
 * {@link isDestructive}: on top of every destructive op (rm/rmi/prune/compose
 * down) it also covers the *disruptive-but-reversible* ones the user wants
 * guarded — stop, restart, and compose stop/restart. Non-destructive
 * start/up/logs/inspect never prompt. Used on every server, not just prod.
 */
export function needsConfirm(args: string[]): boolean {
  if (isDestructive(args)) return true;
  const [cmd, ...rest] = args[0] === "docker" ? args.slice(1) : args;
  switch (cmd) {
    case "stop":
    case "restart":
    case "kill":
      return true;
    case "compose":
      return rest.includes("stop") || rest.includes("restart");
    default:
      return false;
  }
}

// ── View helpers (pure) ──────────────────────────────────────────────────────

/** Whether a container is currently running (drives action availability). */
export function isRunning(c: DockerContainer): boolean {
  return c.state === "running";
}

/** One labelled fact about a container, for the hover card / detail overview. */
export type DockerInfoKey = "status" | "ports" | "cpu" | "mem" | "net" | "created";
export interface DockerInfoRow {
  key: DockerInfoKey;
  value: string;
}

/**
 * The per-container facts that used to sit inline on the row (Phase 36, point 4):
 * status, published ports, and — only while running and a stats snapshot exists —
 * CPU / memory / network I/O, plus the created-at age. Empty fields are dropped so
 * the hover card and the detail Overview render only what's present.
 */
export function containerInfoRows(c: DockerContainer, stat?: DockerStat): DockerInfoRow[] {
  const rows: DockerInfoRow[] = [];
  if (c.status) rows.push({ key: "status", value: c.status });
  if (c.ports) rows.push({ key: "ports", value: c.ports });
  if (stat && isRunning(c)) {
    if (stat.cpu) rows.push({ key: "cpu", value: stat.cpu });
    if (stat.mem) rows.push({ key: "mem", value: stat.mem });
    if (stat.netIo) rows.push({ key: "net", value: stat.netIo });
  }
  if (c.createdAt) rows.push({ key: "created", value: c.createdAt });
  return rows;
}

/** A semantic tone for a container state → the UI maps it to a color token. */
export function stateTone(state: string): "ok" | "warn" | "bad" | "idle" {
  switch (normalizeState(state)) {
    case "running":
      return "ok";
    case "restarting":
    case "paused":
      return "warn";
    case "dead":
      return "bad";
    default: // exited, created
      return "idle";
  }
}
