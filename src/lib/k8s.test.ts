import { describe, expect, it } from "vitest";
import {
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
  execShellCommand,
  k8sAge,
  resolveOwner,
  podDisplayStatus,
  parsePods,
  parseWorkloads,
  parseNamespaces,
  parseContexts,
  parseTopPods,
  metricsKey,
  groupByOwner,
  parseAvailability,
  podPhaseTone,
  isDestructive,
  needsConfirm,
  servicesArgs,
  ingressArgs,
  nodesArgs,
  eventsArgs,
  cordonArgs,
  uncordonArgs,
  drainArgs,
  portForwardCommand,
  parseServices,
  parseIngress,
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

describe("execShellCommand", () => {
  it("inlines context/namespace/container and prefers bash", () => {
    const cmd = execShellCommand(["kubectl"], "api-1", "web", "nginx", SCOPE);
    expect(cmd).toBe(
      "kubectl exec -it --context prod --namespace web api-1 -c nginx -- sh -c " +
        "'command -v bash >/dev/null 2>&1 && exec bash || exec sh'",
    );
  });
  it("omits the container flag when none", () => {
    const cmd = execShellCommand(["k3s", "kubectl"], "api-1", "web", null, {
      context: null,
      namespace: null,
      allNamespaces: false,
    });
    expect(cmd).toBe(
      "k3s kubectl exec -it --namespace web api-1 -- sh -c " +
        "'command -v bash >/dev/null 2>&1 && exec bash || exec sh'",
    );
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
  it("drops the hours suffix past a week", () => {
    expect(k8sAge("2026-07-01T08:00:00Z", now)).toBe("16d");
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
  it("ignores a Completed termination and falls back to the phase", () => {
    expect(
      podDisplayStatus({
        status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { reason: "Completed" } } }] },
      }),
    ).toBe("Succeeded");
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
            { ready: true, restartCount: 1 },
            { ready: false, restartCount: 2 },
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

describe("groupByOwner", () => {
  const pod = (name: string, ownerKind: string, ownerName: string): K8sPod => ({
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
  });
  it("buckets by owner and sorts standalone last", () => {
    const groups = groupByOwner([
      pod("api-1", "Deployment", "api"),
      pod("loose", "", ""),
      pod("api-2", "Deployment", "api"),
      pod("db-0", "StatefulSet", "db"),
    ]);
    expect(groups.map((g) => `${g.kind}/${g.name}`)).toEqual(["Deployment/api", "StatefulSet/db", "/"]);
    expect(groups[0].pods.map((p) => p.name)).toEqual(["api-1", "api-2"]);
    expect(groups[2].name).toBe("");
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
  it("portForwardCommand inlines scope and target", () => {
    const cmd = portForwardCommand(["kubectl"], "svc/api", "web", 8080, 80, SCOPE);
    expect(cmd).toBe("kubectl port-forward --context prod --namespace web svc/api 8080:80");
  });
  it("portForwardCommand carries a wrapper program and omits empty scope", () => {
    const cmd = portForwardCommand(["k3s", "kubectl"], "pod/api-1", "", 5432, 5432, {
      context: null,
      namespace: null,
      allNamespaces: false,
    });
    expect(cmd).toBe("k3s kubectl port-forward pod/api-1 5432:5432");
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
});
