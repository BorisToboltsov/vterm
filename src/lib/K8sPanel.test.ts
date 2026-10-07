import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A cluster that answers: a kubeconfig with a current context, two namespaces.
// Each call takes a macrotask, like a real IPC round trip — the storm this file
// guards against needs the answers to arrive *after* the effects have settled.
const calls: string[] = [];
type Answer = { stdout: string; stderr: string; exitCode: number };
// A test's own answers, tried before the defaults below (the hoisted mock reads it lazily).
let answer: ((args: string[]) => Answer | undefined) | null = null;
// How long one call takes, when a test needs an answer to arrive late.
let slow: ((args: string[]) => number) | null = null;
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  kubectlRun: vi.fn(async (_session: string, args: string[]) => {
    calls.push(args.join(" "));
    await new Promise((r) => setTimeout(r, slow?.(args) ?? 5));
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    const own = answer?.(args);
    if (own) return own;
    if (args.includes("version")) {
      return ok(
        JSON.stringify({
          clientVersion: { gitVersion: "v1.31.1" },
          serverVersion: { gitVersion: "v1.30.4" },
        }),
      );
    }
    if (args.includes("get-contexts")) return ok("prod-eu\nstaging-eu\n");
    if (args.includes("current-context")) return ok("staging-eu\n");
    if (args.includes("namespaces")) {
      return ok(JSON.stringify({ items: [{ metadata: { name: "shop" } }] }));
    }
    return ok(JSON.stringify({ items: [] }));
  }),
}));

import K8sPanel from "./K8sPanel.svelte";
import { peekDockState, resetDockState } from "./stores/dockstate.svelte";

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
/** How many times a command was run, matched by a distinctive fragment of its argv. */
const count = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

beforeEach(() => {
  calls.length = 0;
  answer = null;
  slow = null;
  resetDockState();
});

describe("K8sPanel — probing the cluster", () => {
  it("probes a host with a kubeconfig once, not in a loop", async () => {
    // Before v1.1.0 the init effect depended on the scope it wrote itself: picking
    // up the kubeconfig's current context re-ran the init, which reset the context
    // and probed again — every answer started two more probes. One mount made tens
    // of thousands of `kubectl` calls a second on the session's host.
    render(K8sPanel, { props: { sessionId: "k1", visible: true, sessionReady: true } });
    await settle();
    expect(count("get-contexts")).toBe(1);
    expect(count("current-context")).toBe(1);
    expect(count("version")).toBe(1);
    expect(count("get namespaces")).toBe(1);
    expect(count("get pods")).toBe(1);
    expect(count("top pods")).toBe(1);
    // …and it stays quiet afterwards (the poll interval is seconds away).
    const total = calls.length;
    await settle();
    expect(calls.length).toBe(total);
  });

  it("uses the kubeconfig's current context for every command after the probe", async () => {
    render(K8sPanel, { props: { sessionId: "k2", visible: true, sessionReady: true } });
    await settle();
    // The context selector shows it, and it was not reset behind the user's back.
    expect((screen.getByTestId("k8s-context") as HTMLSelectElement).value).toBe("staging-eu");
    expect(calls.find((c) => c.includes("get pods"))).toContain("--context staging-eu");
  });

  it("reloads once when a namespace is picked, without probing again", async () => {
    render(K8sPanel, { props: { sessionId: "k3", visible: true, sessionReady: true } });
    await settle();
    calls.length = 0;
    await fireEvent.change(screen.getByTestId("k8s-namespace"), { target: { value: "shop" } });
    await settle();
    expect(count("get pods")).toBe(1);
    expect(count("top pods")).toBe(1);
    expect(calls.find((c) => c.includes("get pods"))).toContain("--namespace shop");
    // Picking a namespace is not a new cluster: no re-enumeration, no version probe.
    expect(count("get-contexts")).toBe(0);
    expect(count("version")).toBe(0);
  });

  it("reloads once when the sub-tab changes", async () => {
    render(K8sPanel, { props: { sessionId: "k4", visible: true, sessionReady: true } });
    await settle();
    calls.length = 0;
    await fireEvent.click(screen.getByTestId("k8s-subtab-workloads"));
    await settle();
    expect(count("get deployments")).toBe(1);
    expect(count("version")).toBe(0);
  });

  it("does not touch the cluster before the session is ready", async () => {
    render(K8sPanel, { props: { sessionId: "k5", visible: true, sessionReady: false } });
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("K8sPanel — the route view", () => {
  const json = (...items: unknown[]) => ({ stdout: JSON.stringify({ items }), stderr: "", exitCode: 0 });
  const web = {
    metadata: { name: "web", namespace: "shop" },
    spec: { clusterIP: "10.0.0.12", selector: { app: "web" }, ports: [{ name: "http", port: 80, targetPort: 8080 }] },
  };
  const webSlice = {
    metadata: { name: "web-abcde", namespace: "shop", labels: { "kubernetes.io/service-name": "web" } },
    ports: [{ name: "http", port: 8080 }],
    endpoints: [{ addresses: ["10.1.0.5"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "web-abc" } }],
  };

  async function openNetwork(session: string) {
    render(K8sPanel, { props: { sessionId: session, visible: true, sessionReady: true } });
    await settle();
    calls.length = 0;
    await fireEvent.click(screen.getByTestId("k8s-subtab-network"));
    await settle();
  }

  it("does not ask for EndpointSlices while the list is on screen", async () => {
    // The list view polls exactly what it polled before the route existed.
    await openNetwork("r1");
    expect(count("get services")).toBe(1);
    expect(count("get ingress")).toBe(1);
    expect(count("get endpointslices")).toBe(0);
  });

  it("reloads once, with the slices, when the route is switched on", async () => {
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r2");
    calls.length = 0;
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await settle();
    expect(count("get services")).toBe(1);
    expect(count("get ingress")).toBe(1);
    expect(count("get endpointslices")).toBe(1);
    expect(calls.find((c) => c.includes("endpointslices"))).toContain("--context staging-eu");
    expect(screen.getByTestId("k8s-route-endpoint")).toHaveTextContent("10.1.0.5");
    expect(screen.getByText("1 of 1 ready")).toBeInTheDocument();
    // …and stops asking for them once the list is back.
    calls.length = 0;
    await fireEvent.click(screen.getByRole("button", { name: "List" }));
    await settle();
    expect(count("get endpointslices")).toBe(0);
  });

  it("says the endpoints were not read when the cluster refuses the slices", async () => {
    // EndpointSlices live in their own API group: a role that lists services may
    // not list them. That is not "this service has no endpoints".
    const forbidden = 'Error from server (Forbidden): endpointslices.discovery.k8s.io is forbidden: User "dev" cannot list resource';
    answer = (args) =>
      args.includes("services")
        ? json(web)
        : args.includes("endpointslices")
          ? { stdout: "", stderr: forbidden, exitCode: 1 }
          : undefined;
    await openNetwork("r3");
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await settle();
    expect(screen.getByText("Endpoints could not be read")).toBeInTheDocument();
    expect(screen.queryByText("No endpoints — traffic has nowhere to go")).toBeNull();
  });

  it("says the services were not read instead of 'No services'", async () => {
    answer = (args) =>
      args.includes("services") ? { stdout: "", stderr: "Error from server (Forbidden): services is forbidden", exitCode: 1 } : undefined;
    await openNetwork("r4");
    expect(screen.getByText("Services could not be read")).toBeInTheDocument();
    expect(screen.queryByText("No services")).toBeNull();
    // The switch stays reachable above the message.
    expect(screen.getByTestId("k8s-net-view")).toBeInTheDocument();
  });

  it("keeps the endpoints when an answer asked for under the list arrives late", async () => {
    // A reload started in the list view carries no slices. If it lands after the
    // route's own reload, it must not wipe the endpoints that one brought.
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r6");
    let late = true;
    slow = (args) => {
      if (late && args.includes("services")) {
        late = false;
        return 80;
      }
      return 5;
    };
    await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await settle(200);
    expect(screen.getByTestId("k8s-route-endpoint")).toHaveTextContent("10.1.0.5");
  });

  it("remembers the view for the session", async () => {
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r5");
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await settle();
    expect(peekDockState("r5")?.sub).toMatchObject({ k8s: "network", k8sNet: "route" });
  });
});
