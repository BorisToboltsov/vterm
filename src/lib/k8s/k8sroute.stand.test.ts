// The route of the k8s stand, read from what a real kubectl answered.
//
// `k8sroute.stand.json` is `kubectl get services|ingress|endpointslices -o json` of
// `e2e/k8s/stand.yaml` on Docker Desktop (k8s 1.31), with managedFields and the
// last-applied annotation cut. The unit tests of `k8sroute.test.ts` build their
// objects from the schemas; these answers carry what only a cluster writes — a
// slice with `ports: null` and no `endpoints` for a service nobody matches, a
// named target port resolved by the slice, an ingress without a controller.
// Re-capture after changing the stand: docs/TESTS.md, «Живой кластер k8s».

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEndpointSlices, parseIngress, parseServices } from "./k8s";
import { buildRoutes } from "./k8sroute";

const stand = JSON.parse(readFileSync(join(process.cwd(), "src/lib/k8s/k8sroute.stand.json"), "utf8")) as Record<
  "services" | "ingress" | "endpointslices",
  unknown
>;
const raw = (key: keyof typeof stand) => JSON.stringify(stand[key]);

const table = buildRoutes(
  parseServices(raw("services")),
  parseIngress(raw("ingress")),
  parseEndpointSlices(raw("endpointslices")),
);
const route = (name: string) => {
  const found = table.routes.find((r) => r.service.name === name);
  if (!found) throw new Error(`no route of ${name}`);
  return found;
};

describe("the stand's route, as kubectl answered it", () => {
  it("lists every service of the stand", () => {
    expect(table.routes.map((r) => r.service.name)).toEqual(["notready", "orphan", "web"]);
  });

  it("leads web from its ingress rule to its one ready pod, through the named port", () => {
    const web = route("web");
    expect(web.tone).toBe("ok");
    expect(web.targets.kind).toBe("endpoints");
    if (web.targets.kind !== "endpoints") return;
    expect(web.targets.ready).toBe(1);
    expect(web.targets.endpoints.map((e) => [e.state, e.targetKind, e.targetName.startsWith("web-")])).toEqual([
      ["ready", "Pod", true],
    ]);
    // `targetPort: http` is a name: only the slice says it is 8080.
    expect(web.ports.map((p) => [p.name, p.port, p.targetPort, p.endpointPort])).toEqual([["http", 80, "http", 8080]]);
    expect(web.entries?.map((e) => [e.host, e.path, e.portDeclared, e.address])).toEqual([
      ["web.vterm.test", "/", true, ""],
    ]);
  });

  it("says the pod behind notready is there but not ready", () => {
    const notready = route("notready");
    expect(notready.targets.kind).toBe("endpoints");
    if (notready.targets.kind !== "endpoints") return;
    expect(notready.targets.ready).toBe(0);
    expect(notready.targets.endpoints.map((e) => e.state)).toEqual(["notReady"]);
    expect(notready.ports[0].endpointPort).toBe(8080);
    expect(notready.entries).toEqual([]);
    expect(notready.tone).not.toBe("ok");
  });

  it("reads the slice of a service nobody matches — ports null, no endpoints — as no endpoints, not as unread", () => {
    const orphan = route("orphan");
    expect(orphan.service.selector).toBe("app=nobody");
    expect(orphan.targets).toEqual({ kind: "endpoints", endpoints: [], ready: 0 });
    expect(orphan.ports[0].endpointPort).toBeNull();
    expect(orphan.tone).not.toBe("ok");
  });

  it("names the rule whose service does not exist", () => {
    expect(table.dangling.map((d) => [d.entry.ingress, d.entry.path, d.entry.backend.service, d.reason])).toEqual([
      ["web", "/reports", "reports", "serviceMissing"],
    ]);
  });
});
