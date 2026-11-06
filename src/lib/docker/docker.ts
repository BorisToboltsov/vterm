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

import { REDACTED, redactSecrets } from "../ai/redact";
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

/**
 * The same log followed live (`-f`) — typed into a terminal tab, never run by the
 * panel: following is a stream, and a stream belongs to a terminal (v1.33).
 */
export function followLogsArgv(id: string, tail = 200): string[] {
  return ["docker", "logs", "-f", "--tail", String(tail), "--timestamps", id];
}

/** Aggregated log snapshot for a whole compose project. */
export function composeLogsArgs(project: string, tail = 200): string[] {
  return ["docker", "compose", "-p", project, "logs", "--tail", String(tail), "--timestamps", "--no-color"];
}

/** Full `docker inspect` (pretty JSON) of a container/image (read-only detail). */
export function inspectArgs(id: string): string[] {
  return ["docker", "inspect", id];
}

/** Between a network's name and its addresses, and between networks, in {@link inspectFactsArgs}. */
const GS = "\x1d";
const RS = "\x1e";

/**
 * What `docker ps` does not say about a container, for several containers in one
 * call: its resource ceilings (Phase 43), how often it was restarted, its
 * network mode and its address in each network (v1.33), when it last started or
 * stopped, how it exited.
 *
 * `docker stats` alone cannot answer "is this container near its limit": for an
 * unlimited container it reports `MemUsage` against the **host's** total and
 * `MemPerc` as a share of host RAM, which reads exactly like a limit but is not
 * one. The ceiling only exists in `HostConfig`, and the addresses only in
 * `NetworkSettings` — so it takes an inspect, asked again only when what `ps`
 * shows of a container changes or the answer is old ({@link staleFacts}).
 */
export function inspectFactsArgs(ids: readonly string[]): string[] {
  const nets = `{{range $name, $net := .NetworkSettings.Networks}}{{$name}}${GS}{{$net.IPAddress}}${GS}{{$net.GlobalIPv6Address}}${RS}{{end}}`;
  const fmt = [
    "{{.Id}}",
    "{{.HostConfig.NanoCpus}}",
    "{{.HostConfig.Memory}}",
    "{{.RestartCount}}",
    "{{.HostConfig.NetworkMode}}",
    nets,
    "{{.State.StartedAt}}",
    "{{.State.FinishedAt}}",
    "{{.State.ExitCode}}",
    "{{.State.OOMKilled}}",
  ].join(US);
  return ["docker", "inspect", "--format", fmt, ...ids];
}

/** A container's configured ceilings; null means "no limit set" (docker reports 0). */
export interface DockerLimits {
  /** CPU limit in whole cores (`--cpus`), or null when unlimited. */
  cpuCores: number | null;
  /** Memory limit in bytes (`--memory`), or null when unlimited. */
  memBytes: number | null;
}

/** A container's address in one of its networks; "" — none of that family. */
export interface DockerAddress {
  network: string;
  ipv4: string;
  ipv6: string;
}

/** What {@link inspectFactsArgs} tells about a container. */
export interface DockerFacts extends DockerLimits {
  /** How many times docker restarted it (`RestartCount`); null — not reported. */
  restarts: number | null;
  /** `HostConfig.NetworkMode`: `bridge`, `host`, `none`, `container:<id>`, a network's name. */
  networkMode: string;
  /** Its addresses, one per network, in docker's (name) order. */
  addresses: DockerAddress[];
  /** When it last started / stopped, epoch ms; null — never (docker's zero time). */
  startedAt: number | null;
  finishedAt: number | null;
  /** The code it last exited with; null — not reported. */
  exitCode: number | null;
  /** The kernel killed it for memory. */
  oomKilled: boolean;
}

/**
 * An RFC 3339 stamp with docker's nanoseconds (`2026-11-06T10:41:02.123456789Z`)
 * as epoch ms; null for docker's zero time (`0001-01-01…` — "never") or junk.
 */
export function parseInspectTime(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s || s.startsWith("0001-")) return null;
  // `Date.parse` reads milliseconds; docker writes up to nine digits.
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(t) ? t : null;
}

function parseAddresses(raw: string | undefined): DockerAddress[] {
  return (raw ?? "")
    .split(RS)
    .filter((part) => part.trim())
    .map((part) => {
      const [network = "", ipv4 = "", ipv6 = ""] = part.split(GS);
      return { network: network.trim(), ipv4: ipv4.trim(), ipv6: ipv6.trim() };
    })
    .filter((a) => a.network);
}

const count = (raw: string | undefined): number | null => {
  const n = Number((raw ?? "").trim());
  return (raw ?? "").trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
};

/** Parse {@link inspectFactsArgs} output into a map keyed by full container id. */
export function parseFacts(raw: string): Map<string, DockerFacts> {
  const out = new Map<string, DockerFacts>();
  for (const f of rows(raw)) {
    const id = f[0]?.trim();
    if (!id) continue;
    const nanos = Number(f[1]);
    const mem = Number(f[2]);
    const exit = Number((f[8] ?? "").trim());
    out.set(id, {
      cpuCores: Number.isFinite(nanos) && nanos > 0 ? nanos / 1e9 : null,
      memBytes: Number.isFinite(mem) && mem > 0 ? mem : null,
      restarts: count(f[3]),
      networkMode: (f[4] ?? "").trim(),
      addresses: parseAddresses(f[5]),
      startedAt: parseInspectTime(f[6]),
      finishedAt: parseInspectTime(f[7]),
      exitCode: (f[8] ?? "").trim() !== "" && Number.isInteger(exit) ? exit : null,
      oomKilled: (f[9] ?? "").trim() === "true",
    });
  }
  return out;
}

/** What is known of a container that `ps` cannot say — and when it was asked. */
export interface FactsEntry {
  facts: DockerFacts;
  /** What `ps` showed of it then ({@link factsKey}). */
  key: string;
  /** When it was asked, epoch ms. */
  at: number;
}

/** How long the facts of a running container stand before they are asked again. */
export const FACTS_TTL_MS = 30_000;

/**
 * What of a container, as `ps` shows it, the facts depend on: a start or a stop
 * gives new addresses and times, a network joined or left changes them too.
 */
export function factsKey(c: DockerContainer): string {
  return `${normalizeState(c.state)}|${c.networks.join(",")}`;
}

/**
 * The containers whose facts have to be asked (again): never asked, changed
 * since ({@link factsKey}), or — while it runs — asked longer than `ttl` ago: a
 * restart policy can restart it between two polls, and nothing `ps` shows would
 * say so but the restart count. A stopped container's facts do not change until
 * it starts, and the start changes its key. One inspect asks for all of them.
 */
export function staleFacts(
  containers: readonly DockerContainer[],
  cache: ReadonlyMap<string, FactsEntry>,
  nowMs: number,
  ttl: number = FACTS_TTL_MS,
): string[] {
  return containers
    .filter((c) => {
      const e = cache.get(c.id);
      if (!e || e.key !== factsKey(c)) return true;
      const live = ["running", "restarting"].includes(normalizeState(c.state));
      return live && nowMs - e.at >= ttl;
    })
    .map((c) => c.id);
}

/** Where a container can be reached inside docker — what its address cell says. */
export type AddressView =
  /** Its addresses; `first` is shown, the rest are in the tooltip. */
  | { kind: "ip"; first: string; all: DockerAddress[] }
  /** `--network host`: it has no address of its own — the host's. */
  | { kind: "host" }
  /** `--network none`: no network at all. */
  | { kind: "none" }
  /** `--network container:X`: X's address — `with` is X's name, or its short id. */
  | { kind: "shared"; with: string }
  /** Not running: docker gives a stopped container no address. */
  | { kind: "down" }
  /** Not asked yet, or docker did not say. */
  | { kind: "unknown" };

/**
 * A container's address cell. The address is docker's own — inside its network;
 * outside the docker host the container is reached through its published ports,
 * which the view says in words (the tooltip), not by hiding the address.
 */
export function containerAddress(
  c: DockerContainer,
  facts: DockerFacts | undefined,
  containers: readonly DockerContainer[] = [],
): AddressView {
  if (!facts) return { kind: "unknown" };
  const mode = facts.networkMode;
  if (mode === "host") return { kind: "host" };
  if (mode === "none") return { kind: "none" };
  if (mode.startsWith("container:")) {
    const target = mode.slice("container:".length);
    const peer = containers.find((o) => o.name === target || (o.id && (target.startsWith(o.id) || o.id.startsWith(target))));
    return { kind: "shared", with: peer?.name ?? target.slice(0, 12) };
  }
  const all = facts.addresses.filter((a) => a.ipv4 || a.ipv6);
  if (all.length > 0) return { kind: "ip", first: all[0].ipv4 || all[0].ipv6, all };
  return isRunning(c) ? { kind: "unknown" } : { kind: "down" };
}

/** What a container's own health check says, from `ps`'s status line; null — it has none. */
export type ContainerHealth = "healthy" | "unhealthy" | "starting";

export function containerHealth(c: DockerContainer): ContainerHealth | null {
  if (/\(unhealthy\)/.test(c.status)) return "unhealthy";
  if (/\(health: starting\)/.test(c.status)) return "starting";
  if (/\(healthy\)/.test(c.status)) return "healthy";
  return null;
}

/** The code in `Exited (1) 2 days ago`; null — not an exit line. */
export function exitCodeOf(c: DockerContainer): number | null {
  const m = /^Exited \((-?\d+)\)/.exec(c.status.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Codes a container stopped *on purpose* exits with: 0, and the signals `docker
 * stop` and Ctrl+C send (SIGTERM 143, SIGKILL after the grace period 137, SIGINT
 * 130). A kill for memory exits 137 too — that one is told by `OOMKilled`.
 */
const STOPPED_ON_PURPOSE = new Set([0, 130, 137, 143]);

/** A container's state cell: the word, its tone and how long it has been so. */
export interface StateSummary {
  /** docker's own vocabulary: `running`, `healthy`, `exit 1`, `paused`… — not translated. */
  word: string;
  tone: "ok" | "warn" | "bad" | "idle";
  /** Since the last start (running) or stop (exited), compact; null — not known. */
  age: string | null;
}

export function stateSummary(c: DockerContainer, facts: DockerFacts | undefined, nowMs: number = Date.now()): StateSummary {
  const state = normalizeState(c.state);
  const since = (t: number | null | undefined): string | null => (t == null ? null : compactAge(t, nowMs) || null);
  if (state === "running") {
    const health = containerHealth(c);
    const tone = health === "unhealthy" ? "warn" : health === "starting" ? "idle" : "ok";
    return { word: health ?? "running", tone, age: since(facts?.startedAt) };
  }
  if (state === "exited") {
    const code = facts?.exitCode ?? exitCodeOf(c);
    if (facts?.oomKilled) return { word: "OOMKilled", tone: "bad", age: since(facts.finishedAt) };
    const tone = code == null || STOPPED_ON_PURPOSE.has(code) ? "idle" : "bad";
    return { word: code == null ? "exited" : `exit ${code}`, tone, age: since(facts?.finishedAt) };
  }
  return { word: state || "—", tone: stateTone(state), age: null };
}

// ── A container's details: what `docker inspect` says (v1.33, stage 1) ───────
//
// The Overview of the details reads the full `docker inspect <id>` — the same
// call the Inspect view makes — and shows what explains a container in trouble:
// its health check and the last probes with their output, how it is started and
// restarted, what is mounted into it, its environment and labels.

/** One run of a container's health check. */
export interface HealthProbe {
  /** When it started, epoch ms; null — not reported. */
  start: number | null;
  exitCode: number | null;
  /** What the check printed, as docker keeps it (docker keeps the last few). */
  output: string;
  /** The last non-empty line of it — what a failing check usually says (`HTTP Error 503`). */
  last: string;
}

export interface HealthDetail {
  /** `healthy` · `unhealthy` · `starting` · `none`; "" — not reported. */
  status: string;
  /** How many runs in a row have failed. */
  failingStreak: number;
  /** The check as a command (`CMD`/`CMD-SHELL` taken off); "" — none declared. */
  test: string;
  /** Between runs and before a run is given up, compact (`10s`); null — docker's default. */
  interval: string | null;
  timeout: string | null;
  retries: number | null;
  /** Newest first. */
  probes: HealthProbe[];
}

export interface EnvVar {
  key: string;
  value: string;
  /** Masked until the user asks to see it: the name or the value looks like a secret. */
  sensitive: boolean;
}

export interface MountDetail {
  /** `bind` · `volume` · `tmpfs` · `npipe`. */
  type: string;
  /** Host path or volume name. */
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface ContainerDetail {
  /** What runs: the entrypoint and its arguments, as docker records them. */
  command: string;
  /** `no` · `always` · `unless-stopped` · `on-failure` (`on-failure:5` with a limit). */
  restartPolicy: string;
  /** null — the container declares no health check. */
  health: HealthDetail | null;
  env: EnvVar[];
  mounts: MountDetail[];
  labels: { key: string; value: string }[];
}

/**
 * Names that mark a value as a secret. Broader than the assistant's redaction
 * on purpose (`KEY`, `AUTH`, `SALT`, `DSN`, `COOKIE`): a value hidden by mistake
 * costs one click, one shown by mistake is on the screen of a shared call.
 */
const SECRET_NAME = /(pass|pwd|secret|token|key|cred|auth|salt|private|cookie|session|signature|dsn)/i;

/** Whether an environment variable is masked until asked for. */
export function isSensitiveEnv(key: string, value: string): boolean {
  if (SECRET_NAME.test(key)) return true;
  return redactSecrets(value).count > 0;
}

/** A sensitive value as the view prints it while masked: the marker the recordings use. */
export const MASKED = REDACTED;

/** Nanoseconds (docker's durations) as a compact duration: `10s`, `1m30s`; null for 0 or junk. */
export function nanosDuration(ns: unknown): string | null {
  if (typeof ns !== "number" || !Number.isFinite(ns) || ns <= 0) return null;
  const totalMs = Math.round(ns / 1e6);
  if (totalMs < 1000) return `${totalMs}ms`;
  const s = Math.round(totalMs / 1000);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${s}s`;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}

/** A health check's `Test` as a command: `CMD` args joined, `CMD-SHELL` as written, `NONE` — off. */
export function healthTest(test: unknown): string {
  if (!Array.isArray(test) || test.length === 0) return "";
  const parts = test.map((p) => (typeof p === "string" ? p : ""));
  if (parts[0] === "NONE") return "";
  if (parts[0] === "CMD-SHELL") return parts.slice(1).join(" ");
  if (parts[0] === "CMD") return parts.slice(1).map(shellWord).join(" ");
  return parts.map(shellWord).join(" ");
}

/**
 * A word quoted for reading when it would not survive as one (spaces, quotes):
 * in double quotes when nothing in it means something there (`"`, `$`, `` ` ``,
 * `\\`), else in single quotes — a health check's script reads as written.
 */
function shellWord(w: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w)) return w;
  if (!/["$`\\]/.test(w)) return `"${w}"`;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * A container's details from `docker inspect <id>` (a JSON array of one); null
 * when the answer is not that — an error, an image, junk.
 */
export function parseContainerDetail(raw: string): ContainerDetail | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const it = obj(Array.isArray(doc) ? doc[0] : doc);
  const config = obj(it.Config);
  const state = obj(it.State);
  if (!it.Id || !it.State) return null;
  const host = obj(it.HostConfig);
  const args = Array.isArray(it.Args) ? it.Args.map(text) : [];
  const command = [text(it.Path), ...args].filter(Boolean).map(shellWord).join(" ");
  const policy = obj(host.RestartPolicy);
  const name = text(policy.Name) || "no";
  const retries = int(policy.MaximumRetryCount);
  const restartPolicy = name === "on-failure" && retries ? `on-failure:${retries}` : name;
  const check = obj(config.Healthcheck);
  const hstate = obj(state.Health);
  const test = healthTest(check.Test);
  const log = Array.isArray(hstate.Log) ? (hstate.Log as unknown[]).map(obj) : [];
  const health: HealthDetail | null =
    test || text(hstate.Status)
      ? {
          status: text(hstate.Status),
          failingStreak: int(hstate.FailingStreak) ?? 0,
          test,
          interval: nanosDuration(check.Interval),
          timeout: nanosDuration(check.Timeout),
          retries: int(check.Retries) || null,
          probes: log
            .map((p) => ({
              start: parseInspectTime(text(p.Start)),
              exitCode: int(p.ExitCode),
              output: text(p.Output),
              last: lastLine(text(p.Output)),
            }))
            .reverse(),
        }
      : null;
  const env = (Array.isArray(config.Env) ? config.Env.map(text) : [])
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      const key = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? "" : line.slice(at + 1);
      return { key, value, sensitive: isSensitiveEnv(key, value) };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const mounts = (Array.isArray(it.Mounts) ? (it.Mounts as unknown[]).map(obj) : []).map((m) => ({
    type: text(m.Type),
    source: text(m.Name) || text(m.Source),
    destination: text(m.Destination),
    readOnly: m.RW === false,
  }));
  const labels = Object.entries(obj(config.Labels))
    .map(([key, value]) => ({ key, value: text(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { command, restartPolicy, health, env, mounts, labels };
}

/** Why a container needs a look (v1.33): the strip above the list. */
export type AttentionReason = "dead" | "restarting" | "oom" | "unhealthy" | "restarts" | "exited";

export interface DockerAttention {
  id: string;
  name: string;
  reason: AttentionReason;
  tone: "warn" | "bad";
  /** The figure that says it: the exit code, how many restarts since the panel opened. */
  detail: string;
}

/**
 * How long an exit stays news. A container that crashed an hour ago needs a
 * look; one that has been stopped for a week — a stack nobody started again, a
 * daemon that was shut down under it (`exit 255`) — is history, still shown by
 * its state word in the list, not by the strip.
 */
export const FRESH_EXIT_MS = 24 * 3_600_000;

const ATTENTION_RANK: Record<AttentionReason, number> = {
  dead: 0,
  restarting: 1,
  oom: 2,
  unhealthy: 3,
  restarts: 4,
  exited: 5,
};

/**
 * What needs a look, worst first. A restart count that was already there when
 * the panel first saw the container is history, not news — it counts only once
 * it grows while the panel is open (`baseline`, the way the monitoring page
 * reads its counters). An exit the user asked for (`docker stop`) is not a
 * problem; any other non-zero one is, while it is fresh ({@link FRESH_EXIT_MS});
 * one whose time is not known yet counts as fresh rather than vanishing.
 */
export function dockerAttention(
  containers: readonly DockerContainer[],
  facts: ReadonlyMap<string, DockerFacts>,
  baseline: ReadonlyMap<string, number>,
  nowMs: number = Date.now(),
): DockerAttention[] {
  const out: DockerAttention[] = [];
  for (const c of containers) {
    const f = facts.get(c.id);
    const state = normalizeState(c.state);
    const add = (reason: AttentionReason, tone: "warn" | "bad", detail = "") =>
      out.push({ id: c.id, name: c.name, reason, tone, detail });
    if (state === "dead") add("dead", "bad");
    else if (state === "restarting") add("restarting", "bad", f?.restarts ? `↻${f.restarts}` : "");
    else if (state === "exited") {
      const code = f?.exitCode ?? exitCodeOf(c);
      const fresh = f?.finishedAt == null || nowMs - f.finishedAt < FRESH_EXIT_MS;
      if (!fresh) continue;
      if (f?.oomKilled) add("oom", "bad", code == null ? "" : `exit ${code}`);
      else if (code != null && !STOPPED_ON_PURPOSE.has(code)) add("exited", "warn", `exit ${code}`);
    } else if (state === "running") {
      const grew = f?.restarts != null && f.restarts > (baseline.get(c.id) ?? f.restarts);
      if (containerHealth(c) === "unhealthy") add("unhealthy", "warn", f?.restarts ? `↻${f.restarts}` : "");
      else if (grew) add("restarts", "warn", `↻+${f!.restarts! - baseline.get(c.id)!}`);
    }
  }
  return out.sort((a, b) => ATTENTION_RANK[a.reason] - ATTENTION_RANK[b.reason] || byText(a.name, b.name));
}

/**
 * The restart counts the panel compares against: the first one it saw of each
 * container, kept; gone containers forgotten. Pure — the panel holds the map.
 */
export function restartBaseline(
  prev: ReadonlyMap<string, number>,
  facts: ReadonlyMap<string, DockerFacts>,
  live: readonly string[],
): Map<string, number> {
  const next = new Map<string, number>();
  for (const id of live) {
    const seen = prev.get(id);
    const now = facts.get(id)?.restarts;
    if (seen != null) next.set(id, seen);
    else if (now != null) next.set(id, now);
  }
  return next;
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

/**
 * The views of a container's details (`DockerDetail`). The log comes first and
 * is where details open (v1.33): it is what a container is opened for.
 */
export type DockerDetailTab = "logs" | "overview" | "inspect";

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
