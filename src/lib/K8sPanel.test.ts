import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A cluster that answers: a kubeconfig with a current context, two namespaces.
// Each call takes a macrotask, like a real IPC round trip — the storm this file
// guards against needs the answers to arrive *after* the effects have settled.
const calls: string[] = [];
type Answer = { stdout: string; stderr: string; exitCode: number };
// A test's own answers, tried before the defaults below (the hoisted mock reads it lazily).
let answer: ((args: string[]) => Answer | undefined) | null = null;
// How long one call takes, when a test needs an answer to arrive late.
let slow: ((args: string[]) => number) | null = null;
// Calls asked and not answered yet — what `idle` waits out.
let inFlight = 0;
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  kubectlRun: vi.fn(async (_session: string, args: string[]) => {
    calls.push(args.join(" "));
    inFlight++;
    try {
      await new Promise((r) => setTimeout(r, slow?.(args) ?? 5));
    } finally {
      inFlight--;
    }
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
import { panelSplits, resetPanelShares } from "./stores/panelsplit.svelte";

/** A fixed pause — only for "and nothing more happens": there is no event to wait for. */
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the panel has finished what it started: no call in flight, and
 * none begun for a few turns of the event loop after.
 *
 * Not a pause. "120 ms is enough for six calls of 5 ms" is a bet on how busy the
 * machine is, and a full run under load lost it: a timer that fires late makes
 * every hop of the chain late, and the test looked at a panel that had not
 * finished loading. The panel's calls follow one another without a timer in
 * between — the next is asked in the same turn the last one answered — so a
 * turn with nothing in flight means the chain is over; three in a row is margin.
 * A chain that never ends (the storm this file guards against) is cut off, and
 * the counts that follow say what went wrong.
 */
async function idle(): Promise<void> {
  const until = Date.now() + 4000;
  let quiet = 0;
  let seen = calls.length;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
    if (inFlight === 0 && calls.length === seen) {
      if (++quiet === 3) return;
    } else {
      quiet = 0;
      seen = calls.length;
    }
  }
}
/** How many times a command was run, matched by a distinctive fragment of its argv. */
const count = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

beforeEach(() => {
  calls.length = 0;
  answer = null;
  slow = null;
  resetDockState();
});
// A test that ends with calls still out must not leave them to the next one.
afterEach(idle);

describe("K8sPanel — probing the cluster", () => {
  it("probes a host with a kubeconfig once, not in a loop", async () => {
    // Before v1.1.0 the init effect depended on the scope it wrote itself: picking
    // up the kubeconfig's current context re-ran the init, which reset the context
    // and probed again — every answer started two more probes. One mount made tens
    // of thousands of `kubectl` calls a second on the session's host.
    render(K8sPanel, { props: { sessionId: "k1", visible: true, sessionReady: true } });
    await idle();
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
    await idle();
    // The context selector shows it, and it was not reset behind the user's back.
    expect((screen.getByTestId("k8s-context") as HTMLSelectElement).value).toBe("staging-eu");
    expect(calls.find((c) => c.includes("get pods"))).toContain("--context staging-eu");
  });

  it("reloads once when a namespace is picked, without probing again", async () => {
    render(K8sPanel, { props: { sessionId: "k3", visible: true, sessionReady: true } });
    await idle();
    calls.length = 0;
    await fireEvent.change(screen.getByTestId("k8s-namespace"), { target: { value: "shop" } });
    await idle();
    expect(count("get pods")).toBe(1);
    expect(count("top pods")).toBe(1);
    expect(calls.find((c) => c.includes("get pods"))).toContain("--namespace shop");
    // Picking a namespace is not a new cluster: no re-enumeration, no version probe.
    expect(count("get-contexts")).toBe(0);
    expect(count("version")).toBe(0);
  });

  it("reloads once when the sub-tab changes", async () => {
    render(K8sPanel, { props: { sessionId: "k4", visible: true, sessionReady: true } });
    await idle();
    calls.length = 0;
    await fireEvent.click(screen.getByTestId("k8s-subtab-workloads"));
    await idle();
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
    await idle();
    calls.length = 0;
    await fireEvent.click(screen.getByTestId("k8s-subtab-network"));
    await idle();
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
    await idle();
    expect(count("get services")).toBe(1);
    expect(count("get ingress")).toBe(1);
    expect(count("get endpointslices")).toBe(1);
    expect(calls.find((c) => c.includes("endpointslices"))).toContain("--context staging-eu");
    expect(screen.getByTestId("k8s-route-endpoint")).toHaveTextContent("10.1.0.5");
    expect(screen.getByText("1 of 1 ready")).toBeInTheDocument();
    // …and stops asking for them once the list is back.
    calls.length = 0;
    await fireEvent.click(screen.getByRole("button", { name: "List" }));
    await idle();
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
    await idle();
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
    // Both reloads, the late one too.
    await idle();
    expect(screen.getByTestId("k8s-route-endpoint")).toHaveTextContent("10.1.0.5");
  });

  it("remembers the view for the session", async () => {
    answer = (args) => (args.includes("services") ? json(web) : args.includes("endpointslices") ? json(webSlice) : undefined);
    await openNetwork("r5");
    await fireEvent.click(screen.getByRole("button", { name: "Route" }));
    await idle();
    expect(peekDockState("r5")?.sub).toMatchObject({ k8s: "network", k8sNet: "route" });
  });
});

// ── Details beside the list in a wide panel (v1.7) ───────────────────────────

describe("K8sPanel — where a pod's details open", () => {
  const POD = {
    metadata: {
      name: "web-5f7c",
      namespace: "shop",
      creationTimestamp: "2026-10-07T10:00:00Z",
      ownerReferences: [],
    },
    spec: { nodeName: "node-1", containers: [{ name: "web" }] },
    status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
  };

  /** Give the panel a width and let its observer see it (jsdom has no layout). */
  function resize(width: number) {
    const root = document.querySelector<HTMLElement>("[data-wide]")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([]);
  }

  async function mountWithPod(id: string) {
    answer = (args) =>
      args.includes("pods") && args.includes("get")
        ? { stdout: JSON.stringify({ items: [POD] }), stderr: "", exitCode: 0 }
        : undefined;
    render(K8sPanel, { props: { sessionId: id, visible: true, sessionReady: true } });
    await idle();
    expect(screen.getByText("web-5f7c")).toBeInTheDocument();
  }

  it("a narrow dock opens them as a dialog", async () => {
    await mountWithPod("k-narrow");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("k8s-detail-overview"));
    expect(screen.queryByTestId("k8s-side")).toBeNull();
  });

  it("a wide panel opens them beside the list, which stays on screen", async () => {
    await mountWithPod("k-wide");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const side = screen.getByTestId("k8s-side");
    expect(side).toContainElement(screen.getByTestId("k8s-detail-overview"));
    // The list is still there, next to the pane.
    expect(screen.getByTestId("k8s-list-part")).toContainElement(
      screen.getByRole("button", { name: "View details" }),
    );
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("k8s-side")).toBeNull();
  });

  it("the border between the list and the pane is dragged, and is there only with two parts", async () => {
    resetPanelShares();
    await mountWithPod("k-border");
    resize(1200);
    const list = screen.getByTestId("k8s-list-part");
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(list.style.width).toBe("");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("data-split", "k8s");
    expect(divider.previousElementSibling).toBe(list);
    expect(divider.nextElementSibling).toBe(screen.getByTestId("k8s-side"));
    expect(list.style.width).toBe("50%");

    const row = list.parentElement!;
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 1000 });
    const observers = (
      globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
    ).instances;
    for (const o of observers) o.cb([{ target: row }]);
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 10 });
    await fireEvent.pointerMove(divider, { pointerId: 1, clientX: 650, clientY: 10 });
    await fireEvent.pointerUp(divider, { pointerId: 1, clientX: 650, clientY: 10 });
    expect(panelSplits.shares.k8s).toBeCloseTo(0.65);
    expect(list.style.width).toBe("65%");
    // Docker's border is its own.
    expect(panelSplits.shares.docker).toBeUndefined();
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    resetPanelShares();
  });

  it("details that are open follow the panel across the threshold", async () => {
    await mountWithPod("k-cross");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByTestId("k8s-side")).toBeInTheDocument();
    resize(400);
    await waitFor(() => expect(screen.queryByTestId("k8s-side")).toBeNull());
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("k8s-detail-overview"));
  });
});
