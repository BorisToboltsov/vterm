// Pure Kubernetes logic for the k8s panel (Phase 37). Everything here is
// DOM/network free so it unit-tests cleanly: argument builders (what to run) and
// parsers (how to read the output). The backend (`kube.rs` + `kubectl_run`) is a
// dumb executor — this file owns the contract. See INVARIANTS ("чистая логика в
// .ts" and the orchestration-driver block); mirrors `docker.ts`.
//
// Deliberate differences from the Docker driver (not copy-paste): output is
// parsed from `-o json` (kubectl emits strict JSON — more robust than the
// US-separated `--format` trick docker.ts uses); the `--context`/`--namespace`/
// `-A` scope is a UI selection baked into every argv via {@link withScope} rather
// than mutating kubeconfig; pods are grouped by `ownerReferences`
// ({@link groupByOwner}) as the analogue of docker's compose grouping.

// ── Program resolution ───────────────────────────────────────────────────────

/**
 * Split the configured `kubectlPath` into program tokens. Empty → the bare
 * `kubectl` on PATH. A wrapper like `k3s kubectl` or `microk8s kubectl` splits on
 * whitespace into its tokens; an absolute path stays a single token. Every token
 * is shell-quoted on the backend for SSH, so spaces inside a real path component
 * are not supported here (same simplification as a shell would need) — configure
 * such a path without spaces or symlink it.
 */
export function kubectlProg(kubectlPath: string): string[] {
  const trimmed = (kubectlPath ?? "").trim();
  if (!trimmed) return ["kubectl"];
  return trimmed.split(/\s+/);
}

// ── Scope (context / namespace) ──────────────────────────────────────────────

/**
 * The active cluster scope chosen in the UI. `namespace === null` means "no
 * `--namespace` flag" — kubectl then resolves the context's own default
 * namespace (this is how "namespace текущего контекста по умолчанию" is achieved
 * for free). `allNamespaces` maps to `-A` and overrides `namespace`.
 */
export interface K8sScope {
  context: string | null;
  namespace: string | null;
  allNamespaces: boolean;
}

/** Options controlling how {@link withScope} applies the scope to one argv. */
export interface ScopeOpts {
  /** Cluster-scoped resource (nodes, namespaces list) → skip `--namespace`/`-A`. */
  namespaced?: boolean;
  /** kubeconfig-level command (contexts list, current-context) → skip all scope. */
  scoped?: boolean;
}

/**
 * Compose the full argv run by the backend: `[...prog, ...args, …scope flags]`.
 * The `--context` flag is added when a context is chosen (unless `scoped:false`);
 * the namespace flag (`-A` or `--namespace <ns>`) is added for namespaced
 * resources only. Per-object actions (logs/describe/delete/scale on one object)
 * pass a scope whose `namespace` is the object's own `metadata.namespace` and
 * `allNamespaces:false`, so they target the right namespace even while the list
 * view is showing `-A`. kubeconfig is never mutated — the scope is per-invocation.
 */
export function withScope(
  prog: string[],
  args: string[],
  scope: K8sScope,
  opts: ScopeOpts = {},
): string[] {
  const out = [...prog, ...args];
  if (opts.scoped === false) return out;
  if (scope.context) out.push("--context", scope.context);
  if (opts.namespaced !== false) {
    if (scope.allNamespaces) out.push("-A");
    else if (scope.namespace) out.push("--namespace", scope.namespace);
  }
  return out;
}

/** Scope for a single object living in `namespace` (per-object actions). */
export function objectScope(scope: K8sScope, namespace: string): K8sScope {
  return { context: scope.context, namespace: namespace || null, allNamespaces: false };
}

// ── Argument builders (bare argv — no program, no scope) ─────────────────────

/**
 * `kubectl version -o json`, bounded by a short request timeout so an unreachable
 * API server fails fast instead of hanging the availability probe. Client and
 * server versions drive {@link parseAvailability}.
 */
export function versionArgs(): string[] {
  return ["version", "-o", "json", "--request-timeout=5s"];
}

/** All contexts by name (one per line) — feeds the context selector. */
export function contextsArgs(): string[] {
  return ["config", "get-contexts", "-o", "name"];
}

/** The kubeconfig's current context name (preselects the context dropdown). */
export function currentContextArgs(): string[] {
  return ["config", "current-context"];
}

/** All namespaces as JSON — feeds the namespace selector. Cluster-scoped. */
export function namespacesArgs(): string[] {
  return ["get", "namespaces", "-o", "json"];
}

/** All pods in scope as JSON. */
export function podsArgs(): string[] {
  return ["get", "pods", "-o", "json"];
}

/**
 * Workloads in scope as JSON: Deployments, StatefulSets, DaemonSets and CronJobs
 * in one call (the result is a `List` of mixed `kind`s, split by
 * {@link parseWorkloads}).
 */
export function workloadsArgs(): string[] {
  return ["get", "deployments,statefulsets,daemonsets,cronjobs", "-o", "json"];
}

/**
 * Per-pod CPU/memory snapshot (`kubectl top pods --no-headers`). Columnar text,
 * not JSON — parsed by {@link parseTopPods}. Degrades to a non-zero exit when
 * metrics-server is absent; the panel then simply omits the metrics columns.
 */
export function topPodsArgs(): string[] {
  return ["top", "pods", "--no-headers"];
}

/**
 * Log snapshot for one pod (not `-f` — the panel polls; live follow lives in a
 * terminal). `container` targets one container of a multi-container pod. Scope is
 * applied separately with the pod's own namespace ({@link objectScope}).
 */
export function logsArgs(pod: string, container: string | null, tail = 200): string[] {
  const args = ["logs", pod, "--tail", String(tail), "--timestamps"];
  if (container) args.push("-c", container);
  return args;
}

/** `kubectl describe <kind> <name>` (read-only detail). */
export function describeArgs(kind: string, name: string): string[] {
  return ["describe", kind, name];
}

/** `kubectl get <kind> <name> -o yaml` (read-only manifest). */
export function getYamlArgs(kind: string, name: string): string[] {
  return ["get", kind, name, "-o", "yaml"];
}

// Actions. delete/drain are destructive; scale-to-0 / rollout restart / cordon
// are disruptive-but-reversible (see {@link needsConfirm}).
export function deleteArgs(kind: string, name: string): string[] {
  return ["delete", kind, name];
}
export function scaleArgs(kind: string, name: string, replicas: number): string[] {
  return ["scale", kind, name, "--replicas", String(Math.max(0, Math.floor(replicas)))];
}
export function rolloutRestartArgs(kind: string, name: string): string[] {
  return ["rollout", "restart", `${kind}/${name}`];
}

/**
 * Interactive shell command written into a real terminal tab (like docker's
 * `execShellCommand`). NOT run via `kubectl_run` — it's a PTY command string, so
 * the user gets a live TTY inside the pod. Prefers bash, falls back to sh.
 * `prog` is the resolved kubectl program tokens; scope flags are inlined here
 * because the command runs in a shell, not through {@link withScope}.
 */
export function execShellCommand(
  prog: string[],
  pod: string,
  namespace: string,
  container: string | null,
  scope: K8sScope,
): string {
  const parts = [...prog, "exec", "-it"];
  if (scope.context) parts.push("--context", scope.context);
  if (namespace) parts.push("--namespace", namespace);
  parts.push(pod);
  if (container) parts.push("-c", container);
  parts.push("--", "sh", "-c", "'command -v bash >/dev/null 2>&1 && exec bash || exec sh'");
  return parts.join(" ");
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface K8sPod {
  name: string;
  namespace: string;
  /** Raw pod phase (Running/Pending/Succeeded/Failed/Unknown). */
  phase: string;
  /** Displayed status — the synthesized reason kubectl shows (CrashLoopBackOff,
   * ContainerCreating, Terminating, Completed…), falling back to the phase. */
  status: string;
  /** Ready containers over total, e.g. "1/1". */
  ready: string;
  /** Summed container restart count. */
  restarts: number;
  node: string;
  age: string;
  /** Container names (for the logs container picker / exec). */
  containers: string[];
  /** Owning workload kind (ReplicaSet rolled up to Deployment), "" if standalone. */
  ownerKind: string;
  ownerName: string;
}

export interface K8sWorkload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";
  name: string;
  namespace: string;
  /** "ready/desired" for Deploy/STS/DS; "" for CronJob. */
  ready: string;
  /** Desired replicas for scalable kinds; null for DaemonSet/CronJob. */
  replicas: number | null;
  /** CronJob schedule (cron expression), else "". */
  schedule: string;
  /** CronJob suspended flag. */
  suspended: boolean;
  age: string;
  /** Deployment/StatefulSet support `scale`. */
  scalable: boolean;
}

export interface K8sPodMetrics {
  namespace: string;
  name: string;
  cpu: string;
  mem: string;
}

/** A group of pods sharing one owning workload ("" name === standalone bucket). */
export interface PodGroup {
  kind: string;
  name: string;
  pods: K8sPod[];
}

// ── Age formatting ───────────────────────────────────────────────────────────

/**
 * Compact kubectl-style age from an ISO creation timestamp: "45s", "12m",
 * "3h20m", "5d", "5d4h". Two units at most; empty for an unparseable stamp. Pure
 * (accepts `nowMs` for deterministic tests).
 */
export function k8sAge(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  let s = Math.max(0, Math.floor((nowMs - t) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return h > 0 && d < 7 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Parse a `kubectl … -o json` blob into its `items[]`, tolerating junk. */
function items(raw: string): Record<string, unknown>[] {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (!doc || typeof doc !== "object") return [];
    const list = (doc as { items?: unknown }).items;
    if (Array.isArray(list)) return list as Record<string, unknown>[];
    // A single object (e.g. `get pod <name> -o json`) — wrap it.
    if ((doc as { kind?: unknown }).kind) return [doc as Record<string, unknown>];
    return [];
  } catch {
    return [];
  }
}

/** Safe nested lookup: `dig(obj, "metadata", "name")`. */
function dig(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Resolve a pod's controlling owner to a workload the user recognizes. Pods of a
 * Deployment are owned by a ReplicaSet named `<deploy>-<pod-template-hash>`; since
 * the hash never contains a dash, stripping the last `-segment` yields the
 * Deployment name (rolled up so the Pods view groups by Deployment, not by the
 * churny ReplicaSet). StatefulSets/DaemonSets/Jobs own pods directly. A pod with
 * no controller owner resolves to the empty (standalone) bucket.
 */
export function resolveOwner(refs: unknown): { kind: string; name: string } {
  if (!Array.isArray(refs) || refs.length === 0) return { kind: "", name: "" };
  const controller =
    (refs as Record<string, unknown>[]).find((r) => r.controller === true) ??
    (refs as Record<string, unknown>[])[0];
  const kind = str(controller.kind);
  const name = str(controller.name);
  if (kind === "ReplicaSet") return { kind: "Deployment", name: name.replace(/-[^-]+$/, "") };
  return { kind, name };
}

/**
 * Synthesize the status kubectl's STATUS column shows: a deleting pod is
 * "Terminating"; a container waiting/terminated with a reason surfaces that
 * (CrashLoopBackOff, ImagePullBackOff, ContainerCreating, Error…); otherwise the
 * pod phase. Pure helper for {@link parsePods}.
 */
export function podDisplayStatus(item: Record<string, unknown>): string {
  if (dig(item, "metadata", "deletionTimestamp")) return "Terminating";
  const cs = dig(item, "status", "containerStatuses");
  if (Array.isArray(cs)) {
    for (const c of cs as Record<string, unknown>[]) {
      const waiting = str(dig(c, "state", "waiting", "reason"));
      if (waiting) return waiting;
    }
    for (const c of cs as Record<string, unknown>[]) {
      const term = str(dig(c, "state", "terminated", "reason"));
      if (term && term !== "Completed") return term;
    }
  }
  return str(dig(item, "status", "phase"));
}

export function parsePods(raw: string, nowMs: number = Date.now()): K8sPod[] {
  return items(raw).map((it) => {
    const cs = dig(it, "status", "containerStatuses");
    const csArr = Array.isArray(cs) ? (cs as Record<string, unknown>[]) : [];
    const readyCount = csArr.filter((c) => c.ready === true).length;
    const restarts = csArr.reduce((sum, c) => sum + num(c.restartCount), 0);
    const specContainers = dig(it, "spec", "containers");
    const containers = Array.isArray(specContainers)
      ? (specContainers as Record<string, unknown>[]).map((c) => str(c.name)).filter(Boolean)
      : [];
    const owner = resolveOwner(dig(it, "metadata", "ownerReferences"));
    return {
      name: str(dig(it, "metadata", "name")),
      namespace: str(dig(it, "metadata", "namespace")),
      phase: str(dig(it, "status", "phase")),
      status: podDisplayStatus(it),
      ready: `${readyCount}/${containers.length || csArr.length}`,
      restarts,
      node: str(dig(it, "spec", "nodeName")),
      age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
      containers,
      ownerKind: owner.kind,
      ownerName: owner.name,
    };
  });
}

export function parseWorkloads(raw: string, nowMs: number = Date.now()): K8sWorkload[] {
  const out: K8sWorkload[] = [];
  for (const it of items(raw)) {
    const kind = str(it.kind);
    const name = str(dig(it, "metadata", "name"));
    const namespace = str(dig(it, "metadata", "namespace"));
    const age = k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs);
    if (kind === "Deployment" || kind === "StatefulSet") {
      const desired = num(dig(it, "spec", "replicas"));
      const ready = num(dig(it, "status", "readyReplicas"));
      out.push({
        kind,
        name,
        namespace,
        ready: `${ready}/${desired}`,
        replicas: desired,
        schedule: "",
        suspended: false,
        age,
        scalable: true,
      });
    } else if (kind === "DaemonSet") {
      const desired = num(dig(it, "status", "desiredNumberScheduled"));
      const ready = num(dig(it, "status", "numberReady"));
      out.push({
        kind: "DaemonSet",
        name,
        namespace,
        ready: `${ready}/${desired}`,
        replicas: null,
        schedule: "",
        suspended: false,
        age,
        scalable: false,
      });
    } else if (kind === "CronJob") {
      out.push({
        kind: "CronJob",
        name,
        namespace,
        ready: "",
        replicas: null,
        schedule: str(dig(it, "spec", "schedule")),
        suspended: dig(it, "spec", "suspend") === true,
        age,
        scalable: false,
      });
    }
  }
  return out;
}

/** Namespace names from `get namespaces -o json`, sorted. */
export function parseNamespaces(raw: string): string[] {
  return items(raw)
    .map((it) => str(dig(it, "metadata", "name")))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** Context names from `config get-contexts -o name` (newline list), sorted. */
export function parseContexts(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Parse `kubectl top pods --no-headers`: 3 columns (name cpu mem) without `-A`,
 * 4 columns (namespace name cpu mem) with it. Empty when metrics-server is
 * missing (the command then exits non-zero with no rows).
 */
export function parseTopPods(raw: string): K8sPodMetrics[] {
  const out: K8sPodMetrics[] = [];
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/).filter(Boolean);
    if (cols.length >= 4) {
      out.push({ namespace: cols[0], name: cols[1], cpu: cols[2], mem: cols[3] });
    } else if (cols.length === 3) {
      out.push({ namespace: "", name: cols[0], cpu: cols[1], mem: cols[2] });
    }
  }
  return out;
}

/** Map key aligning a pod with its metrics row (namespace-qualified when known). */
export function metricsKey(namespace: string, name: string): string {
  return namespace ? `${namespace}/${name}` : name;
}

/**
 * Group pods by owning workload. Standalone pods (no controller) collect under a
 * synthetic group with `name === ""`, sorted last; real groups sort by
 * kind then name. Within a group pods keep kubectl's order.
 */
export function groupByOwner(pods: K8sPod[]): PodGroup[] {
  const byKey = new Map<string, PodGroup>();
  for (const p of pods) {
    const key = `${p.ownerKind}/${p.ownerName}`;
    let g = byKey.get(key);
    if (!g) {
      g = { kind: p.ownerKind, name: p.ownerName, pods: [] };
      byKey.set(key, g);
    }
    g.pods.push(p);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.name === "") return 1;
    if (b.name === "") return -1;
    return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
  });
}

// ── Availability ─────────────────────────────────────────────────────────────

export type K8sAvailability =
  | { ok: true; clientVersion: string; serverVersion: string }
  | {
      ok: false;
      reason: "missing" | "no-config" | "unreachable" | "forbidden" | "unknown";
      detail: string;
    };

/**
 * Classify the outcome of {@link versionArgs}: a reachable cluster (with client +
 * server versions), or why not — kubectl binary missing, no/invalid kubeconfig,
 * API server unreachable, or access forbidden. `kubectl version -o json` prints
 * the client version even when the server is unreachable, so a parseable
 * `serverVersion.gitVersion` (regardless of exit code) is the success signal;
 * otherwise the error text decides the reason. Drives the panel's empty/error
 * state.
 */
export function parseAvailability(stdout: string, stderr: string, exitCode: number): K8sAvailability {
  let clientVersion = "";
  let serverVersion = "";
  try {
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    clientVersion = str(dig(doc, "clientVersion", "gitVersion"));
    serverVersion = str(dig(doc, "serverVersion", "gitVersion"));
  } catch {
    /* not JSON — an error path */
  }
  if (serverVersion) return { ok: true, clientVersion, serverVersion };

  const err = `${stderr}\n${stdout}`;
  if (/not found|command not found|no such file|not recognized|executable file not found/i.test(err)) {
    return { ok: false, reason: "missing", detail: stderr.trim() || stdout.trim() };
  }
  if (
    /no configuration has been provided|invalid configuration|no such file.*kube|kubeconfig|current-context is not set|context .* does not exist|no context/i.test(
      err,
    )
  ) {
    return { ok: false, reason: "no-config", detail: stderr.trim() || stdout.trim() };
  }
  if (/forbidden|unauthorized|you must be logged in|error: You must be logged in/i.test(err)) {
    return { ok: false, reason: "forbidden", detail: stderr.trim() || stdout.trim() };
  }
  if (
    /unable to connect to the server|connection refused|no route to host|i\/o timeout|dial tcp|timed out|network is unreachable|server has asked for the client to provide credentials/i.test(
      err,
    )
  ) {
    return { ok: false, reason: "unreachable", detail: stderr.trim() || stdout.trim() };
  }
  return { ok: false, reason: "unknown", detail: stderr.trim() || stdout.trim() };
}

// ── View helpers (pure) ──────────────────────────────────────────────────────

/** A semantic tone for a pod status → the UI maps it to a color token. */
export function podPhaseTone(status: string): "ok" | "warn" | "bad" | "idle" {
  switch (status) {
    case "Running":
      return "ok";
    case "Succeeded":
    case "Completed":
      return "idle";
    case "Pending":
    case "ContainerCreating":
    case "PodInitializing":
    case "Terminating":
      return "warn";
    case "CrashLoopBackOff":
    case "Error":
    case "ImagePullBackOff":
    case "ErrImagePull":
    case "Failed":
    case "OOMKilled":
    case "Evicted":
      return "bad";
    default:
      return "idle";
  }
}

// ── Destructive-op classifiers (confirmation) ────────────────────────────────

/**
 * Whether a bare argv (subcommand first, as returned by the builders — no program
 * or scope) performs a destructive/irreversible action. `delete` and `drain`
 * qualify. A safety net that drives the confirm dialog, not a security boundary.
 */
export function isDestructive(args: string[]): boolean {
  const cmd = args[0];
  return cmd === "delete" || cmd === "drain";
}

/**
 * Whether a bare argv warrants a confirmation dialog. Broader than
 * {@link isDestructive}: on top of delete/drain it also covers the
 * disruptive-but-reversible ops the user wants guarded — `cordon`, `rollout
 * restart`, and `scale` to 0 replicas. Non-mutating get/logs/describe/top never
 * prompt. Used on every server, not just prod (prod adds a red warning on top).
 */
export function needsConfirm(args: string[]): boolean {
  if (isDestructive(args)) return true;
  const cmd = args[0];
  if (cmd === "cordon") return true;
  if (cmd === "rollout" && args[1] === "restart") return true;
  if (cmd === "scale") {
    const i = args.indexOf("--replicas");
    return i >= 0 && args[i + 1] === "0";
  }
  return false;
}
