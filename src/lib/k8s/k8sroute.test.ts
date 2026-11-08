import { describe, expect, it } from "vitest";
import {
  parseEndpointSlices,
  parseHttpRoutes,
  parseIngress,
  parseIngressClasses,
  parseNetworkPolicies,
  parseServices,
  resourceMissing,
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
        source: "ingress",
        ingress: "shop",
        namespace: "shop",
        className: "nginx",
        // IngressClasses not asked for: nothing said about the class.
        classNote: null,
        controller: "",
        accepted: null,
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

describe("v1.35: HTTPRoute, IngressClass and NetworkPolicy", () => {
  const ready = () => slices(slice("web", [ep("10.1.0.5", "web-abc")]));
  const web = () => services(svc("web"));

  function httpRoute(name: string, spec: Record<string, unknown>, status: Record<string, unknown> = {}, namespace = "shop") {
    return { apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute", metadata: { name, namespace }, spec, status };
  }
  const accepted = (value: "True" | "False") => ({
    parents: [{ parentRef: { name: "public" }, conditions: [{ type: "Accepted", status: value }] }],
  });

  it("an HTTPRoute is an entry into the service its rule names", () => {
    const routes = parseHttpRoutes(
      list(
        httpRoute(
          "shop-route",
          {
            parentRefs: [{ name: "public" }],
            hostnames: ["shop.example.com"],
            rules: [{ matches: [{ path: { type: "PathPrefix", value: "/api" } }], backendRefs: [{ name: "web", port: 80 }] }],
          },
          accepted("True"),
        ),
      ),
    );
    const { routes: rows, dangling } = buildRoutes(web(), [], ready(), { httpRoutes: routes });
    expect(dangling).toEqual([]);
    expect(rows[0].entries).toEqual([
      expect.objectContaining({
        source: "httproute",
        ingress: "shop-route",
        className: "public",
        host: "shop.example.com",
        path: "/api",
        pathType: "PathPrefix",
        accepted: true,
        tls: false,
        backend: { service: "web", port: "80", resource: "" },
        portDeclared: true,
      }),
    ]);
    expect(rows[0].tone).toBe("ok");
  });

  it("a route a gateway refused leads nowhere; one with no match is every path", () => {
    const routes = parseHttpRoutes(
      list(httpRoute("r", { parentRefs: [{ name: "public" }], rules: [{ backendRefs: [{ name: "web", port: 80 }] }] }, accepted("False"))),
    );
    expect(routes[0].rules).toEqual([{ path: "/", pathType: "PathPrefix", backends: [expect.objectContaining({ kind: "Service" })] }]);
    const { routes: rows } = buildRoutes(web(), [], ready(), { httpRoutes: routes });
    expect(rows[0].entries?.[0]).toMatchObject({ accepted: false, host: "" });
    expect(rows[0].tone).toBe("bad");
    // No status yet: nothing said, not "refused".
    expect(parseHttpRoutes(list(httpRoute("r", { rules: [] })))[0].accepted).toBeNull();
  });

  it("a backend of another kind or a missing service is dangling, looked for in the ref's namespace", () => {
    const routes = parseHttpRoutes(
      list(
        httpRoute("r", {
          rules: [{ backendRefs: [{ kind: "Bucket", name: "files" }, { name: "api", namespace: "backend", port: 8080 }] }],
        }),
      ),
    );
    const { dangling } = buildRoutes(web(), [], ready(), { httpRoutes: routes });
    expect(dangling.map((d) => [d.reason, d.entry.backend.resource || d.entry.backend.service, d.backendNamespace])).toEqual([
      ["resource", "Bucket/files", "shop"],
      ["serviceMissing", "api", "backend"],
    ]);
  });

  it("a cluster without the Gateway API says so in its own words", () => {
    expect(resourceMissing('error: the server doesn\'t have a resource type "httproutes"')).toBe(true);
    expect(resourceMissing("Error from server (Forbidden): httproutes is forbidden")).toBe(false);
  });

  it("an ingress's class is read from the IngressClasses", () => {
    const classes = parseIngressClasses(
      list(
        {
          metadata: { name: "nginx", annotations: { "ingressclass.kubernetes.io/is-default-class": "true" } },
          spec: { controller: "k8s.io/ingress-nginx" },
        },
        { metadata: { name: "traefik" }, spec: { controller: "traefik.io/ingress-controller" } },
      ),
    );
    const ing = (name: string, cls?: string) =>
      ingress(name, { ...(cls ? { ingressClassName: cls } : {}), rules: [rule(`${name}.example.com`, "/", "web", 80)] });
    const { routes } = buildRoutes(web(), ingresses(ing("a"), ing("b", "traefik"), ing("c", "haproxy")), ready(), { classes });
    expect(routes[0].entries?.map((e) => [e.ingress, e.className, e.classNote, e.controller])).toEqual([
      ["a", "nginx", "default", "k8s.io/ingress-nginx"],
      ["b", "traefik", null, "traefik.io/ingress-controller"],
      ["c", "haproxy", "missing", ""],
    ]);
    // No default class: a class nobody named stays unnamed.
    const none = buildRoutes(web(), ingresses(ing("a")), ready(), { classes: classes.filter((c) => !c.isDefault) });
    expect(none.routes[0].entries?.[0]).toMatchObject({ className: "", classNote: "unset" });
    // Classes not read: nothing is said about any class.
    const unread = buildRoutes(web(), ingresses(ing("c", "haproxy")), ready(), { classes: null });
    expect(unread.routes[0].entries?.[0].classNote).toBeNull();
  });

  it("a service carries the policies of its namespace that restrict what comes in, as their own text", () => {
    const policies = parseNetworkPolicies(
      list(
        { metadata: { name: "deny-all", namespace: "shop" }, spec: { podSelector: {}, policyTypes: ["Ingress"] } },
        {
          metadata: { name: "allow-web", namespace: "shop" },
          spec: {
            podSelector: { matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["front"] }] },
            ingress: [{ from: [{ podSelector: {} }], ports: [{ port: 80 }] }, { from: [{ namespaceSelector: {} }] }],
          },
        },
        { metadata: { name: "open", namespace: "shop" }, spec: { podSelector: {}, ingress: [{}] } },
        { metadata: { name: "egress-only", namespace: "shop" }, spec: { podSelector: {}, policyTypes: ["Egress"] } },
        { metadata: { name: "elsewhere", namespace: "other" }, spec: { podSelector: {} } },
      ),
    );
    const { routes } = buildRoutes(web(), [], ready(), { policies });
    expect(routes[0].policies).toEqual([
      { name: "allow-web", appliesTo: "app=web, tier In (front)", ingress: "rules", ruleCount: 2 },
      { name: "deny-all", appliesTo: "", ingress: "denyAll", ruleCount: 0 },
      { name: "open", appliesTo: "", ingress: "allowAll", ruleCount: 1 },
    ]);
    // Not read: no word about policies, not "none".
    expect(buildRoutes(web(), [], ready()).routes[0].policies).toBeNull();
    expect(buildRoutes(web(), [], ready(), { policies: [] }).routes[0].policies).toEqual([]);
  });
});
