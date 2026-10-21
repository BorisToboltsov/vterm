import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const netcheckRun = vi.fn();
const sftpCancel = vi.fn();
vi.mock("./api", () => ({
  netcheckRun: (...a: unknown[]) => netcheckRun(...a),
  sftpCancel: (...a: unknown[]) => sftpCancel(...a),
  recordAudit: async () => {},
}));

import UtilNetCheck from "./UtilNetCheck.svelte";
import { netcheckState, setRows } from "./stores/netcheck.svelte";
import { textRows } from "./netcheckform";
import type { HostServer, HostTab } from "./netroute";

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const WHO: Record<string, [string, string, string]> = {
  s1: ["app-01", "10.64.48.180", "bash"],
  s2: ["app-02", "10.64.48.181", "bash"],
  L: ["laptop", "192.168.1.10", "native"],
};
const identity = (sid: string, method?: string) => {
  const [name, addr, m] = WHO[sid];
  return `H\t${name}\nA\t127.0.0.1/8\nA\t${addr}/24\nM\t${method ?? m}\n`;
};
const servers: HostServer[] = [
  { id: "a1", alias: "app-01", host: "10.64.48.180", isProd: false },
  { id: "a2", alias: "app-02", host: "10.64.48.181", isProd: true },
];
const tab = (sessionId: string, serverId: string, live = true): HostTab => ({
  sessionId,
  kind: serverId ? "ssh" : "local",
  serverId,
  live,
  connecting: false,
});
const s1 = tab("s1", "a1");
const props = (over: Record<string, unknown> = {}) => ({ homeId: "s1", servers, tabs: [s1], ...over });

/** Answer identity probes, then runs where 8888 is refused and the rest open. */
function serve(method?: string) {
  netcheckRun.mockImplementation(async (sid: string, _args: string[], targets: { host: string; ports: number[] }[]) => {
    let out = identity(sid, method);
    if (targets.length === 0) return ok(out + "E\n");
    out += "S\t10.70.39.10\t10.64.48.180\n";
    for (const t of targets) {
      for (const p of t.ports) {
        const refused = p === 8888;
        out += `R\t${t.host}\t${p}\t${refused ? 1 : 0}\t1700000000000000000\t1700000000004000000\t${refused ? "bash: connect: Connection refused" : ""}\n`;
      }
    }
    return ok(out + "E\n");
  });
}

/** The runs that checked something: session id and targets. */
const runs = () =>
  netcheckRun.mock.calls.filter((c) => (c[2] as unknown[]).length > 0).map((c) => [c[0], c[2]]);

beforeEach(() => {
  netcheckRun.mockReset();
  sftpCancel.mockReset();
  netcheckState.rows = {};
  netcheckState.runs = {};
  netcheckState.history = {};
  netcheckState.methods = {};
});

describe("UtilNetCheck", () => {
  it("shows who is checking before the first run", async () => {
    serve();
    render(UtilNetCheck, { props: props() });
    expect(await screen.findByTestId("netcheck-hostname")).toHaveTextContent("app-01");
    // Loopback is hidden.
    expect(screen.getByTestId("netcheck-addrs")).toHaveTextContent(/^10\.64\.48\.180$/);
    expect(netcheckRun.mock.calls[0][2]).toEqual([]);
  });

  it("reads a pasted request into rules and runs them", async () => {
    serve();
    render(UtilNetCheck, { props: props() });
    await screen.findByTestId("netcheck-hostname");
    const inbox = screen.getByTestId("netcheck-inbox");
    await fireEvent.input(inbox, {
      target: { value: "Прошу открыть доступ:\nИсточник\tНазначение\tПорт\n10.64.48.180\t10.70.39.10\t22, 8888" },
    });
    expect(screen.getByTestId("netcheck-paste-summary")).toHaveTextContent("Rules found: 1");
    await fireEvent.click(screen.getByTestId("netcheck-paste-show"));
    expect(screen.getByTestId("netcheck-paste-lines")).toHaveTextContent("header");
    await fireEvent.click(screen.getByTestId("netcheck-paste-add"));
    expect(screen.getAllByTestId("netcheck-rule-row")).toHaveLength(1);
    expect((screen.getByTestId("netcheck-inbox") as HTMLTextAreaElement).value).toBe("");

    await fireEvent.click(screen.getByTestId("netcheck-run"));
    expect(await screen.findByTestId("netcheck-status-open")).toBeInTheDocument();
    expect(screen.getByTestId("netcheck-status-refused")).toBeInTheDocument();
    expect(screen.getByTestId("netcheck-tally")).toHaveTextContent("1 / 2 open");
    expect(runs()).toEqual([["s1", [{ host: "10.70.39.10", ports: [22, 8888] }]]]);
    expect(netcheckState.history["10.64.48.180"]).toEqual(["10.64.48.180 -> 10.70.39.10:[22, 8888]/tcp"]);
  });

  it("copies the report as text or as a Markdown table", async () => {
    serve();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setRows("10.64.48.180", textRows("10.64.48.180 -> 10.70.39.10:[22, 8888]/tcp"));
    render(UtilNetCheck, { props: props() });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await screen.findByTestId("netcheck-tally");

    await fireEvent.click(screen.getByTestId("netcheck-copy"));
    const text = writeText.mock.calls.at(-1)![0];
    expect(text).toMatch(/^Access check · app-01 \(10\.64\.48\.180\) · \d{4}-\d\d-\d\d \d\d:\d\d [+-]\d\d:\d\d · 1 of 2 open\n/);
    expect(text).toContain("Method: bash /dev/tcp · timeout 3 s");
    expect(text).toContain("✓ 10.64.48.180 → 10.70.39.10:22/tcp    open");
    expect(text).toContain("✗ 10.64.48.180 → 10.70.39.10:8888/tcp  refused");

    await fireEvent.click(screen.getByTestId("netcheck-copy-md"));
    expect(writeText.mock.calls.at(-1)![0]).toContain("| ✓ | 10.64.48.180 | 10.70.39.10 | 22/tcp | open |");
  });

  it("retries only what didn't come back open", async () => {
    serve();
    setRows("10.64.48.180", textRows("10.70.39.10:[22, 8888]"));
    render(UtilNetCheck, { props: props() });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await fireEvent.click(await screen.findByTestId("netcheck-retry"));
    await waitFor(() => expect(runs().at(-1)).toEqual(["s1", [{ host: "10.70.39.10", ports: [8888] }]]));
  });

  it("runs a rule from the server its source names, every server at once", async () => {
    serve();
    setRows("10.64.48.180", textRows("app-02 -> 10.70.39.10:22\n10.70.39.10:8888"));
    render(UtilNetCheck, { props: props({ tabs: [s1, tab("s2", "a2")] }) });
    await screen.findByTestId("netcheck-hostname");
    const routes = screen.getAllByTestId("netcheck-route");
    expect(routes[0]).toHaveTextContent("app-02");
    expect(routes[1]).toHaveTextContent("app-01");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await waitFor(() => expect(screen.getAllByTestId("netcheck-column")).toHaveLength(2));
    expect(runs()).toEqual(
      expect.arrayContaining([
        ["s2", [{ host: "10.70.39.10", ports: [22] }]],
        ["s1", [{ host: "10.70.39.10", ports: [8888] }]],
      ]),
    );
    // What a server wasn't asked reads "—", not a verdict.
    await screen.findAllByTestId("netcheck-status-open");
    expect(screen.getAllByTestId("netcheck-row")).toHaveLength(2);
  });

  it("checks from this tab when no server has the source, and says so", async () => {
    serve();
    setRows("10.64.48.180", textRows("10.1.1.1 -> 10.70.39.10:22"));
    render(UtilNetCheck, { props: props() });
    expect(await screen.findByTestId("netcheck-source-warn")).toHaveTextContent("10.1.1.1");
  });

  it("offers Connect for a server a rule needs, and checks the rest without it", async () => {
    serve();
    const onConnect = vi.fn();
    setRows("10.64.48.180", textRows("app-02 -> 10.70.39.10:22\n10.70.39.10:80"));
    render(UtilNetCheck, { props: props({ onConnect }) });
    await screen.findByTestId("netcheck-hostname");
    expect(screen.getByTestId("netcheck-waiting")).toHaveTextContent("app-02");
    await fireEvent.click(screen.getByTestId("netcheck-connect"));
    expect(onConnect).toHaveBeenCalledWith("a2");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await waitFor(() => expect(runs()).toEqual([["s1", [{ host: "10.70.39.10", ports: [80] }]]]));
  });

  it("asks before sweeping a subnet, and names a production server", async () => {
    serve();
    setRows("10.64.48.181", textRows("192.168.0.0/30:22"));
    render(UtilNetCheck, { props: props({ homeId: "s2", tabs: [tab("s2", "a2")] }) });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    expect(screen.getByTestId("netcheck-confirm-hosts")).toHaveTextContent("app-02: 2 connects");
    expect(screen.getByTestId("netcheck-confirm-prod")).toHaveTextContent("production");
    expect(runs()).toEqual([]);
    const dialog = screen.getByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    await waitFor(() =>
      expect(runs()).toEqual([["s2", [{ host: "192.168.0.1", ports: [22] }, { host: "192.168.0.2", ports: [22] }]]]),
    );
    expect(await screen.findByTestId("netcheck-subnet-cell")).toHaveTextContent("open on 2 of 2");
  });

  it("stops a run: the running server gets its stop and reads 'stopped'", async () => {
    let reject: (e: unknown) => void = () => {};
    netcheckRun.mockImplementation((sid: string, _a: string[], targets: unknown[]) =>
      targets.length === 0
        ? Promise.resolve(ok(identity(sid) + "E\n"))
        : new Promise((_res, rej) => {
            reject = rej;
          }),
    );
    sftpCancel.mockImplementation(async () => reject("cancelled: stopped by the user"));
    setRows("10.64.48.180", textRows("10.70.39.10:22"));
    render(UtilNetCheck, { props: props() });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await fireEvent.click(await screen.findByTestId("netcheck-stop"));
    const cancelId = netcheckRun.mock.calls.at(-1)![5];
    expect(sftpCancel).toHaveBeenCalledWith(cancelId);
    expect(await screen.findByTestId("netcheck-stopped")).toBeInTheDocument();
    expect(screen.getByTestId("netcheck-run")).toBeInTheDocument();
  });

  it("keeps rules and the last answer per server: another tab shows its own", async () => {
    serve();
    setRows("10.64.48.180", textRows("10.70.39.10:22"));
    const first = render(UtilNetCheck, { props: props({ tabs: [s1, tab("s2", "a2")] }) });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await screen.findByTestId("netcheck-status-open");
    first.unmount();

    const second = render(UtilNetCheck, { props: props({ homeId: "s2", tabs: [s1, tab("s2", "a2")] }) });
    await waitFor(() => expect(screen.getByTestId("netcheck-hostname")).toHaveTextContent("app-02"));
    expect(screen.queryAllByTestId("netcheck-rule-row")).toHaveLength(0);
    expect(screen.queryByTestId("netcheck-results")).toBeNull();
    second.unmount();

    render(UtilNetCheck, { props: props({ tabs: [s1, tab("s2", "a2")] }) });
    expect(screen.getAllByTestId("netcheck-rule-row")).toHaveLength(1);
    expect(screen.getByTestId("netcheck-status-open")).toBeInTheDocument();
  });

  it("names a row's error and won't run without a valid rule", async () => {
    serve();
    setRows("10.64.48.180", textRows("10.70.39.300:22"));
    render(UtilNetCheck, { props: props() });
    await screen.findByTestId("netcheck-hostname");
    expect(screen.getByTestId("netcheck-row-error")).toHaveTextContent("10.70.39.300");
    expect(screen.getByTestId("netcheck-run")).toBeDisabled();
  });

  it("deletes a row and brings it back", async () => {
    serve();
    setRows("10.64.48.180", textRows("a.corp:1\nb.corp:2"));
    render(UtilNetCheck, { props: props() });
    await fireEvent.click(screen.getAllByTestId("netcheck-row-menu")[0]);
    await fireEvent.click(screen.getByText("Delete rule"));
    expect(screen.getAllByTestId("netcheck-rule-row")).toHaveLength(1);
    await fireEvent.click(screen.getByTestId("netcheck-undo"));
    const cells = screen.getAllByTestId("netcheck-cell-targets") as HTMLInputElement[];
    expect(cells.map((c) => c.value)).toEqual(["a.corp", "b.corp"]);
  });

  it("spreads a host:port typed into the target cell over two cells", async () => {
    serve();
    render(UtilNetCheck, { props: props() });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-add-row"));
    await fireEvent.input(screen.getByTestId("netcheck-cell-targets"), { target: { value: "db.corp:5432" } });
    expect((screen.getByTestId("netcheck-cell-targets") as HTMLInputElement).value).toBe("db.corp");
    expect((screen.getByTestId("netcheck-cell-ports") as HTMLInputElement).value).toBe("5432");
  });

  it("offers telnet on the server that has nothing to probe with", async () => {
    serve("none");
    const onInstallTool = vi.fn();
    setRows("10.64.48.180", textRows("10.70.39.10:22"));
    render(UtilNetCheck, { props: props({ onInstallTool }) });
    await fireEvent.click(await screen.findByTestId("netcheck-install-telnet"));
    expect(onInstallTool).toHaveBeenCalledWith("telnet", "s1");
  });

  it("never offers an install on a local tab", async () => {
    serve("none");
    render(UtilNetCheck, { props: props({ homeId: "L", tabs: [tab("L", "")], onInstallTool: vi.fn() }) });
    await screen.findByTestId("netcheck-nomethod");
    expect(screen.queryByTestId("netcheck-install-telnet")).toBeNull();
  });

  it("asks for a connected tab when there is none", () => {
    render(UtilNetCheck, { props: { homeId: null, servers, tabs: [] } });
    expect(screen.getByTestId("netcheck-nosession")).toBeInTheDocument();
    expect(netcheckRun).not.toHaveBeenCalled();
  });

  describe("probe method tiles", () => {
    const TOOLS = "C\tbash\tok\nC\tnc\tok\nC\ttelnet\tmissing\nC\tcurl\tnotimeout\n";
    function serveTools() {
      netcheckRun.mockImplementation(async (sid: string, _args: string[], targets: unknown[]) =>
        ok(identity(sid) + TOOLS + (targets.length ? "R\t10.70.39.10\t22\t0\t1\t1\t\n" : "") + "E\n"),
      );
    }

    it("marks each tool usable or not; unusable ones are struck through", async () => {
      serveTools();
      render(UtilNetCheck, { props: props() });
      await waitFor(() => expect(screen.getByTestId("netcheck-method-telnet").innerHTML).toContain("bg-bad"));
      expect(screen.getByTestId("netcheck-method-bash").innerHTML).toContain("bg-ok");
      expect(screen.getByTestId("netcheck-method-telnet").innerHTML).toContain("line-through");
      expect(screen.getByTestId("netcheck-method-curl").innerHTML).toContain("line-through");
      expect(screen.getByTestId("netcheck-method-auto")).toHaveAttribute("aria-checked", "true");
    });

    it("picking a missing tool says so, offers the install and blocks the run", async () => {
      serveTools();
      const onInstallTool = vi.fn();
      setRows("10.64.48.180", textRows("10.70.39.10:22"));
      render(UtilNetCheck, { props: props({ onInstallTool }) });
      await screen.findByTestId("netcheck-hostname");
      await waitFor(() => expect(screen.getByTestId("netcheck-run")).not.toBeDisabled());
      await fireEvent.click(screen.getByTestId("netcheck-method-telnet"));
      expect(screen.getByTestId("netcheck-method-missing")).toHaveTextContent("telnet isn't installed");
      expect(screen.getByTestId("netcheck-run")).toBeDisabled();
      expect(screen.getByTestId("netcheck-nomethod-on")).toHaveTextContent("app-01");
      await fireEvent.click(screen.getByTestId("netcheck-method-install"));
      expect(onInstallTool).toHaveBeenCalledWith("telnet", "s1");
      // Remembered for this checking host.
      expect(netcheckState.methods).toEqual({ "10.64.48.180": "telnet" });
    });

    it("explains a tool that's there but can't be bounded, without an install button", async () => {
      serveTools();
      render(UtilNetCheck, { props: props({ onInstallTool: vi.fn() }) });
      await screen.findByTestId("netcheck-hostname");
      await waitFor(() => expect(screen.getByTestId("netcheck-method-curl").innerHTML).toContain("line-through"));
      await fireEvent.click(screen.getByTestId("netcheck-method-curl"));
      expect(screen.getByTestId("netcheck-method-missing")).toHaveTextContent("timeout");
      expect(screen.queryByTestId("netcheck-method-install")).toBeNull();
    });

    it("runs with the picked tool and shows it as the method", async () => {
      serveTools();
      netcheckState.methods = { "10.64.48.180": "nc" };
      setRows("10.64.48.180", textRows("10.70.39.10:22"));
      render(UtilNetCheck, { props: props() });
      await waitFor(() => expect(screen.getByTestId("netcheck-method")).toHaveTextContent("nc"));
      expect(screen.getByTestId("netcheck-method-nc")).toHaveAttribute("aria-checked", "true");
      await fireEvent.click(screen.getByTestId("netcheck-run"));
      await waitFor(() => expect(runs()).toHaveLength(1));
      const call = netcheckRun.mock.calls.find((c) => (c[2] as unknown[]).length > 0)!;
      expect((call[1] as string[])[2]).toContain(`[ "$Cn" = ok ] && M=nc`);
    });

    it("arrow keys move the choice like a radio group", async () => {
      serveTools();
      render(UtilNetCheck, { props: props() });
      await screen.findByTestId("netcheck-hostname");
      await fireEvent.keyDown(screen.getByTestId("netcheck-method-auto"), { key: "ArrowRight" });
      expect(screen.getByTestId("netcheck-method-bash")).toHaveAttribute("aria-checked", "true");
    });

    it("is not offered on a local tab — the check is native there", async () => {
      serve();
      render(UtilNetCheck, { props: props({ homeId: "L", tabs: [tab("L", "")] }) });
      await screen.findByTestId("netcheck-hostname");
      expect(screen.queryByTestId("netcheck-methods")).toBeNull();
    });
  });
});
