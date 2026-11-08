// Pure route model for the k8s panel's Network sub-tab (v1.5): the chain
// ingress rule → service → endpoints, one row per service. DOM/network free; it
// joins the three lists k8s.ts already parses and decides nothing the cluster's
// own objects do not say.
//
// Since v1.35 an HTTPRoute of the Gateway API is an entry like an ingress rule;
// an ingress's class is read from the IngressClasses (the default one, one that
// does not exist); and a service carries the NetworkPolicies of its namespace —
// which pods each is for is the policy's own text, never matched here: one that
// is for every pod of the namespace is so by its own word.
//
// The one rule this file exists to keep: who receives traffic is read from
// EndpointSlices, never worked out by matching a service's selector against pod
// labels. Matching labels would paint "traffic goes here" onto a pod that is not
// Ready — precisely while someone stares at a 502 — so the selector is carried
// as display text only and this module never sees a pod. The same goes for the
// ingress half: a rule is what a manifest declares; whether any controller serves
// it is not in the data, and nothing here claims it.

import type {
  K8sBackend,
  K8sEndpointSlice,
  K8sHttpRoute,
  K8sIngress,
  K8sIngressClass,
  K8sNetworkPolicy,
  K8sService,
  K8sServicePort,
} from "./k8s";

/** `ready` routes; `terminating` is on its way out; `notReady` is skipped by the cluster. */
export type EndpointState = "ready" | "notReady" | "terminating";

/** One backend the cluster knows for a service — a pod, usually. */
export interface RouteEndpoint {
  /** Its addresses (two for a dual-stack pod, which has a slice per family). */
  addresses: string[];
  state: EndpointState;
  /** Kind of the object behind it ("Pod"), "" when the slice names none. */
  targetKind: string;
  targetName: string;
  node: string;
}

/** Where a service's traffic ends up — or the honest reason that is not known. */
export type RouteTargets =
  | { kind: "endpoints"; endpoints: RouteEndpoint[]; ready: number }
  /** An ExternalName service is a DNS alias: it has no endpoints by design. */
  | { kind: "externalName"; name: string }
  /** EndpointSlices could not be read (or were not asked for yet). */
  | { kind: "unknown" };

/** A service port with the number its `targetPort` resolved to. */
export interface RoutePort extends K8sServicePort {
  /** From the service's slices; null when no slice carries the port (or they disagree). */
  endpointPort: number | null;
}

/**
 * What the IngressClasses say of an ingress's class: `default` — it names none
 * and the cluster's default stands in (`className` is that one); `missing` —
 * there is no IngressClass of that name; `unset` — it names none and there is
 * no default. null — nothing to say: an HTTPRoute, or classes not read.
 */
export type ClassNote = "default" | "missing" | "unset" | null;

/** One ingress rule (host + path), or one match of an HTTPRoute — a declared entry into a service. */
export interface RouteEntry {
  key: string;
  /** Which object declares it (v1.35). */
  source: "ingress" | "httproute";
  /** The ingress, or the HTTPRoute, by name. */
  ingress: string;
  namespace: string;
  /** The ingress class, or the gateways an HTTPRoute attaches to. */
  className: string;
  classNote: ClassNote;
  /** The controller the class names, "" when unknown. */
  controller: string;
  /** An HTTPRoute's `Accepted`: false — a gateway refused it; null — not said (or an ingress). */
  accepted: boolean | null;
  /** Rule host, "" when the rule applies to every host. */
  host: string;
  path: string;
  pathType: string;
  /** The host is listed under the ingress's `spec.tls`. */
  tls: boolean;
  /** Address in the ingress status, "" when no controller has written one. */
  address: string;
  /** The ingress's `defaultBackend` (unmatched requests), not a host/path rule. */
  isDefault: boolean;
  backend: K8sBackend;
}

/** A NetworkPolicy as a service's route shows it (v1.35). */
export interface RoutePolicy {
  name: string;
  /** The pods it is for, as its own text; "" — every pod of the namespace. */
  appliesTo: string;
  ingress: NonNullable<K8sNetworkPolicy["ingress"]>;
  ruleCount: number;
}

/** An entry attached to its service. */
export interface ServiceEntry extends RouteEntry {
  /** The service declares the port the rule names — otherwise the rule leads nowhere. */
  portDeclared: boolean;
}

export type RouteTone = "ok" | "warn" | "bad" | "idle";

export interface ServiceRoute {
  key: string;
  service: K8sService;
  ports: RoutePort[];
  /** Ingress rules naming this service; null when ingresses could not be read. */
  entries: ServiceEntry[] | null;
  targets: RouteTargets;
  tone: RouteTone;
  /** The NetworkPolicies of its namespace that restrict what comes in; null — not read. */
  policies: RoutePolicy[] | null;
}

/** What the route reads besides services, ingresses and slices (v1.35); null — not read. */
export interface RouteExtras {
  httpRoutes?: readonly K8sHttpRoute[] | null;
  classes?: readonly K8sIngressClass[] | null;
  policies?: readonly K8sNetworkPolicy[] | null;
}

/** A rule whose backend cannot be followed. */
export interface DanglingRoute {
  entry: RouteEntry;
  /** `serviceMissing`: no such service in the namespace. `resource`: the backend is not a service. */
  reason: "serviceMissing" | "resource";
  /** Where the backend was looked for: the entry's namespace, or an HTTPRoute's ref's own. */
  backendNamespace: string;
}

export interface RouteTable {
  routes: ServiceRoute[];
  dangling: DanglingRoute[];
}

const SEVERITY: Record<EndpointState, number> = { notReady: 2, terminating: 1, ready: 0 };

const nsKey = (namespace: string, name: string) => `${namespace}/${name}`;

function endpointState(e: { ready: boolean; terminating: boolean }): EndpointState {
  if (e.terminating) return "terminating";
  return e.ready ? "ready" : "notReady";
}

/**
 * A service's endpoints from its slices: one per target, trouble first. A
 * dual-stack pod sits in an IPv4 and an IPv6 slice — the same pod, so its
 * addresses are gathered instead of counting it twice.
 */
function collectEndpoints(slices: readonly K8sEndpointSlice[]): RouteEndpoint[] {
  const byTarget = new Map<string, RouteEndpoint>();
  for (const slice of slices) {
    for (const e of slice.endpoints) {
      const key = e.targetName ? `${e.targetKind}/${e.targetName}` : e.addresses.join(",");
      const state = endpointState(e);
      const seen = byTarget.get(key);
      if (!seen) {
        byTarget.set(key, {
          addresses: [...e.addresses],
          state,
          targetKind: e.targetKind,
          targetName: e.targetName,
          node: e.node,
        });
        continue;
      }
      for (const a of e.addresses) if (!seen.addresses.includes(a)) seen.addresses.push(a);
      if (SEVERITY[state] > SEVERITY[seen.state]) seen.state = state;
    }
  }
  return [...byTarget.values()].sort(
    (a, b) =>
      SEVERITY[b.state] - SEVERITY[a.state] ||
      a.targetName.localeCompare(b.targetName) ||
      (a.addresses[0] ?? "").localeCompare(b.addresses[0] ?? ""),
  );
}

/** The number a service port resolved to, when the slices agree on one. */
function resolvedPort(port: K8sServicePort, slices: readonly K8sEndpointSlice[]): number | null {
  const found = new Set<number>();
  for (const slice of slices) {
    for (const p of slice.ports) if (p.name === port.name && p.port !== null) found.add(p.port);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Whether the service declares the port an ingress backend names (by number or by name). */
export function declaresPort(service: K8sService, port: string): boolean {
  if (!port) return false;
  return service.portList.some((p) => String(p.port) === port || (p.name !== "" && p.name === port));
}

/**
 * Health of one chain. `idle` is "not measured" — an ExternalName alias, or
 * endpoints nobody could read — and must not be painted healthy. A service with
 * no ready endpoint, or a rule naming a port the service does not have, is
 * broken; some endpoints not ready is degraded.
 */
export function routeTone(targets: RouteTargets, entries: readonly ServiceEntry[] | null): RouteTone {
  if (entries?.some((e) => !e.portDeclared || e.accepted === false)) return "bad";
  if (targets.kind !== "endpoints") return "idle";
  if (targets.ready === 0) return "bad";
  return targets.ready < targets.endpoints.length ? "warn" : "ok";
}

/** What the IngressClasses say of `className`: the class that stands, and the note. */
function classOf(
  className: string,
  classes: readonly K8sIngressClass[] | null,
): { className: string; classNote: ClassNote; controller: string } {
  if (classes === null) return { className, classNote: null, controller: "" };
  if (className) {
    const found = classes.find((c) => c.name === className);
    return { className, classNote: found ? null : "missing", controller: found?.controller ?? "" };
  }
  const fallback = classes.find((c) => c.isDefault);
  return fallback
    ? { className: fallback.name, classNote: "default", controller: fallback.controller }
    : { className: "", classNote: "unset", controller: "" };
}

/** An ingress's rules (and default backend) as entries, in manifest order. */
function ingressEntries(ing: K8sIngress, classes: readonly K8sIngressClass[] | null): RouteEntry[] {
  const base = {
    source: "ingress" as const,
    ingress: ing.name,
    namespace: ing.namespace,
    ...classOf(ing.className, classes),
    accepted: null,
    address: ing.address,
  };
  const entries: RouteEntry[] = ing.rules.map((r, i) => ({
    ...base,
    key: `${nsKey(ing.namespace, ing.name)}#${i}`,
    host: r.host,
    path: r.path,
    pathType: r.pathType,
    tls: r.host !== "" && ing.tlsHosts.includes(r.host),
    isDefault: false,
    backend: r.backend,
  }));
  if (ing.defaultBackend) {
    entries.push({
      ...base,
      key: `${nsKey(ing.namespace, ing.name)}#default`,
      host: "",
      path: "",
      pathType: "",
      tls: false,
      isDefault: true,
      backend: ing.defaultBackend,
    });
  }
  return entries;
}

/**
 * An HTTPRoute as entries: one per hostname, match and backend. A backend of
 * another namespace keeps its own (`backendNamespace`), the entry the route's.
 */
function httpRouteEntries(route: K8sHttpRoute): (RouteEntry & { backendNamespace: string })[] {
  const out: (RouteEntry & { backendNamespace: string })[] = [];
  const hosts = route.hostnames.length ? route.hostnames : [""];
  route.rules.forEach((rule, i) => {
    rule.backends.forEach((b, k) => {
      hosts.forEach((host, h) => {
        out.push({
          key: `${nsKey(route.namespace, route.name)}#r${i}b${k}h${h}`,
          source: "httproute",
          ingress: route.name,
          namespace: route.namespace,
          className: route.gateways.join(", "),
          classNote: null,
          controller: "",
          accepted: route.accepted,
          host,
          path: rule.path,
          pathType: rule.pathType,
          // TLS ends at the gateway's listener, which the route does not name.
          tls: false,
          address: "",
          isDefault: false,
          backend:
            b.kind === "Service"
              ? { service: b.name, port: b.port, resource: "" }
              : { service: "", port: "", resource: `${b.kind}/${b.name}` },
          backendNamespace: b.namespace,
        });
      });
    });
  });
  return out;
}

/** The policies of `namespace` that restrict what comes in, by name. */
function namespacePolicies(policies: readonly K8sNetworkPolicy[], namespace: string): RoutePolicy[] {
  return policies
    .filter((p) => p.namespace === namespace && p.ingress !== null)
    .map((p) => ({ name: p.name, appliesTo: p.appliesTo, ingress: p.ingress!, ruleCount: p.ruleCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Join services, ingresses and EndpointSlices into route rows, sorted by
 * namespace and name so a poll never reorders them.
 *
 * `ingresses` and `slices` are null when they could not be read: the entries of
 * every route are then `null` (not "no ingress points here") and its targets
 * `unknown` (not "no endpoints"). Services are required — without them there is
 * nothing to hang a route on, and the caller shows that failure instead.
 */
export function buildRoutes(
  services: readonly K8sService[],
  ingresses: readonly K8sIngress[] | null,
  slices: readonly K8sEndpointSlice[] | null,
  extras: RouteExtras = {},
): RouteTable {
  const classes = extras.classes ?? null;
  const policies = extras.policies ?? null;
  const slicesByService = new Map<string, K8sEndpointSlice[]>();
  for (const slice of slices ?? []) {
    if (!slice.service) continue;
    const key = nsKey(slice.namespace, slice.service);
    const list = slicesByService.get(key);
    if (list) list.push(slice);
    else slicesByService.set(key, [slice]);
  }

  const serviceByKey = new Map(services.map((s) => [nsKey(s.namespace, s.name), s]));
  const entriesByService = new Map<string, ServiceEntry[]>();
  const dangling: DanglingRoute[] = [];
  const declared = [
    // An ingress's backend is always a service of its own namespace.
    ...(ingresses ?? []).flatMap((ing) => ingressEntries(ing, classes).map((e) => ({ ...e, backendNamespace: ing.namespace }))),
    ...(extras.httpRoutes ?? []).flatMap(httpRouteEntries),
  ];
  for (const { backendNamespace, ...entry } of declared) {
    if (!entry.backend.service) {
      dangling.push({ entry, reason: "resource", backendNamespace });
      continue;
    }
    const key = nsKey(backendNamespace, entry.backend.service);
    const service = serviceByKey.get(key);
    if (!service) {
      dangling.push({ entry, reason: "serviceMissing", backendNamespace });
      continue;
    }
    const attached = { ...entry, portDeclared: declaresPort(service, entry.backend.port) };
    const list = entriesByService.get(key);
    if (list) list.push(attached);
    else entriesByService.set(key, [attached]);
  }

  const routes: ServiceRoute[] = [...services]
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
    .map((service) => {
      const key = nsKey(service.namespace, service.name);
      const own = slicesByService.get(key) ?? [];
      let targets: RouteTargets;
      if (service.type === "ExternalName") {
        targets = { kind: "externalName", name: service.externalName };
      } else if (slices === null) {
        targets = { kind: "unknown" };
      } else {
        const endpoints = collectEndpoints(own);
        targets = {
          kind: "endpoints",
          endpoints,
          ready: endpoints.filter((e) => e.state === "ready").length,
        };
      }
      const entries = ingresses === null ? null : (entriesByService.get(key) ?? []);
      return {
        key,
        service,
        ports: service.portList.map((p) => ({ ...p, endpointPort: resolvedPort(p, own) })),
        entries,
        targets,
        tone: routeTone(targets, entries),
        policies: policies === null ? null : namespacePolicies(policies, service.namespace),
      };
    });

  dangling.sort((a, b) =>
    nsKey(a.entry.namespace, a.entry.ingress).localeCompare(nsKey(b.entry.namespace, b.entry.ingress)),
  );
  return { routes, dangling };
}

/** Endpoints listed per service before "and N more" — a 200-replica deployment is not a list. */
export const ROUTE_MAX_ENDPOINTS = 8;

/**
 * The endpoints to list and how many were left out. They arrive trouble-first,
 * so the cut falls on ready endpoints: a not-ready one is not hidden behind a
 * wall of healthy ones.
 */
export function shownEndpoints(
  endpoints: readonly RouteEndpoint[],
  max: number = ROUTE_MAX_ENDPOINTS,
): { shown: RouteEndpoint[]; hidden: number } {
  const shown = endpoints.slice(0, Math.max(0, max));
  return { shown, hidden: endpoints.length - shown.length };
}

/** A service port as text: `80 → 8080/TCP`, or `80/TCP` when the two are the same. */
export function portLabel(port: RoutePort): string {
  const target = port.endpointPort !== null ? String(port.endpointPort) : port.targetPort;
  const mapping = target === String(port.port) ? `${port.port}` : `${port.port} → ${target}`;
  return `${mapping}/${port.protocol}`;
}
