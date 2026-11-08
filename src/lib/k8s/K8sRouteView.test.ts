import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import K8sRouteView from "./K8sRouteView.svelte";
import {
  parseEndpointSlices,
  parseHttpRoutes,
  parseIngress,
  parseIngressClasses,
  parseNetworkPolicies,
  parseServices,
} from "./k8s";
import { ROUTE_MAX_ENDPOINTS, buildRoutes, type RouteTable } from "./k8sroute";

const list = (...items: unknown[]) => JSON.stringify({ items });

const svc = (name: string, spec: Record<string, unknown> = {}) => ({
  metadata: { name, namespace: "shop" },
  spec: {
    type: "ClusterIP",
    clusterIP: "10.0.0.12",
    selector: { app: name },
    ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }],
    ...spec,
  },
});

const ep = (ip: string, pod: string, conditions: Record<string, unknown> = { ready: true }) => ({
  addresses: [ip],
  conditions,
  nodeName: "node-1",
  targetRef: { kind: "Pod", name: pod },
});

const slice = (service: string, endpoints: unknown[]) => ({
  metadata: { name: `${service}-abcde`, namespace: "shop", labels: { "kubernetes.io/service-name": service } },
  addressType: "IPv4",
  ports: [{ name: "http", port: 8080, protocol: "TCP" }],
  endpoints,
});

const ingress = (name: string, service: string, port: number, status: Record<string, unknown> = {}) => ({
  metadata: { name, namespace: "shop" },
  spec: {
    ingressClassName: "nginx",
    rules: [
      {
        host: "shop.example.com",
        http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: service, port: { number: port } } } }] },
      },
    ],
  },
  status,
});

function table(services: unknown[], ingresses: unknown[] | null, slices: unknown[] | null): RouteTable {
  return buildRoutes(
    parseServices(list(...services)),
    ingresses === null ? null : parseIngress(list(...ingresses)),
    slices === null ? null : parseEndpointSlices(list(...slices)),
  );
}

function props(t: RouteTable, over: Record<string, unknown> = {}) {
  return {
    table: t,
    onServiceMenu: vi.fn(),
    onIngressMenu: vi.fn(),
    onPortForward: vi.fn(),
    ...over,
  };
}

describe("K8sRouteView — the chain", () => {
  it("draws ingress rule, service and endpoints on one row", () => {
    render(K8sRouteView, {
      props: props(
        table(
          [svc("web")],
          [ingress("shop", "web", 80, { loadBalancer: { ingress: [{ ip: "203.0.113.7" }] } })],
          [slice("web", [ep("10.1.0.5", "web-abc"), ep("10.1.0.6", "web-xyz", { ready: false })])],
        ),
      ),
    });
    const row = screen.getByTestId("k8s-route-row");
    expect(within(row).getByText("shop.example.com/")).toBeInTheDocument();
    expect(within(row).getByText("203.0.113.7")).toBeInTheDocument();
    expect(within(row).getByText("web")).toBeInTheDocument();
    // The service's port, resolved to the number the slices carry.
    expect(within(row).getByText("10.0.0.12 · 80 → 8080/TCP")).toBeInTheDocument();
    expect(within(row).getByText("1 of 2 ready")).toBeInTheDocument();
    // Trouble first, and only the endpoint that is not ready is labelled.
    const endpoints = within(row).getAllByTestId("k8s-route-endpoint");
    expect(endpoints.map((e) => e.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "10.1.0.6 web-xyz not ready",
      "10.1.0.5 web-abc",
    ]);
    expect(within(row).getByTestId("k8s-route-tone")).toHaveAttribute("data-tone", "warn");
  });

  it("says a service has no endpoints, and shows the selector beside it", () => {
    render(K8sRouteView, { props: props(table([svc("web")], [], [slice("web", [])])) });
    const targets = screen.getByTestId("k8s-route-targets");
    expect(within(targets).getByText("No endpoints — traffic has nowhere to go")).toBeInTheDocument();
    expect(within(targets).getByText("selector: app=web")).toBeInTheDocument();
    expect(screen.getByTestId("k8s-route-tone")).toHaveAttribute("data-tone", "bad");
  });

  it("says a selector-less service without endpoints is managed by hand", () => {
    render(K8sRouteView, { props: props(table([svc("legacy", { selector: undefined })], [], [])) });
    expect(screen.getByText("no selector — endpoints are managed by hand")).toBeInTheDocument();
  });

  it("cuts a long endpoint list and says how many it left out", () => {
    const many = Array.from({ length: ROUTE_MAX_ENDPOINTS + 4 }, (_, i) => ep(`10.1.0.${i}`, `web-${i}`));
    render(K8sRouteView, { props: props(table([svc("web")], [], [slice("web", many)])) });
    expect(screen.getAllByTestId("k8s-route-endpoint")).toHaveLength(ROUTE_MAX_ENDPOINTS);
    expect(screen.getByText("and 4 more")).toBeInTheDocument();
  });

  it("marks a headless service and an ExternalName alias for what they are", () => {
    render(K8sRouteView, {
      props: props(
        table(
          [
            svc("pg", { clusterIP: "None" }),
            svc("db", { type: "ExternalName", externalName: "db.example.com", clusterIP: undefined, selector: undefined, ports: [] }),
          ],
          [],
          [slice("pg", [ep("10.1.0.7", "pg-0")])],
        ),
      ),
    });
    expect(screen.getByText("headless")).toBeInTheDocument();
    // An alias has no endpoints by design: it is not reported as a broken service.
    expect(screen.getByText("DNS alias for db.example.com — no endpoints by design")).toBeInTheDocument();
    expect(screen.queryByText("No endpoints — traffic has nowhere to go")).toBeNull();
  });
});

describe("K8sRouteView — what was not read is not shown as absent", () => {
  it("says endpoints could not be read instead of 'no endpoints'", () => {
    render(K8sRouteView, {
      props: props(table([svc("web")], [], null), { slicesError: "endpointslices.discovery.k8s.io is forbidden" }),
    });
    expect(screen.getByText("Endpoints could not be read")).toBeInTheDocument();
    expect(screen.queryByText("No endpoints — traffic has nowhere to go")).toBeNull();
    expect(screen.getByTestId("k8s-route-tone")).toHaveAttribute("data-tone", "idle");
  });

  it("says neither while the endpoints are still on their way", () => {
    render(K8sRouteView, { props: props(table([svc("web")], [], null)) });
    expect(screen.queryByText("Endpoints could not be read")).toBeNull();
    expect(screen.queryByText("No endpoints — traffic has nowhere to go")).toBeNull();
  });

  it("says ingress could not be read instead of 'no ingress points here'", () => {
    render(K8sRouteView, {
      props: props(table([svc("web")], null, [slice("web", [ep("10.1.0.5", "web-abc")])]), {
        ingressError: "ingresses.networking.k8s.io is forbidden",
      }),
    });
    expect(screen.getByTestId("k8s-route-ingress-error")).toBeInTheDocument();
    expect(screen.getByText("ingress not read")).toBeInTheDocument();
    expect(screen.queryByText("no ingress points here")).toBeNull();
  });

  it("says no ingress points at a service when the ingresses were read", () => {
    render(K8sRouteView, { props: props(table([svc("web")], [], [slice("web", [ep("10.1.0.5", "web-abc")])])) });
    expect(screen.getByText("no ingress points here")).toBeInTheDocument();
    expect(screen.queryByTestId("k8s-route-ingress-error")).toBeNull();
  });

  it("does not turn an unpublished ingress address into a verdict", () => {
    render(K8sRouteView, {
      props: props(table([svc("web")], [ingress("shop", "web", 80)], [slice("web", [ep("10.1.0.5", "web-abc")])])),
    });
    expect(screen.getByText("no address published")).toBeInTheDocument();
    // Empty status is not evidence of a dead ingress: the chain stays healthy.
    expect(screen.getByTestId("k8s-route-tone")).toHaveAttribute("data-tone", "ok");
    expect(screen.queryByTestId("k8s-route-problem")).toBeNull();
  });
});

describe("K8sRouteView — rules that lead nowhere", () => {
  it("flags a rule naming a port the service does not declare", () => {
    render(K8sRouteView, {
      props: props(table([svc("web")], [ingress("shop", "web", 8080)], [slice("web", [ep("10.1.0.5", "web-abc")])])),
    });
    expect(screen.getByTestId("k8s-route-problem")).toHaveTextContent("port 8080 is not declared by the service");
    expect(screen.getByTestId("k8s-route-tone")).toHaveAttribute("data-tone", "bad");
  });

  it("lists a rule whose service does not exist under its own heading", () => {
    render(K8sRouteView, { props: props(table([svc("web")], [ingress("shop", "gone", 80)], [])) });
    const dangling = screen.getByTestId("k8s-route-dangling");
    expect(within(dangling).getByText("shop.example.com/")).toBeInTheDocument();
    expect(within(dangling).getByTestId("k8s-route-problem")).toHaveTextContent("service gone not found in shop");
    expect(screen.getByText("Rules that lead nowhere")).toBeInTheDocument();
  });

  it("says a non-service backend is not followed", () => {
    const resource = {
      metadata: { name: "assets", namespace: "shop" },
      spec: {
        rules: [
          {
            host: "assets.example.com",
            http: { paths: [{ path: "/", backend: { resource: { kind: "StorageBucket", name: "static" } } }] },
          },
        ],
      },
    };
    render(K8sRouteView, { props: props(table([svc("web")], [resource], [])) });
    expect(screen.getByText("backend is StorageBucket/static, not a service")).toBeInTheDocument();
  });
});

describe("K8sRouteView — actions", () => {
  it("opens the service menu and the ingress menu from their own cells", async () => {
    const p = props(
      table([svc("web")], [ingress("shop", "web", 80)], [slice("web", [ep("10.1.0.5", "web-abc")])]),
    );
    render(K8sRouteView, { props: p });
    await fireEvent.contextMenu(screen.getByRole("group", { name: "web" }));
    expect(p.onServiceMenu).toHaveBeenCalledTimes(1);
    expect(p.onServiceMenu.mock.calls[0][1]).toMatchObject({ name: "web", namespace: "shop" });
    await fireEvent.contextMenu(screen.getByTestId("k8s-route-entry"));
    expect(p.onIngressMenu).toHaveBeenCalledWith(expect.anything(), "shop", "shop", "ingress");
  });

  it("port-forwards to the service's first port", async () => {
    const p = props(table([svc("web")], [], [slice("web", [ep("10.1.0.5", "web-abc")])]));
    render(K8sRouteView, { props: p });
    await fireEvent.click(screen.getByRole("button", { name: "Port-forward" }));
    expect(p.onPortForward).toHaveBeenCalledWith("svc/web", "shop", 80);
  });
});

describe("K8sRouteView — HTTPRoute, IngressClass, NetworkPolicy (v1.35)", () => {
  const base = () => ({
    services: parseServices(list(svc("web"))),
    slices: parseEndpointSlices(list(slice("web", [ep("10.1.0.5", "web-abc")]))),
  });

  it("an HTTPRoute is an entry with its gateway, and a refused one says so", async () => {
    const { services, slices } = base();
    const httpRoutes = parseHttpRoutes(
      list({
        metadata: { name: "shop-route", namespace: "shop" },
        spec: {
          parentRefs: [{ name: "public" }],
          hostnames: ["api.example.com"],
          rules: [{ matches: [{ path: { type: "PathPrefix", value: "/v1" } }], backendRefs: [{ name: "web", port: 80 }] }],
        },
        status: { parents: [{ conditions: [{ type: "Accepted", status: "False" }] }] },
      }),
    );
    const p = props(buildRoutes(services, [], slices, { httpRoutes }));
    render(K8sRouteView, { props: p });
    const entry = screen.getByTestId("k8s-route-entry");
    expect(entry).toHaveTextContent("api.example.com/v1");
    expect(within(entry).getByTestId("k8s-route-source")).toHaveTextContent("HTTPRoute");
    expect(entry).toHaveTextContent("shop-route · public");
    // The address belongs to the gateway: the route says nothing of it.
    expect(entry).not.toHaveTextContent("no address");
    expect(within(entry).getByTestId("k8s-route-problem")).toHaveTextContent("did not accept");
    expect(screen.getByTestId("k8s-route-tone")).toHaveAttribute("data-tone", "bad");
    await fireEvent.contextMenu(entry);
    expect(p.onIngressMenu).toHaveBeenCalledWith(expect.anything(), "shop-route", "shop", "httproutes.gateway.networking.k8s.io");
  });

  it("an ingress's class: the default one standing in, one the cluster has not", () => {
    const { services, slices } = base();
    const classes = parseIngressClasses(
      list({ metadata: { name: "traefik", annotations: { "ingressclass.kubernetes.io/is-default-class": "true" } }, spec: {} }),
    );
    const noClass = { ...ingress("a", "web", 80), spec: { ...ingress("a", "web", 80).spec, ingressClassName: undefined } };
    render(K8sRouteView, {
      props: props(buildRoutes(services, parseIngress(list(noClass, ingress("b", "web", 80))), slices, { classes })),
    });
    const [a, b] = screen.getAllByTestId("k8s-route-entry");
    expect(a).toHaveTextContent("a · traefik (default)");
    expect(within(a).queryByTestId("k8s-route-problem")).toBeNull();
    expect(within(b).getByTestId("k8s-route-problem")).toHaveTextContent("There is no IngressClass “nginx” in the cluster");
  });

  it("a service shows the policies of its namespace, with whom each is for in its own words", () => {
    const { services, slices } = base();
    const policies = parseNetworkPolicies(
      list(
        { metadata: { name: "deny-all", namespace: "shop" }, spec: { podSelector: {}, policyTypes: ["Ingress"] } },
        { metadata: { name: "allow-web", namespace: "shop" }, spec: { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{}] }] } },
      ),
    );
    render(K8sRouteView, { props: props(buildRoutes(services, [], slices, { policies })) });
    expect(screen.getAllByTestId("k8s-route-policy").map((el) => el.textContent?.trim())).toEqual([
      "NetworkPolicy allow-web: in only by its rules (1) · for pods app=web",
      "NetworkPolicy deny-all: nothing comes in · for every pod of the namespace",
    ]);
  });

  it("says once when HTTPRoutes could not be read", () => {
    const { services, slices } = base();
    render(K8sRouteView, { props: props(buildRoutes(services, [], slices), { routesError: "forbidden" }) });
    expect(screen.getByTestId("k8s-route-httproute-error")).toHaveTextContent("HTTPRoutes could not be read");
  });
});
