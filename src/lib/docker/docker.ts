// Pure Docker logic for the Docker panel (Phase 35). Everything here is
// DOM/network free so it unit-tests cleanly: argument builders (what to run) and
// parsers (how to read the output). The backend (`container.rs` + `container_run`)
// is a dumb executor — this file owns the contract. See INVARIANTS «чистая логика — в .ts»;
// mirrors `git.ts`.
//
// Output is made machine-readable with a custom `--format` using a US (0x1f)
// field separator and newline records — robust to spaces/commas in values
// (ports, image names), the same trick `git.ts` uses. `{{json .}}` is avoided
// because its `Labels`/`Ports` fields are themselves comma-joined and ambiguous.

import { SHELL_SCRIPT } from "../terminal/termcmd";
import { compactAge } from "../ui/age";
import { NO_GROUPS, type ListOrder, type ListSchema } from "../ui/listview";

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

/**
 * All containers (running + stopped), US-delimited fields incl. compose labels.
 * `{{.Networks}}` rides along (v1.5): membership costs one token here, where a
 * `network inspect` per network would cost a call each.
 */
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
    "{{.Networks}}",
  ].join(US);
  return ["docker", "ps", "-a", "--format", fmt];
}

/**
 * `CreatedAt`, not `CreatedSince`: docker's own phrase ("About an hour ago",
 * "3 weeks ago") needs an 80px column and cannot be localized; the timestamp
 * gives both the compact age and a real date for the tooltip.
 */
export function imagesArgs(): string[] {
  const fmt = ["{{.ID}}", "{{.Repository}}", "{{.Tag}}", "{{.Size}}", "{{.CreatedAt}}"].join(US);
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

/**
 * Per-container resource ceilings for several containers in one call (Phase 43).
 *
 * `docker stats` alone cannot answer "is this container near its limit": for an
 * unlimited container it reports `MemUsage` against the **host's** total and
 * `MemPerc` as a share of host RAM, which reads exactly like a limit but is not
 * one. The ceiling only exists in `HostConfig`, so it takes an inspect — but it
 * is fixed for the life of a container, so it is fetched once per id and cached,
 * not polled.
 */
export function inspectLimitsArgs(ids: readonly string[]): string[] {
  const fmt = ["{{.Id}}", "{{.HostConfig.NanoCpus}}", "{{.HostConfig.Memory}}"].join(US);
  return ["docker", "inspect", "--format", fmt, ...ids];
}

/** A container's configured ceilings; null means "no limit set" (docker reports 0). */
export interface DockerLimits {
  /** CPU limit in whole cores (`--cpus`), or null when unlimited. */
  cpuCores: number | null;
  /** Memory limit in bytes (`--memory`), or null when unlimited. */
  memBytes: number | null;
}

/** Parse {@link inspectLimitsArgs} output into a map keyed by full container id. */
export function parseLimits(raw: string): Map<string, DockerLimits> {
  const out = new Map<string, DockerLimits>();
  for (const f of rows(raw)) {
    const id = f[0]?.trim();
    if (!id) continue;
    const nanos = Number(f[1]);
    const mem = Number(f[2]);
    out.set(id, {
      cpuCores: Number.isFinite(nanos) && nanos > 0 ? nanos / 1e9 : null,
      memBytes: Number.isFinite(mem) && mem > 0 ? mem : null,
    });
  }
  return out;
}

/** Byte multipliers docker uses in `MemUsage` (it mixes binary and decimal suffixes). */
const MEM_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/**
 * Bytes actually in use, from the left half of docker's `MemUsage`
 * (`"412MiB / 1GiB"`). The right half is deliberately ignored: it is the limit
 * *or* the host total depending on whether one was set, and the two are
 * indistinguishable here — {@link parseLimits} is the honest source.
 */
export function parseMemUsed(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = MEM_UNITS[m[2].toLowerCase()];
  return Number.isFinite(n) && mult ? n * mult : null;
}

/**
 * Totals for a compose project: summed CPU percent and memory bytes over the
 * containers that reported a reading. Returns null for a resource nothing
 * reported, so an empty or fully-idle-unreported project shows "—" rather than a
 * confident zero.
 */
export function groupUsage(
  containers: readonly DockerContainer[],
  statsById: ReadonlyMap<string, DockerStat>,
  parsePct: (s: string | undefined) => number | null,
): { cpu: number | null; mem: number | null } {
  let cpu: number | null = null;
  let mem: number | null = null;
  for (const c of containers) {
    const st = statsById.get(c.id) ?? statsById.get(c.id.slice(0, 12));
    const pct = parsePct(st?.cpu);
    if (pct != null) cpu = (cpu ?? 0) + pct;
    const used = parseMemUsed(st?.mem);
    if (used != null) mem = (mem ?? 0) + used;
  }
  return { cpu, mem };
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
 * Interactive shell command typed into a real terminal tab (Phase 35, point 5).
 * NOT run via `container_run` — it runs in a PTY, so the user gets a live TTY
 * inside the container. Returned as argv: the tab renders it for the shell it
 * actually runs (`renderArgv`) — the POSIX string misfires in cmd.exe.
 */
export function execShellArgv(id: string): string[] {
  return ["docker", "exec", "-it", id, "sh", "-c", SHELL_SCRIPT];
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
  /**
   * Names of the networks the container is attached to, sorted. `host` and `none`
   * are network *modes* docker lists the same way; a container sharing another
   * one's namespace (`--network container:…`) has none at all.
   */
  networks: string[];
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  /** Raw `CreatedAt` stamp — see {@link dockerAge} / {@link dockerDate}. */
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
    networks: parseNetworkNames(f[11]),
  }));
}

/**
 * `{{.Networks}}` → sorted names. Docker joins them with commas in no stable
 * order (the same container printed `a,b` created and `b,a` exited), so they are
 * sorted here — otherwise a poll could reshuffle a list nothing happened to.
 */
export function parseNetworkNames(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
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

/**
 * Remediation command shown in the `denied` availability state (user not in the
 * `docker` group). A one-time privileged host change the user runs themselves —
 * we never execute it silently (needs sudo/TTY + a re-login to take effect). Not
 * translated: it's a shell command (domain term), like the rest of docker argv.
 */
export const DOCKER_GROUP_ADD_CMD = "sudo usermod -aG docker $USER";

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

// ── Creation time ────────────────────────────────────────────────────────────

const DOCKER_TIME =
  /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.\d+)?\s*(?:(Z)|([+-])(\d\d):?(\d\d))?/;

/**
 * Epoch ms of a docker `CreatedAt` stamp ("2026-09-12 14:03:11 +0300 MSK";
 * the trailing zone name is ignored — the numeric offset is the unambiguous
 * half). A stamp without an offset is read as UTC. `null` when unparseable.
 */
export function parseDockerTime(raw: string): number | null {
  const m = DOCKER_TIME.exec((raw ?? "").trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(utc)) return null;
  const offsetMin = m[8] ? (m[8] === "-" ? -1 : 1) * (+m[9] * 60 + +m[10]) : 0;
  return utc - offsetMin * 60_000;
}

/** Compact age of a `CreatedAt` stamp ("3w"); "—" when it cannot be read. */
export function dockerAge(raw: string, nowMs: number = Date.now()): string {
  const t = parseDockerTime(raw);
  return t == null ? "—" : compactAge(t, nowMs);
}

/**
 * A `CreatedAt` stamp as a date in the UI language and the viewer's zone, with
 * the compact age appended ("12 сент. 2026 г., 14:03 · 3w"). An unparseable
 * stamp is returned as docker printed it — better raw than invented.
 */
export function dockerDate(
  raw: string,
  locale: string,
  nowMs: number = Date.now(),
  timeZone?: string,
): string {
  const t = parseDockerTime(raw);
  if (t == null) return raw;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(t);
  return `${date} · ${compactAge(t, nowMs)}`;
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

/** The views of a container's details (`DockerDetail`). */
export type DockerDetailTab = "overview" | "logs" | "inspect";

// ── List views (v1.29, ADR 0050) ─────────────────────────────────────────────
//
// What the filter row, the facets and the «View» menu of the three sub-tabs
// read. The model is `ui/listview.ts`; here is only what a container, an image,
// a network is ordered, grouped and narrowed by.

/** The compose facet's value of a container in no project — a name compose cannot give one. */
export const STANDALONE = "~standalone";

/** Lifecycle states in the order a list shows them; `unhealthy` — running, its health check failing. */
export const CONTAINER_STATES = ["running", "unhealthy", "restarting", "paused", "created", "exited", "dead"];

/** What a container is filtered and grouped by: docker's state, or `unhealthy`. */
export function containerState(c: DockerContainer): string {
  const state = normalizeState(c.state);
  return state === "running" && /\(unhealthy\)/.test(c.status) ? "unhealthy" : state;
}

const stateRank = (state: string): number => {
  const i = CONTAINER_STATES.indexOf(state);
  return i === -1 ? CONTAINER_STATES.length : i;
};
const byText = (a: string, b: string): number => a.localeCompare(b);

/** The live figures a container is ordered by; null — `docker stats` has none for it. */
export interface ContainerUsage {
  cpu: number | null;
  mem: number | null;
}

export function containerSchema(usage: (c: DockerContainer) => ContainerUsage): ListSchema<DockerContainer> {
  const figure = (key: keyof ContainerUsage) => ({
    compare: (a: DockerContainer, b: DockerContainer) => (usage(a)[key] ?? 0) - (usage(b)[key] ?? 0),
    missing: (c: DockerContainer) => usage(c)[key] === null,
  });
  return {
    text: (c) => `${c.name} ${c.image} ${c.ports} ${c.project} ${c.service}`,
    sorts: [
      { id: "name", firstDir: "asc", compare: (a, b) => byText(a.name, b.name) },
      { id: "image", firstDir: "asc", compare: (a, b) => byText(a.image, b.image) },
      { id: "state", firstDir: "asc", compare: (a, b) => stateRank(containerState(a)) - stateRank(containerState(b)) },
      { id: "cpu", firstDir: "desc", ...figure("cpu") },
      { id: "mem", firstDir: "desc", ...figure("mem") },
    ],
    groups: [
      // Projects by name; the standalone containers (no project) are the rest.
      { id: "compose", of: (c) => ({ key: c.project, label: c.project }), compare: (a, b) => byText(a.label, b.label) },
      {
        id: "state",
        of: (c) => ({ key: containerState(c), label: containerState(c) }),
        compare: (a, b) => stateRank(a.key) - stateRank(b.key),
      },
    ],
    facets: [
      { id: "state", value: containerState },
      { id: "compose", value: (c) => c.project || STANDALONE },
    ],
    tie: (a, b) => byText(a.name, b.name) || byText(a.id, b.id),
  };
}

/** Compose stacks, containers by name — how the list lay before it had a choice. */
export const CONTAINER_ORDER: ListOrder = { sort: { key: "name", dir: "asc" }, group: "compose" };

/** An image without a name: what `docker image prune` removes. */
export function isDangling(img: DockerImage): boolean {
  return img.repository === "<none>";
}

export const IMAGE_SCHEMA: ListSchema<DockerImage> = {
  text: (img) => `${img.repository}:${img.tag} ${img.id}`,
  sorts: [
    { id: "name", firstDir: "asc", compare: (a, b) => byText(a.repository, b.repository) || byText(a.tag, b.tag) },
    {
      id: "size",
      firstDir: "desc",
      compare: (a, b) => (parseMemUsed(a.size) ?? 0) - (parseMemUsed(b.size) ?? 0),
      missing: (img) => parseMemUsed(img.size) === null,
    },
    {
      id: "created",
      firstDir: "desc",
      compare: (a, b) => (parseDockerTime(a.created) ?? 0) - (parseDockerTime(b.created) ?? 0),
      missing: (img) => parseDockerTime(img.created) === null,
    },
  ],
  groups: [
    // By repository; images without one (dangling) are the rest.
    {
      id: "repo",
      of: (img) => (isDangling(img) ? { key: "", label: "" } : { key: img.repository, label: img.repository }),
      compare: (a, b) => byText(a.label, b.label),
    },
  ],
  facets: [{ id: "kind", value: (img) => (isDangling(img) ? "dangling" : "tagged"), order: ["tagged", "dangling"] }],
  tie: (a, b) => byText(a.id, b.id),
};

export const IMAGE_ORDER: ListOrder = { sort: { key: "name", dir: "asc" }, group: NO_GROUPS };

/** A row of the networks sub-tab: a published port, a network or a volume. */
export type NetItem =
  | { kind: "port"; name: string }
  | { kind: "network"; name: string; driver: string }
  | { kind: "volume"; name: string; driver: string };

/**
 * The networks sub-tab narrows its three sections by one filter: the text by
 * name, the driver facet over networks and volumes (a port has no driver, so a
 * picked driver leaves the ports out).
 */
export const NET_SCHEMA: ListSchema<NetItem> = {
  text: (item) => item.name,
  sorts: [],
  facets: [{ id: "driver", value: (item) => (item.kind === "port" ? "" : item.driver) }],
  tie: (a, b) => byText(a.name, b.name),
};
