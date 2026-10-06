import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A cluster that answers: a kubeconfig with a current context, two namespaces.
// Each call takes a macrotask, like a real IPC round trip — the storm this file
// guards against needs the answers to arrive *after* the effects have settled.
const calls: string[] = [];
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  kubectlRun: vi.fn(async (_session: string, args: string[]) => {
    calls.push(args.join(" "));
    await new Promise((r) => setTimeout(r, 5));
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
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
import { resetDockState } from "./stores/dockstate.svelte";

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
/** How many times a command was run, matched by a distinctive fragment of its argv. */
const count = (fragment: string) => calls.filter((c) => c.includes(fragment)).length;

beforeEach(() => {
  calls.length = 0;
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
