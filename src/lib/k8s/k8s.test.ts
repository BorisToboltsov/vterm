import { describe, expect, it } from "vitest";
import { applyView, facetValues, NO_FILTER } from "../ui/listview";
import { SHELL_SCRIPT } from "../terminal/termcmd";
import {
  followLogsArgv,
  podAttention,
  podRestartBaseline,
  parseCpuMillis,
  parseMemMiB,
  sumLimit,
  limitRatio,
  limitTone,
  kubectlProg,
  withScope,
  objectScope,
  versionArgs,
  contextsArgs,
  currentContextArgs,
  namespacesArgs,
  podsArgs,
  workloadsArgs,
  topPodsArgs,
  logsArgs,
  describeArgs,
  getYamlArgs,
  deleteArgs,
  scaleArgs,
  rolloutRestartArgs,
  execShellArgv,
  k8sAge,
  resolveOwner,
  podDisplayStatus,
  podRow,
  parsePodDetail,
  podDetailFacts,
  podItem,
  listItems,
  podsOf,
  parsePods,
  parseWorkloads,
  parseNamespaces,
  parseContexts,
  parseTopPods,
  metricsKey,
  podSchema,
  POD_ORDER,
  WORKLOAD_SCHEMA,
  WORKLOAD_ORDER,
  EVENT_SCHEMA,
  EVENT_ORDER,
  type K8sEvent,
  type K8sWorkload,
  parseAvailability,
  podPhaseTone,
  isDestructive,
  needsConfirm,
  servicesArgs,
  ingressArgs,
  nodesArgs,
  eventsArgs,
  endpointSlicesArgs,
  cordonArgs,
  uncordonArgs,
  drainArgs,
  portForwardArgv,
  parseServices,
  parseIngress,
  parseEndpointSlices,
  listFailure,
  parseNodes,
  parseEvents,
  podEventsArgs,
  podReadings,
  appOf,
  appInfo,
  parseNodeDetail,
  nodePodsArgs,
  podRequest,
  nodeAllocated,
  topNodeArgs,
  parseTopNode,
  claimsArgs,
  parseClaims,
  claimUsers,
  claimReasons,
  jobsArgs,
  parseJobs,
  jobOwners,
  selectorArg,
  workloadPodsArgs,
  replicaSetsArgs,
  parseRevisions,
  parseWorkloadDetail,
  workloadPods,
  podResourceKey,
  topContainersArgs,
  parseTopContainers,
  metricsGap,
  sumRequest,
  schedulerReason,
  RECENT_OOM_MS,
  nodeRoles,
  nodeStatusTone,
  eventTone,
  type K8sScope,
  type K8sPod,
} from "./k8s";

const SCOPE: K8sScope = { context: "prod", namespace: "web", allNamespaces: false };

describe("kubectlProg", () => {
  it("defaults to bare kubectl when empty", () => {
    expect(kubectlProg("")).toEqual(["kubectl"]);
    expect(kubectlProg("   ")).toEqual(["kubectl"]);
  });
  it("splits a wrapper into tokens", () => {
    expect(kubectlProg("k3s kubectl")).toEqual(["k3s", "kubectl"]);
    expect(kubectlProg("  microk8s   kubectl ")).toEqual(["microk8s", "kubectl"]);
  });
  it("keeps an absolute path as one token", () => {
    expect(kubectlProg("/usr/local/bin/kubectl")).toEqual(["/usr/local/bin/kubectl"]);
  });
});

describe("withScope", () => {
  it("appends context and namespace to a namespaced command", () => {
    expect(withScope(["kubectl"], podsArgs(), SCOPE)).toEqual([
      "kubectl",
      "get",
      "pods",
      "-o",
      "json",
      "--context",
      "prod",
      "--namespace",
      "web",
    ]);
  });
  it("uses -A when allNamespaces, overriding namespace", () => {
    const scope: K8sScope = { context: null, namespace: "web", allNamespaces: true };
    expect(withScope(["kubectl"], podsArgs(), scope)).toEqual([
      "kubectl",
      "get",
      "pods",
      "-o",
      "json",
      "-A",
    ]);
  });
  it("omits the namespace flag when namespace is null (context default)", () => {
    const scope: K8sScope = { context: "prod", namespace: null, allNamespaces: false };
    expect(withScope(["kubectl"], podsArgs(), scope)).toEqual([
      "kubectl",
      "get",
      "pods",
      "-o",
      "json",
      "--context",
      "prod",
    ]);
  });
  it("skips the namespace flag for cluster-scoped resources", () => {
    expect(withScope(["kubectl"], namespacesArgs(), SCOPE, { namespaced: false })).toEqual([
      "kubectl",
      "get",
      "namespaces",
      "-o",
      "json",
      "--context",
      "prod",
    ]);
  });
  it("skips all scope for kubeconfig-level commands", () => {
    expect(withScope(["kubectl"], contextsArgs(), SCOPE, { scoped: false })).toEqual([
      "kubectl",
      "config",
      "get-contexts",
      "-o",
      "name",
    ]);
  });
  it("carries a multi-token program through", () => {
    expect(withScope(["k3s", "kubectl"], podsArgs(), { context: null, namespace: null, allNamespaces: false })).toEqual(
      ["k3s", "kubectl", "get", "pods", "-o", "json"],
    );
  });
  it("objectScope targets one namespace regardless of -A view", () => {
    const view: K8sScope = { context: "prod", namespace: null, allNamespaces: true };
    expect(withScope(["kubectl"], logsArgs("api-1", null), objectScope(view, "billing"))).toEqual([
      "kubectl",
      "logs",
      "api-1",
      "--tail",
      "200",
      "--timestamps",
      "--context",
      "prod",
      "--namespace",
      "billing",
    ]);
  });
});

describe("argument builders", () => {
  it("versionArgs bounds the request", () => {
    expect(versionArgs()).toEqual(["version", "-o", "json", "--request-timeout=5s"]);
  });
  it("currentContextArgs", () => {
    expect(currentContextArgs()).toEqual(["config", "current-context"]);
  });
  it("workloadsArgs fetches the kinds and the Jobs, in one call (stage 4)", () => {
    expect(workloadsArgs()).toEqual([
      "get",
      "deployments,statefulsets,daemonsets,cronjobs,jobs",
      "-o",
      "json",
    ]);
  });
  it("topPodsArgs", () => {
    expect(topPodsArgs()).toEqual(["top", "pods", "--no-headers"]);
  });
  it("logsArgs picks a container when given", () => {
    expect(logsArgs("api-1", "nginx", 50)).toEqual([
      "logs",
      "api-1",
      "--tail",
      "50",
      "--timestamps",
      "-c",
      "nginx",
    ]);
  });
  it("describeArgs / getYamlArgs", () => {
    expect(describeArgs("pod", "api-1")).toEqual(["describe", "pod", "api-1"]);
    expect(getYamlArgs("deployment", "api")).toEqual(["get", "deployment", "api", "-o", "yaml"]);
  });
  it("scaleArgs clamps to a non-negative integer", () => {
    expect(scaleArgs("deployment", "api", 3)).toEqual(["scale", "deployment", "api", "--replicas", "3"]);
    expect(scaleArgs("deployment", "api", -2)).toEqual(["scale", "deployment", "api", "--replicas", "0"]);
  });
  it("rolloutRestartArgs uses kind/name form", () => {
    expect(rolloutRestartArgs("deployment", "api")).toEqual(["rollout", "restart", "deployment/api"]);
  });
  it("deleteArgs", () => {
    expect(deleteArgs("pod", "api-1")).toEqual(["delete", "pod", "api-1"]);
  });
});

describe("execShellArgv", () => {
  it("inlines context/namespace/container and prefers bash", () => {
    const cmd = execShellArgv(["kubectl"], "api-1", "web", "nginx", SCOPE);
    expect(cmd).toEqual([
      ...["kubectl", "exec", "-it", "--context", "prod", "--namespace", "web", "api-1"],
      ...["-c", "nginx", "--", "sh", "-c", SHELL_SCRIPT],
    ]);
  });
  it("omits the container flag when none", () => {
    const cmd = execShellArgv(["k3s", "kubectl"], "api-1", "web", null, {
      context: null,
      namespace: null,
      allNamespaces: false,
    });
    expect(cmd).toEqual([
      ...["k3s", "kubectl", "exec", "-it", "--namespace", "web", "api-1"],
      ...["--", "sh", "-c", SHELL_SCRIPT],
    ]);
  });
});

describe("k8sAge", () => {
  const now = Date.parse("2026-07-17T12:00:00Z");
  it("formats seconds/minutes/hours/days", () => {
    expect(k8sAge("2026-07-17T11:59:30Z", now)).toBe("30s");
    expect(k8sAge("2026-07-17T11:15:00Z", now)).toBe("45m");
    expect(k8sAge("2026-07-17T09:40:00Z", now)).toBe("2h20m");
    expect(k8sAge("2026-07-14T12:00:00Z", now)).toBe("3d");
    expect(k8sAge("2026-07-16T08:00:00Z", now)).toBe("1d4h");
  });
  it("coarsens past a week", () => {
    expect(k8sAge("2026-07-08T08:00:00Z", now)).toBe("9d");
    expect(k8sAge("2026-07-01T08:00:00Z", now)).toBe("2w");
  });
  it("returns empty for an unparseable stamp", () => {
    expect(k8sAge("", now)).toBe("");
    expect(k8sAge("not-a-date", now)).toBe("");
  });
});

describe("resolveOwner", () => {
  it("rolls a ReplicaSet up to its Deployment", () => {
    expect(resolveOwner([{ kind: "ReplicaSet", name: "api-7d8f9c6b5b", controller: true }])).toEqual({
      kind: "Deployment",
      name: "api",
    });
  });
  it("keeps a deployment name with dashes intact", () => {
    expect(resolveOwner([{ kind: "ReplicaSet", name: "my-web-app-5f6c7d8e9f", controller: true }])).toEqual(
      { kind: "Deployment", name: "my-web-app" },
    );
  });
  it("passes StatefulSet/DaemonSet/Job through directly", () => {
    expect(resolveOwner([{ kind: "StatefulSet", name: "db", controller: true }])).toEqual({
      kind: "StatefulSet",
      name: "db",
    });
  });
  it("prefers the controller ref", () => {
    expect(
      resolveOwner([
        { kind: "Node", name: "n1" },
        { kind: "DaemonSet", name: "fluentd", controller: true },
      ]),
    ).toEqual({ kind: "DaemonSet", name: "fluentd" });
  });
  it("returns the standalone bucket with no owner", () => {
    expect(resolveOwner(undefined)).toEqual({ kind: "", name: "" });
    expect(resolveOwner([])).toEqual({ kind: "", name: "" });
  });
});

describe("podDisplayStatus", () => {
  it("reports Terminating for a deleting pod", () => {
    expect(podDisplayStatus({ metadata: { deletionTimestamp: "2026-07-17T00:00:00Z" }, status: { phase: "Running" } })).toBe(
      "Terminating",
    );
  });
  it("surfaces a waiting reason", () => {
    expect(
      podDisplayStatus({
        status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] },
      }),
    ).toBe("CrashLoopBackOff");
  });
  it("surfaces a non-Completed terminated reason", () => {
    expect(
      podDisplayStatus({
        status: { phase: "Failed", containerStatuses: [{ state: { terminated: { reason: "Error" } } }] },
      }),
    ).toBe("Error");
  });
  it("prints Completed for a finished pod, as kubectl does", () => {
    expect(
      podDisplayStatus({
        status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { reason: "Completed" } } }] },
      }),
    ).toBe("Completed");
  });
});

// kubectl's own printer (pkg/printers/internalversion, printPod): the STATUS, READY and
// RESTARTS of `kubectl get pods`. Each case is one the stand (e2e/k8s/stand.yaml) shows live.
describe("podRow — a pod as kubectl get pods prints it", () => {
  const running = { running: { startedAt: "2026-11-07T12:00:00Z" } };
  const done = { terminated: { exitCode: 0, reason: "Completed" } };
  const pod = (spec: Record<string, unknown>, status: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    metadata,
    spec,
    status,
  });

  it("counts a native sidecar as a container: in READY and in RESTARTS", () => {
    const web = pod(
      {
        initContainers: [{ name: "prepare" }, { name: "log-shipper", restartPolicy: "Always" }],
        containers: [{ name: "httpd" }],
      },
      {
        phase: "Running",
        conditions: [{ type: "Initialized", status: "True" }, { type: "Ready", status: "True" }],
        initContainerStatuses: [
          { name: "prepare", state: done, restartCount: 0 },
          { name: "log-shipper", state: running, started: true, ready: true, restartCount: 2 },
        ],
        containerStatuses: [{ name: "httpd", state: running, ready: true, restartCount: 1 }],
      },
    );
    expect(podRow(web)).toEqual({ status: "Running", ready: "2/2", restarts: 3 });
  });

  it("a sidecar that is not ready yet holds READY below the total", () => {
    const web = pod(
      { initContainers: [{ name: "log-shipper", restartPolicy: "Always" }], containers: [{ name: "httpd" }] },
      {
        phase: "Running",
        conditions: [{ type: "Initialized", status: "True" }],
        initContainerStatuses: [{ name: "log-shipper", state: running, started: true, ready: false }],
        containerStatuses: [{ name: "httpd", state: running, ready: true }],
      },
    );
    expect(podRow(web).ready).toBe("1/2");
  });

  it("names the init step while the pod initializes, and the failing init container's reason", () => {
    const spec = { initContainers: [{ name: "migrate" }, { name: "seed" }], containers: [{ name: "app" }] };
    const waiting = { waiting: { reason: "PodInitializing" } };
    expect(
      podRow(
        pod(spec, {
          phase: "Pending",
          initContainerStatuses: [
            { name: "migrate", state: done },
            { name: "seed", state: running },
          ],
          containerStatuses: [{ name: "app", state: waiting }],
        }),
      ),
    ).toEqual({ status: "Init:1/2", ready: "0/1", restarts: 0 });
    expect(
      podRow(
        pod(spec, {
          phase: "Pending",
          initContainerStatuses: [
            { name: "migrate", state: { waiting: { reason: "CrashLoopBackOff" } }, restartCount: 4 },
            { name: "seed", state: waiting },
          ],
          containerStatuses: [{ name: "app", state: waiting }],
        }),
      ),
    ).toEqual({ status: "Init:CrashLoopBackOff", ready: "0/1", restarts: 4 });
    expect(
      podRow(
        pod(spec, {
          phase: "Failed",
          initContainerStatuses: [{ name: "migrate", state: { terminated: { exitCode: 3 } } }],
        }),
      ).status,
    ).toBe("Init:ExitCode:3");
  });

  it("the first container with a reason speaks for the pod", () => {
    const row = podRow(
      pod(
        { containers: [{ name: "a" }, { name: "b" }] },
        {
          phase: "Running",
          containerStatuses: [
            { name: "a", state: { terminated: { exitCode: 1, reason: "Error" } } },
            { name: "b", state: { waiting: { reason: "CrashLoopBackOff" } } },
          ],
        },
      ),
    );
    expect(row.status).toBe("Error");
    expect(
      podRow(
        pod(
          { containers: [{ name: "a" }] },
          { phase: "Running", containerStatuses: [{ name: "a", state: { terminated: { exitCode: 0, signal: 9 } } }] },
        ),
      ).status,
    ).toBe("Signal:9");
  });

  it("a finished container beside a running one is not «Completed»", () => {
    const spec = { containers: [{ name: "job" }, { name: "proxy" }] };
    const status = (ready: string) => ({
      phase: "Running",
      conditions: [{ type: "Ready", status: ready }],
      containerStatuses: [
        { name: "job", state: done },
        { name: "proxy", state: running, ready: true },
      ],
    });
    expect(podRow(pod(spec, status("False"))).status).toBe("NotReady");
    expect(podRow(pod(spec, status("True"))).status).toBe("Running");
  });

  it("reads the pod's own reason, a scheduling gate, and deletion only of an unfinished pod", () => {
    expect(podRow(pod({ containers: [{ name: "a" }] }, { phase: "Failed", reason: "Evicted" })).status).toBe("Evicted");
    expect(
      podRow(
        pod({ containers: [{ name: "a" }] }, { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "SchedulingGated" }] }),
      ).status,
    ).toBe("SchedulingGated");
    const deleted = { deletionTimestamp: "2026-11-07T12:00:00Z" };
    const finished = { phase: "Succeeded", containerStatuses: [{ name: "a", state: done }] };
    expect(podRow(pod({ containers: [{ name: "a" }] }, finished, deleted)).status).toBe("Completed");
    expect(podRow(pod({ containers: [{ name: "a" }] }, { phase: "Running", reason: "NodeLost" }, deleted)).status).toBe("Unknown");
    expect(podRow(pod({ containers: [{ name: "a" }] }, { phase: "Running" }, deleted)).status).toBe("Terminating");
  });
});

describe("parsePods", () => {
  const now = Date.parse("2026-07-17T12:00:00Z");
  const raw = JSON.stringify({
    items: [
      {
        kind: "Pod",
        metadata: {
          name: "api-7d8f9c6b5b-abcde",
          namespace: "web",
          creationTimestamp: "2026-07-17T10:00:00Z",
          ownerReferences: [{ kind: "ReplicaSet", name: "api-7d8f9c6b5b", controller: true }],
        },
        spec: { nodeName: "node-1", containers: [{ name: "api" }, { name: "sidecar" }] },
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "api", state: { running: {} }, ready: true, restartCount: 1 },
            { name: "sidecar", state: { running: {} }, ready: false, restartCount: 2 },
          ],
        },
      },
    ],
  });
  it("extracts identity, ready, restarts, node, age and owner", () => {
    const [p] = parsePods(raw, now);
    expect(p.name).toBe("api-7d8f9c6b5b-abcde");
    expect(p.namespace).toBe("web");
    expect(p.ready).toBe("1/2");
    expect(p.restarts).toBe(3);
    expect(p.node).toBe("node-1");
    expect(p.age).toBe("2h");
    expect(p.containers).toEqual(["api", "sidecar"]);
    expect(p.ownerKind).toBe("Deployment");
    expect(p.ownerName).toBe("api");
    expect(p.status).toBe("Running");
  });
  it("tolerates junk", () => {
    expect(parsePods("not json")).toEqual([]);
    expect(parsePods("{}")).toEqual([]);
  });
});

describe("parseWorkloads", () => {
  const raw = JSON.stringify({
    items: [
      {
        kind: "Deployment",
        metadata: { name: "api", namespace: "web", creationTimestamp: "2026-07-16T12:00:00Z" },
        spec: { replicas: 3 },
        status: { readyReplicas: 2 },
      },
      {
        kind: "DaemonSet",
        metadata: { name: "fluentd", namespace: "kube-system" },
        status: { desiredNumberScheduled: 5, numberReady: 5 },
      },
      {
        kind: "CronJob",
        metadata: { name: "backup", namespace: "web" },
        spec: { schedule: "0 3 * * *", suspend: true },
      },
    ],
  });
  it("maps each kind to its ready/replicas/schedule shape", () => {
    const w = parseWorkloads(raw, Date.parse("2026-07-17T12:00:00Z"));
    expect(w[0]).toMatchObject({ kind: "Deployment", ready: "2/3", replicas: 3, scalable: true });
    expect(w[1]).toMatchObject({ kind: "DaemonSet", ready: "5/5", replicas: null, scalable: false });
    expect(w[2]).toMatchObject({
      kind: "CronJob",
      ready: "",
      schedule: "0 3 * * *",
      suspended: true,
      scalable: false,
    });
  });
});

describe("parseNamespaces / parseContexts", () => {
  it("parses and sorts namespace names", () => {
    const raw = JSON.stringify({ items: [{ metadata: { name: "web" } }, { metadata: { name: "default" } }] });
    expect(parseNamespaces(raw)).toEqual(["default", "web"]);
  });
  it("parses and sorts context names from a newline list", () => {
    expect(parseContexts("prod\nstaging\ndev\n")).toEqual(["dev", "prod", "staging"]);
  });
});

describe("parseTopPods", () => {
  it("parses 3-column output (single namespace)", () => {
    expect(parseTopPods("api-1   5m   20Mi\napi-2   3m   18Mi")).toEqual([
      { namespace: "", name: "api-1", cpu: "5m", mem: "20Mi" },
      { namespace: "", name: "api-2", cpu: "3m", mem: "18Mi" },
    ]);
  });
  it("parses 4-column output (-A)", () => {
    expect(parseTopPods("web   api-1   5m   20Mi")).toEqual([
      { namespace: "web", name: "api-1", cpu: "5m", mem: "20Mi" },
    ]);
  });
  it("is empty when metrics-server is absent (no rows)", () => {
    expect(parseTopPods("")).toEqual([]);
  });
  it("metricsKey qualifies with namespace when present", () => {
    expect(metricsKey("web", "api-1")).toBe("web/api-1");
    expect(metricsKey("", "api-1")).toBe("api-1");
  });
});

describe("pod list", () => {
  const pod = (name: string, ownerKind: string, ownerName: string, over: Partial<K8sPod> = {}): K8sPod => ({
    name,
    namespace: "web",
    phase: "Running",
    status: "Running",
    cpuLimit: null,
    memLimit: null,
    qos: "Burstable",
    ready: "1/1",
    restarts: 0,
    node: "n1",
    age: "1h",
    containers: ["app"],
    ownerKind,
    ownerName,
    ...over,
  });
  const pods = [
    pod("api-2", "Deployment", "api", { restarts: 9, status: "CrashLoopBackOff", created: 3000 }),
    pod("loose", "", "", { node: "n2", created: 1000 }),
    pod("api-1", "Deployment", "api", { created: 2000 }),
    pod("db-0", "StatefulSet", "db", { node: "n2" }),
  ];
  const cpu: Record<string, number | null> = { "api-2": 300, loose: null, "api-1": 20, "db-0": 90 };
  const schema = podSchema((p) => ({ cpu: cpu[p.name], mem: null }));
  const names = (v: ReturnType<typeof applyView<K8sPod>>) => v.groups.map((g) => [g.key, g.items.map((p) => p.name)]);

  it("lies as it did: owners by kind then name, standalone last, pods by name", () => {
    expect(names(applyView(pods, schema, NO_FILTER, POD_ORDER))).toEqual([
      ["Deployment/api", ["api-1", "api-2"]],
      ["StatefulSet/db", ["db-0"]],
      ["", ["loose"]],
    ]);
  });

  it("orders by restarts, CPU and age — the oldest first, an unknown age last", () => {
    const by = (key: string) =>
      applyView(pods, schema, NO_FILTER, { sort: { key, dir: "desc" }, group: "none" }).groups[0].items.map((p) => p.name);
    expect(by("restarts")[0]).toBe("api-2");
    expect(by("cpu")).toEqual(["api-2", "db-0", "api-1", "loose"]);
    expect(by("age")).toEqual(["loose", "api-1", "api-2", "db-0"]);
  });

  it("groups by node and narrows by status and node", () => {
    expect(names(applyView(pods, schema, NO_FILTER, { ...POD_ORDER, group: "node" })).map(([k]) => k)).toEqual(["n1", "n2"]);
    const crashing = applyView(pods, schema, { text: "", facets: { status: ["CrashLoopBackOff"] } }, POD_ORDER);
    expect(crashing.shown).toBe(1);
    expect(facetValues(pods, schema, NO_FILTER, "node")).toEqual([
      { value: "n1", count: 2 },
      { value: "n2", count: 2 },
    ]);
  });
});

describe("workload and event lists", () => {
  const w = (kind: K8sWorkload["kind"], name: string): K8sWorkload => ({
    kind,
    name,
    namespace: "web",
    ready: "",
    replicas: null,
    schedule: "",
    suspended: false,
    age: "1d",
    scalable: false,
  });

  it("workloads by kind in the order the panel always had, the facet lists every kind", () => {
    const list = [w("CronJob", "nightly"), w("Deployment", "api"), w("DaemonSet", "agent")];
    expect(applyView(list, WORKLOAD_SCHEMA, NO_FILTER, WORKLOAD_ORDER).groups.map((g) => g.key)).toEqual([
      "Deployment",
      "DaemonSet",
      "CronJob",
    ]);
    expect(facetValues(list, WORKLOAD_SCHEMA, NO_FILTER, "kind").map((v) => [v.value, v.count])).toEqual([
      ["Deployment", 1],
      ["StatefulSet", 0],
      ["DaemonSet", 1],
      ["CronJob", 1],
      ["Job", 0],
    ]);
  });

  it("events: the latest first, Warning and Normal as the type facet", () => {
    const e = (type: string, reason: string, ts: number): K8sEvent => ({
      type,
      reason,
      object: "Pod/x",
      namespace: "web",
      message: "",
      count: 1,
      age: "",
      ts,
    });
    const events = [e("Normal", "Pulled", 1), e("Warning", "BackOff", 3), e("Normal", "Started", 2)];
    const view = applyView(events, EVENT_SCHEMA, NO_FILTER, EVENT_ORDER);
    expect(view.groups[0].items.map((x) => x.reason)).toEqual(["BackOff", "Started", "Pulled"]);
    const warn = applyView(events, EVENT_SCHEMA, { text: "", facets: { type: ["Warning"] } }, EVENT_ORDER);
    expect(warn.shown).toBe(1);
  });
});

describe("parseAvailability", () => {
  it("ok when a server version is present", () => {
    const raw = JSON.stringify({
      clientVersion: { gitVersion: "v1.29.0" },
      serverVersion: { gitVersion: "v1.28.5" },
    });
    expect(parseAvailability(raw, "", 0)).toEqual({
      ok: true,
      clientVersion: "v1.29.0",
      serverVersion: "v1.28.5",
    });
  });
  it("classifies a missing binary", () => {
    const a = parseAvailability("", "kubectl: command not found", 127);
    expect(a).toMatchObject({ ok: false, reason: "missing" });
  });
  it("classifies a missing kubeconfig", () => {
    const a = parseAvailability(
      JSON.stringify({ clientVersion: { gitVersion: "v1.29.0" } }),
      "error: no configuration has been provided",
      1,
    );
    expect(a).toMatchObject({ ok: false, reason: "no-config" });
  });
  it("classifies an unreachable API server", () => {
    const a = parseAvailability(
      JSON.stringify({ clientVersion: { gitVersion: "v1.29.0" } }),
      "Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused",
      1,
    );
    expect(a).toMatchObject({ ok: false, reason: "unreachable" });
  });
  it("classifies a forbidden response", () => {
    const a = parseAvailability("", 'Error from server (Forbidden): pods is forbidden', 1);
    expect(a).toMatchObject({ ok: false, reason: "forbidden" });
  });
  it("falls back to unknown", () => {
    const a = parseAvailability("", "something weird happened", 1);
    expect(a).toMatchObject({ ok: false, reason: "unknown" });
  });
});

describe("podPhaseTone", () => {
  it("maps statuses to tones", () => {
    expect(podPhaseTone("Running")).toBe("ok");
    expect(podPhaseTone("Completed")).toBe("idle");
    expect(podPhaseTone("Pending")).toBe("warn");
    expect(podPhaseTone("ContainerCreating")).toBe("warn");
    expect(podPhaseTone("CrashLoopBackOff")).toBe("bad");
    expect(podPhaseTone("OOMKilled")).toBe("bad");
    expect(podPhaseTone("Weird")).toBe("idle");
  });
  it("reads an init step, a failing init container, NotReady and a bare exit like kubectl prints them", () => {
    expect(podPhaseTone("Init:1/2")).toBe("warn");
    expect(podPhaseTone("Init:CrashLoopBackOff")).toBe("bad");
    expect(podPhaseTone("Init:ExitCode:3")).toBe("bad");
    expect(podPhaseTone("Init:Weird")).toBe("bad");
    expect(podPhaseTone("NotReady")).toBe("warn");
    expect(podPhaseTone("SchedulingGated")).toBe("warn");
    expect(podPhaseTone("ExitCode:1")).toBe("bad");
    expect(podPhaseTone("Signal:9")).toBe("bad");
    expect(podPhaseTone("CreateContainerConfigError")).toBe("bad");
  });
});

describe("isDestructive / needsConfirm", () => {
  it("flags delete and drain as destructive", () => {
    expect(isDestructive(deleteArgs("pod", "api-1"))).toBe(true);
    expect(isDestructive(["drain", "node-1"])).toBe(true);
    expect(isDestructive(podsArgs())).toBe(false);
    expect(isDestructive(logsArgs("api-1", null))).toBe(false);
  });
  it("confirms delete/drain plus cordon/rollout restart/scale-to-0", () => {
    expect(needsConfirm(deleteArgs("deployment", "api"))).toBe(true);
    expect(needsConfirm(["drain", "node-1"])).toBe(true);
    expect(needsConfirm(["cordon", "node-1"])).toBe(true);
    expect(needsConfirm(rolloutRestartArgs("deployment", "api"))).toBe(true);
    expect(needsConfirm(scaleArgs("deployment", "api", 0))).toBe(true);
  });
  it("does not confirm a non-zero scale or reads", () => {
    expect(needsConfirm(scaleArgs("deployment", "api", 3))).toBe(false);
    expect(needsConfirm(podsArgs())).toBe(false);
    expect(needsConfirm(topPodsArgs())).toBe(false);
    expect(needsConfirm(describeArgs("pod", "api-1"))).toBe(false);
  });
});

// ─── Phase 37.1: Network + Cluster ───────────────────────────────────────────

describe("network/cluster builders", () => {
  it("servicesArgs / ingressArgs / nodesArgs / eventsArgs", () => {
    expect(servicesArgs()).toEqual(["get", "services", "-o", "json"]);
    expect(ingressArgs()).toEqual(["get", "ingress", "-o", "json"]);
    expect(nodesArgs()).toEqual(["get", "nodes", "-o", "json"]);
    expect(eventsArgs()).toEqual(["get", "events", "-o", "json"]);
  });
  it("endpointSlicesArgs reads the slices, scoped like any namespaced list", () => {
    expect(endpointSlicesArgs()).toEqual(["get", "endpointslices", "-o", "json"]);
    expect(withScope(["kubectl"], endpointSlicesArgs(), SCOPE).join(" ")).toBe(
      "kubectl get endpointslices -o json --context prod --namespace web",
    );
  });
  it("cordon / uncordon / drain", () => {
    expect(cordonArgs("n1")).toEqual(["cordon", "n1"]);
    expect(uncordonArgs("n1")).toEqual(["uncordon", "n1"]);
    expect(drainArgs("n1")).toEqual(["drain", "n1", "--ignore-daemonsets", "--delete-emptydir-data"]);
  });
  it("cordon/drain confirm, uncordon does not", () => {
    expect(needsConfirm(cordonArgs("n1"))).toBe(true);
    expect(needsConfirm(drainArgs("n1"))).toBe(true);
    expect(isDestructive(drainArgs("n1"))).toBe(true);
    expect(needsConfirm(uncordonArgs("n1"))).toBe(false);
    expect(isDestructive(uncordonArgs("n1"))).toBe(false);
  });
  it("portForwardArgv inlines scope and target", () => {
    const cmd = portForwardArgv(["kubectl"], "svc/api", "web", 8080, 80, SCOPE);
    expect(cmd.join(" ")).toBe("kubectl port-forward --context prod --namespace web svc/api 8080:80");
  });
  it("portForwardArgv carries a wrapper program and omits empty scope", () => {
    const cmd = portForwardArgv(["k3s", "kubectl"], "pod/api-1", "", 5432, 5432, {
      context: null,
      namespace: null,
      allNamespaces: false,
    });
    expect(cmd.join(" ")).toBe("k3s kubectl port-forward pod/api-1 5432:5432");
  });
});

describe("parseServices", () => {
  const raw = JSON.stringify({
    items: [
      {
        metadata: { name: "api", namespace: "web", creationTimestamp: "2026-07-17T10:00:00Z" },
        spec: {
          type: "NodePort",
          clusterIP: "10.0.0.5",
          ports: [
            { port: 80, nodePort: 30080, protocol: "TCP" },
            { port: 443, protocol: "TCP" },
          ],
        },
      },
      {
        metadata: { name: "lb", namespace: "web" },
        spec: { type: "LoadBalancer", clusterIP: "10.0.0.6", ports: [{ port: 8080, protocol: "TCP" }] },
        status: { loadBalancer: { ingress: [{ ip: "203.0.113.7" }] } },
      },
      {
        metadata: { name: "pending", namespace: "web" },
        spec: { type: "LoadBalancer", clusterIP: "10.0.0.7", ports: [] },
      },
    ],
  });
  it("maps type/clusterIP/external/ports/firstPort", () => {
    const [np, lb, pend] = parseServices(raw, Date.parse("2026-07-17T12:00:00Z"));
    expect(np).toMatchObject({
      name: "api",
      type: "NodePort",
      clusterIp: "10.0.0.5",
      externalIp: "-",
      ports: "80:30080/TCP, 443/TCP",
      firstPort: 80,
    });
    expect(lb).toMatchObject({ externalIp: "203.0.113.7", firstPort: 8080 });
    expect(pend).toMatchObject({ externalIp: "<pending>", firstPort: null });
  });

  it("keeps the ports apart, with the targetPort as it was written", () => {
    const [s] = parseServices(
      JSON.stringify({
        items: [
          {
            metadata: { name: "web", namespace: "shop" },
            spec: {
              clusterIP: "10.0.0.5",
              ports: [
                { name: "http", port: 80, targetPort: "http", protocol: "TCP" },
                { name: "metrics", port: 9100, targetPort: 9101, nodePort: 30910 },
                { port: 53, protocol: "UDP" },
              ],
            },
          },
        ],
      }),
    );
    expect(s.portList).toEqual([
      { name: "http", port: 80, targetPort: "http", nodePort: null, protocol: "TCP" },
      { name: "metrics", port: 9100, targetPort: "9101", nodePort: 30910, protocol: "TCP" },
      // An omitted targetPort is the service port itself.
      { name: "", port: 53, targetPort: "53", nodePort: null, protocol: "UDP" },
    ]);
  });

  it("renders the selector as text, sorted by key", () => {
    const of = (spec: Record<string, unknown>) =>
      parseServices(JSON.stringify({ items: [{ metadata: { name: "s" }, spec }] }))[0].selector;
    expect(of({ selector: { tier: "api", app: "web" } })).toBe("app=web, tier=api");
    expect(of({ selector: {} })).toBe("");
    expect(of({})).toBe("");
    // Junk in place of a label map is not rendered as one.
    expect(of({ selector: "app=web" })).toBe("");
    expect(of({ selector: { app: 1 } })).toBe("");
  });

  it("recognizes headless and ExternalName services", () => {
    const [headless, external, plain] = parseServices(
      JSON.stringify({
        items: [
          { metadata: { name: "pg" }, spec: { clusterIP: "None" } },
          { metadata: { name: "db" }, spec: { type: "ExternalName", externalName: "db.example.com" } },
          // `externalName` on a service of another type is not an alias.
          { metadata: { name: "web" }, spec: { clusterIP: "10.0.0.5", externalName: "stale.example.com" } },
        ],
      }),
    );
    expect(headless).toMatchObject({ headless: true, externalName: "" });
    expect(external).toMatchObject({ headless: false, externalName: "db.example.com" });
    expect(plain).toMatchObject({ headless: false, externalName: "" });
  });
});

describe("parseIngress", () => {
  it("joins hosts and resolves the LB address", () => {
    const raw = JSON.stringify({
      items: [
        {
          metadata: { name: "web", namespace: "web" },
          spec: { ingressClassName: "nginx", rules: [{ host: "a.example.com" }, { host: "b.example.com" }] },
          status: { loadBalancer: { ingress: [{ hostname: "lb.example.com" }] } },
        },
      ],
    });
    const [ing] = parseIngress(raw);
    expect(ing).toMatchObject({
      className: "nginx",
      hosts: "a.example.com,b.example.com",
      address: "lb.example.com",
    });
    // Hosts without paths name no backend: there is no rule to follow.
    expect(ing.rules).toEqual([]);
    expect(ing.defaultBackend).toBeNull();
  });

  const one = (spec: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
    parseIngress(JSON.stringify({ items: [{ metadata: { name: "shop", namespace: "shop", ...metadata }, spec }] }))[0];

  it("reads every host and path with the backend it names", () => {
    const ing = one({
      rules: [
        {
          host: "shop.example.com",
          http: {
            paths: [
              { path: "/api", pathType: "Prefix", backend: { service: { name: "api", port: { number: 8080 } } } },
              { pathType: "ImplementationSpecific", backend: { service: { name: "web", port: { name: "http" } } } },
            ],
          },
        },
        { http: { paths: [{ path: "/", pathType: "Exact", backend: { service: { name: "fallback", port: { number: 80 } } } }] } },
      ],
    });
    expect(ing.rules).toEqual([
      { host: "shop.example.com", path: "/api", pathType: "Prefix", backend: { service: "api", port: "8080", resource: "" } },
      // No path means the whole host.
      { host: "shop.example.com", path: "/", pathType: "ImplementationSpecific", backend: { service: "web", port: "http", resource: "" } },
      // No host means every host.
      { host: "", path: "/", pathType: "Exact", backend: { service: "fallback", port: "80", resource: "" } },
    ]);
  });

  it("reads the default backend, a resource backend and the tls hosts", () => {
    const ing = one({
      defaultBackend: { service: { name: "web", port: { number: 80 } } },
      tls: [{ hosts: ["a.example.com", "b.example.com"], secretName: "tls" }, { secretName: "no-hosts" }],
      rules: [
        {
          host: "assets.example.com",
          http: { paths: [{ path: "/", backend: { resource: { apiGroup: "k8s.example.com", kind: "StorageBucket", name: "static" } } }] },
        },
      ],
    });
    expect(ing.defaultBackend).toEqual({ service: "web", port: "80", resource: "" });
    expect(ing.tlsHosts).toEqual(["a.example.com", "b.example.com"]);
    expect(ing.rules[0].backend).toEqual({ service: "", port: "", resource: "StorageBucket/static" });
  });

  it("skips a path whose backend names nothing", () => {
    const ing = one({ rules: [{ host: "a.example.com", http: { paths: [{ path: "/" }, { path: "/x", backend: {} }] } }] });
    expect(ing.rules).toEqual([]);
  });

  it("still reads the flat backend of the retired v1beta1 shape", () => {
    const ing = one({
      backend: { serviceName: "ignored-here", servicePort: 80 },
      rules: [{ host: "a.example.com", http: { paths: [{ path: "/", backend: { serviceName: "web", servicePort: "http" } }] } }],
    });
    expect(ing.rules[0].backend).toEqual({ service: "web", port: "http", resource: "" });
  });

  it("takes the class from the field, else from the legacy annotation", () => {
    expect(one({ ingressClassName: "nginx" }, { annotations: { "kubernetes.io/ingress.class": "traefik" } }).className).toBe("nginx");
    expect(one({}, { annotations: { "kubernetes.io/ingress.class": "traefik" } }).className).toBe("traefik");
    expect(one({}).className).toBe("");
  });
});

describe("parseEndpointSlices", () => {
  const raw = JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        metadata: {
          name: "web-7xk2p",
          namespace: "shop",
          labels: { "kubernetes.io/service-name": "web", "endpointslice.kubernetes.io/managed-by": "endpointslice-controller.k8s.io" },
        },
        addressType: "IPv4",
        ports: [{ name: "http", port: 8080, protocol: "TCP" }, { name: "", port: null }],
        endpoints: [
          {
            addresses: ["10.1.0.5"],
            conditions: { ready: true, serving: true, terminating: false },
            nodeName: "node-1",
            targetRef: { kind: "Pod", name: "web-abc", namespace: "shop" },
          },
          { addresses: ["10.1.0.6"], conditions: { ready: false, serving: false, terminating: true } },
          { addresses: ["10.1.0.7"] },
        ],
      },
      { metadata: { name: "custom", namespace: "shop" }, addressType: "FQDN" },
    ],
  });

  it("maps a slice to its service, ports and endpoints", () => {
    const [s] = parseEndpointSlices(raw);
    expect(s).toMatchObject({ name: "web-7xk2p", namespace: "shop", service: "web", addressType: "IPv4" });
    expect(s.ports).toEqual([
      { name: "http", port: 8080, protocol: "TCP" },
      { name: "", port: null, protocol: "TCP" },
    ]);
    expect(s.endpoints[0]).toEqual({
      addresses: ["10.1.0.5"],
      ready: true,
      terminating: false,
      targetKind: "Pod",
      targetName: "web-abc",
      node: "node-1",
    });
  });

  it("reads conditions as the API defines an absent value", () => {
    const [s] = parseEndpointSlices(raw);
    expect(s.endpoints[1]).toMatchObject({ ready: false, terminating: true, targetName: "" });
    // No conditions at all: ready, and not terminating.
    expect(s.endpoints[2]).toMatchObject({ ready: true, terminating: false });
  });

  it("tolerates a slice with no service label, ports or endpoints", () => {
    const [, bare] = parseEndpointSlices(raw);
    expect(bare).toEqual({ name: "custom", namespace: "shop", service: "", addressType: "FQDN", ports: [], endpoints: [] });
  });

  it("is empty for junk", () => {
    expect(parseEndpointSlices("not json")).toEqual([]);
  });
});

describe("listFailure", () => {
  it("trusts a list, empty or not", () => {
    expect(listFailure(JSON.stringify({ items: [] }), "", 0)).toBeNull();
    // kubectl says this on stderr for an empty namespace and still exits 0.
    expect(listFailure(JSON.stringify({ kind: "List", items: [] }), "No resources found in shop namespace.", 0)).toBeNull();
  });

  it("reports a refused read with kubectl's own first line", () => {
    const stderr =
      'Error from server (Forbidden): endpointslices.discovery.k8s.io is forbidden: User "dev" cannot list resource "endpointslices"\n';
    expect(listFailure("", stderr, 1)).toBe(stderr.trim());
  });

  it("falls back to stdout, then to the exit code", () => {
    expect(listFailure("error: the server doesn't have a resource type \"endpointslices\"\n", "", 1)).toBe(
      'error: the server doesn\'t have a resource type "endpointslices"',
    );
    expect(listFailure("", "  \n", 127)).toBe("exit 127");
  });

  it("extracts the useful message from a Kubernetes Status response", () => {
    const status = JSON.stringify(
      {
        kind: "Status",
        status: "Failure",
        message: 'services is forbidden: User "dev" cannot list resource "services"',
        reason: "Forbidden",
      },
      null,
      2,
    );
    expect(listFailure(status, "", 1)).toBe(
      'services is forbidden: User "dev" cannot list resource "services"',
    );
  });

  it("never exposes a bare JSON bracket as the failure detail", () => {
    expect(listFailure("{\n", "", 1)).toBe("exit 1");
    expect(listFailure("[\n", "", 1)).toBe("exit 1");
  });

  it("does not trust exit 0 with something that is not a list", () => {
    // An unreadable answer must not become "there are none".
    expect(listFailure("", "", 0)).toBe("");
    expect(listFailure("<html>proxy error</html>", "", 0)).toBe("");
    expect(listFailure(JSON.stringify({ kind: "Status", status: "Failure" }), "", 0)).toBe("");
    expect(listFailure("null", "", 0)).toBe("");
  });
});

describe("nodeRoles / parseNodes / nodeStatusTone", () => {
  it("extracts roles from labels", () => {
    expect(nodeRoles({ "node-role.kubernetes.io/control-plane": "", "node-role.kubernetes.io/master": "" })).toBe(
      "control-plane,master",
    );
    expect(nodeRoles({ "kubernetes.io/role": "worker" })).toBe("worker");
    expect(nodeRoles({ foo: "bar" })).toBe("<none>");
    expect(nodeRoles(undefined)).toBe("<none>");
  });
  it("maps Ready/cordoned status and version", () => {
    const raw = JSON.stringify({
      items: [
        {
          metadata: {
            name: "node-1",
            creationTimestamp: "2026-07-10T12:00:00Z",
            labels: { "node-role.kubernetes.io/control-plane": "" },
          },
          spec: { unschedulable: true },
          status: {
            conditions: [{ type: "Ready", status: "True" }],
            nodeInfo: { kubeletVersion: "v1.28.5" },
            addresses: [{ type: "InternalIP", address: "10.0.0.1" }],
          },
        },
        {
          metadata: { name: "node-2" },
          status: { conditions: [{ type: "Ready", status: "False" }] },
        },
      ],
    });
    const [n1, n2] = parseNodes(raw, Date.parse("2026-07-17T12:00:00Z"));
    expect(n1).toMatchObject({
      status: "Ready,SchedulingDisabled",
      schedulable: false,
      roles: "control-plane",
      version: "v1.28.5",
      internalIp: "10.0.0.1",
    });
    expect(n2.status).toBe("NotReady");
    expect(nodeStatusTone("Ready")).toBe("ok");
    expect(nodeStatusTone("Ready,SchedulingDisabled")).toBe("warn");
    expect(nodeStatusTone("NotReady")).toBe("bad");
  });
});

describe("parseEvents / eventTone", () => {
  it("sorts newest first and maps fields", () => {
    const raw = JSON.stringify({
      items: [
        {
          type: "Normal",
          reason: "Scheduled",
          involvedObject: { kind: "Pod", name: "api-1" },
          metadata: { namespace: "web" },
          message: "Successfully assigned",
          count: 1,
          lastTimestamp: "2026-07-17T11:00:00Z",
        },
        {
          type: "Warning",
          reason: "BackOff",
          involvedObject: { kind: "Pod", name: "api-2" },
          metadata: { namespace: "web" },
          message: "Back-off restarting",
          count: 5,
          lastTimestamp: "2026-07-17T11:30:00Z",
        },
      ],
    });
    const evs = parseEvents(raw, Date.parse("2026-07-17T12:00:00Z"));
    expect(evs[0]).toMatchObject({ type: "Warning", reason: "BackOff", object: "Pod/api-2", count: 5 });
    expect(evs[1]).toMatchObject({ type: "Normal", object: "Pod/api-1" });
    expect(eventTone("Warning")).toBe("warn");
    expect(eventTone("Normal")).toBe("idle");
  });

  it("reads a repeated event by its series: the count and the last time, not the first (stage 2)", () => {
    // The stand's too-big pod, as Docker Desktop's k8s 1.31.1 answered: the scheduler
    // reports with `eventTime` and keeps repeats in `series` — no `count`, no `lastTimestamp`.
    const raw = JSON.stringify({
      items: [
        {
          type: "Warning",
          reason: "FailedScheduling",
          involvedObject: { kind: "Pod", name: "too-big-5968cbf6b9-cwdxs", uid: "88e4f2dc" },
          metadata: { namespace: "vterm-stand", creationTimestamp: "2026-11-07T13:01:40Z" },
          message: "0/1 nodes are available: 1 Insufficient memory.",
          eventTime: "2026-11-07T13:01:40.416509Z",
          firstTimestamp: null,
          lastTimestamp: null,
          series: { count: 36, lastObservedTime: "2026-11-07T13:24:02.270815Z" },
        },
        {
          type: "Warning",
          reason: "Unhealthy",
          involvedObject: { kind: "Pod", name: "notready-59b4c7b994-8xz62", fieldPath: "spec.containers{app}" },
          metadata: { namespace: "vterm-stand" },
          message: "Readiness probe failed: cat: can't open '/tmp/ready': No such file or directory\n",
          count: 371,
          lastTimestamp: "2026-11-07T13:28:45Z",
        },
        {
          type: "Warning",
          reason: "BackOff",
          involvedObject: { kind: "Pod", name: "init-fail", fieldPath: "spec.initContainers{wait-db}" },
          metadata: { namespace: "vterm-stand" },
          message: "Back-off restarting failed container wait-db",
          count: 3,
          lastTimestamp: "2026-11-07T13:20:00Z",
        },
      ],
    });
    const [unhealthy, scheduling, backoff] = parseEvents(raw, Date.parse("2026-11-07T13:30:00Z"));
    expect(scheduling).toMatchObject({ reason: "FailedScheduling", count: 36, ts: Date.parse("2026-11-07T13:24:02.270815Z"), age: "5m", container: "" });
    expect(unhealthy).toMatchObject({
      reason: "Unhealthy",
      count: 371,
      container: "app",
      message: "Readiness probe failed: cat: can't open '/tmp/ready': No such file or directory",
    });
    expect(backoff.container).toBe("wait-db");
  });
});

describe("podEventsArgs / schedulerReason (stage 2)", () => {
  it("asks for one pod's events by its uid, in one token the policy reads as an option", () => {
    expect(podEventsArgs("88e4f2dc-1a6d")).toEqual(["get", "events", "--field-selector=involvedObject.uid=88e4f2dc-1a6d", "-o", "json"]);
  });
  it("keeps what the scheduler says about the nodes, without the preemption tail", () => {
    expect(
      schedulerReason(
        "0/1 nodes are available: 1 Insufficient memory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.",
      ),
    ).toBe("1 Insufficient memory");
    expect(schedulerReason("0/3 nodes are available: 1 node(s) had untolerated taint {x}, 2 Insufficient cpu.")).toBe(
      "1 node(s) had untolerated taint {x}, 2 Insufficient cpu",
    );
    expect(schedulerReason("pod has unbound immediate PersistentVolumeClaims")).toBe("pod has unbound immediate PersistentVolumeClaims");
  });
});

describe("what a pod's own object says needs a look (stage 2)", () => {
  const now = Date.parse("2026-11-07T13:30:00Z");
  const list = (...pods: Record<string, unknown>[]) => JSON.stringify({ items: pods });
  const meta = (name: string) => ({ name, namespace: "vterm-stand", uid: `uid-${name}`, creationTimestamp: "2026-11-07T12:53:39Z" });

  it("reads the uid, a recent OOM kill, an image that cannot be pulled, the scheduler's refusal and a failing readiness probe", () => {
    const pods = parsePods(
      list(
        {
          metadata: meta("oom"),
          spec: { containers: [{ name: "app" }] },
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: "app",
                restartCount: 9,
                lastState: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: "2026-11-07T13:10:45Z" } },
                state: { waiting: { reason: "CrashLoopBackOff" } },
              },
            ],
          },
        },
        {
          metadata: meta("bad-image"),
          spec: { containers: [{ name: "app" }] },
          status: {
            phase: "Pending",
            containerStatuses: [
              { name: "app", state: { waiting: { reason: "ImagePullBackOff", message: 'Back-off pulling image "busybox:vterm-missing-tag"' } } },
            ],
          },
        },
        {
          metadata: meta("too-big"),
          spec: { containers: [{ name: "app" }] },
          status: {
            phase: "Pending",
            conditions: [
              { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available: 1 Insufficient memory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod." },
            ],
          },
        },
        {
          metadata: meta("notready"),
          spec: { containers: [{ name: "app", readinessProbe: { exec: { command: ["cat", "/tmp/ready"] } } }] },
          status: { phase: "Running", containerStatuses: [{ name: "app", ready: false, started: true, state: { running: {} } }] },
        },
      ),
      now,
    );
    expect(pods.map((p) => [p.name, p.uid, p.oomAt, p.imagePull, p.unschedulable, p.readinessFailing])).toEqual([
      ["oom", "uid-oom", Date.parse("2026-11-07T13:10:45Z"), "", "", false],
      ["bad-image", "uid-bad-image", null, 'Back-off pulling image "busybox:vterm-missing-tag"', "", false],
      ["too-big", "uid-too-big", null, "", "1 Insufficient memory", false],
      ["notready", "uid-notready", null, "", "", true],
    ]);
    expect(podAttention(pods, new Map(), now).map((a) => [a.name, a.reason, a.tone, a.detail])).toEqual([
      ["oom", "oom", "bad", "OOMKilled · ↻9"],
      ["bad-image", "imagePull", "bad", "ImagePullBackOff"],
      ["too-big", "unschedulable", "warn", "1 Insufficient memory"],
      ["notready", "probe", "warn", "0/1"],
    ]);
  });

  it("an OOM kill is news for an hour; after that a running pod is just running", () => {
    const pod = (finishedAt: string) =>
      parsePods(
        list({
          metadata: meta("p"),
          spec: { containers: [{ name: "app" }] },
          status: {
            phase: "Running",
            containerStatuses: [
              { name: "app", ready: true, restartCount: 1, state: { running: {} }, lastState: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt } } },
            ],
          },
        }),
        now,
      );
    const recent = new Date(now - RECENT_OOM_MS + 60_000).toISOString();
    const old = new Date(now - RECENT_OOM_MS - 60_000).toISOString();
    expect(podAttention(pod(recent), new Map(), now).map((a) => a.reason)).toEqual(["oom"]);
    expect(podAttention(pod(old), new Map(), now)).toEqual([]);
  });

  it("an OOM of an init container or a sidecar counts too", () => {
    const [p] = parsePods(
      list({
        metadata: meta("p"),
        spec: { initContainers: [{ name: "seed" }], containers: [{ name: "app" }] },
        status: {
          phase: "Pending",
          initContainerStatuses: [{ name: "seed", state: { terminated: { exitCode: 137, reason: "OOMKilled", finishedAt: "2026-11-07T13:29:00Z" } } }],
        },
      }),
      now,
    );
    expect(p.oomAt).toBe(Date.parse("2026-11-07T13:29:00Z"));
  });
});

describe("parseCpuMillis", () => {
  it("reads kubectl CPU quantities", () => {
    expect(parseCpuMillis("120m")).toBe(120);
    expect(parseCpuMillis("1")).toBe(1000);
    expect(parseCpuMillis("2.5")).toBe(2500);
    expect(parseCpuMillis("1500u")).toBe(1.5);
    expect(parseCpuMillis("1500000n")).toBe(1.5);
  });

  it("is null when metrics-server has nothing to report", () => {
    expect(parseCpuMillis("<unknown>")).toBeNull();
    expect(parseCpuMillis("")).toBeNull();
    expect(parseCpuMillis(undefined)).toBeNull();
  });
});

describe("parseMemMiB", () => {
  it("reads kubectl memory quantities", () => {
    expect(parseMemMiB("412Mi")).toBe(412);
    expect(parseMemMiB("1Gi")).toBe(1024);
    expect(parseMemMiB("2048Ki")).toBe(2);
    expect(parseMemMiB("1Ti")).toBe(1024 * 1024);
  });

  it("treats a bare number as bytes", () => {
    expect(parseMemMiB(String(1024 * 1024))).toBe(1);
  });

  it("is null for unparseable values", () => {
    expect(parseMemMiB("<unknown>")).toBeNull();
    expect(parseMemMiB(undefined)).toBeNull();
  });
});

describe("sumLimit", () => {
  const c = (cpu?: string, mem?: string) => ({
    name: "c",
    resources: { limits: { ...(cpu ? { cpu } : {}), ...(mem ? { memory: mem } : {}) } },
  });

  it("sums the limit across containers", () => {
    expect(sumLimit([c("200m"), c("300m")], "cpu", parseCpuMillis)).toBe(500);
    expect(sumLimit([c(undefined, "512Mi"), c(undefined, "512Mi")], "memory", parseMemMiB)).toBe(1024);
  });

  it("is null when ANY container is unlimited — one unbounded container unbounds the pod", () => {
    expect(sumLimit([c("200m"), c()], "cpu", parseCpuMillis)).toBeNull();
  });

  it("never invents a ceiling from the containers that happen to declare one", () => {
    // The tempting bug: summing only the limited containers would report 200m,
    // and a pod using 800m would be drawn as 400% of a limit nothing enforces.
    expect(sumLimit([c("200m"), c(), c()], "cpu", parseCpuMillis)).toBeNull();
  });

  it("is null for a pod with no containers", () => {
    expect(sumLimit([], "cpu", parseCpuMillis)).toBeNull();
  });

  it("is null when the quantity is unparseable rather than treating it as zero", () => {
    expect(sumLimit([{ resources: { limits: { cpu: "wat" } } }], "cpu", parseCpuMillis)).toBeNull();
  });
});

describe("limitRatio", () => {
  it("divides usage by the limit", () => {
    expect(limitRatio(250, 500)).toBe(0.5);
    expect(limitRatio(600, 500)).toBe(1.2);
  });

  it("is null when either side is unknown", () => {
    expect(limitRatio(null, 500)).toBeNull();
    expect(limitRatio(250, null)).toBeNull();
    expect(limitRatio(250, 0)).toBeNull();
  });
});

describe("limitTone", () => {
  it("escalates as the pod approaches its ceiling", () => {
    expect(limitTone(0.4)).toBe("ok");
    expect(limitTone(0.8)).toBe("warn");
    expect(limitTone(0.95)).toBe("bad");
    expect(limitTone(1.4)).toBe("bad");
  });

  it("stays null for an unbounded pod — unmeasured is not healthy", () => {
    expect(limitTone(null)).toBeNull();
  });
});

describe("parsePods limits", () => {
  const podJson = (containers: unknown[], qos = "Guaranteed") =>
    JSON.stringify({
      items: [
        {
          metadata: { name: "p", namespace: "default", creationTimestamp: new Date().toISOString() },
          spec: { containers, nodeName: "n1" },
          status: { phase: "Running", qosClass: qos, containerStatuses: [] },
        },
      ],
    });

  it("reads cpu/memory limits and the QoS class from the json we already fetch", () => {
    const [p] = parsePods(
      podJson([{ name: "a", resources: { limits: { cpu: "500m", memory: "1Gi" } } }]),
    );
    expect(p.cpuLimit).toBe(500);
    expect(p.memLimit).toBe(1024);
    expect(p.qos).toBe("Guaranteed");
  });

  it("reports no limit for a BestEffort pod instead of guessing one", () => {
    const [p] = parsePods(podJson([{ name: "a" }], "BestEffort"));
    expect(p.cpuLimit).toBeNull();
    expect(p.memLimit).toBeNull();
    expect(p.qos).toBe("BestEffort");
  });

  it("keeps the container list working alongside the new fields", () => {
    const [p] = parsePods(podJson([{ name: "a" }, { name: "b" }]));
    expect(p.containers).toEqual(["a", "b"]);
  });

  it("a native sidecar runs beside the app: its limit counts, and without one the pod has none", () => {
    const pods = (sidecar: Record<string, unknown>) =>
      JSON.stringify({
        items: [
          {
            metadata: { name: "web", namespace: "default" },
            spec: {
              initContainers: [{ name: "prepare" }, { name: "log-shipper", restartPolicy: "Always", ...sidecar }],
              containers: [{ name: "httpd", resources: { limits: { cpu: "200m", memory: "64Mi" } } }],
            },
            status: { phase: "Running" },
          },
        ],
      });
    const [unbounded] = parsePods(pods({ resources: { limits: { memory: "16Mi" } } }));
    expect(unbounded.containers).toEqual(["httpd", "log-shipper"]);
    expect(unbounded.cpuLimit).toBeNull();
    expect(unbounded.memLimit).toBe(80);
    const [bounded] = parsePods(pods({ resources: { limits: { cpu: "50m", memory: "16Mi" } } }));
    expect(bounded.cpuLimit).toBe(250);
  });
});

describe("addresses of pods and nodes (v1.33)", () => {
  const podJson = (status: Record<string, unknown>, spec: Record<string, unknown> = {}) =>
    JSON.stringify({ items: [{ metadata: { name: "p", namespace: "ns" }, spec: { containers: [{ name: "c" }], ...spec }, status }] });

  it("reads every pod IP, the node's, and whether it is the node's network", () => {
    const [dual] = parsePods(podJson({ podIP: "10.42.1.17", podIPs: [{ ip: "10.42.1.17" }, { ip: "fd00::17" }], hostIP: "10.0.1.11" }));
    expect(dual.podIps).toEqual(["10.42.1.17", "fd00::17"]);
    expect(dual.hostIp).toBe("10.0.1.11");
    expect(dual.hostNetwork).toBe(false);
    const [old] = parsePods(podJson({ podIP: "10.42.2.9" }, { hostNetwork: true }));
    expect(old.podIps).toEqual(["10.42.2.9"]);
    expect(old.hostNetwork).toBe(true);
    const [pending] = parsePods(podJson({ phase: "Pending" }));
    expect(pending.podIps).toEqual([]);
    expect(pending.hostIp).toBe("");
  });

  it("reads a node's internal and external address and its hostname", () => {
    const raw = JSON.stringify({
      items: [
        {
          metadata: { name: "node-a" },
          status: {
            addresses: [
              { type: "InternalIP", address: "10.0.1.11" },
              { type: "ExternalIP", address: "203.0.113.21" },
              { type: "Hostname", address: "node-a.local" },
            ],
          },
        },
        { metadata: { name: "node-b" }, status: {} },
      ],
    });
    const [a, b] = parseNodes(raw);
    expect([a.internalIp, a.externalIp, a.hostname]).toEqual(["10.0.1.11", "203.0.113.21", "node-a.local"]);
    expect([b.internalIp, b.externalIp, b.hostname]).toEqual(["", "", ""]);
  });

  it("follows a pod's log in a terminal, in its own namespace and context", () => {
    const scope = { context: "prod", namespace: null, allNamespaces: true };
    expect(followLogsArgv(["kubectl"], "web-1", "shop", "app", scope, 1000)).toEqual([
      "kubectl", "logs", "-f", "--tail", "1000", "--timestamps", "--context", "prod", "--namespace", "shop", "web-1", "-c", "app",
    ]);
  });
});

describe("podAttention (v1.33)", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const base: K8sPod = {
    name: "p",
    namespace: "ns",
    phase: "Running",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    node: "n",
    age: "1h",
    containers: ["c"],
    ownerKind: "",
    ownerName: "",
    cpuLimit: null,
    memLimit: null,
    qos: "",
    created: now - 3_600_000,
  };
  const pod = (over: Partial<K8sPod>): K8sPod => ({ ...base, ...over });

  it("names the failing, the stuck and the not ready — once their grace is over", () => {
    const pods = [
      pod({ name: "crash", status: "CrashLoopBackOff", restarts: 7 }),
      pod({ name: "pending-old", status: "Pending" }),
      pod({ name: "pending-new", status: "Pending", created: now - 10_000 }),
      pod({ name: "unready", ready: "0/1" }),
      pod({ name: "unready-new", ready: "0/1", created: now - 10_000 }),
      pod({ name: "fine" }),
      pod({ name: "leaving", status: "Terminating" }),
    ];
    const got = podAttention(pods, new Map(), now);
    expect(got.map((a) => [a.name, a.reason, a.tone, a.detail])).toEqual([
      ["crash", "failing", "bad", "CrashLoopBackOff · ↻7"],
      ["pending-old", "pending", "warn", "Pending"],
      ["unready", "notReady", "warn", "0/1"],
    ]);
  });

  it("a pod kubectl calls NotReady is not ready, not stuck in Pending", () => {
    expect(podAttention([pod({ name: "half", status: "NotReady", ready: "1/2" })], new Map(), now)).toEqual([
      { key: "ns/half", name: "half", namespace: "ns", reason: "notReady", tone: "warn", detail: "1/2" },
    ]);
  });

  it("counts restarts only once they grow while the panel is open", () => {
    const seen = podRestartBaseline(new Map(), [pod({ restarts: 4 })]);
    expect(podAttention([pod({ restarts: 4 })], seen, now)).toEqual([]);
    expect(podAttention([pod({ restarts: 6 })], seen, now)).toEqual([
      { key: "ns/p", name: "p", namespace: "ns", reason: "restarts", tone: "warn", detail: "↻+2" },
    ]);
    // The first count seen is kept; a gone pod is forgotten.
    expect([...podRestartBaseline(seen, [pod({ restarts: 9 })])]).toEqual([["ns/p", 4]]);
    expect(podRestartBaseline(seen, []).size).toBe(0);
  });
});

// Stage 1 (ADR 0054): what «Overview» explains. The objects are the stand's
// (e2e/k8s/stand.yaml) as Docker Desktop's k8s 1.31.1 answered `get pods -o json`,
// trimmed to what the model reads; messages are verbatim.
describe("parsePodDetail — what Overview explains (stage 1)", () => {
  const kubeApi = { mountPath: "/var/run/secrets/kubernetes.io/serviceaccount", name: "kube-api-access-t9482", readOnly: true };
  const web = {
    metadata: { name: "web-68b586bcf5-b8tg5", namespace: "vterm-stand", labels: { app: "web", "app.kubernetes.io/part-of": "vterm-stand" } },
    spec: {
      serviceAccountName: "default",
      containers: [
        {
          name: "httpd",
          image: "busybox:1.37",
          command: ["sh", "-c", "cp /config/index.html /www/ && exec httpd -f -v -p 8080 -h /www"],
          env: [
            { name: "LOG_LEVEL", valueFrom: { configMapKeyRef: { key: "LOG_LEVEL", name: "app-config" } } },
            { name: "API_TOKEN", valueFrom: { secretKeyRef: { key: "token", name: "app-secret" } } },
            { name: "DB_PASSWORD", value: "stand-password" },
            { name: "GREETING", value: "hello" },
          ],
          envFrom: [{ configMapRef: { name: "app-config" } }],
          ports: [{ containerPort: 8080, name: "http", protocol: "TCP" }],
          resources: { limits: { cpu: "200m", memory: "64Mi" }, requests: { cpu: "10m", memory: "16Mi" } },
          startupProbe: { failureThreshold: 15, httpGet: { path: "/", port: "http", scheme: "HTTP" }, periodSeconds: 2, successThreshold: 1, timeoutSeconds: 1 },
          readinessProbe: { failureThreshold: 3, httpGet: { path: "/", port: "http", scheme: "HTTP" }, periodSeconds: 5, successThreshold: 1, timeoutSeconds: 1 },
          livenessProbe: { failureThreshold: 3, periodSeconds: 10, successThreshold: 1, tcpSocket: { port: "http" }, timeoutSeconds: 1 },
          volumeMounts: [{ mountPath: "/config", name: "site" }, { mountPath: "/work", name: "work", readOnly: true }, kubeApi],
        },
      ],
      initContainers: [
        { name: "prepare", image: "busybox:1.37", command: ["sh", "-c", "echo prepared > /work/ready"], volumeMounts: [{ mountPath: "/work", name: "work" }] },
        {
          name: "log-shipper",
          image: "busybox:1.37",
          restartPolicy: "Always",
          command: ["sh", "-c", 'while true; do echo "$(date -Iseconds) shipped 3 lines"; sleep 10; done'],
          resources: { limits: { memory: "16Mi" }, requests: { cpu: "5m", memory: "8Mi" } },
        },
      ],
      volumes: [
        { name: "site", configMap: { defaultMode: 420, name: "site" } },
        { name: "work", emptyDir: {} },
        { name: "kube-api-access-t9482", projected: { defaultMode: 420, sources: [{ serviceAccountToken: { expirationSeconds: 3607, path: "token" } }] } },
      ],
    },
    status: {
      phase: "Running",
      qosClass: "Burstable",
      conditions: [
        { lastTransitionTime: "2026-11-07T13:01:40Z", status: "True", type: "Ready" },
        { lastTransitionTime: "2026-11-07T12:53:39Z", status: "True", type: "PodScheduled" },
        { lastTransitionTime: "2026-11-07T12:59:55Z", status: "True", type: "Initialized" },
      ],
      containerStatuses: [{ name: "httpd", ready: true, restartCount: 0, started: true, state: { running: { startedAt: "2026-11-07T13:01:31Z" } } }],
      initContainerStatuses: [
        { name: "prepare", ready: true, restartCount: 0, started: false, state: { terminated: { exitCode: 0, finishedAt: "2026-11-07T12:59:53Z", reason: "Completed" } } },
        { name: "log-shipper", ready: true, restartCount: 0, started: true, state: { running: { startedAt: "2026-11-07T12:59:54Z" } } },
      ],
    },
  };
  const oom = {
    metadata: { name: "oom-66d9b57c4b-fn8v8", namespace: "vterm-stand" },
    spec: { containers: [{ name: "app", image: "busybox:1.37", resources: { limits: { memory: "24Mi" }, requests: { cpu: "5m", memory: "16Mi" } } }] },
    status: {
      phase: "Running",
      conditions: [{ lastTransitionTime: "2026-11-07T12:59:57Z", message: "containers with unready status: [app]", reason: "ContainersNotReady", status: "False", type: "Ready" }],
      containerStatuses: [
        {
          name: "app",
          ready: false,
          restartCount: 7,
          started: false,
          lastState: { terminated: { exitCode: 137, finishedAt: "2026-11-07T13:10:45Z", reason: "OOMKilled", startedAt: "2026-11-07T13:10:45Z" } },
          state: { waiting: { message: "back-off 5m0s restarting failed container=app pod=oom-66d9b57c4b-fn8v8_vterm-stand(7527d695)", reason: "CrashLoopBackOff" } },
        },
      ],
    },
  };
  const tooBig = {
    metadata: { name: "too-big-5968cbf6b9-cwdxs", namespace: "vterm-stand" },
    spec: { containers: [{ name: "app", image: "busybox:1.37", command: ["sleep", "3600"], resources: { requests: { cpu: "5m", memory: "512Gi" } } }] },
    status: {
      phase: "Pending",
      conditions: [
        {
          lastTransitionTime: "2026-11-07T12:53:39Z",
          message: "0/1 nodes are available: 1 Insufficient memory. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.",
          reason: "Unschedulable",
          status: "False",
          type: "PodScheduled",
        },
      ],
    },
  };

  it("reads each container with its role: the app first, then the sidecar, then the init that ran", () => {
    const d = parsePodDetail(web)!;
    expect(d.containers.map((c) => [c.name, c.role, c.state, c.reason])).toEqual([
      ["httpd", "app", "running", ""],
      ["log-shipper", "sidecar", "running", ""],
      ["prepare", "init", "terminated", "Completed"],
    ]);
    expect(d.serviceAccount).toBe("default");
    expect(d.labels.map((l) => l.key)).toEqual(["app", "app.kubernetes.io/part-of"]);
  });

  it("says what each container runs, asks for, is held to, checks and mounts", () => {
    const [httpd, sidecar] = parsePodDetail(web)!.containers;
    expect(httpd.command).toBe('sh -c "cp /config/index.html /www/ && exec httpd -f -v -p 8080 -h /www"');
    expect(httpd.requests).toEqual({ cpu: "10m", memory: "16Mi" });
    expect(httpd.limits).toEqual({ cpu: "200m", memory: "64Mi" });
    expect(sidecar.limits).toEqual({ cpu: "", memory: "16Mi" });
    expect(httpd.ports).toEqual(["http 8080/TCP"]);
    expect(httpd.probes.map((p) => [p.kind, p.action, p.periodSec, p.failureThreshold])).toEqual([
      ["startup", "GET http://:http/", 2, 15],
      ["readiness", "GET http://:http/", 5, 3],
      ["liveness", "TCP :http", 10, 3],
    ]);
    expect(httpd.mounts.map((m) => [m.path, m.source, m.readOnly])).toEqual([
      ["/config", "configMap site", false],
      ["/work", "emptyDir", true],
      ["/var/run/secrets/kubernetes.io/serviceaccount", "projected · service account token", true],
    ]);
    expect(httpd.since).toBe(Date.parse("2026-11-07T13:01:31Z"));
  });

  it("names where a value comes from instead of reading a secret, and masks what looks like one", () => {
    const [httpd] = parsePodDetail(web)!.containers;
    expect(httpd.env).toEqual([
      { key: "LOG_LEVEL", value: "", from: "configMap app-config · LOG_LEVEL", sensitive: false },
      { key: "API_TOKEN", value: "", from: "secret app-secret · token", sensitive: false },
      { key: "DB_PASSWORD", value: "stand-password", from: "", sensitive: true },
      { key: "GREETING", value: "hello", from: "", sensitive: false },
    ]);
    expect(httpd.envFrom).toEqual(["configMap app-config"]);
  });

  it("tells how a container ended the time before — what CrashLoopBackOff hides", () => {
    const [app] = parsePodDetail(oom)!.containers;
    expect(app).toMatchObject({ state: "waiting", reason: "CrashLoopBackOff", ready: false, restarts: 7, command: "" });
    expect(app.message).toMatch(/^back-off 5m0s restarting failed container=app/);
    expect(app.last).toEqual({ reason: "OOMKilled", exitCode: 137, signal: null, finishedAt: Date.parse("2026-11-07T13:10:45Z"), message: "" });
  });

  it("orders the conditions as a pod comes up and keeps what the scheduler said", () => {
    expect(parsePodDetail(web)!.conditions.map((c) => [c.type, c.ok])).toEqual([
      ["PodScheduled", true],
      ["Initialized", true],
      ["Ready", true],
    ]);
    const [scheduled] = parsePodDetail(tooBig)!.conditions;
    expect(scheduled).toMatchObject({ type: "PodScheduled", ok: false, reason: "Unschedulable" });
    expect(scheduled.message).toMatch(/^0\/1 nodes are available: 1 Insufficient memory\./);
    // No status yet — not a guessed one.
    expect(parsePodDetail(tooBig)!.containers[0]).toMatchObject({ state: "", reason: "", ready: null, restarts: 0, since: null });
  });

  it("reads the other probe and volume kinds as what they are", () => {
    const d = parsePodDetail({
      metadata: { name: "p", namespace: "n" },
      spec: {
        containers: [
          {
            name: "c",
            ports: [{ containerPort: 9090, hostPort: 19090 }],
            readinessProbe: { exec: { command: ["cat", "/tmp/ready file"] }, initialDelaySeconds: 5 },
            livenessProbe: { grpc: { port: 9090 } },
            startupProbe: { httpGet: { port: 8443, path: "/healthz", scheme: "HTTPS", host: "10.0.0.1" } },
            volumeMounts: [
              { name: "data", mountPath: "/data" },
              { name: "creds", mountPath: "/etc/creds", subPath: "key" },
              { name: "logs", mountPath: "/var/log" },
              { name: "scratch", mountPath: "/tmp" },
              { name: "weird", mountPath: "/w" },
            ],
            env: [{ name: "POD", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } }],
            envFrom: [{ secretRef: { name: "creds" }, prefix: "DB_" }],
          },
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "data-db-0" } },
          { name: "creds", secret: { secretName: "creds" } },
          { name: "logs", hostPath: { path: "/var/log" } },
          { name: "scratch", emptyDir: { medium: "Memory" } },
          { name: "weird", flocker: {} },
        ],
      },
      status: {},
    })!;
    const [c] = d.containers;
    expect(c.probes.map((p) => [p.kind, p.action, p.initialDelaySec])).toEqual([
      ["startup", "GET https://10.0.0.1:8443/healthz", null],
      ["readiness", "exec cat \"/tmp/ready file\"", 5],
      ["liveness", "gRPC :9090", null],
    ]);
    expect(c.ports).toEqual(["9090/TCP → host 19090"]);
    expect(c.mounts.map((m) => [m.source, m.subPath])).toEqual([
      ["pvc data-db-0", ""],
      ["secret creds", "key"],
      ["hostPath /var/log", ""],
      ["emptyDir · memory", ""],
      ["flocker", ""],
    ]);
    expect(c.env).toEqual([{ key: "POD", value: "", from: "field metadata.name", sensitive: false }]);
    expect(c.envFrom).toEqual(["secret creds · DB_"]);
  });

  it("is nothing for what is not a pod, and finds a pod of a parsed list by namespace and name", () => {
    expect(parsePodDetail(null)).toBeNull();
    expect(parsePodDetail({})).toBeNull();
    const list = listItems(JSON.stringify({ items: [web, oom] }));
    expect(podItem(list, "vterm-stand", "oom-66d9b57c4b-fn8v8")).toBe(list[1]);
    expect(podItem(list, "other", "oom-66d9b57c4b-fn8v8")).toBeNull();
    expect(podsOf(list).map((p) => [p.name, p.ready])).toEqual([
      ["web-68b586bcf5-b8tg5", "2/2"],
      ["oom-66d9b57c4b-fn8v8", "0/1"],
    ]);
  });

  it("tells the assistant what does not hold and how containers ended — never the environment", () => {
    const facts = podDetailFacts(parsePodDetail(oom)!).join("\n");
    expect(facts).toContain("Condition Ready: False (ContainersNotReady) — containers with unready status: [app]");
    expect(facts).toContain("Container app: waiting CrashLoopBackOff, 7 restarts; last time: OOMKilled exit 137; limits memory 24Mi");
    const webFacts = podDetailFacts(parsePodDetail(web)!).join("\n");
    expect(webFacts).not.toMatch(/stand-password|DB_PASSWORD|API_TOKEN|app-secret|GREETING/);
    expect(webFacts).toContain("Container log-shipper (sidecar): running");
    expect(webFacts).not.toContain("Condition");
  });

  it("a finished pod's False Ready only repeats that it ended — the end is in its container", () => {
    // The stand's `migrate` Job pod, as Docker Desktop answered.
    const migrate = {
      metadata: { name: "migrate-qr4zh", namespace: "vterm-stand" },
      spec: { containers: [{ name: "migrate", image: "busybox:1.37" }] },
      status: {
        phase: "Succeeded",
        conditions: [
          { type: "PodReadyToStartContainers", status: "False", lastTransitionTime: "2026-11-07T12:59:56Z" },
          { type: "Ready", status: "False", reason: "PodCompleted", lastTransitionTime: "2026-11-07T12:59:56Z" },
        ],
        containerStatuses: [{ name: "migrate", ready: false, restartCount: 0, state: { terminated: { exitCode: 0, reason: "Completed" } } }],
      },
    };
    const d = parsePodDetail(migrate)!;
    expect(d.finished).toBe(true);
    expect(podDetailFacts(d)).toEqual(["Container migrate: terminated Completed exit 0"]);
    expect(parsePodDetail(oom)!.finished).toBe(false);
  });
});

// Stage 3 (ADR 0054): a pod's resources against its ceiling.
describe("a pod's resources (stage 3)", () => {
  it("reads one poll of `top pods` into the panel's history: millicores and MiB, by pod", () => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          { metadata: { name: "web", namespace: "a" }, spec: { containers: [{ name: "c" }] }, status: {} },
          { metadata: { name: "db", namespace: "a" }, spec: { containers: [{ name: "c" }] }, status: {} },
        ],
      }),
    );
    const metrics = new Map([[metricsKey("a", "web"), { namespace: "a", name: "web", cpu: "12m", mem: "30Mi" }]]);
    expect(podReadings(pods, metrics)).toEqual({
      [podResourceKey("a/web", "cpu")]: 12,
      [podResourceKey("a/web", "mem")]: 30,
      [podResourceKey("a/db", "cpu")]: null,
      [podResourceKey("a/db", "mem")]: null,
    });
    // Without -A kubectl prints no namespace column: the row is keyed by name only.
    const bare = new Map([[metricsKey("", "db"), { namespace: "", name: "db", cpu: "1", mem: "1Gi" }]]);
    expect(podReadings(pods, bare)[podResourceKey("a/db", "cpu")]).toBe(1000);
    expect(podReadings(pods, bare)[podResourceKey("a/db", "mem")]).toBe(1024);
  });

  it("asks one pod's containers, and reads only that pod's rows", () => {
    expect(topContainersArgs("web-68b5")).toEqual(["top", "pod", "web-68b5", "--containers", "--no-headers"]);
    const raw = "web-68b5   httpd         1m    2Mi\nweb-68b5   log-shipper   0m    560Ki\nother      x   5m   1Mi\n";
    // What kubectl prints under a MiB, rounded: zero, not «nothing».
    expect(parseTopContainers("web-68b5   httpd   1m   0Mi   \n", "web-68b5")).toEqual([{ container: "httpd", cpu: 1, mem: 0 }]);
    expect(parseTopContainers(raw, "web-68b5")).toEqual([
      { container: "httpd", cpu: 1, mem: 2 },
      { container: "log-shipper", cpu: 0, mem: 0.546875 },
    ]);
  });

  it("tells a cluster without metrics-server from metrics not there yet, and from another failure", () => {
    expect(metricsGap({ stdout: "web 1m 2Mi\n", stderr: "", exitCode: 0 })).toBeNull();
    // Docker Desktop's cluster, as it answered.
    expect(metricsGap({ stdout: "", stderr: "error: Metrics API not available\n", exitCode: 1 })).toEqual({ kind: "noServer", text: "error: Metrics API not available" });
    expect(metricsGap({ stdout: "", stderr: "error: metrics not available yet\n", exitCode: 1 })?.kind).toBe("notYet");
    expect(metricsGap({ stdout: "", stderr: 'Error from server (NotFound): podmetrics.metrics.k8s.io "a/web" not found', exitCode: 1 })?.kind).toBe("notYet");
    // A Pending pod of the stand, as metrics-server 0.9.1 on Docker Desktop answered: the
    // pod is there, its sample is not.
    expect(metricsGap({ stdout: "", stderr: 'Error from server (NotFound): pods "too-big-5968cbf6b9-cwdxs" not found\n', exitCode: 1 })?.kind).toBe("notYet");
    expect(metricsGap({ stdout: "", stderr: "", exitCode: 0 })?.kind).toBe("notYet");
    expect(metricsGap({ stdout: "", stderr: 'Error from server (Forbidden): pods.metrics.k8s.io is forbidden', exitCode: 1 })).toEqual({
      kind: "other",
      text: "Error from server (Forbidden): pods.metrics.k8s.io is forbidden",
    });
  });

  it("sums the requests of what runs — a container without one asks for nothing", () => {
    const c = (cpu?: string) => ({ resources: cpu ? { requests: { cpu } } : {} });
    expect(sumRequest([c("10m"), c("5m")], "cpu", parseCpuMillis)).toBe(15);
    expect(sumRequest([c("10m"), c()], "cpu", parseCpuMillis)).toBe(10);
    expect(sumRequest([c(), c()], "cpu", parseCpuMillis)).toBeNull();
    // The pod's own: its app containers and native sidecars, like its limit.
    const [web] = parsePods(
      JSON.stringify({
        items: [
          {
            metadata: { name: "web", namespace: "a" },
            spec: {
              initContainers: [{ name: "prepare", resources: { requests: { cpu: "100m" } } }, { name: "sidecar", restartPolicy: "Always", resources: { requests: { cpu: "5m", memory: "8Mi" } } }],
              containers: [{ name: "httpd", resources: { requests: { cpu: "10m", memory: "16Mi" } } }],
            },
            status: {},
          },
        ],
      }),
    );
    expect([web.cpuRequest, web.memRequest]).toEqual([15, 24]);
  });
});

// Stage 4 (ADR 0054): a workload's details. The objects are the stand's as Docker
// Desktop's k8s 1.31.1 answered, trimmed to what the model reads.
describe("a workload's details (stage 4)", () => {
  const now = Date.parse("2026-11-07T14:05:00Z");
  const deploy = (name: string, status: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    kind: "Deployment",
    metadata: { name, namespace: "vterm-stand", uid: `uid-${name}`, creationTimestamp: "2026-11-07T12:53:39Z", annotations: { "deployment.kubernetes.io/revision": "2" } },
    spec: {
      replicas: 2,
      strategy: { rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" }, type: "RollingUpdate" },
      selector: { matchLabels: { app: name } },
      progressDeadlineSeconds: 30,
      template: { spec: { containers: [{ name: "app", image: "busybox:vterm-missing-tag" }] } },
      ...extra,
    },
    status,
  });
  const rollout = deploy("rollout", {
    replicas: 3,
    updatedReplicas: 1,
    readyReplicas: 2,
    availableReplicas: 2,
    unavailableReplicas: 1,
    conditions: [
      { type: "Available", status: "True", reason: "MinimumReplicasAvailable", message: "Deployment has minimum availability.", lastTransitionTime: "2026-11-07T13:59:00Z" },
      { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "rollout-5d9c" has timed out progressing.', lastTransitionTime: "2026-11-07T14:01:39Z" },
    ],
  });
  const job = (name: string, owner: string | null, status: Record<string, unknown>) => ({
    kind: "Job",
    metadata: {
      name,
      namespace: "vterm-stand",
      uid: `uid-${name}`,
      creationTimestamp: "2026-11-07T14:02:00Z",
      ownerReferences: owner ? [{ kind: "CronJob", name: owner, uid: `uid-${owner}`, controller: true }] : undefined,
    },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0 },
    status,
  });
  const failed = job("report-29901003", "report", {
    startTime: "2026-11-07T14:03:00Z",
    failed: 1,
    conditions: [
      { type: "FailureTarget", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" },
      { type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" },
    ],
  });
  const done = job("migrate", null, {
    startTime: "2026-11-07T13:01:35Z",
    completionTime: "2026-11-07T13:01:39Z",
    succeeded: 1,
    conditions: [
      { type: "SuccessCriteriaMet", status: "True", reason: "CompletionsReached" },
      { type: "Complete", status: "True", reason: "CompletionsReached", message: "Reached expected number of succeeded pods" },
    ],
  });
  const running = job("report-29901004", "report", { startTime: "2026-11-07T14:04:00Z", active: 1 });

  it("asks for the Jobs, and reads each: its CronJob, how it ended, how long it took", () => {
    expect(jobsArgs()).toEqual(["get", "jobs", "-o", "json"]);
    const jobs = parseJobs(JSON.stringify({ items: [failed, done, running] }), now);
    expect(jobs.map((j) => [j.name, j.owner?.name ?? null, j.status, j.reason, j.succeeded, j.failed, j.active])).toEqual([
      ["report-29901003", "report", "Failed", "BackoffLimitExceeded", 0, 1, 0],
      ["migrate", null, "Complete", "CompletionsReached", 1, 0, 0],
      ["report-29901004", "report", "Running", "", 0, 0, 1],
    ]);
    expect(jobs[1].durationSec).toBe(4);
    expect(jobs[0].durationSec).toBeNull();
    expect(jobs[0].message).toBe("Job has reached the specified backoff limit");
  });

  it("rolls a CronJob's run pods up to the CronJob, as a ReplicaSet's are rolled up to its Deployment", () => {
    const jobs = parseJobs(JSON.stringify({ items: [failed, done] }));
    const owners = jobOwners(jobs);
    const pods = podsOf(
      listItems(
        JSON.stringify({
          items: [
            { metadata: { name: "report-29901003-wx9hk", namespace: "vterm-stand", ownerReferences: [{ kind: "Job", name: "report-29901003", controller: true }] }, spec: { containers: [{ name: "c" }] }, status: {} },
            { metadata: { name: "migrate-qr4zh", namespace: "vterm-stand", ownerReferences: [{ kind: "Job", name: "migrate", controller: true }] }, spec: { containers: [{ name: "c" }] }, status: {} },
          ],
        }),
      ),
      now,
      owners,
    );
    expect(pods.map((p) => [p.ownerKind, p.ownerName])).toEqual([
      ["CronJob", "report"],
      ["Job", "migrate"],
    ]);
    // Without the Jobs the pod's own owner is all there is — no guess from the name.
    expect(podsOf(listItems(JSON.stringify({ items: [{ metadata: { name: "report-29901003-wx9hk", namespace: "vterm-stand", ownerReferences: [{ kind: "Job", name: "report-29901003" }] }, spec: {}, status: {} }] })), now).map((p) => p.ownerKind)).toEqual(["Job"]);
  });

  it("lists a Job of its own as a workload, and leaves a CronJob's runs to its CronJob", () => {
    const list = parseWorkloads(JSON.stringify({ items: [rollout, failed, done, running] }), now);
    expect(list.map((w) => [w.kind, w.name, w.ready, w.uid])).toEqual([
      ["Deployment", "rollout", "2/2", "uid-rollout"],
      ["Job", "migrate", "1/1", "uid-migrate"],
    ]);
    expect(list[1]).toMatchObject({ status: "Complete", scalable: false, replicas: null });
  });

  it("writes a selector as kubectl reads it, and asks the pods and ReplicaSets it selects", () => {
    expect(selectorArg({ matchLabels: { app: "web", tier: "front" } })).toBe("app=web,tier=front");
    expect(
      selectorArg({
        matchExpressions: [
          { key: "env", operator: "In", values: ["prod", "stage"] },
          { key: "canary", operator: "DoesNotExist" },
          { key: "zone", operator: "NotIn", values: ["a"] },
          { key: "owner", operator: "Exists" },
        ],
      }),
    ).toBe("env in (prod,stage),!canary,zone notin (a),owner");
    // An empty selector selects everything — not a question worth asking.
    expect(selectorArg({})).toBeNull();
    expect(selectorArg(undefined)).toBeNull();
    expect(workloadPodsArgs("app=web")).toEqual(["get", "pods", "--selector=app=web", "-o", "json"]);
    expect(replicaSetsArgs("app=web")).toEqual(["get", "replicasets", "--selector=app=web", "-o", "json"]);
  });

  it("reads a Deployment's revisions from its own ReplicaSets, newest first, the current one marked", () => {
    const rs = (name: string, rev: string, owner: string, image: string, replicas: number, ready?: number) => ({
      metadata: { name, namespace: "vterm-stand", creationTimestamp: "2026-11-07T13:00:00Z", annotations: { "deployment.kubernetes.io/revision": rev }, ownerReferences: [{ kind: "Deployment", name: owner, uid: `uid-${owner}`, controller: true }] },
      spec: { replicas, template: { spec: { containers: [{ name: "app", image }] } } },
      status: ready == null ? {} : { readyReplicas: ready },
    });
    const raw = JSON.stringify({ items: [rs("rollout-7f9c", "1", "rollout", "busybox:1.37", 2, 2), rs("rollout-5d9c", "2", "rollout", "busybox:vterm-missing-tag", 1), rs("web-68b5", "1", "web", "busybox:1.37", 1, 1)] });
    expect(parseRevisions(raw, "uid-rollout", 2, now).map((r) => [r.revision, r.name, r.images, r.desired, r.ready, r.current])).toEqual([
      [2, "rollout-5d9c", ["busybox:vterm-missing-tag"], 1, 0, true],
      [1, "rollout-7f9c", ["busybox:1.37"], 2, 2, false],
    ]);
  });

  it("reads what a Deployment is told, has, and says: replicas, strategy, conditions, images", () => {
    const d = parseWorkloadDetail(rollout, now)!;
    expect(d).toMatchObject({ kind: "Deployment", name: "rollout", uid: "uid-rollout", selector: "app=rollout", revision: 2 });
    expect(d.replicas).toEqual({ desired: 2, current: 3, updated: 1, ready: 2, available: 2, unavailable: 1 });
    expect(d.strategy).toBe("RollingUpdate · maxSurge 25% · maxUnavailable 25%");
    expect(d.images).toEqual(["busybox:vterm-missing-tag"]);
    expect(d.conditions.map((c) => [c.type, c.ok, c.reason])).toEqual([
      ["Available", true, "MinimumReplicasAvailable"],
      ["Progressing", false, "ProgressDeadlineExceeded"],
    ]);
    expect(d.conditions[1].message).toBe('ReplicaSet "rollout-5d9c" has timed out progressing.');
  });

  it("reads a StatefulSet's revisions and claims, a DaemonSet's nodes, a CronJob's schedule and last runs", () => {
    const sts = parseWorkloadDetail(
      {
        kind: "StatefulSet",
        metadata: { name: "db", namespace: "vterm-stand", uid: "uid-db" },
        spec: {
          replicas: 1,
          serviceName: "db",
          selector: { matchLabels: { app: "db" } },
          updateStrategy: { rollingUpdate: { partition: 0 }, type: "RollingUpdate" },
          volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { resources: { requests: { storage: "64Mi" } } } }],
          template: { spec: { containers: [{ name: "db", image: "busybox:1.37" }] } },
        },
        status: { availableReplicas: 1, currentReplicas: 1, currentRevision: "db-7b65c666b7", readyReplicas: 1, replicas: 1, updateRevision: "db-7b65c666b7", updatedReplicas: 1 },
      },
      now,
    )!;
    expect(sts).toMatchObject({ serviceName: "db", currentRevision: "db-7b65c666b7", updateRevision: "db-7b65c666b7", strategy: "RollingUpdate · partition 0" });
    expect(sts.claims).toEqual([{ name: "data", size: "64Mi", storageClass: "" }]);
    expect(sts.replicas).toMatchObject({ desired: 1, ready: 1, updated: 1 });
    const ds = parseWorkloadDetail(
      {
        kind: "DaemonSet",
        metadata: { name: "node-agent", namespace: "vterm-stand", uid: "uid-ds" },
        spec: { selector: { matchLabels: { app: "node-agent" } }, updateStrategy: { rollingUpdate: { maxSurge: 0, maxUnavailable: 1 }, type: "RollingUpdate" } },
        status: { currentNumberScheduled: 1, desiredNumberScheduled: 1, numberAvailable: 1, numberMisscheduled: 0, numberReady: 1, updatedNumberScheduled: 1 },
      },
      now,
    )!;
    expect(ds.replicas).toEqual({ desired: 1, current: 1, updated: 1, ready: 1, available: 1, unavailable: 0 });
    expect(ds.misscheduled).toBe(0);
    expect(ds.strategy).toBe("RollingUpdate · maxSurge 0 · maxUnavailable 1");
    const cron = parseWorkloadDetail(
      {
        kind: "CronJob",
        metadata: { name: "report", namespace: "vterm-stand", uid: "uid-report" },
        spec: { schedule: "*/1 * * * *", suspend: false, concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 2, jobTemplate: { spec: { template: { spec: { containers: [{ name: "report", image: "busybox:1.37" }] } } } } },
        status: { lastScheduleTime: "2026-11-07T14:03:00Z", active: [{ name: "report-29901004" }] },
      },
      now,
    )!;
    expect(cron).toMatchObject({ schedule: "*/1 * * * *", suspended: false, concurrency: "Forbid", lastSchedule: Date.parse("2026-11-07T14:03:00Z"), lastSuccess: null, activeJobs: 1, keep: { succeeded: 1, failed: 2 } });
    expect(cron.images).toEqual(["busybox:1.37"]);
    expect(cron.selector).toBeNull();
    expect(parseWorkloadDetail(null, now)).toBeNull();
  });

  it("takes a workload's pods by their owner, not by a selector that may match more", () => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          { metadata: { name: "rollout-7f9c-a", namespace: "vterm-stand", ownerReferences: [{ kind: "ReplicaSet", name: "rollout-7f9c", controller: true }] }, spec: { containers: [{ name: "app" }] }, status: {} },
          { metadata: { name: "rollout-canary", namespace: "vterm-stand" }, spec: { containers: [{ name: "app" }] }, status: {} },
          { metadata: { name: "db-0", namespace: "vterm-stand", ownerReferences: [{ kind: "StatefulSet", name: "db", controller: true }] }, spec: { containers: [{ name: "db" }] }, status: {} },
        ],
      }),
    );
    expect(workloadPods(pods, { kind: "Deployment", name: "rollout", namespace: "vterm-stand" }).map((p) => p.name)).toEqual(["rollout-7f9c-a"]);
    expect(workloadPods(pods, { kind: "StatefulSet", name: "db", namespace: "vterm-stand" }).map((p) => p.name)).toEqual(["db-0"]);
  });
});

// Stage 5 (ADR 0054): a node and the volume claims. The objects are the stand's as
// Docker Desktop's k8s 1.31.1 answered, trimmed to what the model reads.
describe("a node's details (stage 5)", () => {
  const now = Date.parse("2026-11-07T14:30:00Z");
  const NODE = {
    metadata: { name: "desktop-control-plane", creationTimestamp: "2026-11-07T12:49:00Z", labels: { "node-role.kubernetes.io/control-plane": "", "kubernetes.io/arch": "arm64" } },
    spec: { taints: [{ key: "node.kubernetes.io/disk-pressure", effect: "NoSchedule" }, { key: "dedicated", value: "db", effect: "NoExecute" }] },
    status: {
      capacity: { cpu: "8", memory: "12235532Ki", pods: "110", "ephemeral-storage": "61202244Ki" },
      allocatable: { cpu: "7800m", memory: "11Gi", pods: "110", "ephemeral-storage": "56Gi" },
      conditions: [
        { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory", message: "kubelet has sufficient memory available" },
        { type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure", message: "kubelet has disk pressure", lastTransitionTime: "2026-11-07T14:20:00Z" },
        { type: "PIDPressure", status: "False", reason: "KubeletHasSufficientPID" },
        { type: "Ready", status: "True", reason: "KubeletReady", message: "kubelet is posting ready status" },
      ],
      addresses: [{ type: "InternalIP", address: "172.23.0.2" }, { type: "Hostname", address: "desktop-control-plane" }],
      nodeInfo: { kubeletVersion: "v1.31.1", containerRuntimeVersion: "containerd://1.7.18", osImage: "Debian GNU/Linux 12 (bookworm)", kernelVersion: "6.12.67-linuxkit", architecture: "arm64" },
    },
  };

  it("reads what a node has, what it can give, what it says and how it is tainted", () => {
    const d = parseNodeDetail(NODE, now)!;
    expect(d.name).toBe("desktop-control-plane");
    expect(d.capacity).toEqual({ cpu: 8000, memory: 11948.76171875, pods: 110, storage: 59767.81640625 });
    expect(d.allocatable).toEqual({ cpu: 7800, memory: 11264, pods: 110, storage: 57344 });
    // A pressure is healthy when it is False; Ready — when it is True.
    expect(d.conditions.map((c) => [c.type, c.healthy])).toEqual([
      ["Ready", true],
      ["MemoryPressure", true],
      ["DiskPressure", false],
      ["PIDPressure", true],
    ]);
    expect(d.conditions[2].message).toBe("kubelet has disk pressure");
    expect(d.taints).toEqual(["node.kubernetes.io/disk-pressure:NoSchedule", "dedicated=db:NoExecute"]);
    expect(d.info).toEqual({ kubelet: "v1.31.1", runtime: "containerd://1.7.18", os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.12.67-linuxkit", arch: "arm64" });
    expect(d.addresses).toEqual([
      { type: "InternalIP", address: "172.23.0.2" },
      { type: "Hostname", address: "desktop-control-plane" },
    ]);
    expect(parseNodeDetail(null, now)).toBeNull();
  });

  it("names the pressures in the list's row too", () => {
    const [n] = parseNodes(JSON.stringify({ items: [NODE] }), now);
    expect(n.pressures).toEqual(["DiskPressure"]);
  });

  it("asks the node's pods across namespaces, and its usage now", () => {
    expect(nodePodsArgs("desktop-control-plane")).toEqual(["get", "pods", "-A", "--field-selector=spec.nodeName=desktop-control-plane", "-o", "json"]);
    expect(topNodeArgs("desktop-control-plane")).toEqual(["top", "node", "desktop-control-plane", "--no-headers"]);
    expect(parseTopNode("desktop-control-plane   252m   3%    957Mi   8%    \n", "desktop-control-plane")).toEqual({ cpu: 252, cpuPct: 3, mem: 957, memPct: 8 });
    expect(parseTopNode("", "desktop-control-plane")).toBeNull();
  });

  it("counts a pod's request as the scheduler does: an init container may ask for more than the rest", () => {
    const pod = (init: Record<string, unknown>[], containers: Record<string, unknown>[]) => ({ spec: { initContainers: init, containers } });
    const req = (cpu?: string) => ({ resources: cpu ? { requests: { cpu } } : {} });
    expect(podRequest(pod([], [req("100m"), req("50m")]), "cpu")).toBe(150);
    // An init container runs alone: the pod asks for the larger of it and the rest.
    expect(podRequest(pod([req("500m")], [req("100m")]), "cpu")).toBe(500);
    // A native sidecar keeps running: it adds to the app, and to every init after it.
    expect(podRequest(pod([{ ...req("50m"), restartPolicy: "Always" }, req("400m")], [req("100m")]), "cpu")).toBe(450);
    expect(podRequest(pod([], [req(), req()]), "cpu")).toBe(0);
  });

  it("sums what the node's running pods ask for and are held to — finished pods hold nothing", () => {
    const pod = (phase: string, cpu: string, mem: string, limits?: { cpu?: string; memory?: string }) => ({
      metadata: { name: `p-${phase}-${cpu}`, namespace: "a" },
      spec: { containers: [{ name: "c", resources: { requests: { cpu, memory: mem }, ...(limits ? { limits } : {}) } }] },
      status: { phase },
    });
    const a = nodeAllocated(
      listItems(JSON.stringify({ items: [pod("Running", "100m", "64Mi", { cpu: "200m", memory: "128Mi" }), pod("Pending", "50m", "32Mi"), pod("Succeeded", "1", "1Gi")] })),
    );
    expect(a).toEqual({ pods: 2, requests: { cpu: 150, memory: 96 }, limits: { cpu: 200, memory: 128 }, unbounded: 1 });
  });
});

describe("volume claims (stage 5)", () => {
  const now = Date.parse("2026-11-07T14:30:00Z");
  const pvc = (name: string, phase: string, spec: Record<string, unknown>, status: Record<string, unknown> = {}) => ({
    metadata: { name, namespace: "vterm-stand", creationTimestamp: "2026-11-07T13:02:00Z" },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "64Mi" } }, ...spec },
    status: { phase, ...status },
  });
  const RAW = JSON.stringify({
    items: [
      pvc("data-db-0", "Bound", { storageClassName: "standard", volumeName: "pvc-62f55cec" }, { capacity: { storage: "64Mi" } }),
      pvc("orphan-claim", "Pending", { storageClassName: "vterm-none" }),
      pvc("spare", "Pending", { storageClassName: "standard" }),
    ],
  });

  it("asks for the claims and reads each: its state, size, class, access and volume", () => {
    expect(claimsArgs()).toEqual(["get", "persistentvolumeclaims", "-o", "json"]);
    expect(parseClaims(RAW, now).map((c) => [c.name, c.phase, c.capacity, c.requested, c.storageClass, c.access, c.volume])).toEqual([
      ["data-db-0", "Bound", "64Mi", "64Mi", "standard", "RWO", "pvc-62f55cec"],
      ["orphan-claim", "Pending", "", "64Mi", "vterm-none", "RWO", ""],
      ["spare", "Pending", "", "64Mi", "standard", "RWO", ""],
    ]);
  });

  it("says who mounts each claim, from the pods' own volumes", () => {
    const pods = listItems(
      JSON.stringify({
        items: [
          { metadata: { name: "db-0", namespace: "vterm-stand" }, spec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-db-0" } }, { name: "tmp", emptyDir: {} }] } },
          { metadata: { name: "other", namespace: "elsewhere" }, spec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: "spare" } }] } },
        ],
      }),
    );
    const users = claimUsers(pods);
    expect(users.get("vterm-stand/data-db-0")).toEqual(["db-0"]);
    // A claim is its namespace's: a pod elsewhere does not mount this one.
    expect(users.get("vterm-stand/spare")).toBeUndefined();
  });

  it("says why a claim waits, from the latest event about it", () => {
    const events = parseEvents(
      JSON.stringify({
        items: [
          { type: "Warning", reason: "ProvisioningFailed", involvedObject: { kind: "PersistentVolumeClaim", name: "orphan-claim" }, metadata: { namespace: "vterm-stand" }, message: 'storageclass.storage.k8s.io "vterm-none" not found', count: 321, lastTimestamp: "2026-11-07T14:29:00Z" },
          { type: "Normal", reason: "WaitForFirstConsumer", involvedObject: { kind: "PersistentVolumeClaim", name: "spare" }, metadata: { namespace: "vterm-stand" }, message: "waiting for first consumer to be created before binding", count: 322, lastTimestamp: "2026-11-07T14:29:30Z" },
          { type: "Normal", reason: "Scheduled", involvedObject: { kind: "Pod", name: "spare" }, metadata: { namespace: "vterm-stand" }, message: "not a claim", lastTimestamp: "2026-11-07T14:29:59Z" },
        ],
      }),
      now,
    );
    const why = claimReasons(events);
    expect(why.get("vterm-stand/orphan-claim")).toEqual({ type: "Warning", reason: "ProvisioningFailed", message: 'storageclass.storage.k8s.io "vterm-none" not found' });
    expect(why.get("vterm-stand/spare")?.reason).toBe("WaitForFirstConsumer");
    expect(why.size).toBe(2);
  });
});

// Stage 6 (ADR 0054): what application an object is part of — read from the
// recommended labels and Helm's own annotation, never guessed from a name.
describe("an object's application (stage 6)", () => {
  const helmLabels = {
    "app.kubernetes.io/managed-by": "Helm",
    "app.kubernetes.io/instance": "shop",
    "app.kubernetes.io/name": "shop",
    "app.kubernetes.io/component": "api",
    "app.kubernetes.io/version": "1.2.0",
    "helm.sh/chart": "shop-1.2.0",
  };

  it("reads «part of» first, then a Helm release, then the instance, then the name", () => {
    expect(appOf({ "app.kubernetes.io/part-of": "vterm-stand", "app.kubernetes.io/name": "web" })).toEqual({ name: "vterm-stand", source: "partOf", helm: false });
    expect(appOf(helmLabels, { "meta.helm.sh/release-name": "shop", "meta.helm.sh/release-namespace": "vterm-stand" })).toEqual({ name: "shop", source: "helm", helm: true });
    // Pods carry the chart's labels, not Helm's annotation: managed-by says it is a release.
    expect(appOf(helmLabels)).toEqual({ name: "shop", source: "helm", helm: true });
    expect(appOf({ "app.kubernetes.io/instance": "mysql-abc" })).toEqual({ name: "mysql-abc", source: "instance", helm: false });
    expect(appOf({ "app.kubernetes.io/name": "mysql" })).toEqual({ name: "mysql", source: "name", helm: false });
    // An object of a Helm release that is part of a bigger application is that application's.
    expect(appOf({ ...helmLabels, "app.kubernetes.io/part-of": "storefront" })).toEqual({ name: "storefront", source: "partOf", helm: true });
  });

  it("is nothing for an object that does not say — `app: web` is not an application's label", () => {
    expect(appOf({ app: "web", "pod-template-hash": "68b5" })).toBeNull();
    expect(appOf(undefined)).toBeNull();
    expect(appOf({ "app.kubernetes.io/part-of": "  " })).toBeNull();
  });

  it("says the whole of it for the details: release, chart, version, component, who manages it", () => {
    expect(appInfo(helmLabels, { "meta.helm.sh/release-name": "shop" })).toEqual({
      app: { name: "shop", source: "helm", helm: true },
      release: "shop",
      chart: "shop-1.2.0",
      version: "1.2.0",
      component: "api",
      managedBy: "Helm",
    });
    expect(appInfo({ app: "web" })).toBeNull();
  });

  it("puts it on the pods and workloads of a list, and groups them by it", () => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          { metadata: { name: "shop-api-1", namespace: "a", labels: helmLabels }, spec: { containers: [{ name: "c" }] }, status: {} },
          { metadata: { name: "web-1", namespace: "a", labels: { "app.kubernetes.io/part-of": "vterm-stand" } }, spec: { containers: [{ name: "c" }] }, status: {} },
          { metadata: { name: "loose", namespace: "a", labels: { app: "loose" } }, spec: { containers: [{ name: "c" }] }, status: {} },
        ],
      }),
    );
    expect(pods.map((p) => p.app?.name ?? null)).toEqual(["shop", "vterm-stand", null]);
    const view = applyView(pods, podSchema(() => ({ cpu: null, mem: null })), NO_FILTER, { sort: { key: "name", dir: "asc" }, group: "app" });
    expect(view.groups.map((g) => [g.label, g.items.map((p) => p.name)])).toEqual([
      ["shop", ["shop-api-1"]],
      ["vterm-stand", ["web-1"]],
      ["", ["loose"]],
    ]);
    const [w] = parseWorkloads(
      JSON.stringify({
        items: [
          {
            kind: "Deployment",
            metadata: { name: "shop-api", namespace: "a", labels: helmLabels, annotations: { "meta.helm.sh/release-name": "shop" } },
            spec: { replicas: 1 },
            status: {},
          },
        ],
      }),
    );
    expect(w.app).toEqual({ name: "shop", source: "helm", helm: true });
    expect((WORKLOAD_SCHEMA.groups ?? []).map((g) => g.id)).toContain("app");
    expect(parseWorkloadDetail({ kind: "Deployment", metadata: { name: "shop-api", namespace: "a", labels: helmLabels, annotations: { "meta.helm.sh/release-name": "shop" } }, spec: {}, status: {} })!.app?.release).toBe("shop");
  });
});
