import { describe, expect, it } from "vitest";
import {
  parseEndpointSlices,
  parseIngress,
  parseServices,
  type K8sEndpointSlice,
  type K8sIngress,
  type K8sService,
} from "./k8s";
import {
  ROUTE_MAX_ENDPOINTS,
  buildRoutes,
  declaresPort,
  portLabel,
  routeTone,
  shownEndpoints,
  type RouteEndpoint,
} from "./k8sroute";

// Fixtures are written as the objects `kubectl get … -o json` returns and run
// through the real parsers, so a route test also proves the parser feeds it.

const list = (...items: unknown[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items });

function svc(name: string, spec: Record<string, unknown> = {}, namespace = "shop") {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace },
    spec: {
      type: "ClusterIP",
      clusterIP: "10.0.0.12",
      selector: { app: name },
      ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }],
      ...spec,
    },
  };
}

function slice(
  service: string,
  endpoints: Record<string, unknown>[],
  over: Record<string, unknown> = {},
  namespace = "shop",
) {
  return {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: { name: `${service}-abcde`, namespace, labels: { "kubernetes.io/service-name": service } },
    addressType: "IPv4",
    ports: [{ name: "http", port: 8080, protocol: "TCP" }],
    endpoints,
    ...over,
  };
}

function ep(ip: string, pod: string, conditions: Record<string, unknown> = { ready: true }) {
  return {
    addresses: [ip],
    conditions,
    nodeName: "node-1",
    targetRef: { kind: "Pod", name: pod, namespace: "shop" },
  };
}

function ingress(name: string, spec: Record<string, unknown>, status: Record<string, unknown> = {}, namespace = "shop") {
  return { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name, namespace }, spec, status };
}

const rule = (host: string, path: string, service: string, port: number | string) => ({
  host,
  http: {
    paths: [
      {
        path,
        pathType: "Prefix",
        backend: { service: { name: service, port: typeof port === "number" ? { number: port } : { name: port } } },
      },
    ],
  },
});

const services = (...items: unknown[]): K8sService[] => parseServices(list(...items));
const ingresses = (...items: unknown[]): K8sIngress[] => parseIngress(list(...items));
const slices = (...items: unknown[]): K8sEndpointSlice[] => parseEndpointSlices(list(...items));

describe("buildRoutes — who receives traffic", () => {
  it("lists a service's endpoints from its slices with their readiness", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(slice("web", [ep("10.1.0.5", "web-abc"), ep("10.1.0.6", "web-xyz", { ready: false })])),
    );
    expect(routes).toHaveLength(1);
    const t = routes[0].targets;
    expect(t.kind).toBe("endpoints");
    if (t.kind !== "endpoints") return;
    expect(t.ready).toBe(1);
    // Trouble first: the endpoint the cluster skips leads the list.
    expect(t.endpoints.map((e) => `${e.targetName} ${e.state}`)).toEqual(["web-xyz notReady", "web-abc ready"]);
    expect(routes[0].tone).toBe("warn");
  });

  it("does not make an endpoint out of a pod the slices do not list", () => {
    // The service has a selector, and a pod may well match it — but the cluster
    // routes to nobody, and that is what the route must say.
    const { routes } = buildRoutes(services(svc("web")), [], slices(slice("web", [])));
    expect(routes[0].targets).toEqual({ kind: "endpoints", endpoints: [], ready: 0 });
    expect(routes[0].tone).toBe("bad");
    expect(routes[0].service.selector).toBe("app=web");
  });

  it("is broken when a service has endpoints and none is ready", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(slice("web", [ep("10.1.0.5", "web-abc", { ready: false }), ep("10.1.0.6", "web-xyz", { ready: false })])),
    );
    expect(routes[0].tone).toBe("bad");
  });

  it("is healthy only when every endpoint is ready", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(slice("web", [ep("10.1.0.5", "web-abc"), ep("10.1.0.6", "web-xyz")])),
    );
    expect(routes[0].tone).toBe("ok");
  });

  it("reads absent conditions the way the API defines them", () => {
    // discovery.k8s.io/v1: a nil `ready` is ready, a nil `terminating` is not.
    const { routes } = buildRoutes(services(svc("web")), [], slices(slice("web", [ep("10.1.0.5", "web-abc", {})])));
    const t = routes[0].targets;
    expect(t.kind === "endpoints" && t.endpoints[0].state).toBe("ready");
  });

  it("shows a terminating endpoint as terminating, whatever its ready flag", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(
        slice("web", [
          ep("10.1.0.5", "web-abc"),
          ep("10.1.0.6", "web-old", { ready: false, serving: true, terminating: true }),
        ]),
      ),
    );
    const t = routes[0].targets;
    expect(t.kind === "endpoints" && t.endpoints.map((e) => e.state)).toEqual(["terminating", "ready"]);
    expect(routes[0].tone).toBe("warn");
  });

  it("counts a dual-stack pod once and keeps both its addresses", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(
        slice("web", [ep("10.1.0.5", "web-abc")]),
        slice("web", [ep("fd00::5", "web-abc")], {
          addressType: "IPv6",
          metadata: { name: "web-v6", namespace: "shop", labels: { "kubernetes.io/service-name": "web" } },
        }),
      ),
    );
    const t = routes[0].targets;
    expect(t.kind === "endpoints" && t.endpoints).toEqual([
      { addresses: ["10.1.0.5", "fd00::5"], state: "ready", targetKind: "Pod", targetName: "web-abc", node: "node-1" },
    ]);
  });

  it("takes the worse state when two slices disagree about one target", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(
        slice("web", [ep("10.1.0.5", "web-abc")]),
        slice("web", [ep("fd00::5", "web-abc", { ready: false })], {
          metadata: { name: "web-v6", namespace: "shop", labels: { "kubernetes.io/service-name": "web" } },
        }),
      ),
    );
    const t = routes[0].targets;
    expect(t.kind === "endpoints" && t.endpoints[0].state).toBe("notReady");
  });

  it("keeps endpoints without a target apart by address", () => {
    const bare = (ip: string) => ({ addresses: [ip], conditions: { ready: true } });
    const { routes } = buildRoutes(
      services(svc("legacy", { selector: undefined })),
      [],
      slices(slice("legacy", [bare("192.0.2.10"), bare("192.0.2.11")])),
    );
    const t = routes[0].targets;
    expect(t.kind === "endpoints" && t.endpoints.map((e) => e.addresses[0])).toEqual(["192.0.2.10", "192.0.2.11"]);
    expect(routes[0].service.selector).toBe("");
  });

  it("ignores slices of another namespace and slices that name no service", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(
        slice("web", [ep("10.9.9.9", "other-web")], {}, "staging"),
        { ...slice("web", [ep("10.8.8.8", "orphan")]), metadata: { name: "custom", namespace: "shop", labels: {} } },
      ),
    );
    expect(routes[0].targets).toEqual({ kind: "endpoints", endpoints: [], ready: 0 });
  });
});

describe("buildRoutes — what is not known is not guessed", () => {
  it("says endpoints are unknown when the slices could not be read", () => {
    // Not "no endpoints": a forbidden `get endpointslices` says nothing about them.
    const { routes } = buildRoutes(services(svc("web")), [], null);
    expect(routes[0].targets).toEqual({ kind: "unknown" });
    expect(routes[0].tone).toBe("idle");
  });

  it("says entries are unknown when ingresses could not be read", () => {
    // Not "no ingress points here".
    const { routes, dangling } = buildRoutes(services(svc("web")), null, slices(slice("web", [ep("10.1.0.5", "a")])));
    expect(routes[0].entries).toBeNull();
    expect(dangling).toEqual([]);
    expect(routes[0].tone).toBe("ok");
  });

  it("treats an ExternalName service as a DNS alias, not as a service without endpoints", () => {
    const { routes } = buildRoutes(
      services(
        svc("db", { type: "ExternalName", externalName: "db.example.com", clusterIP: undefined, selector: undefined, ports: [] }),
      ),
      [],
      slices(),
    );
    expect(routes[0].targets).toEqual({ kind: "externalName", name: "db.example.com" });
    expect(routes[0].tone).toBe("idle");
  });

  it("marks a headless service and still lists its endpoints", () => {
    const { routes } = buildRoutes(
      services(svc("pg", { clusterIP: "None" })),
      [],
      slices(slice("pg", [ep("10.1.0.7", "pg-0")])),
    );
    expect(routes[0].service.headless).toBe(true);
    expect(routes[0].targets.kind).toBe("endpoints");
    expect(routes[0].tone).toBe("ok");
  });
});

describe("buildRoutes — ingress rules", () => {
  const web = () => services(svc("web"));
  const ready = () => slices(slice("web", [ep("10.1.0.5", "web-abc")]));

  it("attaches a rule to the service it names, with what the ingress declares", () => {
    const { routes, dangling } = buildRoutes(
      web(),
      ingresses(
        ingress(
          "shop",
          { ingressClassName: "nginx", tls: [{ hosts: ["shop.example.com"] }], rules: [rule("shop.example.com", "/", "web", 80)] },
          { loadBalancer: { ingress: [{ ip: "203.0.113.7" }] } },
        ),
      ),
      ready(),
    );
    expect(dangling).toEqual([]);
    expect(routes[0].entries).toEqual([
      {
        key: "shop/shop#0",
        ingress: "shop",
        namespace: "shop",
        className: "nginx",
        host: "shop.example.com",
        path: "/",
        pathType: "Prefix",
        tls: true,
        address: "203.0.113.7",
        isDefault: false,
        backend: { service: "web", port: "80", resource: "" },
        portDeclared: true,
      },
    ]);
    expect(routes[0].tone).toBe("ok");
  });

  it("accepts a backend port given by name", () => {
    const { routes } = buildRoutes(web(), ingresses(ingress("shop", { rules: [rule("a.example.com", "/", "web", "http")] })), ready());
    expect(routes[0].entries?.[0].portDeclared).toBe(true);
  });

  it("flags a rule that names a port the service does not declare", () => {
    // The rule points at a real service and still leads nowhere.
    const { routes } = buildRoutes(web(), ingresses(ingress("shop", { rules: [rule("a.example.com", "/", "web", 8080)] })), ready());
    expect(routes[0].entries?.[0].portDeclared).toBe(false);
    expect(routes[0].tone).toBe("bad");
  });

  it("reports a rule whose service does not exist", () => {
    const { routes, dangling } = buildRoutes(web(), ingresses(ingress("shop", { rules: [rule("a.example.com", "/", "gone", 80)] })), ready());
    expect(routes[0].entries).toEqual([]);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toMatchObject({ reason: "serviceMissing", entry: { ingress: "shop", backend: { service: "gone" } } });
  });

  it("looks a backend up in the ingress's own namespace only", () => {
    // `web` exists in `shop`; the ingress lives in `staging`.
    const { dangling } = buildRoutes(
      web(),
      ingresses(ingress("edge", { rules: [rule("a.example.com", "/", "web", 80)] }, {}, "staging")),
      ready(),
    );
    expect(dangling.map((d) => d.reason)).toEqual(["serviceMissing"]);
  });

  it("reports a backend that is not a service without pretending to follow it", () => {
    const resourceRule = {
      host: "assets.example.com",
      http: {
        paths: [{ path: "/", pathType: "Prefix", backend: { resource: { apiGroup: "k8s.example.com", kind: "StorageBucket", name: "static" } } }],
      },
    };
    const { dangling } = buildRoutes(web(), ingresses(ingress("assets", { rules: [resourceRule] })), ready());
    expect(dangling[0]).toMatchObject({ reason: "resource", entry: { backend: { service: "", resource: "StorageBucket/static" } } });
  });

  it("carries the default backend as an entry of its own", () => {
    const { routes } = buildRoutes(
      web(),
      ingresses(ingress("shop", { defaultBackend: { service: { name: "web", port: { number: 80 } } } })),
      ready(),
    );
    expect(routes[0].entries).toHaveLength(1);
    expect(routes[0].entries?.[0]).toMatchObject({ isDefault: true, host: "", key: "shop/shop#default", portDeclared: true });
  });

  it("leaves an unpublished address empty instead of inventing one", () => {
    const { routes } = buildRoutes(web(), ingresses(ingress("shop", { rules: [rule("a.example.com", "/", "web", 80)] })), ready());
    expect(routes[0].entries?.[0].address).toBe("");
    // An ingress nobody has claimed is not visible in the data: the chain's
    // health does not change on a guess.
    expect(routes[0].tone).toBe("ok");
  });

  it("marks TLS only for hosts the ingress lists under tls", () => {
    const { routes } = buildRoutes(
      web(),
      ingresses(
        ingress("shop", {
          tls: [{ hosts: ["a.example.com"] }],
          rules: [rule("a.example.com", "/", "web", 80), rule("b.example.com", "/", "web", 80)],
        }),
      ),
      ready(),
    );
    expect(routes[0].entries?.map((e) => e.tls)).toEqual([true, false]);
  });

  it("lists dangling rules by namespace and ingress, whatever order kubectl answered in", () => {
    const { dangling } = buildRoutes(
      web(),
      ingresses(
        ingress("zeta", { rules: [rule("z.example.com", "/", "gone", 80)] }),
        ingress("alpha", { rules: [rule("a.example.com", "/", "gone", 80)] }),
        ingress("edge", { rules: [rule("e.example.com", "/", "gone", 80)] }, {}, "admin"),
      ),
      ready(),
    );
    expect(dangling.map((d) => `${d.entry.namespace}/${d.entry.ingress}`)).toEqual(["admin/edge", "shop/alpha", "shop/zeta"]);
  });
});

describe("buildRoutes — ports and order", () => {
  it("resolves a named targetPort to the number the slices carry", () => {
    const { routes } = buildRoutes(services(svc("web")), [], slices(slice("web", [ep("10.1.0.5", "web-abc")])));
    expect(routes[0].ports).toEqual([
      { name: "http", port: 80, targetPort: "http", nodePort: null, protocol: "TCP", endpointPort: 8080 },
    ]);
    expect(portLabel(routes[0].ports[0])).toBe("80 → 8080/TCP");
  });

  it("falls back to the declared targetPort when no slice carries the port", () => {
    const { routes } = buildRoutes(services(svc("web")), [], null);
    expect(routes[0].ports[0].endpointPort).toBeNull();
    expect(portLabel(routes[0].ports[0])).toBe("80 → http/TCP");
  });

  it("does not pick a number when slices disagree on it", () => {
    const { routes } = buildRoutes(
      services(svc("web")),
      [],
      slices(
        slice("web", [ep("10.1.0.5", "web-abc")]),
        slice("web", [ep("10.1.0.6", "web-new")], { ports: [{ name: "http", port: 9090, protocol: "TCP" }] }),
      ),
    );
    expect(routes[0].ports[0].endpointPort).toBeNull();
  });

  it("writes a port that maps to itself once", () => {
    const { routes } = buildRoutes(
      services(svc("dns", { ports: [{ port: 53, protocol: "UDP" }] })),
      [],
      slices(slice("dns", [ep("10.1.0.9", "dns-0")], { ports: [{ port: 53, protocol: "UDP" }] })),
    );
    expect(portLabel(routes[0].ports[0])).toBe("53/UDP");
  });

  it("sorts routes by namespace and name, whatever order kubectl answered in", () => {
    const { routes } = buildRoutes(
      services(svc("web", {}, "shop"), svc("api", {}, "shop"), svc("zeta", {}, "admin")),
      [],
      slices(),
    );
    expect(routes.map((r) => r.key)).toEqual(["admin/zeta", "shop/api", "shop/web"]);
  });

  it("keeps same-named services of two namespaces apart", () => {
    const { routes } = buildRoutes(
      services(svc("web", {}, "shop"), svc("web", {}, "staging")),
      [],
      slices(slice("web", [ep("10.1.0.5", "web-abc")], {}, "staging")),
    );
    const byKey = Object.fromEntries(routes.map((r) => [r.key, r.targets]));
    expect(byKey["shop/web"]).toMatchObject({ kind: "endpoints", ready: 0 });
    expect(byKey["staging/web"]).toMatchObject({ kind: "endpoints", ready: 1 });
  });
});

describe("declaresPort / routeTone", () => {
  const [service] = services(svc("web", { ports: [{ name: "http", port: 80 }, { port: 9000 }] }));

  it("matches a declared port by number or by name", () => {
    expect(declaresPort(service, "80")).toBe(true);
    expect(declaresPort(service, "http")).toBe(true);
    expect(declaresPort(service, "9000")).toBe(true);
    expect(declaresPort(service, "8080")).toBe(false);
    expect(declaresPort(service, "https")).toBe(false);
  });

  it("does not match a rule without a port against an unnamed service port", () => {
    expect(declaresPort(service, "")).toBe(false);
  });

  it("keeps unmeasured targets out of the healthy tone", () => {
    expect(routeTone({ kind: "unknown" }, [])).toBe("idle");
    expect(routeTone({ kind: "externalName", name: "db.example.com" }, null)).toBe("idle");
  });
});

describe("shownEndpoints", () => {
  const many = (n: number, state: RouteEndpoint["state"]): RouteEndpoint[] =>
    Array.from({ length: n }, (_, i) => ({
      addresses: [`10.1.0.${i}`],
      state,
      targetKind: "Pod",
      targetName: `web-${i}`,
      node: "",
    }));

  it("shows everything while it fits", () => {
    expect(shownEndpoints(many(3, "ready"))).toMatchObject({ hidden: 0 });
  });

  it("cuts a long list and counts what it left out", () => {
    const { shown, hidden } = shownEndpoints(many(ROUTE_MAX_ENDPOINTS + 5, "ready"));
    expect(shown).toHaveLength(ROUTE_MAX_ENDPOINTS);
    expect(hidden).toBe(5);
  });

  it("never hides a not-ready endpoint behind ready ones", () => {
    // 200 replicas, one of them failing: it must be on screen.
    const pods = Array.from({ length: 200 }, (_, i) => ep(`10.1.${Math.floor(i / 250)}.${i % 250}`, `web-${String(i).padStart(3, "0")}`));
    pods[150] = ep("10.1.9.9", "web-150", { ready: false });
    const { routes } = buildRoutes(services(svc("web")), [], slices(slice("web", pods)));
    const t = routes[0].targets;
    if (t.kind !== "endpoints") throw new Error("expected endpoints");
    const { shown, hidden } = shownEndpoints(t.endpoints);
    expect(shown[0]).toMatchObject({ targetName: "web-150", state: "notReady" });
    expect(hidden).toBe(200 - ROUTE_MAX_ENDPOINTS);
  });
});
