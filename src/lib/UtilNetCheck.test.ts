import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const netcheckRun = vi.fn();
vi.mock("./api", () => ({
  netcheckRun: (...a: unknown[]) => netcheckRun(...a),
}));

import UtilNetCheck from "./UtilNetCheck.svelte";
import { netcheckState } from "./stores/netcheck.svelte";
import type { ProbeSession } from "./probe";

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const identity = (method = "bash") =>
  `H\tapp-01\nA\t127.0.0.1/8\nA\t10.64.48.180/24\nM\t${method}\n`;
const ssh: ProbeSession = { id: "s1", kind: "ssh", live: true, host: "10.64.48.180", isProd: false };

/** Answer the identity probe, then a run where 22 is open and 8888 refused. */
function serve(method = "bash") {
  netcheckRun.mockImplementation(async (_id: string, _args: string[], targets: { host: string; ports: number[] }[]) => {
    if (targets.length === 0) return ok(identity(method) + "E\n");
    let out = identity(method) + "S\t10.70.39.10\t10.64.48.180\n";
    for (const t of targets) {
      for (const p of t.ports) {
        const refused = p === 8888;
        out += `R\t${t.host}\t${p}\t${refused ? 1 : 0}\t1700000000000000000\t1700000000004000000\t${refused ? "bash: connect: Connection refused" : ""}\n`;
      }
    }
    return ok(out + "E\n");
  });
}

beforeEach(() => {
  netcheckRun.mockReset();
  netcheckState.draft = "";
  netcheckState.history = {};
});

describe("UtilNetCheck", () => {
  it("shows who is checking before the first run", async () => {
    serve();
    render(UtilNetCheck, { props: { session: ssh } });
    expect(await screen.findByTestId("netcheck-hostname")).toHaveTextContent("app-01");
    // Loopback is hidden from the header.
    expect(screen.getByTestId("netcheck-addrs")).toHaveTextContent(/^10\.64\.48\.180$/);
    expect(netcheckRun.mock.calls[0][2]).toEqual([]);
  });

  it("runs the rules and renders a verdict per port", async () => {
    serve();
    netcheckState.draft = "10.64.48.180 -> 10.70.39.10:[22, 8888]/tcp";
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));

    expect(await screen.findByTestId("netcheck-status-open")).toBeInTheDocument();
    expect(screen.getByTestId("netcheck-status-refused")).toBeInTheDocument();
    expect(screen.getByTestId("netcheck-tally")).toHaveTextContent("1 / 2 open");
    // The run sent the targets and remembered the rules for this host.
    expect(netcheckRun.mock.calls.at(-1)![2]).toEqual([{ host: "10.70.39.10", ports: [22, 8888] }]);
    expect(netcheckState.history["10.64.48.180"]).toEqual([netcheckState.draft]);
  });

  it("retries only what didn't come back open", async () => {
    serve();
    netcheckState.draft = "10.70.39.10:[22, 8888]";
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await fireEvent.click(await screen.findByTestId("netcheck-retry"));
    await waitFor(() =>
      expect(netcheckRun.mock.calls.at(-1)![2]).toEqual([{ host: "10.70.39.10", ports: [8888] }]),
    );
  });

  it("warns when a rule's source is not this host", async () => {
    serve();
    netcheckState.draft = "10.64.48.181 -> 10.70.39.10:22";
    render(UtilNetCheck, { props: { session: ssh } });
    expect(await screen.findByTestId("netcheck-source-warn")).toHaveTextContent("10.64.48.181");
  });

  it("shows parse errors per line and won't run without a valid rule", async () => {
    serve();
    netcheckState.draft = "10.70.39.300:22";
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    expect(screen.getByTestId("netcheck-parse-error")).toHaveTextContent("Line 1");
    expect(screen.getByTestId("netcheck-run")).toBeDisabled();
  });

  it("offers telnet when the server has nothing to probe with", async () => {
    serve("none");
    const onInstallTelnet = vi.fn();
    netcheckState.draft = "10.70.39.10:22";
    render(UtilNetCheck, { props: { session: ssh, onInstallTelnet } });
    await fireEvent.click(await screen.findByTestId("netcheck-install-telnet"));
    expect(onInstallTelnet).toHaveBeenCalledOnce();
    expect(screen.getByTestId("netcheck-run")).toBeDisabled();
  });

  it("never offers an install on a local tab", async () => {
    serve("none");
    render(UtilNetCheck, {
      props: { session: { ...ssh, kind: "local" }, onInstallTelnet: vi.fn() },
    });
    await screen.findByTestId("netcheck-nomethod");
    expect(screen.queryByTestId("netcheck-install-telnet")).toBeNull();
  });

  it("asks for a connected tab when there is none", () => {
    render(UtilNetCheck, { props: { session: null } });
    expect(screen.getByTestId("netcheck-nosession")).toBeInTheDocument();
    expect(netcheckRun).not.toHaveBeenCalled();
  });
});
