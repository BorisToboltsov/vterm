// Pure Kubernetes logic for the k8s panel (Phase 37). Everything here is
// DOM/network free so it unit-tests cleanly: argument builders (what to run) and
// parsers (how to read the output). The backend (`kube.rs` + `kubectl_run`) is a
// dumb executor — this file owns the contract. See INVARIANTS «чистая логика — в .ts»
// and the k8s row of the driver table; mirrors `docker.ts`.
//
// Deliberate differences from the Docker driver (not copy-paste): output is
// parsed from `-o json` (kubectl emits strict JSON — more robust than the
// US-separated `--format` trick docker.ts uses); the `--context`/`--namespace`/
// `-A` scope is a UI selection baked into every argv via {@link withScope} rather
// than mutating kubeconfig; pods are grouped by `ownerReferences`
// ({@link groupByOwner}) as the analogue of docker's compose grouping.

import { isSensitiveEnv } from "../ai/redact";
import { SHELL_SCRIPT } from "../terminal/termcmd";
import { compactAge } from "../ui/age";
import { NO_GROUPS, type ListOrder, type ListSchema } from "../ui/listview";

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

/**
 * All contexts as kubectl's table — feeds the context selector, and its NAMESPACE
 * column names the namespace "(context default)" stands for ({@link parseContexts}).
 * `-o name` gave the names alone, and the selector then said "by context" without
 * saying which namespace that was: a list from `default` read as the whole cluster.
 */
export function contextsArgs(): string[] {
  return ["config", "get-contexts"];
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
  // The Jobs in the same call (stage 4): a Job of its own is a workload, a
  // CronJob's runs are its CronJob's — and they are what rolls their pods up.
  return ["get", "deployments,statefulsets,daemonsets,cronjobs,jobs", "-o", "json"];
}

/** The Jobs in scope as JSON — for the pods poll, when a pod is a Job's (stage 4). */
export function jobsArgs(): string[] {
  return ["get", "jobs", "-o", "json"];
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

// Going back and running by hand (v1.36, ADR 0061) — the only other changes the
// backend lets through (`kube::check_args`): a Deployment to one of its revisions,
// and a CronJob's Job made now.
export function rollbackArgs(name: string, revision: number): string[] {
  return ["rollout", "undo", `deployment/${name}`, `--to-revision=${Math.max(0, Math.floor(revision))}`];
}

/** The longest name a Job may have: it is a label value of its pods. */
const JOB_NAME_MAX = 63;

/**
 * The name of a Job made by hand from a CronJob: `<cronjob>-manual-<time>`, as
 * kubectl's own help names one — told apart from the schedule's runs at a glance,
 * and within the 63 a Job's name may have (a CronJob's own may be 52).
 */
export function manualJobName(cronjob: string, nowMs: number): string {
  const suffix = `-manual-${Math.floor(nowMs / 1000).toString(36)}`;
  const head = cronjob.slice(0, JOB_NAME_MAX - suffix.length).replace(/-+$/, "");
  return `${head}${suffix}`;
}

export function runNowArgs(cronjob: string, nowMs: number = Date.now()): string[] {
  return ["create", "job", manualJobName(cronjob, nowMs), `--from=cronjob/${cronjob}`];
}

/**
 * Interactive shell command typed into a real terminal tab (like docker's
 * `execShellArgv`). NOT run via `kubectl_run` — it runs in a PTY, so the user
 * gets a live TTY inside the pod. Prefers bash, falls back to sh. `prog` is the
 * resolved kubectl program tokens; scope flags are inlined here because the
 * command runs in a shell, not through {@link withScope}. Returned as argv — the
 * tab renders it for its own shell (`renderArgv`).
 */
export function execShellArgv(
  prog: string[],
  pod: string,
  namespace: string,
  container: string | null,
  scope: K8sScope,
): string[] {
  const parts = [...prog, "exec", "-it"];
  if (scope.context) parts.push("--context", scope.context);
  if (namespace) parts.push("--namespace", namespace);
  parts.push(pod);
  if (container) parts.push("-c", container);
  parts.push("--", "sh", "-c", SHELL_SCRIPT);
  return parts;
}

/**
 * A pod's log followed live (`-f`) from the last `tail` lines — typed into a
 * terminal tab like {@link execShellArgv}, never run by the panel: following is
 * a stream, and a stream belongs to a terminal (v1.33).
 */
export function followLogsArgv(
  prog: string[],
  pod: string,
  namespace: string,
  container: string | null,
  scope: K8sScope,
  tail = 200,
): string[] {
  const parts = [...prog, "logs", "-f", "--tail", String(tail), "--timestamps"];
  if (scope.context) parts.push("--context", scope.context);
  if (namespace) parts.push("--namespace", namespace);
  parts.push(pod);
  if (container) parts.push("-c", container);
  return parts;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface K8sPod {
  name: string;
  namespace: string;
  /** Raw pod phase (Running/Pending/Succeeded/Failed/Unknown). */
  phase: string;
  /** Displayed status — what kubectl's STATUS column prints (CrashLoopBackOff,
   * Init:1/2, NotReady, Terminating, Completed…), falling back to the phase ({@link podRow}). */
  status: string;
  /** Ready containers over all of them, native sidecars included, e.g. "2/2". */
  ready: string;
  /** Restarts as kubectl's RESTARTS counts them — sidecars included. */
  restarts: number;
  node: string;
  age: string;
  /** Container names, app containers then native sidecars (logs container picker / exec). */
  containers: string[];
  /** Owning workload kind (ReplicaSet rolled up to Deployment), "" if standalone. */
  ownerKind: string;
  ownerName: string;
  /**
   * Pod CPU limit in millicores, or null when the pod is effectively unbounded
   * (see `sumLimit`). Read from the `-o json` we already fetch — `kubectl top`
   * reports usage but never the ceiling, so before Phase 43 the panel had a
   * numerator with no denominator.
   */
  cpuLimit: number | null;
  /** Pod memory limit in MiB, or null when unbounded. */
  memLimit: number | null;
  /** QoS class (`Guaranteed`/`Burstable`/`BestEffort`), "" when absent. */
  qos: string;
  /** When it was created, epoch ms — what «age» orders by (v1.29); null — not reported. */
  created?: number | null;
  /**
   * Its addresses (v1.33): `status.podIPs` — two for a dual-stack pod — or the
   * older single `status.podIP`; empty until the pod is given one.
   */
  podIps?: string[];
  /** The address of the node it runs on (`status.hostIP`); "" until it is scheduled. */
  hostIp?: string;
  /** `spec.hostNetwork`: its address is the node's, not one of its own. */
  hostNetwork?: boolean;
  /** `metadata.uid` — what its events are asked by (stage 2); "" — not reported. */
  uid?: string;
  /** The latest OOM kill of any of its containers, epoch ms; null — none it remembers. */
  oomAt?: number | null;
  /** What kubelet says while an image cannot be pulled; "" — none is stuck so. */
  imagePull?: string;
  /** What the scheduler says while no node takes it ({@link schedulerReason}); "" — it is not refused. */
  unschedulable?: string;
  /** A running container is not ready and has a readinessProbe — the probe is what fails. */
  readinessFailing?: boolean;
  /** What its running containers ask for (stage 3): millicores and MiB; null — none asks. */
  cpuRequest?: number | null;
  memRequest?: number | null;
  /** The application it is part of ({@link appOf}, stage 6); null — it does not say. */
  app?: K8sApp | null;
}

const IMAGE_PULL = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull"]);

/**
 * The scheduler's own words on why no node takes a pod — `1 Insufficient memory`
 * out of `0/1 nodes are available: 1 Insufficient memory. preemption: …`; another
 * message as it is.
 */
export function schedulerReason(message: string): string {
  const m = /nodes are available: (.*?)(?:\. preemption:|\.\s*$|$)/.exec(message.trim());
  return (m ? m[1] : message).trim();
}

/** What a pod's object says needs a look, for {@link podAttention} — read with the list. */
function podSigns(it: Record<string, unknown>): Pick<K8sPod, "oomAt" | "imagePull" | "unschedulable" | "readinessFailing"> {
  const statuses = [
    ...records(dig(it, "status", "containerStatuses")),
    ...records(dig(it, "status", "initContainerStatuses")),
  ];
  let oomAt: number | null = null;
  let imagePull = "";
  for (const c of statuses) {
    for (const part of ["state", "lastState"]) {
      const term = dig(c, part, "terminated") as Record<string, unknown> | undefined;
      if (str(term?.reason) !== "OOMKilled") continue;
      const at = Date.parse(str(term?.finishedAt));
      if (Number.isFinite(at) && (oomAt == null || at > oomAt)) oomAt = at;
    }
    const waiting = dig(c, "state", "waiting") as Record<string, unknown> | undefined;
    if (!imagePull && IMAGE_PULL.has(str(waiting?.reason))) imagePull = str(waiting?.message).trim() || str(waiting?.reason);
  }
  const scheduled = records(dig(it, "status", "conditions")).find((c) => c.type === "PodScheduled");
  const unschedulable =
    scheduled && scheduled.status === "False" && scheduled.reason === "Unschedulable" ? schedulerReason(str(scheduled.message)) : "";
  const probed = new Set(
    podContainers(it)
      .filter((c) => c.readinessProbe && typeof c.readinessProbe === "object")
      .map((c) => str(c.name)),
  );
  const readinessFailing = statuses.some(
    (c) => probed.has(str(c.name)) && c.ready === false && dig(c, "state", "running") != null,
  );
  return { oomAt, imagePull, unschedulable, readinessFailing };
}

export interface K8sWorkload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob" | "Job";
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
  /** When it was created, epoch ms (v1.29); null — not reported. */
  created?: number | null;
  /** `metadata.uid` — what its ReplicaSets and Jobs name as their owner (stage 4). */
  uid?: string;
  /** A Job's state ({@link K8sJob}); "" for the other kinds. */
  status?: string;
  /** The application it is part of ({@link appOf}, stage 6); null — it does not say. */
  app?: K8sApp | null;
}

export interface K8sPodMetrics {
  namespace: string;
  name: string;
  cpu: string;
  mem: string;
}

/** A group of pods sharing one owning workload ("" name === standalone bucket). */
// ── Age formatting ───────────────────────────────────────────────────────────

/**
 * Compact age from an ISO creation timestamp ("45s", "3h20m", "5d4h", "3w",
 * "8mo" — see {@link compactAge}); empty for an unparseable stamp. Pure (accepts
 * `nowMs` for deterministic tests).
 */
export function k8sAge(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? compactAge(t, nowMs) : "";
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

/**
 * kubectl CPU quantity → millicores: `"120m"` → 120, `"1"` → 1000, `"1500n"` →
 * 0.0015. Null when unparseable (metrics-server absent prints `<unknown>`).
 */
export function parseCpuMillis(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([munk]?)\s*$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "n":
      return n / 1e6;
    case "u":
      return n / 1e3;
    case "m":
      return n;
    default:
      return n * 1000;
  }
}

/** kubectl memory quantity → MiB: `"412Mi"` → 412, `"1Gi"` → 1024. Null if unparseable. */
export function parseMemMiB(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?i?\s*$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? "";
  const MIB = 1024 * 1024;
  switch (unit) {
    case "Ki":
    case "K":
      return (n * 1024) / MIB;
    case "Mi":
    case "M":
      return n;
    case "Gi":
    case "G":
      return n * 1024;
    case "Ti":
    case "T":
      return n * 1024 * 1024;
    default:
      return n / MIB; // bare number is bytes
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `metadata.creationTimestamp` as epoch ms, or null when absent or unreadable. */
function createdAt(it: Record<string, unknown>): number | null {
  const ms = Date.parse(str(dig(it, "metadata", "creationTimestamp")));
  return Number.isFinite(ms) ? ms : null;
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

/** An init container that keeps running beside the app: a native sidecar (k8s ≥ 1.29). */
function isSidecar(c: Record<string, unknown>): boolean {
  return c.restartPolicy === "Always";
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : [];
}

function conditionTrue(item: Record<string, unknown>, type: string): boolean {
  return records(dig(item, "status", "conditions")).some((c) => c.type === type && c.status === "True");
}

/** A terminated state without a reason, as kubectl prints it: the signal, else the exit code. */
function bareExit(term: Record<string, unknown>): string {
  const signal = num(term.signal);
  return signal ? `Signal:${signal}` : `ExitCode:${num(term.exitCode)}`;
}

/** What `kubectl get pods` prints for a pod in its STATUS, READY and RESTARTS columns. */
export interface PodRow {
  status: string;
  /** Ready containers over all of them, native sidecars included, e.g. "2/2". */
  ready: string;
  restarts: number;
}

/**
 * A pod as kubectl's own printer reads it (`printPod`, pkg/printers/internalversion):
 * the pod's reason or phase; while it initializes — the init step or the failing init
 * container's reason (`Init:1/2`, `Init:CrashLoopBackOff`) and their restarts; after —
 * the first container with a waiting or terminated reason, `NotReady` for a finished
 * container beside a running one in a pod that is not Ready. A native sidecar is one of
 * the pod's containers: it counts in READY once started and in RESTARTS. Deletion reads
 * `Terminating` only for a pod that has not finished. Pure helper for {@link parsePods}.
 */
export function podRow(item: Record<string, unknown>): PodRow {
  const initSpec = records(dig(item, "spec", "initContainers"));
  const sidecars = new Set(initSpec.filter(isSidecar).map((c) => str(c.name)));
  const statuses = records(dig(item, "status", "containerStatuses"));
  const total = records(dig(item, "spec", "containers")).length + sidecars.size || statuses.length;
  const phase = str(dig(item, "status", "phase"));
  let reason = str(dig(item, "status", "reason")) || phase;
  const gated = records(dig(item, "status", "conditions")).some(
    (c) => c.type === "PodScheduled" && c.reason === "SchedulingGated",
  );
  if (gated) reason = "SchedulingGated";

  let ready = 0;
  let restarts = 0;
  let sidecarRestarts = 0;
  let initializing = false;
  for (const [i, c] of records(dig(item, "status", "initContainerStatuses")).entries()) {
    const count = num(c.restartCount);
    const sidecar = sidecars.has(str(c.name));
    restarts += count;
    if (sidecar) sidecarRestarts += count;
    const term = dig(c, "state", "terminated") as Record<string, unknown> | undefined;
    const waiting = str(dig(c, "state", "waiting", "reason"));
    if (term && num(term.exitCode) === 0) continue;
    if (sidecar && c.started === true) {
      if (c.ready === true) ready++;
      continue;
    }
    if (term) reason = `Init:${str(term.reason) || bareExit(term)}`;
    else if (waiting && waiting !== "PodInitializing") reason = `Init:${waiting}`;
    else reason = `Init:${i}/${initSpec.length}`;
    initializing = true;
    break;
  }

  if (!initializing || conditionTrue(item, "Initialized")) {
    restarts = sidecarRestarts;
    let hasRunning = false;
    // Backwards, as kubectl does: the first container with a reason has the last word.
    for (let i = statuses.length - 1; i >= 0; i--) {
      const c = statuses[i];
      restarts += num(c.restartCount);
      const waiting = str(dig(c, "state", "waiting", "reason"));
      const term = dig(c, "state", "terminated") as Record<string, unknown> | undefined;
      if (waiting) reason = waiting;
      else if (term) reason = str(term.reason) || bareExit(term);
      else if (c.ready === true && dig(c, "state", "running")) {
        hasRunning = true;
        ready++;
      }
    }
    if (reason === "Completed" && hasRunning) reason = conditionTrue(item, "Ready") ? "Running" : "NotReady";
  }

  if (dig(item, "metadata", "deletionTimestamp")) {
    if (str(dig(item, "status", "reason")) === "NodeLost") reason = "Unknown";
    else if (phase !== "Succeeded" && phase !== "Failed") reason = "Terminating";
  }
  return { status: reason, ready: `${ready}/${total}`, restarts };
}

/** The STATUS column alone — see {@link podRow}. */
export function podDisplayStatus(item: Record<string, unknown>): string {
  return podRow(item).status;
}

/**
 * Sum one resource limit across a pod's running containers — its app containers and
 * native sidecars ({@link podContainers}); an ordinary init container has finished
 * before they start and is no part of the ceiling.
 *
 * Returns null when **any** container lacks the limit, because that is what the
 * cluster does: one unbounded container makes the whole pod unbounded, and
 * summing only the containers that happen to declare a limit would invent a
 * ceiling the scheduler never enforces. Showing "800m / 500m" for such a pod
 * would be worse than showing nothing.
 */
export function sumLimit(
  containers: readonly Record<string, unknown>[],
  key: "cpu" | "memory",
  parse: (s: string | undefined) => number | null,
): number | null {
  if (containers.length === 0) return null;
  let total = 0;
  for (const c of containers) {
    const v = parse(str(dig(c, "resources", "limits", key)));
    if (v == null) return null;
    total += v;
  }
  return total;
}

/**
 * Sum one resource request across a pod's running containers. A container that
 * asks for nothing adds nothing — that is how the scheduler counts it (a limit
 * without a request has the request defaulted to it in the spec we read); null
 * when none asks at all.
 */
export function sumRequest(
  containers: readonly Record<string, unknown>[],
  key: "cpu" | "memory",
  parse: (s: string | undefined) => number | null,
): number | null {
  let total: number | null = null;
  for (const c of containers) {
    const v = parse(str(dig(c, "resources", "requests", key)));
    if (v != null) total = (total ?? 0) + v;
  }
  return total;
}

/** Fraction of a limit in use (0…1+), or null when either side is unknown. */
export function limitRatio(usage: number | null, limit: number | null): number | null {
  if (usage == null || limit == null || !(limit > 0)) return null;
  return usage / limit;
}

/**
 * Tone for a usage/limit ratio. `null` ratio stays `null` — an unbounded pod is
 * not "healthy", it is unmeasured, and colouring it green would say otherwise.
 */
export function limitTone(ratio: number | null): "ok" | "warn" | "bad" | null {
  if (ratio == null) return null;
  if (ratio >= 0.9) return "bad";
  if (ratio >= 0.75) return "warn";
  return "ok";
}

/** The objects of a `kubectl get … -o json` list, tolerating junk. */
export function listItems(raw: string): Record<string, unknown>[] {
  return items(raw);
}

export function parsePods(raw: string, nowMs: number = Date.now()): K8sPod[] {
  return podsOf(items(raw), nowMs);
}

/**
 * The pods of a list already parsed ({@link listItems}) — the panel reads the JSON
 * once. `owners` ({@link jobOwners}) rolls a CronJob's run pods up to the CronJob,
 * as a ReplicaSet's are rolled up to its Deployment; without it a pod's owner is
 * its own Job — never guessed from the name.
 */
export function podsOf(
  list: readonly Record<string, unknown>[],
  nowMs: number = Date.now(),
  owners?: ReadonlyMap<string, { kind: string; name: string }>,
): K8sPod[] {
  return list.map((it) => {
    const running = podContainers(it);
    const row = podRow(it);
    const own = resolveOwner(dig(it, "metadata", "ownerReferences"));
    const owner =
      own.kind === "Job" ? (owners?.get(`${str(dig(it, "metadata", "namespace"))}/${own.name}`) ?? own) : own;
    return {
      name: str(dig(it, "metadata", "name")),
      namespace: str(dig(it, "metadata", "namespace")),
      phase: str(dig(it, "status", "phase")),
      status: row.status,
      ready: row.ready,
      restarts: row.restarts,
      node: str(dig(it, "spec", "nodeName")),
      age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
      containers: running.map((c) => str(c.name)).filter(Boolean),
      ownerKind: owner.kind,
      ownerName: owner.name,
      cpuLimit: sumLimit(running, "cpu", parseCpuMillis),
      memLimit: sumLimit(running, "memory", parseMemMiB),
      cpuRequest: sumRequest(running, "cpu", parseCpuMillis),
      memRequest: sumRequest(running, "memory", parseMemMiB),
      qos: str(dig(it, "status", "qosClass")),
      created: createdAt(it),
      podIps: podIps(it),
      hostIp: str(dig(it, "status", "hostIP")),
      hostNetwork: dig(it, "spec", "hostNetwork") === true,
      uid: str(dig(it, "metadata", "uid")),
      ...podSigns(it),
      app: appOf(dig(it, "metadata", "labels"), dig(it, "metadata", "annotations")),
    };
  });
}

/**
 * The containers that run side by side once the pod is up: the app containers, then
 * the native sidecars — the ones a log, a shell and the ceiling are about.
 */
function podContainers(it: Record<string, unknown>): Record<string, unknown>[] {
  return [...records(dig(it, "spec", "containers")), ...records(dig(it, "spec", "initContainers")).filter(isSidecar)];
}

/** `status.podIPs[].ip`, else the single `status.podIP`, deduplicated. */
function podIps(it: Record<string, unknown>): string[] {
  const list = dig(it, "status", "podIPs");
  const ips = Array.isArray(list) ? (list as Record<string, unknown>[]).map((p) => str(p.ip)).filter(Boolean) : [];
  const single = str(dig(it, "status", "podIP"));
  if (single && !ips.includes(single)) ips.unshift(single);
  return [...new Set(ips)];
}

export function parseWorkloads(raw: string, nowMs: number = Date.now()): K8sWorkload[] {
  const out: K8sWorkload[] = [];
  for (const it of items(raw)) {
    const kind = str(it.kind);
    const name = str(dig(it, "metadata", "name"));
    const namespace = str(dig(it, "metadata", "namespace"));
    const age = k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs);
    const created = createdAt(it);
    const uid = str(dig(it, "metadata", "uid"));
    const app = appOf(dig(it, "metadata", "labels"), dig(it, "metadata", "annotations"));
    if (kind === "Job") {
      // A CronJob's run is its CronJob's — shown in its details, not as a row.
      const job = jobOf(it, nowMs);
      if (job.owner?.kind === "CronJob") continue;
      out.push({
        kind: "Job",
        name,
        namespace,
        ready: `${job.succeeded}/${job.completions ?? 1}`,
        replicas: null,
        schedule: "",
        suspended: job.status === "Suspended",
        age,
        created,
        scalable: false,
        uid,
        status: job.status,
        app,
      });
    } else if (kind === "Deployment" || kind === "StatefulSet") {
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
        created,
        scalable: true,
        uid,
        app,
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
        created,
        scalable: false,
        uid,
        app,
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
        created,
        scalable: false,
        uid,
        app,
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

/** A kubeconfig context and the namespace it sets. */
export interface K8sContext {
  name: string;
  /** The context's own namespace; empty when it sets none. */
  namespace: string;
}

/**
 * The table `config get-contexts` prints (CURRENT NAME CLUSTER AUTHINFO
 * NAMESPACE), sorted by name. A cell is cut at its heading's column, not split on
 * blanks: an empty NAMESPACE leaves the row a cell short, and a name may hold a
 * space. kubectl aligns the columns in code points, so the row is cut in code
 * points too. No NAME and NAMESPACE headings — no contexts read.
 */
export function parseContexts(raw: string): K8sContext[] {
  const lines = raw.split(/\r?\n/);
  for (let at = 0; at < lines.length; at++) {
    const heads = [...lines[at].matchAll(/\S+/g)].map((m) => ({ title: m[0], from: m.index ?? 0 }));
    const name = heads.findIndex((h) => h.title === "NAME");
    const ns = heads.find((h) => h.title === "NAMESPACE");
    if (name < 0 || !ns) continue;
    const nameEnd = heads[name + 1]?.from;
    const cut = (row: string[], from: number, to?: number) => row.slice(from, to).join("").trim();
    return lines
      .slice(at + 1)
      .map((line) => Array.from(line))
      .map((row) => ({ name: cut(row, heads[name].from, nameEnd), namespace: cut(row, ns.from) }))
      .filter((c) => c.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return [];
}

/**
 * The namespace kubectl lists for `context` when the argv names none: the one
 * the context sets, else `default` — kubectl's own rule. (Run inside a pod, it
 * would take the pod's namespace instead; the panel runs kubectl on a host over
 * SSH or on the desktop.) Null — no context chosen, or one the kubeconfig does not
 * list: then which namespace it is is not known, and the selector does not say.
 */
export function contextNamespace(contexts: readonly K8sContext[], context: string | null): string | null {
  const found = context ? contexts.find((c) => c.name === context) : undefined;
  return found ? found.namespace || "default" : null;
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
export function parseAvailability(stdout: string, stderr: string, _exitCode: number): K8sAvailability {
  let clientVersion = "";
  let serverVersion = "";
  const doc = parseJsonOrNull(stdout) as Record<string, unknown> | null;
  if (doc) {
    clientVersion = str(dig(doc, "clientVersion", "gitVersion"));
    serverVersion = str(dig(doc, "serverVersion", "gitVersion"));
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
  // While it initializes: the step is progress, anything else an init container failing.
  if (status.startsWith("Init:")) {
    const rest = status.slice(5);
    return /^\d+\/\d+$/.test(rest) ? "warn" : "bad";
  }
  if (/^(ExitCode|Signal):/.test(status)) return "bad";
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
    case "NotReady":
    case "SchedulingGated":
      return "warn";
    case "CrashLoopBackOff":
    case "Error":
    case "ImagePullBackOff":
    case "ErrImagePull":
    case "InvalidImageName":
    case "CreateContainerConfigError":
    case "CreateContainerError":
    case "ContainerStatusUnknown":
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
 * restart` and `undo`, `scale` to 0 replicas and a CronJob run by hand. Non-mutating get/logs/describe/top never
 * prompt. Used on every server, not just prod (prod adds a red warning on top).
 */
export function needsConfirm(args: string[]): boolean {
  if (isDestructive(args)) return true;
  const cmd = args[0];
  if (cmd === "cordon") return true;
  if (cmd === "rollout" && (args[1] === "restart" || args[1] === "undo")) return true;
  // A Job made by hand does whatever the CronJob does — mail, a migration (ADR 0061).
  if (cmd === "create") return true;
  if (cmd === "scale") {
    const i = args.indexOf("--replicas");
    return i >= 0 && args[i + 1] === "0";
  }
  return false;
}

// ═══ Phase 37.1 — Network (Services + Ingress) + Cluster (Nodes + Events) ═════
// Same driver/contract as 37.0: bare-argv builders + JSON parsers, no new backend
// command. Cordon/drain confirmation is already covered by needsConfirm above
// (`drain` is destructive, `cordon` prompts); `uncordon` is safe (no prompt).

// ── Argument builders ────────────────────────────────────────────────────────

/** All services in scope as JSON. */
export function servicesArgs(): string[] {
  return ["get", "services", "-o", "json"];
}

/** All ingresses in scope as JSON. */
export function ingressArgs(): string[] {
  return ["get", "ingress", "-o", "json"];
}

/**
 * EndpointSlices in scope as JSON (v1.5) — the addresses the cluster actually
 * routes a service to. Read instead of matching selectors against pod labels:
 * a pod whose labels match is not an endpoint while it is not Ready, held back
 * by a readiness gate, or terminating.
 */
export function endpointSlicesArgs(): string[] {
  return ["get", "endpointslices", "-o", "json"];
}

/** IngressClasses as JSON (v1.35; cluster-scoped — `namespaced:false`): the controller each names, the default. */
export function ingressClassesArgs(): string[] {
  return ["get", "ingressclasses", "-o", "json"];
}

/** HTTPRoutes of the Gateway API in scope as JSON (v1.35) — a cluster without the API answers {@link resourceMissing}. */
export function httpRoutesArgs(): string[] {
  return ["get", "httproutes.gateway.networking.k8s.io", "-o", "json"];
}

/** NetworkPolicies in scope as JSON (v1.35). */
export function networkPoliciesArgs(): string[] {
  return ["get", "networkpolicies", "-o", "json"];
}

/**
 * kubectl said the cluster has no such type of resource — the Gateway API is not
 * installed. Then there are no HTTPRoutes: an answer, not a failure to read.
 */
export function resourceMissing(stderr: string): boolean {
  return /the server doesn't have a resource type/i.test(stderr);
}

/** All nodes as JSON (cluster-scoped — call {@link withScope} with `namespaced:false`). */
export function nodesArgs(): string[] {
  return ["get", "nodes", "-o", "json"];
}

/**
 * One pod's events (stage 2), by its uid — a pod recreated under the same name
 * (a StatefulSet's) is another pod. One token, so the policy reads it as an option.
 */
export function podEventsArgs(uid: string): string[] {
  return ["get", "events", `--field-selector=involvedObject.uid=${uid}`, "-o", "json"];
}

/** Events in scope as JSON (parsed newest-first by {@link parseEvents}). */
export function eventsArgs(): string[] {
  return ["get", "events", "-o", "json"];
}

// Node actions. `cordon` marks a node unschedulable (reversible with `uncordon`);
// `drain` evicts pods (disruptive → destructive). Node commands are cluster-scoped —
// run them with an empty per-object namespace so no `--namespace` flag is added.
export function cordonArgs(node: string): string[] {
  return ["cordon", node];
}
export function uncordonArgs(node: string): string[] {
  return ["uncordon", node];
}
export function drainArgs(node: string): string[] {
  return ["drain", node, "--ignore-daemonsets", "--delete-emptydir-data"];
}

/**
 * Interactive `kubectl port-forward` command typed into a real terminal tab (like
 * {@link execShellArgv}) — NOT run via `kubectl_run`: the forwarding process must
 * live in a PTY the panel doesn't manage. `target` is `svc/<name>` or `pod/<name>`.
 * Scope flags are inlined because the command runs in a shell. Returned as argv.
 */
export function portForwardArgv(
  prog: string[],
  target: string,
  namespace: string,
  local: number,
  remote: number,
  scope: K8sScope,
): string[] {
  const parts = [...prog, "port-forward"];
  if (scope.context) parts.push("--context", scope.context);
  if (namespace) parts.push("--namespace", namespace);
  parts.push(target, `${local}:${remote}`);
  return parts;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** One port of a service, as declared in `spec.ports[]`. */
export interface K8sServicePort {
  /** Port name ("" when unnamed) — also how an EndpointSlice port is matched to it. */
  name: string;
  port: number;
  /** `targetPort` as written: a number ("8080") or a container port name ("http"). */
  targetPort: string;
  nodePort: number | null;
  protocol: string;
}

export interface K8sService {
  name: string;
  namespace: string;
  /** ClusterIP · NodePort · LoadBalancer · ExternalName. */
  type: string;
  clusterIp: string;
  /** Resolved external address (LB ingress / externalIPs), "<pending>" or "-". */
  externalIp: string;
  /** Port mappings string, e.g. "80:30080/TCP, 443/TCP". */
  ports: string;
  /** First service port, for a default port-forward target (null if none). */
  firstPort: number | null;
  age: string;
  /** The ports one by one (the route needs them apart; `ports` is the joined text). */
  portList: K8sServicePort[];
  /**
   * `spec.selector` rendered for display ("app=web, tier=api"), "" when the
   * service has none. Text on purpose: it is shown next to a service without
   * endpoints, and never matched against anything (see {@link endpointSlicesArgs}).
   */
  selector: string;
  /** `clusterIP: None` — no virtual IP, DNS answers with the endpoints themselves. */
  headless: boolean;
  /** `spec.externalName` of an ExternalName service, else "". */
  externalName: string;
}

/** Where an ingress rule sends traffic. */
export interface K8sBackend {
  /** Backend service name, "" when the backend is not a service. */
  service: string;
  /** Backend service port as written: a number ("80") or a port name ("http"). */
  port: string;
  /** "Kind/name" of a non-service (`resource`) backend, else "". */
  resource: string;
}

/** One host + path of an ingress and the backend it names. */
export interface K8sIngressRule {
  /** Rule host, "" when the rule applies to every host. */
  host: string;
  path: string;
  /** Exact · Prefix · ImplementationSpecific. */
  pathType: string;
  backend: K8sBackend;
}

export interface K8sIngress {
  name: string;
  namespace: string;
  className: string;
  /** Comma-joined rule hosts. */
  hosts: string;
  /** Load-balancer address (ip/hostname), or "". */
  address: string;
  age: string;
  /** Every host + path with its backend, in manifest order. */
  rules: K8sIngressRule[];
  /** `spec.defaultBackend` — where unmatched requests go — or null. */
  defaultBackend: K8sBackend | null;
  /** Hosts listed under `spec.tls`. */
  tlsHosts: string[];
}

/** An IngressClass (v1.35): the controller it names, and whether it is the cluster's default. */
export interface K8sIngressClass {
  name: string;
  /** `spec.controller`, e.g. `k8s.io/ingress-nginx`. */
  controller: string;
  /** Annotated `ingressclass.kubernetes.io/is-default-class: "true"`. */
  isDefault: boolean;
}

/** Where an HTTPRoute rule sends traffic: a `backendRef`. */
export interface K8sRouteBackend {
  /** "Service" when the ref names no kind (the API's default). */
  kind: string;
  name: string;
  /** The route's own namespace when the ref names none. */
  namespace: string;
  /** As written; "" when the ref has none. */
  port: string;
}

/** An HTTPRoute of the Gateway API (v1.35), as far as the route view shows it. */
export interface K8sHttpRoute {
  name: string;
  namespace: string;
  /** The gateways it attaches to (`spec.parentRefs`), by name. */
  gateways: string[];
  /** `spec.hostnames`; empty — every host its gateways listen for. */
  hostnames: string[];
  /** One per match of each rule: the path and the backends of that rule. */
  rules: { path: string; pathType: string; backends: K8sRouteBackend[] }[];
  /** `Accepted` across `status.parents`: false when a gateway refused it, null when none said. */
  accepted: boolean | null;
}

/** What a NetworkPolicy does to traffic coming in (v1.35). */
export type PolicyIngress = "denyAll" | "allowAll" | "rules";

/** A NetworkPolicy, as far as the route view shows it. */
export interface K8sNetworkPolicy {
  name: string;
  namespace: string;
  /**
   * The pods it is for, as display text (`app=web, tier In (api)`); "" — every
   * pod of its namespace. Text on purpose, like a service's selector: nothing
   * matches it against anything.
   */
  appliesTo: string;
  /** null — it restricts only traffic going out. */
  ingress: PolicyIngress | null;
  /** Ingress rules it lists. */
  ruleCount: number;
}

/** One endpoint of an EndpointSlice. */
export interface K8sEndpoint {
  addresses: string[];
  /** `conditions.ready`; the API reads an absent value as true. */
  ready: boolean;
  /** `conditions.terminating`; the API reads an absent value as false. */
  terminating: boolean;
  /** Kind of the object behind the endpoint ("Pod"), "" when there is no `targetRef`. */
  targetKind: string;
  targetName: string;
  node: string;
}

/** One port of an EndpointSlice: the number a service port resolved to. */
export interface K8sSlicePort {
  /** Same name as the service port it belongs to ("" when unnamed). */
  name: string;
  port: number | null;
  protocol: string;
}

export interface K8sEndpointSlice {
  name: string;
  namespace: string;
  /** Owning service (`kubernetes.io/service-name`), "" for a slice that has none. */
  service: string;
  /** IPv4 · IPv6 · FQDN. */
  addressType: string;
  ports: K8sSlicePort[];
  endpoints: K8sEndpoint[];
}

export interface K8sNode {
  name: string;
  /** "Ready" · "NotReady" (+ ",SchedulingDisabled" when cordoned). */
  status: string;
  /** Whether the node is cordoned (spec.unschedulable). */
  schedulable: boolean;
  /** Comma-joined roles from `node-role.kubernetes.io/*` labels, or "<none>". */
  roles: string;
  version: string;
  internalIp: string;
  /** `ExternalIP` from `status.addresses` (v1.33); "" — the node reports none. */
  externalIp?: string;
  /** `Hostname` from `status.addresses`; "" — not reported. */
  hostname?: string;
  age: string;
  /** The pressures it reports now — `MemoryPressure`, `DiskPressure`, `PIDPressure` (stage 5). */
  pressures?: string[];
}

export interface K8sEvent {
  /** Normal · Warning. */
  type: string;
  reason: string;
  /** Involved object as "Kind/name". */
  object: string;
  namespace: string;
  message: string;
  count: number;
  age: string;
  /** Epoch ms of the last occurrence (for sorting), or 0. */
  ts: number;
  /** The container it is about (`spec.containers{app}`), "" — the pod or another object. */
  container?: string;
}

// ── A pod's details (ADR 0054, stage 1) ──────────────────────────────────────
//
// What «Overview» explains, read from the same `get pods -o json` the list polls:
// no call of its own. The conditions say why a pod waits (PodScheduled carries the
// scheduler's «0/1 nodes are available: Insufficient memory»), each container
// what it is doing and how it ended last time, what it checks, asks for and is
// held to. Secret values are never read — a reference to a secret is its name.

export type PodContainerRole = "app" | "sidecar" | "init";

export interface PodCondition {
  type: string;
  /** True / False; null — Unknown. */
  ok: boolean | null;
  reason: string;
  message: string;
  /** When it last changed, epoch ms; null — not reported. */
  since: number | null;
}

export type PodProbeKind = "startup" | "readiness" | "liveness";

export interface PodProbe {
  kind: PodProbeKind;
  /** What it does: `GET http://:http/`, `TCP :http`, `exec cat /tmp/ready`, `gRPC :9090`. */
  action: string;
  periodSec: number | null;
  timeoutSec: number | null;
  /** Failures in a row before it counts as failed. */
  failureThreshold: number | null;
  initialDelaySec: number | null;
}

export interface PodTermination {
  reason: string;
  exitCode: number | null;
  signal: number | null;
  /** epoch ms; null — not reported. */
  finishedAt: number | null;
  /** The termination message the container left (its file, or its log tail on error). */
  message: string;
}

export interface PodMount {
  path: string;
  /** The pod volume's name. */
  volume: string;
  /** What the volume is: `configMap site`, `secret creds`, `pvc data-db-0`, `emptyDir`, `hostPath /var/log`. */
  source: string;
  readOnly: boolean;
  subPath: string;
}

export interface PodEnvVar {
  key: string;
  /** The value written in the spec; "" when it comes from elsewhere. */
  value: string;
  /** Where it comes from when not written: `secret app-secret · token`, `configMap app-config · LOG_LEVEL`, `field metadata.name`. */
  from: string;
  /** Masked until asked for ({@link isSensitiveEnv}); a value read from a secret is not here at all. */
  sensitive: boolean;
}

export interface PodContainer {
  name: string;
  role: PodContainerRole;
  image: string;
  /** `running` · `waiting` · `terminated`; "" — no status reported yet. */
  state: "running" | "waiting" | "terminated" | "";
  /** Why it waits or how it ended: CrashLoopBackOff, ErrImagePull, OOMKilled, Completed. */
  reason: string;
  /** What kubelet says about it: `back-off 5m0s restarting failed container…`, the pull error. */
  message: string;
  /** Started (running) or finished (terminated), epoch ms. */
  since: number | null;
  exitCode: number | null;
  ready: boolean | null;
  restarts: number;
  /** How it ended the time before — what a restart hides. */
  last: PodTermination | null;
  /** command + args as written; "" — the image's own. */
  command: string;
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
  /** `http 8080/TCP`, `9090/TCP → host 9090`. */
  ports: string[];
  probes: PodProbe[];
  mounts: PodMount[];
  env: PodEnvVar[];
  /** Whole ConfigMaps and Secrets taken as variables: `configMap app-config`, `secret creds · DB_`. */
  envFrom: string[];
}

export interface PodDetail {
  /** The application it is part of (stage 6); null — it does not say. */
  app: K8sAppInfo | null;
  /**
   * The pod has finished (Succeeded / Failed): its Ready and ContainersReady are
   * False because it ended — what the end says is in its containers, not there.
   */
  finished: boolean;
  conditions: PodCondition[];
  /** App containers, then native sidecars, then the init containers that ran before them. */
  containers: PodContainer[];
  serviceAccount: string;
  priorityClass: string;
  labels: { key: string; value: string }[];
}

/** The pod `namespace/name` of a parsed list ({@link listItems}); null — not in it. */
export function podItem(
  list: readonly Record<string, unknown>[],
  namespace: string,
  name: string,
): Record<string, unknown> | null {
  return (
    list.find((it) => str(dig(it, "metadata", "name")) === name && str(dig(it, "metadata", "namespace")) === namespace) ??
    null
  );
}

const CONDITION_ORDER = ["PodScheduled", "PodReadyToStartContainers", "Initialized", "ContainersReady", "Ready"];

const when = (v: unknown): number | null => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
};
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** A word quoted for reading when it would not survive as one (spaces, quotes). */
function readableWord(w: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w)) return w;
  if (!/["$`\\]/.test(w)) return `"${w}"`;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

/** argv as one readable line; "" for none. */
function argvText(...parts: unknown[]): string {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : []))
    .map((w) => readableWord(typeof w === "string" ? w : String(w)))
    .join(" ");
}

function probeAction(p: Record<string, unknown>): string {
  const http = dig(p, "httpGet") as Record<string, unknown> | undefined;
  if (http) {
    const scheme = (str(http.scheme) || "HTTP").toLowerCase();
    const host = str(http.host);
    return `GET ${scheme}://${host}:${portText(http.port)}${str(http.path) || "/"}`;
  }
  const tcp = dig(p, "tcpSocket") as Record<string, unknown> | undefined;
  if (tcp) return `TCP ${str(tcp.host)}:${portText(tcp.port)}`;
  const grpc = dig(p, "grpc") as Record<string, unknown> | undefined;
  if (grpc) return `gRPC :${portText(grpc.port)}${str(grpc.service) ? ` ${str(grpc.service)}` : ""}`;
  const cmd = dig(p, "exec", "command");
  if (Array.isArray(cmd)) return `exec ${argvText(cmd)}`;
  return "";
}

function probesOf(c: Record<string, unknown>): PodProbe[] {
  const out: PodProbe[] = [];
  for (const [kind, field] of [
    ["startup", "startupProbe"],
    ["readiness", "readinessProbe"],
    ["liveness", "livenessProbe"],
  ] as const) {
    const p = c[field];
    if (!p || typeof p !== "object") continue;
    const probe = p as Record<string, unknown>;
    out.push({
      kind,
      action: probeAction(probe),
      periodSec: intOrNull(probe.periodSeconds),
      timeoutSec: intOrNull(probe.timeoutSeconds),
      failureThreshold: intOrNull(probe.failureThreshold),
      initialDelaySec: intOrNull(probe.initialDelaySeconds) || null,
    });
  }
  return out;
}

function volumeSource(v: Record<string, unknown> | undefined): string {
  if (!v) return "";
  if (v.configMap) return `configMap ${str(dig(v, "configMap", "name"))}`;
  if (v.secret) return `secret ${str(dig(v, "secret", "secretName"))}`;
  if (v.persistentVolumeClaim) return `pvc ${str(dig(v, "persistentVolumeClaim", "claimName"))}`;
  if (v.emptyDir) return str(dig(v, "emptyDir", "medium")) === "Memory" ? "emptyDir · memory" : "emptyDir";
  if (v.hostPath) return `hostPath ${str(dig(v, "hostPath", "path"))}`;
  if (v.projected) {
    const sources = records(dig(v, "projected", "sources"));
    return sources.some((x) => x.serviceAccountToken) ? "projected · service account token" : "projected";
  }
  if (v.downwardAPI) return "downwardAPI";
  if (v.ephemeral) return "ephemeral";
  if (v.csi) return `csi ${str(dig(v, "csi", "driver"))}`;
  if (v.nfs) return `nfs ${str(dig(v, "nfs", "server"))}:${str(dig(v, "nfs", "path"))}`;
  // Any other kind: its field name, which is what it is.
  return Object.keys(v).find((k) => k !== "name") ?? "";
}

function envFromRef(v: Record<string, unknown>): string {
  const secret = dig(v, "secretKeyRef") as Record<string, unknown> | undefined;
  if (secret) return `secret ${str(secret.name)} · ${str(secret.key)}`;
  const cm = dig(v, "configMapKeyRef") as Record<string, unknown> | undefined;
  if (cm) return `configMap ${str(cm.name)} · ${str(cm.key)}`;
  const field = str(dig(v, "fieldRef", "fieldPath"));
  if (field) return `field ${field}`;
  const res = dig(v, "resourceFieldRef") as Record<string, unknown> | undefined;
  if (res) return `resource ${str(res.resource)}${str(res.containerName) ? ` · ${str(res.containerName)}` : ""}`;
  return "?";
}

function termination(t: unknown): PodTermination | null {
  if (!t || typeof t !== "object") return null;
  const r = t as Record<string, unknown>;
  return {
    reason: str(r.reason),
    exitCode: intOrNull(r.exitCode),
    signal: intOrNull(r.signal) || null,
    finishedAt: when(r.finishedAt),
    message: str(r.message).trim(),
  };
}

function resources(c: Record<string, unknown>, kind: "requests" | "limits"): { cpu: string; memory: string } {
  return {
    cpu: str(dig(c, "resources", kind, "cpu")),
    memory: str(dig(c, "resources", kind, "memory")),
  };
}

function containerOf(
  spec: Record<string, unknown>,
  role: PodContainerRole,
  statuses: readonly Record<string, unknown>[],
  volumes: ReadonlyMap<string, Record<string, unknown>>,
): PodContainer {
  const name = str(spec.name);
  const st = statuses.find((s) => str(s.name) === name);
  const running = dig(st, "state", "running") as Record<string, unknown> | undefined;
  const waiting = dig(st, "state", "waiting") as Record<string, unknown> | undefined;
  const term = dig(st, "state", "terminated") as Record<string, unknown> | undefined;
  const state = running ? "running" : waiting ? "waiting" : term ? "terminated" : "";
  return {
    name,
    role,
    image: str(spec.image),
    state,
    reason: str(waiting?.reason) || str(term?.reason),
    message: (str(waiting?.message) || str(term?.message)).trim(),
    since: when(running?.startedAt) ?? when(term?.finishedAt),
    exitCode: intOrNull(term?.exitCode),
    ready: st && typeof st.ready === "boolean" ? st.ready : null,
    restarts: num(st?.restartCount),
    last: termination(dig(st, "lastState", "terminated")),
    command: argvText(spec.command, spec.args),
    requests: resources(spec, "requests"),
    limits: resources(spec, "limits"),
    ports: records(spec.ports).map((p) => {
      const port = `${num(p.containerPort)}/${str(p.protocol) || "TCP"}`;
      const host = num(p.hostPort) ? ` → host ${num(p.hostPort)}` : "";
      return `${str(p.name) ? `${str(p.name)} ` : ""}${port}${host}`;
    }),
    probes: probesOf(spec),
    mounts: records(spec.volumeMounts).map((m) => ({
      path: str(m.mountPath),
      volume: str(m.name),
      source: volumeSource(volumes.get(str(m.name))),
      readOnly: m.readOnly === true,
      subPath: str(m.subPath),
    })),
    env: records(spec.env).map((e) => {
      const key = str(e.name);
      const from = e.valueFrom && typeof e.valueFrom === "object" ? envFromRef(e.valueFrom as Record<string, unknown>) : "";
      const value = from ? "" : str(e.value);
      return { key, value, from, sensitive: !from && isSensitiveEnv(key, value) };
    }),
    envFrom: records(spec.envFrom).map((f) => {
      const cm = str(dig(f, "configMapRef", "name"));
      const kind = cm ? "configMap" : "secret";
      const name = cm || str(dig(f, "secretRef", "name"));
      return `${kind} ${name}${str(f.prefix) ? ` · ${str(f.prefix)}` : ""}`;
    }),
  };
}

/** What «Overview» shows of a pod — see the section above; null for what is not a pod. */
export function parsePodDetail(item: Record<string, unknown> | null): PodDetail | null {
  if (!item || !dig(item, "metadata", "name")) return null;
  const volumes = new Map(records(dig(item, "spec", "volumes")).map((v) => [str(v.name), v] as const));
  const statuses = records(dig(item, "status", "containerStatuses"));
  const initStatuses = records(dig(item, "status", "initContainerStatuses"));
  const initSpec = records(dig(item, "spec", "initContainers"));
  const containers = [
    ...records(dig(item, "spec", "containers")).map((c) => containerOf(c, "app", statuses, volumes)),
    ...initSpec.filter(isSidecar).map((c) => containerOf(c, "sidecar", initStatuses, volumes)),
    ...initSpec.filter((c) => !isSidecar(c)).map((c) => containerOf(c, "init", initStatuses, volumes)),
  ];
  const rank = (type: string) => {
    const i = CONDITION_ORDER.indexOf(type);
    return i < 0 ? CONDITION_ORDER.length : i;
  };
  const conditions = records(dig(item, "status", "conditions"))
    .map((c) => ({
      type: str(c.type),
      ok: c.status === "True" ? true : c.status === "False" ? false : null,
      reason: str(c.reason),
      message: str(c.message).trim(),
      since: when(c.lastTransitionTime),
    }))
    .sort((a, b) => rank(a.type) - rank(b.type));
  const labels = dig(item, "metadata", "labels");
  const phase = str(dig(item, "status", "phase"));
  return {
    app: appInfo(labels, dig(item, "metadata", "annotations")),
    finished: phase === "Succeeded" || phase === "Failed",
    conditions,
    containers,
    serviceAccount: str(dig(item, "spec", "serviceAccountName")),
    priorityClass: str(dig(item, "spec", "priorityClassName")),
    labels:
      labels && typeof labels === "object"
        ? Object.entries(labels as Record<string, unknown>)
            .map(([key, value]) => ({ key, value: str(value) }))
            .sort((a, b) => a.key.localeCompare(b.key))
        : [],
  };
}

/**
 * What the assistant is told of a pod's details: the conditions that do not hold
 * with what they say (none of a finished pod — they only repeat that it ended),
 * each container's state and how it ended last time. Never the environment — not
 * even its names.
 */
export function podDetailFacts(d: PodDetail): string[] {
  const out: string[] = [];
  for (const c of d.conditions) {
    if (c.ok === true || d.finished) continue;
    out.push(`Condition ${c.type}: ${c.ok === false ? "False" : "Unknown"}${c.reason ? ` (${c.reason})` : ""}${c.message ? ` — ${c.message}` : ""}`);
  }
  for (const c of d.containers) {
    const now = [c.state || "no status", c.reason, c.exitCode != null ? `exit ${c.exitCode}` : ""].filter(Boolean).join(" ");
    const last = c.last
      ? `; last time: ${[c.last.reason, c.last.exitCode != null ? `exit ${c.last.exitCode}` : ""].filter(Boolean).join(" ")}`
      : "";
    const probes = c.probes.length ? `; probes: ${c.probes.map((p) => `${p.kind} ${p.action}`).join(", ")}` : "";
    const limits = [c.limits.cpu && `cpu ${c.limits.cpu}`, c.limits.memory && `memory ${c.limits.memory}`].filter(Boolean).join(", ");
    out.push(
      `Container ${c.name}${c.role === "app" ? "" : ` (${c.role})`}: ${now}${c.restarts ? `, ${c.restarts} restarts` : ""}${last}${limits ? `; limits ${limits}` : ""}${probes}${c.message ? ` — ${c.message}` : ""}`,
    );
  }
  return out;
}

// ── A pod's resources (ADR 0054, stage 3) ───────────────────────────────────
//
// The history of a pod's CPU and memory is the panel's: `top pods` already runs
// with every poll of the list, so «Resources» opens with what was polled while it
// was closed. Its containers are asked (`top pod --containers`) only while the
// view is on screen. The metrics API reports CPU and memory — not network, not
// disk — and the view says so instead of drawing a zero.

export type PodSeries = "cpu" | "mem";

/** The history key of a pod's series: `<metricsKey>.cpu|mem`. */
export const podResourceKey = (key: string, s: PodSeries): string => `${key}.${s}`;

/** One poll of `top pods` as readings: millicores and MiB by pod; null — no row for it. */
export function podReadings(
  pods: readonly K8sPod[],
  metrics: ReadonlyMap<string, K8sPodMetrics>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const p of pods) {
    const key = metricsKey(p.namespace, p.name);
    const m = metrics.get(key) ?? metrics.get(metricsKey("", p.name));
    out[podResourceKey(key, "cpu")] = parseCpuMillis(m?.cpu);
    out[podResourceKey(key, "mem")] = parseMemMiB(m?.mem);
  }
  return out;
}

/** One pod's containers' usage now (stage 3) — asked only while «Resources» is on screen. */
export function topContainersArgs(pod: string): string[] {
  return ["top", "pod", pod, "--containers", "--no-headers"];
}

export interface ContainerUsage {
  container: string;
  /** Millicores; null — not reported. */
  cpu: number | null;
  /** MiB; null — not reported. */
  mem: number | null;
}

/** `top pod <pod> --containers --no-headers` (POD NAME CPU MEMORY) — the rows of `pod`. */
export function parseTopContainers(raw: string, pod: string): ContainerUsage[] {
  const out: ContainerUsage[] = [];
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/).filter(Boolean);
    if (cols.length < 4 || cols[0] !== pod) continue;
    out.push({ container: cols[1], cpu: parseCpuMillis(cols[2]), mem: parseMemMiB(cols[3]) });
  }
  return out;
}

/**
 * Why there are no readings (stage 3), told apart — they mean different things:
 * the cluster has no metrics-server at all; it has, but has no sample for the pod
 * yet (it measures every 15–60 s, a pod that does not run has none); another
 * failure, in its own words. null — `top` answered.
 */
export interface MetricsGap {
  kind: "noServer" | "notYet" | "other";
  text: string;
}

export function metricsGap(out: { stdout: string; stderr: string; exitCode: number }): MetricsGap | null {
  const text = (out.stderr.trim() || out.stdout.trim()).split("\n")[0]?.trim() ?? "";
  if (out.exitCode === 0) return out.stdout.trim() ? null : { kind: "notYet", text };
  if (/Metrics API not available/i.test(text)) return { kind: "noServer", text };
  // A pod with no sample yet is NotFound to the metrics API — `pods "x" not found` on
  // Docker Desktop's metrics-server 0.9.1, though the pod is there.
  if (/metrics not available yet|\(NotFound\)/i.test(text)) return { kind: "notYet", text };
  return { kind: "other", text };
}

// ── A workload's details (ADR 0054, stage 4) ────────────────────────────────
//
// What a workload is told (its spec), has (its status) and says (its conditions) —
// from the workloads poll, no call of its own. What it owns is asked only while
// its details are on screen: its pods and, for a Deployment, its ReplicaSets — by
// its selector, then taken by owner, since a selector may match more. A CronJob's
// Jobs come with the poll.

export type JobStatus = "Complete" | "Failed" | "Suspended" | "Running" | "Pending";

export interface K8sJob {
  name: string;
  namespace: string;
  uid: string;
  /** The controller that made it — a CronJob for its runs; null — a Job of its own. */
  owner: { kind: string; name: string; uid: string } | null;
  status: JobStatus;
  /** The condition's reason: `BackoffLimitExceeded`, `DeadlineExceeded`, `CompletionsReached`. */
  reason: string;
  message: string;
  succeeded: number;
  failed: number;
  active: number;
  completions: number | null;
  start: number | null;
  /** Only a completed Job reports when it ended. */
  end: number | null;
  durationSec: number | null;
  age: string;
  created: number | null;
}

const when4 = (v: unknown): number | null => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
};

function conditionOf(it: unknown, type: string): Record<string, unknown> | undefined {
  return records(dig(it, "status", "conditions")).find((c) => c.type === type && c.status === "True");
}

function jobOf(it: Record<string, unknown>, nowMs: number): K8sJob {
  const ref = records(dig(it, "metadata", "ownerReferences")).find((r) => r.controller === true) ??
    records(dig(it, "metadata", "ownerReferences"))[0];
  const complete = conditionOf(it, "Complete") ?? conditionOf(it, "SuccessCriteriaMet");
  const failed = conditionOf(it, "Failed") ?? conditionOf(it, "FailureTarget");
  const suspended = conditionOf(it, "Suspended");
  const active = num(dig(it, "status", "active"));
  const status: JobStatus = complete ? "Complete" : failed ? "Failed" : suspended ? "Suspended" : active > 0 ? "Running" : "Pending";
  const said = complete ?? failed ?? suspended;
  const start = when4(dig(it, "status", "startTime"));
  const end = when4(dig(it, "status", "completionTime"));
  const completions = dig(it, "spec", "completions");
  return {
    name: str(dig(it, "metadata", "name")),
    namespace: str(dig(it, "metadata", "namespace")),
    uid: str(dig(it, "metadata", "uid")),
    owner: ref ? { kind: str(ref.kind), name: str(ref.name), uid: str(ref.uid) } : null,
    status,
    reason: str(said?.reason),
    message: str(said?.message).trim(),
    succeeded: num(dig(it, "status", "succeeded")),
    failed: num(dig(it, "status", "failed")),
    active,
    completions: typeof completions === "number" ? completions : null,
    start,
    end,
    durationSec: start != null && end != null ? Math.round((end - start) / 1000) : null,
    age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
    created: createdAt(it),
  };
}

/** The Jobs of a `get jobs` list (or of the workloads poll, which carries them). */
export function parseJobs(raw: string, nowMs: number = Date.now()): K8sJob[] {
  return items(raw)
    .filter((it) => str(it.kind || "Job") === "Job")
    .map((it) => jobOf(it, nowMs));
}

/** Whose each Job is, by `namespace/name` — what {@link podsOf} rolls a run pod up to. */
export function jobOwners(jobs: readonly K8sJob[]): Map<string, { kind: string; name: string }> {
  const out = new Map<string, { kind: string; name: string }>();
  for (const j of jobs) {
    if (j.owner?.kind === "CronJob") out.set(`${j.namespace}/${j.name}`, { kind: "CronJob", name: j.owner.name });
  }
  return out;
}

/**
 * A label selector as kubectl's `--selector` reads it: `k=v`, `k in (a,b)`,
 * `k notin (a)`, `k`, `!k`. null for an empty one — it selects everything, which is
 * not a question worth asking.
 */
export function selectorArg(selector: unknown): string | null {
  if (!selector || typeof selector !== "object") return null;
  const parts: string[] = [];
  const labels = dig(selector, "matchLabels");
  if (labels && typeof labels === "object") {
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) parts.push(`${k}=${str(v)}`);
  }
  for (const e of records(dig(selector, "matchExpressions"))) {
    const key = str(e.key);
    const values = Array.isArray(e.values) ? (e.values as unknown[]).map(str).join(",") : "";
    switch (str(e.operator)) {
      case "In":
        parts.push(`${key} in (${values})`);
        break;
      case "NotIn":
        parts.push(`${key} notin (${values})`);
        break;
      case "Exists":
        parts.push(key);
        break;
      case "DoesNotExist":
        parts.push(`!${key}`);
        break;
    }
  }
  return parts.length ? parts.join(",") : null;
}

/** The pods a workload's selector picks — taken by owner after ({@link workloadPods}). */
export function workloadPodsArgs(selector: string): string[] {
  return ["get", "pods", `--selector=${selector}`, "-o", "json"];
}

/** A Deployment's ReplicaSets, by its selector — taken by owner after ({@link parseRevisions}). */
export function replicaSetsArgs(selector: string): string[] {
  return ["get", "replicasets", `--selector=${selector}`, "-o", "json"];
}

export interface K8sRevision {
  revision: number;
  name: string;
  images: string[];
  desired: number;
  ready: number;
  age: string;
  /** The Deployment's own revision — what it rolls out now. */
  current: boolean;
}

const templateImages = (spec: unknown): string[] =>
  records(dig(spec, "template", "spec", "containers")).map((c) => str(c.image)).filter(Boolean);

/** The ReplicaSets the Deployment `ownerUid` owns, as its revisions, newest first. */
export function parseRevisions(raw: string, ownerUid: string, current: number | null, nowMs: number = Date.now()): K8sRevision[] {
  return items(raw)
    .filter((it) => records(dig(it, "metadata", "ownerReferences")).some((r) => str(r.uid) === ownerUid))
    .map((it) => {
      const revision = Number.parseInt(str(dig(it, "metadata", "annotations", "deployment.kubernetes.io/revision")), 10);
      return {
        revision: Number.isFinite(revision) ? revision : 0,
        name: str(dig(it, "metadata", "name")),
        images: templateImages(dig(it, "spec")),
        desired: num(dig(it, "spec", "replicas")),
        ready: num(dig(it, "status", "readyReplicas")),
        age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
        current: current != null && revision === current,
      };
    })
    .sort((a, b) => b.revision - a.revision);
}

export interface WorkloadReplicas {
  desired: number;
  current: number;
  updated: number;
  ready: number;
  available: number;
  unavailable: number;
}

export interface WorkloadDetail {
  kind: K8sWorkload["kind"];
  /** The application it is part of, with its release, chart and version (stage 6). */
  app: K8sAppInfo | null;
  name: string;
  namespace: string;
  uid: string;
  /** What picks its pods (`--selector`); null — none (a CronJob makes Jobs, not pods). */
  selector: string | null;
  images: string[];
  conditions: PodCondition[];
  replicas: WorkloadReplicas | null;
  /** How it rolls out: `RollingUpdate · maxSurge 25% · maxUnavailable 25%`, `Recreate`, `OnDelete`. */
  strategy: string;
  /** A Deployment's revision now; null — not reported. */
  revision: number | null;
  progressDeadlineSec: number | null;
  paused: boolean;
  serviceName: string;
  currentRevision: string;
  updateRevision: string;
  claims: { name: string; size: string; storageClass: string }[];
  misscheduled: number | null;
  schedule: string;
  timeZone: string;
  suspended: boolean;
  concurrency: string;
  lastSchedule: number | null;
  lastSuccess: number | null;
  activeJobs: number;
  keep: { succeeded: number | null; failed: number | null } | null;
  job: K8sJob | null;
}

const intOr = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const quantity = (v: unknown): string => (typeof v === "number" ? String(v) : str(v));

function strategyText(s: unknown): string {
  const type = str(dig(s, "type"));
  const ru = dig(s, "rollingUpdate");
  if (type !== "RollingUpdate" || !ru || typeof ru !== "object") return type;
  const r = ru as Record<string, unknown>;
  const parts = [type];
  if ("maxSurge" in r) parts.push(`maxSurge ${quantity(r.maxSurge)}`);
  if ("maxUnavailable" in r) parts.push(`maxUnavailable ${quantity(r.maxUnavailable)}`);
  if ("partition" in r) parts.push(`partition ${quantity(r.partition)}`);
  return parts.join(" · ");
}

/** What a workload's details show — see the section above; null for what is not one. */
export function parseWorkloadDetail(item: Record<string, unknown> | null, nowMs: number = Date.now()): WorkloadDetail | null {
  if (!item || !dig(item, "metadata", "name")) return null;
  const kind = str(item.kind) as K8sWorkload["kind"];
  const spec = dig(item, "spec");
  const st = (k: string) => num(dig(item, "status", k));
  const conditions = records(dig(item, "status", "conditions")).map((c) => ({
    type: str(c.type),
    ok: c.status === "True" ? true : c.status === "False" ? false : null,
    reason: str(c.reason),
    message: str(c.message).trim(),
    since: when4(c.lastTransitionTime),
  }));
  let replicas: WorkloadReplicas | null = null;
  if (kind === "Deployment" || kind === "StatefulSet") {
    const desired = intOr(dig(spec, "replicas")) ?? 1;
    replicas = {
      desired,
      current: st("replicas"),
      updated: st("updatedReplicas"),
      ready: st("readyReplicas"),
      available: st("availableReplicas"),
      unavailable: kind === "Deployment" ? st("unavailableReplicas") : Math.max(0, desired - st("availableReplicas")),
    };
  } else if (kind === "DaemonSet") {
    replicas = {
      desired: st("desiredNumberScheduled"),
      current: st("currentNumberScheduled"),
      updated: st("updatedNumberScheduled"),
      ready: st("numberReady"),
      available: st("numberAvailable"),
      unavailable: st("numberUnavailable"),
    };
  }
  const revision = Number.parseInt(str(dig(item, "metadata", "annotations", "deployment.kubernetes.io/revision")), 10);
  const jobSpec = kind === "CronJob" ? dig(spec, "jobTemplate", "spec") : spec;
  const keep =
    kind === "CronJob"
      ? { succeeded: intOr(dig(spec, "successfulJobsHistoryLimit")), failed: intOr(dig(spec, "failedJobsHistoryLimit")) }
      : null;
  return {
    kind,
    app: appInfo(dig(item, "metadata", "labels"), dig(item, "metadata", "annotations")),
    name: str(dig(item, "metadata", "name")),
    namespace: str(dig(item, "metadata", "namespace")),
    uid: str(dig(item, "metadata", "uid")),
    selector: kind === "CronJob" ? null : selectorArg(dig(spec, "selector")),
    images: templateImages(jobSpec),
    conditions,
    replicas,
    strategy: strategyText(kind === "Deployment" ? dig(spec, "strategy") : dig(spec, "updateStrategy")),
    revision: kind === "Deployment" && Number.isFinite(revision) ? revision : null,
    progressDeadlineSec: kind === "Deployment" ? intOr(dig(spec, "progressDeadlineSeconds")) : null,
    paused: dig(spec, "paused") === true,
    serviceName: str(dig(spec, "serviceName")),
    currentRevision: str(dig(item, "status", "currentRevision")),
    updateRevision: str(dig(item, "status", "updateRevision")),
    claims: records(dig(spec, "volumeClaimTemplates")).map((c) => ({
      name: str(dig(c, "metadata", "name")),
      size: quantity(dig(c, "spec", "resources", "requests", "storage")),
      storageClass: str(dig(c, "spec", "storageClassName")),
    })),
    misscheduled: kind === "DaemonSet" ? st("numberMisscheduled") : null,
    schedule: str(dig(spec, "schedule")),
    timeZone: str(dig(spec, "timeZone")),
    suspended: dig(spec, "suspend") === true,
    concurrency: str(dig(spec, "concurrencyPolicy")),
    lastSchedule: when4(dig(item, "status", "lastScheduleTime")),
    lastSuccess: when4(dig(item, "status", "lastSuccessfulTime")),
    activeJobs: records(dig(item, "status", "active")).length,
    keep,
    job: kind === "Job" ? jobOf(item, nowMs) : null,
  };
}

/** The workload `kind namespace/name` of a parsed list ({@link listItems}); null — not in it. */
export function workloadItem(
  list: readonly Record<string, unknown>[],
  kind: string,
  namespace: string,
  name: string,
): Record<string, unknown> | null {
  return (
    list.find(
      (it) =>
        str(it.kind) === kind && str(dig(it, "metadata", "name")) === name && str(dig(it, "metadata", "namespace")) === namespace,
    ) ?? null
  );
}

/** A workload's own pods, by the owner the list rolls them up to — not by a selector. */
export function workloadPods(pods: readonly K8sPod[], w: { kind: string; name: string; namespace: string }): K8sPod[] {
  return pods.filter((p) => p.namespace === w.namespace && p.ownerKind === w.kind && p.ownerName === w.name);
}

// ── A node and the volume claims (ADR 0054, stage 5) ─────────────────────────
//
// What a node has (capacity), can give (allocatable), says (its conditions) and is
// asked for: the requests of its running pods, summed as the scheduler sums them —
// the figure `kubectl describe node` calls «Allocated resources». Its pods and its
// usage now are asked only while its details are on screen. A volume claim says
// why it waits through its events (already polled with the view), and who mounts
// it through the pods' own volumes.

export interface NodeCondition extends PodCondition {
  /**
   * Whether all is well by it: Ready when True, a pressure (or NetworkUnavailable)
   * when False; null — Unknown.
   */
  healthy: boolean | null;
}

/** CPU in millicores, memory and storage in MiB, pods as a count; null — not reported. */
export interface NodeResources {
  cpu: number | null;
  memory: number | null;
  pods: number | null;
  storage: number | null;
}

export interface NodeDetail {
  name: string;
  conditions: NodeCondition[];
  capacity: NodeResources;
  allocatable: NodeResources;
  /** `key=value:Effect`. */
  taints: string[];
  unschedulable: boolean;
  info: { kubelet: string; runtime: string; os: string; kernel: string; arch: string };
  addresses: { type: string; address: string }[];
  labels: { key: string; value: string }[];
  age: string;
}

function nodeResources(r: unknown): NodeResources {
  const count = Number.parseInt(str(dig(r, "pods")), 10);
  return {
    cpu: parseCpuMillis(str(dig(r, "cpu")) || undefined),
    memory: parseMemMiB(str(dig(r, "memory")) || undefined),
    pods: Number.isFinite(count) ? count : null,
    storage: parseMemMiB(str(dig(r, "ephemeral-storage")) || undefined),
  };
}

/** What a node's details show — see the section above; null for what is not a node. */
export function parseNodeDetail(item: Record<string, unknown> | null, nowMs: number = Date.now()): NodeDetail | null {
  if (!item || !dig(item, "metadata", "name")) return null;
  const conditions = records(dig(item, "status", "conditions")).map((c) => {
    const status = str(c.status);
    const ok = status === "True" ? true : status === "False" ? false : null;
    return {
      type: str(c.type),
      ok,
      healthy: ok == null ? null : c.type === "Ready" ? ok : !ok,
      reason: str(c.reason),
      message: str(c.message).trim(),
      since: Number.isFinite(Date.parse(str(c.lastTransitionTime))) ? Date.parse(str(c.lastTransitionTime)) : null,
    };
  });
  const labels = dig(item, "metadata", "labels");
  return {
    name: str(dig(item, "metadata", "name")),
    conditions: [...conditions.filter((c) => c.type === "Ready"), ...conditions.filter((c) => c.type !== "Ready")],
    capacity: nodeResources(dig(item, "status", "capacity")),
    allocatable: nodeResources(dig(item, "status", "allocatable")),
    taints: records(dig(item, "spec", "taints")).map(
      (x) => `${str(x.key)}${str(x.value) ? `=${str(x.value)}` : ""}:${str(x.effect)}`,
    ),
    unschedulable: dig(item, "spec", "unschedulable") === true,
    info: {
      kubelet: str(dig(item, "status", "nodeInfo", "kubeletVersion")),
      runtime: str(dig(item, "status", "nodeInfo", "containerRuntimeVersion")),
      os: str(dig(item, "status", "nodeInfo", "osImage")),
      kernel: str(dig(item, "status", "nodeInfo", "kernelVersion")),
      arch: str(dig(item, "status", "nodeInfo", "architecture")),
    },
    addresses: records(dig(item, "status", "addresses")).map((a) => ({ type: str(a.type), address: str(a.address) })),
    labels:
      labels && typeof labels === "object"
        ? Object.entries(labels as Record<string, unknown>)
            .map(([key, value]) => ({ key, value: str(value) }))
            .sort((a, b) => a.key.localeCompare(b.key))
        : [],
    age: k8sAge(str(dig(item, "metadata", "creationTimestamp")), nowMs),
  };
}

/** A node's pods, every namespace's — asked while its details are on screen. */
export function nodePodsArgs(node: string): string[] {
  return ["get", "pods", "-A", `--field-selector=spec.nodeName=${node}`, "-o", "json"];
}

/** A node's usage now — asked while its details are on screen. */
export function topNodeArgs(node: string): string[] {
  return ["top", "node", node, "--no-headers"];
}

/** `top node <name> --no-headers` (NAME CPU CPU% MEMORY MEMORY%): millicores, MiB; null — no row. */
export function parseTopNode(
  raw: string,
  node: string,
): { cpu: number | null; cpuPct: number | null; mem: number | null; memPct: number | null } | null {
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/).filter(Boolean);
    if (cols.length < 5 || cols[0] !== node) continue;
    const pct = (v: string) => {
      const n = Number.parseFloat(v);
      return v.endsWith("%") && Number.isFinite(n) ? n : null;
    };
    return { cpu: parseCpuMillis(cols[1]), cpuPct: pct(cols[2]), mem: parseMemMiB(cols[3]), memPct: pct(cols[4]) };
  }
  return null;
}

/**
 * What a pod asks of a node, as the scheduler counts it: its app containers and
 * native sidecars together — or an init container, which runs alone (with the
 * sidecars started before it), when that asks for more. 0 — it asks for nothing.
 */
export function podRequest(item: unknown, key: "cpu" | "memory"): number {
  const parse = key === "cpu" ? parseCpuMillis : parseMemMiB;
  const req = (c: Record<string, unknown>) => parse(str(dig(c, "resources", "requests", key)) || undefined) ?? 0;
  let sidecars = 0;
  let init = 0;
  for (const c of records(dig(item, "spec", "initContainers"))) {
    if (isSidecar(c)) sidecars += req(c);
    else init = Math.max(init, req(c) + sidecars);
  }
  const app = records(dig(item, "spec", "containers")).reduce((sum, c) => sum + req(c), 0) + sidecars;
  return Math.max(app, init);
}

export interface NodeAllocated {
  /** Pods that hold resources on it — not finished ones. */
  pods: number;
  requests: { cpu: number; memory: number };
  /** The limits that are declared; `unbounded` pods hold no ceiling at all on one of the two. */
  limits: { cpu: number; memory: number };
  unbounded: number;
}

/** What a node's running pods ask for and are held to ({@link nodePodsArgs}). */
export function nodeAllocated(pods: readonly Record<string, unknown>[]): NodeAllocated {
  const out: NodeAllocated = { pods: 0, requests: { cpu: 0, memory: 0 }, limits: { cpu: 0, memory: 0 }, unbounded: 0 };
  for (const it of pods) {
    const phase = str(dig(it, "status", "phase"));
    if (phase === "Succeeded" || phase === "Failed") continue;
    out.pods += 1;
    out.requests.cpu += podRequest(it, "cpu");
    out.requests.memory += podRequest(it, "memory");
    let bounded = true;
    for (const c of podContainers(it)) {
      const cpu = parseCpuMillis(str(dig(c, "resources", "limits", "cpu")) || undefined);
      const mem = parseMemMiB(str(dig(c, "resources", "limits", "memory")) || undefined);
      if (cpu == null || mem == null) bounded = false;
      out.limits.cpu += cpu ?? 0;
      out.limits.memory += mem ?? 0;
    }
    if (!bounded) out.unbounded += 1;
  }
  return out;
}

/** The volume claims in scope as JSON (stage 5). */
export function claimsArgs(): string[] {
  return ["get", "persistentvolumeclaims", "-o", "json"];
}

export interface K8sClaim {
  name: string;
  namespace: string;
  /** Bound · Pending · Lost. */
  phase: string;
  /** What it got (`status.capacity.storage`); "" — not bound yet. */
  capacity: string;
  /** What it asked for. */
  requested: string;
  storageClass: string;
  /** `RWO`, `ROX`, `RWX`, `RWOP`, comma-joined. */
  access: string;
  volume: string;
  age: string;
  created: number | null;
}

const ACCESS: Record<string, string> = {
  ReadWriteOnce: "RWO",
  ReadOnlyMany: "ROX",
  ReadWriteMany: "RWX",
  ReadWriteOncePod: "RWOP",
};

export function parseClaims(raw: string, nowMs: number = Date.now()): K8sClaim[] {
  return items(raw).map((it) => ({
    name: str(dig(it, "metadata", "name")),
    namespace: str(dig(it, "metadata", "namespace")),
    phase: str(dig(it, "status", "phase")),
    capacity: str(dig(it, "status", "capacity", "storage")),
    requested: str(dig(it, "spec", "resources", "requests", "storage")),
    storageClass: str(dig(it, "spec", "storageClassName")),
    access: (Array.isArray(dig(it, "spec", "accessModes")) ? (dig(it, "spec", "accessModes") as unknown[]) : [])
      .map((m) => ACCESS[str(m)] ?? str(m))
      .join(","),
    volume: str(dig(it, "spec", "volumeName")),
    age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
    created: createdAt(it),
  }));
}

/** Who mounts each claim, by `namespace/claim` — from the pods' own volumes. */
export function claimUsers(pods: readonly Record<string, unknown>[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const it of pods) {
    const ns = str(dig(it, "metadata", "namespace"));
    const name = str(dig(it, "metadata", "name"));
    for (const v of records(dig(it, "spec", "volumes"))) {
      const claim = str(dig(v, "persistentVolumeClaim", "claimName"));
      if (!claim) continue;
      const key = `${ns}/${claim}`;
      out.set(key, [...(out.get(key) ?? []), name]);
    }
  }
  return out;
}

/** What the cluster said last about each claim, by `namespace/claim` — why one waits. */
export function claimReasons(events: readonly K8sEvent[]): Map<string, { type: string; reason: string; message: string }> {
  const out = new Map<string, { type: string; reason: string; message: string }>();
  // `parseEvents` gives the newest first: the first one seen is the latest.
  for (const e of events) {
    if (!e.object.startsWith("PersistentVolumeClaim/")) continue;
    const key = `${e.namespace}/${e.object.slice("PersistentVolumeClaim/".length)}`;
    if (!out.has(key)) out.set(key, { type: e.type, reason: e.reason, message: e.message });
  }
  return out;
}

// ── An object's application (ADR 0054, stage 6) ─────────────────────────────
//
// What application an object is part of, read from Kubernetes' recommended labels
// and Helm's own annotation — the way a compose stack is read from its labels. An
// object that does not say is no application's: `app: web` is a selector's label,
// not a claim about an application, and a name is never parsed for one.

const L_PART_OF = "app.kubernetes.io/part-of";
const L_INSTANCE = "app.kubernetes.io/instance";
const L_NAME = "app.kubernetes.io/name";
const L_MANAGED = "app.kubernetes.io/managed-by";
const A_RELEASE = "meta.helm.sh/release-name";

export interface K8sApp {
  name: string;
  /** What says it: `app.kubernetes.io/part-of`, a Helm release, the instance, the name. */
  source: "partOf" | "helm" | "instance" | "name";
  /** It is (part of) a Helm release. */
  helm: boolean;
}

const label = (m: unknown, key: string): string => str(dig(m, key)).trim();

/**
 * The application an object is part of: its `part-of` — the higher-level
 * application — first; else its Helm release (Helm's annotation on what it
 * manages, or the instance of a chart `managed-by: Helm`, which is what a pod of
 * it carries); else its instance; else its name. null — it does not say.
 */
export function appOf(labels: unknown, annotations?: unknown): K8sApp | null {
  const release = label(annotations, A_RELEASE) || (label(labels, L_MANAGED) === "Helm" ? label(labels, L_INSTANCE) : "");
  const helm = Boolean(release) || label(labels, L_MANAGED) === "Helm";
  const partOf = label(labels, L_PART_OF);
  if (partOf) return { name: partOf, source: "partOf", helm };
  if (release) return { name: release, source: "helm", helm: true };
  const instance = label(labels, L_INSTANCE);
  if (instance) return { name: instance, source: "instance", helm };
  const name = label(labels, L_NAME);
  if (name) return { name, source: "name", helm };
  return null;
}

export interface K8sAppInfo {
  app: K8sApp;
  /** The Helm release it belongs to; "" — none. */
  release: string;
  /** `helm.sh/chart`: the chart and its version. */
  chart: string;
  version: string;
  component: string;
  managedBy: string;
}

/** The whole of what an object says of its application — for its details; null — nothing. */
export function appInfo(labels: unknown, annotations?: unknown): K8sAppInfo | null {
  const app = appOf(labels, annotations);
  if (!app) return null;
  return {
    app,
    release: label(annotations, A_RELEASE) || (label(labels, L_MANAGED) === "Helm" ? label(labels, L_INSTANCE) : ""),
    chart: label(labels, "helm.sh/chart"),
    version: label(labels, "app.kubernetes.io/version"),
    component: label(labels, "app.kubernetes.io/component"),
    managedBy: label(labels, L_MANAGED),
  };
}

/** The list group of an application, by namespace — the same name in two namespaces is two. */
const appGroup = (x: { namespace: string; app?: K8sApp | null }) =>
  x.app ? { key: `${x.namespace}/${x.app.name}`, label: x.app.name } : { key: "", label: "" };

// ── Parsers ──────────────────────────────────────────────────────────────────

/** Resolve a service's external address from LB ingress / externalIPs / type. */
function serviceExternal(item: Record<string, unknown>, type: string): string {
  const lb = dig(item, "status", "loadBalancer", "ingress");
  if (Array.isArray(lb) && lb.length) {
    const vals = (lb as Record<string, unknown>[]).map((x) => str(x.ip) || str(x.hostname)).filter(Boolean);
    if (vals.length) return vals.join(",");
  }
  const ext = dig(item, "spec", "externalIPs");
  if (Array.isArray(ext) && ext.length) return (ext as string[]).filter(Boolean).join(",");
  if (type === "LoadBalancer") return "<pending>";
  if (type === "ExternalName") return str(dig(item, "spec", "externalName"));
  return "-";
}

/** A number-or-name field (`targetPort`, a backend port) as the text it was written as. */
function portText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

/** `spec.selector` as "k=v, k2=v2" (sorted by key), "" when absent or empty. */
function selectorText(selector: unknown): string {
  if (!selector || typeof selector !== "object") return "";
  return Object.entries(selector as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v as string}`)
    .join(", ");
}

export function parseServices(raw: string, nowMs: number = Date.now()): K8sService[] {
  return items(raw).map((it) => {
    const type = str(dig(it, "spec", "type")) || "ClusterIP";
    const ports = dig(it, "spec", "ports");
    const portArr = Array.isArray(ports) ? (ports as Record<string, unknown>[]) : [];
    const portsStr = portArr
      .map((p) => `${num(p.port)}${p.nodePort ? ":" + num(p.nodePort) : ""}/${str(p.protocol) || "TCP"}`)
      .join(", ");
    const clusterIp = str(dig(it, "spec", "clusterIP"));
    return {
      name: str(dig(it, "metadata", "name")),
      namespace: str(dig(it, "metadata", "namespace")),
      type,
      clusterIp,
      externalIp: serviceExternal(it, type),
      ports: portsStr,
      firstPort: portArr.length ? num(portArr[0].port) : null,
      age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
      portList: portArr.map((p) => ({
        name: str(p.name),
        port: num(p.port),
        // An omitted targetPort defaults to the service port itself.
        targetPort: portText(p.targetPort) || String(num(p.port)),
        nodePort: p.nodePort ? num(p.nodePort) : null,
        protocol: str(p.protocol) || "TCP",
      })),
      selector: selectorText(dig(it, "spec", "selector")),
      headless: clusterIp === "None",
      externalName: type === "ExternalName" ? str(dig(it, "spec", "externalName")) : "",
    };
  });
}

/**
 * One ingress backend. `networking.k8s.io/v1` nests it as
 * `service.{name, port.{number|name}}` or `resource.{kind, name}`; the flat
 * `serviceName`/`servicePort` of the retired v1beta1 shape is still read, since a
 * manifest dumped from an old cluster costs nothing to understand.
 */
function parseBackend(raw: unknown): K8sBackend | null {
  if (!raw || typeof raw !== "object") return null;
  const service = str(dig(raw, "service", "name")) || str(dig(raw, "serviceName"));
  if (service) {
    const port =
      portText(dig(raw, "service", "port", "number")) ||
      portText(dig(raw, "service", "port", "name")) ||
      portText(dig(raw, "servicePort"));
    return { service, port, resource: "" };
  }
  const kind = str(dig(raw, "resource", "kind"));
  const name = str(dig(raw, "resource", "name"));
  if (kind || name) return { service: "", port: "", resource: `${kind}/${name}` };
  return null;
}

export function parseIngress(raw: string, nowMs: number = Date.now()): K8sIngress[] {
  return items(raw).map((it) => {
    const rules = dig(it, "spec", "rules");
    const ruleArr = Array.isArray(rules) ? (rules as Record<string, unknown>[]) : [];
    const hosts = ruleArr.map((r) => str(r.host)).filter(Boolean).join(",");
    const lb = dig(it, "status", "loadBalancer", "ingress");
    const address = Array.isArray(lb)
      ? (lb as Record<string, unknown>[]).map((x) => str(x.ip) || str(x.hostname)).filter(Boolean).join(",")
      : "";
    const parsedRules: K8sIngressRule[] = [];
    for (const r of ruleArr) {
      const paths = dig(r, "http", "paths");
      for (const p of Array.isArray(paths) ? (paths as Record<string, unknown>[]) : []) {
        const backend = parseBackend(p.backend);
        if (!backend) continue;
        parsedRules.push({
          host: str(r.host),
          // No path means "everything under the host".
          path: str(p.path) || "/",
          pathType: str(p.pathType),
          backend,
        });
      }
    }
    const tls = dig(it, "spec", "tls");
    const tlsHosts = Array.isArray(tls)
      ? (tls as Record<string, unknown>[]).flatMap((x) =>
          Array.isArray(x.hosts) ? (x.hosts as unknown[]).map(str).filter(Boolean) : [],
        )
      : [];
    return {
      name: str(dig(it, "metadata", "name")),
      namespace: str(dig(it, "metadata", "namespace")),
      // The class moved from an annotation to a field in v1; both are still written.
      className:
        str(dig(it, "spec", "ingressClassName")) ||
        str((dig(it, "metadata", "annotations") as Record<string, unknown> | undefined)?.["kubernetes.io/ingress.class"]),
      hosts,
      address,
      age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
      rules: parsedRules,
      defaultBackend: parseBackend(dig(it, "spec", "defaultBackend")),
      tlsHosts,
    };
  });
}

/** Parse `get ingressclasses -o json`. */
export function parseIngressClasses(raw: string): K8sIngressClass[] {
  return items(raw).map((it) => {
    const notes = dig(it, "metadata", "annotations") as Record<string, unknown> | undefined;
    return {
      name: str(dig(it, "metadata", "name")),
      controller: str(dig(it, "spec", "controller")),
      isDefault: str(notes?.["ingressclass.kubernetes.io/is-default-class"]) === "true",
    };
  });
}

/** Parse `get httproutes.gateway.networking.k8s.io -o json` (`gateway.networking.k8s.io/v1`). */
export function parseHttpRoutes(raw: string): K8sHttpRoute[] {
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return items(raw).map((it) => {
    const namespace = str(dig(it, "metadata", "namespace"));
    const rules: K8sHttpRoute["rules"] = [];
    for (const rule of list(dig(it, "spec", "rules"))) {
      const backends = list(rule.backendRefs).map((b) => ({
        kind: str(b.kind) || "Service",
        name: str(b.name),
        namespace: str(b.namespace) || namespace,
        port: portText(b.port),
      }));
      // No match means every request: the API's default is a `/` prefix.
      const matches = list(rule.matches);
      for (const m of matches.length ? matches : [{}]) {
        rules.push({
          path: str(dig(m, "path", "value")) || "/",
          pathType: str(dig(m, "path", "type")) || "PathPrefix",
          backends,
        });
      }
    }
    const said = list(dig(it, "status", "parents")).flatMap((p) =>
      list(p.conditions).filter((c) => str(c.type) === "Accepted").map((c) => str(c.status)),
    );
    return {
      name: str(dig(it, "metadata", "name")),
      namespace,
      gateways: list(dig(it, "spec", "parentRefs")).map((p) => str(p.name)).filter(Boolean),
      hostnames: (Array.isArray(dig(it, "spec", "hostnames")) ? (dig(it, "spec", "hostnames") as unknown[]) : [])
        .map(str)
        .filter(Boolean),
      rules,
      accepted: said.length === 0 ? null : said.every((v) => v === "True") ? true : said.includes("False") ? false : null,
    };
  });
}

/** `podSelector` as text: `matchLabels` and `matchExpressions` both, "" for every pod. */
function podSelectorText(sel: unknown): string {
  const labels = selectorText(dig(sel, "matchLabels"));
  const exprs = dig(sel, "matchExpressions");
  const rest = (Array.isArray(exprs) ? (exprs as Record<string, unknown>[]) : []).map((e) => {
    const values = Array.isArray(e.values) ? (e.values as unknown[]).map(str).filter(Boolean) : [];
    return values.length ? `${str(e.key)} ${str(e.operator)} (${values.join(", ")})` : `${str(e.key)} ${str(e.operator)}`;
  });
  return [labels, ...rest].filter(Boolean).join(", ");
}

/** Parse `get networkpolicies -o json` (`networking.k8s.io/v1`). */
export function parseNetworkPolicies(raw: string): K8sNetworkPolicy[] {
  return items(raw).map((it) => {
    const types = dig(it, "spec", "policyTypes");
    const ingressRules = dig(it, "spec", "ingress");
    const rules = Array.isArray(ingressRules) ? (ingressRules as Record<string, unknown>[]) : [];
    // Without policyTypes a policy always restricts what comes in (and what goes
    // out only when it lists egress rules) — the API's own reading.
    const restricts = Array.isArray(types) ? (types as unknown[]).map(str).includes("Ingress") : true;
    // An empty rule — no `from`, no `ports` — lets everything in.
    const open = rules.some((r) => !Array.isArray(r.from) && !Array.isArray(r.ports));
    return {
      name: str(dig(it, "metadata", "name")),
      namespace: str(dig(it, "metadata", "namespace")),
      appliesTo: podSelectorText(dig(it, "spec", "podSelector")),
      ingress: !restricts ? null : rules.length === 0 ? "denyAll" : open ? "allowAll" : "rules",
      ruleCount: rules.length,
    };
  });
}

/**
 * Parse `get endpointslices -o json` (`discovery.k8s.io/v1`). Conditions follow
 * the API's own reading of an absent value: `ready` missing is ready,
 * `terminating` missing is not terminating.
 */
export function parseEndpointSlices(raw: string): K8sEndpointSlice[] {
  return items(raw).map((it) => {
    const labels = dig(it, "metadata", "labels") as Record<string, unknown> | undefined;
    const ports = dig(it, "ports");
    const endpoints = dig(it, "endpoints");
    return {
      name: str(dig(it, "metadata", "name")),
      namespace: str(dig(it, "metadata", "namespace")),
      service: str(labels?.["kubernetes.io/service-name"]),
      addressType: str(dig(it, "addressType")),
      ports: (Array.isArray(ports) ? (ports as Record<string, unknown>[]) : []).map((p) => ({
        name: str(p.name),
        port: typeof p.port === "number" && Number.isFinite(p.port) ? p.port : null,
        protocol: str(p.protocol) || "TCP",
      })),
      endpoints: (Array.isArray(endpoints) ? (endpoints as Record<string, unknown>[]) : []).map((e) => ({
        addresses: Array.isArray(e.addresses) ? (e.addresses as unknown[]).map(str).filter(Boolean) : [],
        ready: dig(e, "conditions", "ready") !== false,
        terminating: dig(e, "conditions", "terminating") === true,
        targetKind: str(dig(e, "targetRef", "kind")),
        targetName: str(dig(e, "targetRef", "name")),
        node: str(e.nodeName),
      })),
    };
  });
}

/**
 * Why a `kubectl get … -o json` answer cannot be trusted as a list, or null when
 * it can. An unreadable list and an empty one must not look alike: "no endpoints"
 * says the service routes nowhere, while a forbidden `get` says nothing at all
 * (EndpointSlices sit in their own API group, so a role that lists services may
 * well not list them). The reason is kubectl's own first line — "" when it gave
 * none, as when it exits 0 with something that is not a list.
 */
/** `text` as JSON, or null when it is not JSON — kubectl's error path prints text. */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function listFailure(stdout: string, stderr: string, exitCode: number): string | null {
  if (exitCode === 0) {
    const doc = parseJsonOrNull(stdout) as { items?: unknown } | null;
    if (doc && Array.isArray(doc.items)) return null;
    return "";
  }
  const detail = (text: string): string => {
    const body = text.trim();
    if (!body) return "";
    try {
      const doc = JSON.parse(body) as { message?: unknown; reason?: unknown } | null;
      if (doc && typeof doc.message === "string" && doc.message.trim()) return doc.message.trim();
      if (doc && typeof doc.reason === "string" && doc.reason.trim()) return doc.reason.trim();
    } catch {
      // A truncated/foreign JSON response starts with punctuation, whose first
      // line used to be shown literally as "{". It carries no useful detail.
      if (/^[{[]/u.test(body)) return "";
    }
    return (
      body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !/^[{}[\],:]+$/u.test(line)) ?? ""
    );
  };
  return detail(stderr) || detail(stdout) || `exit ${exitCode}`;
}

/** Extract node roles from `node-role.kubernetes.io/<role>` (and legacy) labels. */
export function nodeRoles(labels: unknown): string {
  if (!labels || typeof labels !== "object") return "<none>";
  const roles: string[] = [];
  for (const key of Object.keys(labels as Record<string, unknown>)) {
    const m = /^node-role\.kubernetes\.io\/(.+)$/.exec(key);
    if (m && m[1]) roles.push(m[1]);
    else if (key === "kubernetes.io/role") {
      const v = str((labels as Record<string, unknown>)[key]);
      if (v) roles.push(v);
    }
  }
  return roles.length ? roles.sort().join(",") : "<none>";
}

export function parseNodes(raw: string, nowMs: number = Date.now()): K8sNode[] {
  return items(raw).map((it) => {
    const conds = dig(it, "status", "conditions");
    const ready =
      Array.isArray(conds) &&
      (conds as Record<string, unknown>[]).some((c) => c.type === "Ready" && c.status === "True");
    const unschedulable = dig(it, "spec", "unschedulable") === true;
    const status = `${ready ? "Ready" : "NotReady"}${unschedulable ? ",SchedulingDisabled" : ""}`;
    const addrs = dig(it, "status", "addresses");
    const address = (type: string): string =>
      Array.isArray(addrs) ? str((addrs as Record<string, unknown>[]).find((a) => a.type === type)?.address) : "";
    const internalIp = address("InternalIP");
    return {
      name: str(dig(it, "metadata", "name")),
      status,
      schedulable: !unschedulable,
      roles: nodeRoles(dig(it, "metadata", "labels")),
      version: str(dig(it, "status", "nodeInfo", "kubeletVersion")),
      internalIp,
      externalIp: address("ExternalIP"),
      hostname: address("Hostname"),
      age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
      pressures: records(conds)
        .filter((c) => c.type !== "Ready" && c.status === "True")
        .map((c) => str(c.type)),
    };
  });
}

export function parseEvents(raw: string, nowMs: number = Date.now()): K8sEvent[] {
  const out = items(raw).map((it) => {
    // A repeat is kept in `series` by reporters on the newer API (the scheduler):
    // its count and last time are there, `count` and `lastTimestamp` are not set.
    const when =
      str(dig(it, "series", "lastObservedTime")) ||
      str(dig(it, "lastTimestamp")) ||
      str(dig(it, "eventTime")) ||
      str(dig(it, "firstTimestamp")) ||
      str(dig(it, "metadata", "creationTimestamp"));
    const ts = Date.parse(when);
    const kind = str(dig(it, "involvedObject", "kind"));
    const objName = str(dig(it, "involvedObject", "name"));
    return {
      type: str(dig(it, "type")) || "Normal",
      reason: str(dig(it, "reason")),
      object: kind ? `${kind}/${objName}` : objName,
      namespace: str(dig(it, "metadata", "namespace")),
      // kubelet ends a probe's output with its newline.
      message: str(dig(it, "message")).trim(),
      count: Math.max(1, num(dig(it, "series", "count")) || num(dig(it, "count"))),
      age: k8sAge(when, nowMs),
      ts: Number.isFinite(ts) ? ts : 0,
      container: /^spec\.(?:initContainers|containers|ephemeralContainers)\{(.+)\}$/.exec(str(dig(it, "involvedObject", "fieldPath")))?.[1] ?? "",
    };
  });
  // Newest first.
  return out.sort((a, b) => b.ts - a.ts);
}

// ── View helpers (pure) ──────────────────────────────────────────────────────

/** A tone for a node status → the UI maps it to a color token. */
export function nodeStatusTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status.includes("SchedulingDisabled")) return "warn";
  if (status.startsWith("Ready")) return "ok";
  return "bad";
}

/** A tone for an event type → Warning stands out, Normal is quiet. */
export function eventTone(type: string): "ok" | "warn" | "bad" | "idle" {
  return type === "Warning" ? "warn" : "idle";
}

/** The views of a pod's details (`K8sDetail`); the log first — where details open (v1.33). */
export type K8sDetailTab = "logs" | "overview" | "resources" | "describe" | "yaml";

/** The views of a workload's details (stage 4). */
export type K8sWorkloadTab = "overview" | "describe" | "yaml";

/**
 * Why a pod needs a look (v1.33): the strip above the list. Stage 2 names the cause
 * where the pod's own object says it: killed for memory, an image that cannot be
 * pulled, no node that takes it, a readiness probe that fails.
 */
export type PodAttentionReason =
  | "oom"
  | "imagePull"
  | "failing"
  | "unschedulable"
  | "pending"
  | "probe"
  | "notReady"
  | "restarts";

export interface PodAttention {
  /** {@link metricsKey} of the pod. */
  key: string;
  name: string;
  namespace: string;
  reason: PodAttentionReason;
  tone: "warn" | "bad";
  /** What says it: kubectl's status, ready containers, restarts since the panel opened. */
  detail: string;
}

/** A pod may sit in Pending this long while it is scheduled and pulled before it is news. */
export const PENDING_GRACE_MS = 120_000;
/** A running pod may be not ready this long while its probes warm up. */
export const READY_GRACE_MS = 60_000;
/**
 * An OOM kill is news this long — about as long as the cluster keeps events. Its
 * container remembers the last kill until the next end, so one long ago would
 * keep a pod that has run fine since in the strip.
 */
export const RECENT_OOM_MS = 3_600_000;

const POD_ATTENTION_RANK: Record<PodAttentionReason, number> = {
  oom: 0,
  imagePull: 1,
  failing: 2,
  unschedulable: 3,
  pending: 4,
  probe: 5,
  notReady: 6,
  restarts: 7,
};

/** `1/2` → whether every container is ready; an unreadable figure is not a finding. */
function allReady(ready: string): boolean {
  const m = /^(\d+)\/(\d+)$/.exec(ready);
  return !m || +m[1] >= +m[2];
}

/**
 * What needs a look, worst first — the same reading as the state dot
 * (`podPhaseTone`), plus what time makes a problem: a pod that has been Pending
 * or not ready past its grace. Restarts are history until they grow while the
 * panel is open (`baseline`, as the Docker panel and the monitoring page read
 * their counters).
 */
export function podAttention(
  pods: readonly K8sPod[],
  baseline: ReadonlyMap<string, number>,
  nowMs: number = Date.now(),
): PodAttention[] {
  const out: PodAttention[] = [];
  for (const p of pods) {
    const key = metricsKey(p.namespace, p.name);
    const age = p.created == null ? null : nowMs - p.created;
    const add = (reason: PodAttentionReason, tone: "warn" | "bad", detail: string) =>
      out.push({ key, name: p.name, namespace: p.namespace, reason, tone, detail });
    const tone = podPhaseTone(p.status);
    const seen = baseline.get(key);
    const up = p.status === "Running" || p.status === "NotReady";
    const restarted = p.restarts > 0 ? ` · ↻${p.restarts}` : "";
    if (p.oomAt != null && nowMs - p.oomAt <= RECENT_OOM_MS) add("oom", "bad", `OOMKilled${restarted}`);
    else if (p.imagePull) add("imagePull", "bad", p.status);
    else if (tone === "bad") add("failing", "bad", `${p.status}${restarted}`);
    else if (up && !allReady(p.ready) && age != null && age >= READY_GRACE_MS)
      add(p.readinessFailing ? "probe" : "notReady", "warn", p.ready);
    else if (tone === "warn" && !up && p.status !== "Terminating" && age != null && age >= PENDING_GRACE_MS)
      add(p.unschedulable ? "unschedulable" : "pending", "warn", p.unschedulable || p.status);
    else if (seen != null && p.restarts > seen) add("restarts", "warn", `↻+${p.restarts - seen}`);
  }
  return out.sort(
    (a, b) => POD_ATTENTION_RANK[a.reason] - POD_ATTENTION_RANK[b.reason] || a.name.localeCompare(b.name),
  );
}

/** The restart counts {@link podAttention} compares against: the first seen of each pod, kept. */
export function podRestartBaseline(prev: ReadonlyMap<string, number>, pods: readonly K8sPod[]): Map<string, number> {
  const next = new Map<string, number>();
  for (const p of pods) {
    const key = metricsKey(p.namespace, p.name);
    next.set(key, prev.get(key) ?? p.restarts);
  }
  return next;
}

// ── List views (v1.29, ADR 0050) ─────────────────────────────────────────────
//
// What the filter rows of the pods, workloads and events read. The model is
// `ui/listview.ts`; here is only what a pod, a workload, an event is ordered,
// grouped and narrowed by.

const byText = (a: string, b: string): number => a.localeCompare(b);

/** Older first is "the biggest age": a later creation compares lower. */
const byAge = <T extends { created?: number | null }>(a: T, b: T): number => (b.created ?? 0) - (a.created ?? 0);
const noAge = (x: { created?: number | null }): boolean => x.created == null;

/** The live figures a pod is ordered by; null — `kubectl top` has none for it. */
export interface PodUsage {
  cpu: number | null;
  mem: number | null;
}

/** The workload kinds in the order the panel has always listed them. */
export const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"];
const kindRank = (kind: string): number => {
  const i = WORKLOAD_KINDS.indexOf(kind);
  return i === -1 ? WORKLOAD_KINDS.length : i;
};

export function podSchema(usage: (p: K8sPod) => PodUsage): ListSchema<K8sPod> {
  const figure = (key: keyof PodUsage) => ({
    compare: (a: K8sPod, b: K8sPod) => (usage(a)[key] ?? 0) - (usage(b)[key] ?? 0),
    missing: (p: K8sPod) => usage(p)[key] === null,
  });
  return {
    text: (p) => `${p.name} ${p.namespace} ${p.node} ${p.status}`,
    sorts: [
      { id: "name", firstDir: "asc", compare: (a, b) => byText(a.name, b.name) },
      { id: "restarts", firstDir: "desc", compare: (a, b) => a.restarts - b.restarts },
      { id: "cpu", firstDir: "desc", ...figure("cpu") },
      { id: "mem", firstDir: "desc", ...figure("mem") },
      { id: "age", firstDir: "desc", compare: byAge, missing: noAge },
    ],
    groups: [
      // By owning workload, kind then name; pods without a controller are the rest.
      {
        id: "owner",
        of: (p) => (p.ownerName ? { key: `${p.ownerKind}/${p.ownerName}`, label: p.ownerName } : { key: "", label: "" }),
        compare: (a, b) => byText(a.key, b.key),
      },
      // By the application its labels name (stage 6); pods that name none are the rest.
      { id: "app", of: appGroup, compare: (a, b) => byText(a.label, b.label) },
      { id: "node", of: (p) => ({ key: p.node, label: p.node }), compare: (a, b) => byText(a.label, b.label) },
      { id: "namespace", of: (p) => ({ key: p.namespace, label: p.namespace }), compare: (a, b) => byText(a.label, b.label) },
    ],
    facets: [
      { id: "status", value: (p) => p.status },
      { id: "node", value: (p) => p.node },
    ],
    tie: (a, b) => byText(a.name, b.name) || byText(a.namespace, b.namespace),
  };
}

/** Owners, pods by name — how the list lay before it had a choice. */
export const POD_ORDER: ListOrder = { sort: { key: "name", dir: "asc" }, group: "owner" };

export const WORKLOAD_SCHEMA: ListSchema<K8sWorkload> = {
  text: (w) => `${w.name} ${w.namespace} ${w.kind}`,
  sorts: [
    { id: "name", firstDir: "asc", compare: (a, b) => byText(a.name, b.name) },
    { id: "age", firstDir: "desc", compare: byAge, missing: noAge },
  ],
  groups: [
    { id: "kind", of: (w) => ({ key: w.kind, label: w.kind }), compare: (a, b) => kindRank(a.key) - kindRank(b.key) },
    { id: "app", of: appGroup, compare: (a, b) => byText(a.label, b.label) },
    { id: "namespace", of: (w) => ({ key: w.namespace, label: w.namespace }), compare: (a, b) => byText(a.label, b.label) },
  ],
  facets: [{ id: "kind", value: (w) => w.kind, order: WORKLOAD_KINDS }],
  tie: (a, b) => byText(a.name, b.name) || byText(a.namespace, b.namespace),
};

export const WORKLOAD_ORDER: ListOrder = { sort: { key: "name", dir: "asc" }, group: "kind" };

export const EVENT_SCHEMA: ListSchema<K8sEvent> = {
  text: (e) => `${e.reason} ${e.object} ${e.namespace} ${e.message}`,
  sorts: [
    { id: "time", firstDir: "desc", compare: (a, b) => a.ts - b.ts, missing: (e) => e.ts === 0 },
    { id: "count", firstDir: "desc", compare: (a, b) => a.count - b.count },
  ],
  facets: [{ id: "type", value: (e) => e.type, order: ["Warning", "Normal"] }],
  tie: (a, b) => byText(a.object, b.object) || byText(a.reason, b.reason),
};

/** The latest first, as `parseEvents` lists them. */
export const EVENT_ORDER: ListOrder = { sort: { key: "time", dir: "desc" }, group: NO_GROUPS };

// ── ConfigMaps and Secrets (v1.36, ADR 0061) ──────────────────────────────────
//
// A ConfigMap is read whole — its values are shown, those that look like a
// secret masked until asked for (`isSensitiveEnv`) and never put to the AI. A
// Secret is read through one template that prints its keys and no value: the
// backend refuses every other read of Secrets (`kube::check_args`), `describe`
// among them — it prints a service-account token in clear.

/**
 * Namespace, name, type, creation time and keys of each Secret, a line each — and
 * no value. The same string as `kube::SECRET_KEYS_TEMPLATE`: the backend lets
 * this one through and no other (`k8s.test.ts` holds them equal).
 */
export const SECRET_KEYS_TEMPLATE =
  '{{range .items}}{{.metadata.namespace}}{{"\\t"}}{{.metadata.name}}{{"\\t"}}{{.type}}{{"\\t"}}{{.metadata.creationTimestamp}}{{"\\t"}}{{range $k, $v := .data}}{{$k}}{{" "}}{{end}}{{"\\n"}}{{end}}';

export function configMapsArgs(): string[] {
  return ["get", "configmaps", "-o", "json"];
}

export function secretsArgs(): string[] {
  return ["get", "secrets", `--output=go-template=${SECRET_KEYS_TEMPLATE}`];
}

export interface K8sConfigEntry {
  key: string;
  /** The value; null — not read (a Secret) or not text (a ConfigMap's `binaryData`). */
  value: string | null;
  /** Looks like a secret (`isSensitiveEnv`): masked until asked for. */
  sensitive: boolean;
}

export interface K8sConfig {
  kind: "ConfigMap" | "Secret";
  namespace: string;
  name: string;
  /** A Secret's type (`Opaque`, `kubernetes.io/tls`, …); empty for a ConfigMap. */
  type: string;
  age: string;
  created: number | null;
  entries: K8sConfigEntry[];
}

export const CONFIG_KINDS = ["ConfigMap", "Secret"];

/** `kubectl get configmaps -o json`: every key, its value when it is text. */
export function parseConfigMaps(raw: string, nowMs: number = Date.now()): K8sConfig[] {
  return items(raw).map((it) => {
    const created = Date.parse(str(dig(it, "metadata", "creationTimestamp")));
    const data = dig(it, "data");
    const text = data && typeof data === "object" ? Object.entries(data as Record<string, unknown>) : [];
    const binary = dig(it, "binaryData");
    const blobs = binary && typeof binary === "object" ? Object.keys(binary as Record<string, unknown>) : [];
    return {
      kind: "ConfigMap" as const,
      namespace: str(dig(it, "metadata", "namespace")),
      name: str(dig(it, "metadata", "name")),
      type: "",
      age: k8sAge(str(dig(it, "metadata", "creationTimestamp")), nowMs),
      created: Number.isFinite(created) ? created : null,
      entries: [
        ...text.map(([key, v]) => ({ key, value: str(v), sensitive: isSensitiveEnv(key, str(v)) })),
        ...blobs.map((key) => ({ key, value: null, sensitive: false })),
      ].sort((a, b) => byText(a.key, b.key)),
    };
  });
}

/** The lines {@link SECRET_KEYS_TEMPLATE} prints: keys, and no value to parse. */
export function parseSecrets(raw: string, nowMs: number = Date.now()): K8sConfig[] {
  const out: K8sConfig[] = [];
  for (const line of raw.split("\n")) {
    const [namespace, name, type, stamp, keys] = line.split("\t");
    if (!name) continue;
    const created = Date.parse(stamp ?? "");
    out.push({
      kind: "Secret",
      namespace: namespace ?? "",
      name,
      type: type ?? "",
      age: k8sAge(stamp ?? "", nowMs),
      created: Number.isFinite(created) ? created : null,
      entries: (keys ?? "")
        .split(" ")
        .filter(Boolean)
        .sort(byText)
        .map((key) => ({ key, value: null, sensitive: true })),
    });
  }
  return out;
}

const configRank = (kind: string): number => CONFIG_KINDS.indexOf(kind);

export const CONFIG_SCHEMA: ListSchema<K8sConfig> = {
  text: (c) => `${c.name} ${c.namespace} ${c.kind} ${c.type} ${c.entries.map((e) => e.key).join(" ")}`,
  sorts: [
    { id: "name", firstDir: "asc", compare: (a, b) => byText(a.name, b.name) },
    { id: "age", firstDir: "desc", compare: byAge, missing: noAge },
  ],
  groups: [
    { id: "kind", of: (c) => ({ key: c.kind, label: c.kind }), compare: (a, b) => configRank(a.key) - configRank(b.key) },
    { id: "namespace", of: (c) => ({ key: c.namespace, label: c.namespace }), compare: (a, b) => byText(a.label, b.label) },
  ],
  facets: [{ id: "kind", value: (c) => c.kind, order: CONFIG_KINDS }],
  tie: (a, b) => byText(a.name, b.name) || byText(a.namespace, b.namespace),
};

export const CONFIG_ORDER: ListOrder = { sort: { key: "name", dir: "asc" }, group: "kind" };
