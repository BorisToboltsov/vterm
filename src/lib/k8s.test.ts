import { describe, expect, it } from "vitest";
import {
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
