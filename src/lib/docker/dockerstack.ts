// A compose stack's details (v1.33, stage 5): its services — the ones with
// containers and the ones its files declare but nothing created — what each
// is doing, the actions on one service, and the stack's configuration as
// compose renders it. Pure (ADR 0003).
//
// What a stack is made of is told by its containers' labels: the project, its
// directory, the files and the env file it was brought up with. Reading the
// configuration takes those same files (`-f`, `--env-file` — the backend allows
// them for `config` alone, which runs nothing). Starting something takes the
// project alone: `start`/`stop`/`restart` of a service act on its containers by
// the project's name; `up` of a service reads the project's directory, and so
// is offered only where the stack was brought up from that directory's own
// default file — otherwise it would bring up a different definition.

import type { DockerContainer } from "./docker";

/** A stack, as its containers' labels describe it. */
export interface DockerStack {
  project: string;
  workdir: string | null;
  files: string[];
  envFile: string;
}

/** The stack `project` from its containers; null — no container of it. */
export function stackOf(containers: readonly DockerContainer[], project: string): DockerStack | null {
  const own = containers.filter((c) => c.project === project);
  if (!project || own.length === 0) return null;
  const pick = <T>(f: (c: DockerContainer) => T | null | undefined, empty: T): T =>
    own.map(f).find((v) => v != null && (Array.isArray(v) ? v.length > 0 : v !== "")) ?? empty;
  return {
    project,
    workdir: pick((c) => c.workdir, null),
    files: pick((c) => c.configFiles, [] as string[]),
    envFile: pick((c) => c.envFile, ""),
  };
}

const DEFAULT_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const base = (p: string): string => p.split("/").pop() ?? p;
const dir = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/**
 * Whether the stack was brought up from its own choice of files — more than
 * one, a name compose would not pick by itself, a file outside its directory,
 * or an env file other than the directory's `.env`. Then what compose reads from
 * the directory alone is not this stack, and `up` from the panel would bring up
 * something else.
 */
export function usesOwnFiles(stack: DockerStack): boolean {
  if (stack.files.length > 1) return true;
  const [file] = stack.files;
  if (file && (!DEFAULT_FILES.includes(base(file)) || (stack.workdir != null && dir(file) !== stack.workdir))) return true;
  return stack.envFile !== "" && stack.workdir != null && stack.envFile !== `${stack.workdir}/.env`;
}

const head = (stack: DockerStack): string[] => {
  const out = ["docker", "compose"];
  if (stack.workdir) out.push("--project-directory", stack.workdir);
  out.push("-p", stack.project);
  return out;
};

/** The stack's configuration as compose renders it, from the files it was brought up with. */
export function stackConfigArgs(stack: DockerStack, servicesOnly = false): string[] {
  return [
    ...head(stack),
    ...stack.files.flatMap((f) => ["-f", f]),
    ...(stack.envFile ? ["--env-file", stack.envFile] : []),
    "config",
    ...(servicesOnly ? ["--services"] : []),
  ];
}

/** Every container of the stack, stopped ones too, as compose reports them. */
export function stackPsArgs(project: string): string[] {
  return ["docker", "compose", "-p", project, "ps", "-a", "--format", "json"];
}

/** One container of a service, as `compose ps` reports it. */
export interface ServiceContainer {
  id: string;
  name: string;
  /** running · exited · restarting · paused · created · dead. */
  state: string;
  /** healthy · unhealthy · starting; "" — no health check. */
  health: string;
  exitCode: number | null;
}

/**
 * `compose ps --format json` — one object per line in compose 2.21+, one array in
 * older ones; both read the same. Rows without a service are left out.
 */
export function parseStackPs(raw: string): (ServiceContainer & { service: string })[] {
  const items: unknown[] = [];
  const t = raw.trim();
  if (!t) return [];
  try {
    const doc = JSON.parse(t) as unknown;
    if (Array.isArray(doc)) items.push(...doc);
    else items.push(doc);
  } catch {
    for (const line of t.split("\n")) {
      try {
        items.push(JSON.parse(line) as unknown);
      } catch {
        /* a line that is not an object is not a container */
      }
    }
  }
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .map((r) => ({
      service: typeof r.Service === "string" ? r.Service : "",
      id: typeof r.ID === "string" ? r.ID : "",
      name: typeof r.Name === "string" ? r.Name : "",
      state: typeof r.State === "string" ? r.State.toLowerCase() : "",
      health: typeof r.Health === "string" ? r.Health : "",
      exitCode: typeof r.ExitCode === "number" ? r.ExitCode : null,
    }))
    .filter((r) => r.service);
}

/** `config --services` → the service names, in the files' order. */
export function parseServiceNames(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9][\w.-]*$/.test(l));
}

/** A service of the stack: its containers, or none — declared, never created. */
export interface StackService {
  name: string;
  containers: ServiceContainer[];
  /** Declared by the files (when they could be read). */
  declared: boolean;
}

/**
 * The stack's services: the declared ones in the files' order, then any a
 * container names that the files no longer do (a service renamed or removed
 * since the stack came up). `declared` null — the files could not be read, and
 * what has no container cannot be known.
 */
export function stackServices(
  declared: readonly string[] | null,
  rows: readonly (ServiceContainer & { service: string })[],
): StackService[] {
  const by = new Map<string, ServiceContainer[]>();
  for (const { service, ...c } of rows) {
    const list = by.get(service);
    if (list) list.push(c);
    else by.set(service, [c]);
  }
  const out: StackService[] = (declared ?? []).map((name) => ({ name, containers: by.get(name) ?? [], declared: true }));
  const known = new Set(declared ?? []);
  for (const [name, containers] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!known.has(name)) out.push({ name, containers, declared: false });
  }
  return out;
}

/** An action on one service's containers, by the project's name — no file is read. */
export type ServiceAction = "start" | "stop" | "restart";

export function serviceActionArgs(project: string, action: ServiceAction, service: string): string[] {
  return ["docker", "compose", "-p", project, action, service];
}

/** Bring one service up from the project's directory — see {@link usesOwnFiles} for when that is this stack. */
export function serviceUpArgs(stack: DockerStack, service: string): string[] {
  return [...head(stack), "up", "-d", service];
}

/** The same `up`, as a command to run by hand with the stack's own files (copied, never run by the panel). */
export function serviceUpCommand(stack: DockerStack, service: string): string {
  const argv = [
    ...head(stack),
    ...stack.files.flatMap((f) => ["-f", f]),
    ...(stack.envFile ? ["--env-file", stack.envFile] : []),
    "up",
    "-d",
    service,
  ];
  return argv.map((w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A service's log: the last lines of its containers. */
export function serviceLogsArgs(project: string, service: string | null, tail = 200): string[] {
  return ["docker", "compose", "-p", project, "logs", "--tail", String(tail), "--timestamps", "--no-color", ...(service ? [service] : [])];
}

/** How a service reads in one word: how many of its containers run, or why none does. */
export function serviceSummary(s: StackService): { word: string; tone: "ok" | "warn" | "bad" | "idle" } {
  // No container: the view says it in words ("not created"); docker has no word for it.
  if (s.containers.length === 0) return { word: "", tone: "idle" };
  const running = s.containers.filter((c) => c.state === "running");
  const unhealthy = running.some((c) => c.health === "unhealthy");
  if (s.containers.some((c) => c.state === "restarting" || c.state === "dead")) return { word: s.containers.find((c) => c.state === "restarting" || c.state === "dead")!.state, tone: "bad" };
  if (running.length === s.containers.length) {
    const n = s.containers.length > 1 ? ` ${running.length}/${s.containers.length}` : "";
    return unhealthy ? { word: `unhealthy${n}`, tone: "warn" } : { word: `running${n}`, tone: "ok" };
  }
  if (running.length > 0) return { word: `running ${running.length}/${s.containers.length}`, tone: "warn" };
  const exit = s.containers.find((c) => c.exitCode != null && c.exitCode !== 0);
  return exit ? { word: `exit ${exit.exitCode}`, tone: "bad" } : { word: s.containers[0].state || "exited", tone: "idle" };
}
