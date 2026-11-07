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
  it("workloadsArgs fetches the four kinds", () => {
    expect(workloadsArgs()).toEqual([
      "get",
      "deployments,statefulsets,daemonsets,cronjobs",
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
