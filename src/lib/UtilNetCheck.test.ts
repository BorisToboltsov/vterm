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
  netcheckState.methods = {};
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

  it("copies the report as text or as a Markdown table", async () => {
    serve();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    netcheckState.draft = "10.64.48.180 -> 10.70.39.10:[22, 8888]/tcp";
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.click(screen.getByTestId("netcheck-run"));
    await screen.findByTestId("netcheck-tally");

    await fireEvent.click(screen.getByTestId("netcheck-copy"));
    const text = writeText.mock.calls.at(-1)![0];
    // Header: host without loopback, a timestamp, the tally, then method + timeout.
    expect(text).toMatch(/^Access check · app-01 \(10\.64\.48\.180\) · \d{4}-\d\d-\d\d \d\d:\d\d [+-]\d\d:\d\d · 1 of 2 open\n/);
    expect(text).toContain("Method: bash /dev/tcp · timeout 3 s");
    expect(text).toContain("✓ 10.64.48.180 → 10.70.39.10:22/tcp    open");
    expect(text).toContain("✗ 10.64.48.180 → 10.70.39.10:8888/tcp  refused");

    await fireEvent.click(screen.getByTestId("netcheck-copy-md"));
    const md = writeText.mock.calls.at(-1)![0];
    expect(md).toContain("| ✓ | 10.64.48.180 | 10.70.39.10 | 22/tcp | open |");
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
    const onInstallTool = vi.fn();
    netcheckState.draft = "10.70.39.10:22";
    render(UtilNetCheck, { props: { session: ssh, onInstallTool } });
    await fireEvent.click(await screen.findByTestId("netcheck-install-telnet"));
    expect(onInstallTool).toHaveBeenCalledWith("telnet");
    expect(screen.getByTestId("netcheck-run")).toBeDisabled();
  });

  it("never offers an install on a local tab", async () => {
    serve("none");
    render(UtilNetCheck, {
      props: { session: { ...ssh, kind: "local" }, onInstallTool: vi.fn() },
    });
    await screen.findByTestId("netcheck-nomethod");
    expect(screen.queryByTestId("netcheck-install-telnet")).toBeNull();
  });

  it("asks for a connected tab when there is none", () => {
    render(UtilNetCheck, { props: { session: null } });
    expect(screen.getByTestId("netcheck-nosession")).toBeInTheDocument();
    expect(netcheckRun).not.toHaveBeenCalled();
  });

  it("builds a rule from fields: host's first address as source, Enter adds a line", async () => {
    serve();
    netcheckState.draft = "10.70.39.10:80";
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    // Source follows the host's addresses once they load (loopback hidden).
    await waitFor(() =>
      expect((screen.getByTestId("netcheck-b-source") as HTMLSelectElement).value).toBe("10.64.48.180"),
    );
    const target = screen.getByTestId("netcheck-b-target") as HTMLInputElement;
    expect(target.placeholder).toBe("0.0.0.0");
    expect((screen.getByTestId("netcheck-b-add") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(target, { target: { value: "10.70.39.20" } });
    await fireEvent.input(screen.getByTestId("netcheck-b-ports"), { target: { value: "22, 443" } });
    await fireEvent.keyDown(target, { key: "Enter" });
    expect(netcheckState.draft).toBe("10.70.39.10:80\n10.64.48.180 -> 10.70.39.20:[22, 443]/tcp");
    // Cleared for the next rule.
    expect(target.value).toBe("");
  });

  it("splits a pasted host:port and can drop the source", async () => {
    serve();
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.change(screen.getByTestId("netcheck-b-source"), { target: { value: "" } });
    await fireEvent.input(screen.getByTestId("netcheck-b-target"), { target: { value: "db.corp:5432" } });
    expect((screen.getByTestId("netcheck-b-ports") as HTMLInputElement).value).toBe("5432");
    await fireEvent.click(screen.getByTestId("netcheck-b-add"));
    expect(netcheckState.draft).toBe("db.corp:5432/tcp");
  });

  it("won't add the unfilled placeholder address, and says why", async () => {
    serve();
    render(UtilNetCheck, { props: { session: ssh } });
    await screen.findByTestId("netcheck-hostname");
    await fireEvent.input(screen.getByTestId("netcheck-b-target"), { target: { value: "0.0.0.0" } });
    await fireEvent.input(screen.getByTestId("netcheck-b-ports"), { target: { value: "22" } });
    expect(screen.getByTestId("netcheck-b-error")).toHaveTextContent("any address");
    expect((screen.getByTestId("netcheck-b-add") as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByTestId("netcheck-b-add"));
    expect(netcheckState.draft).toBe("");
  });

  describe("per-line trash", () => {
    /** Point the mouse at line `i` of a 24px-line box with a 1px border and 6px
     *  top padding (the real `border` + `py-1.5` + `leading-6`). */
    async function hoverLine(i: number) {
      const box = screen.getByTestId("netcheck-rules") as HTMLTextAreaElement;
      box.style.lineHeight = "24px";
      box.style.paddingTop = "6px";
      box.style.borderTopWidth = "1px";
      await fireEvent.mouseMove(box, { clientY: 7 + i * 24 + 5 });
      return box;
    }

    it("shows a trash beside a hovered line with content, none on blank lines", async () => {
      serve();
      netcheckState.draft = "a.corp:1\n\nb.corp:2";
      render(UtilNetCheck, { props: { session: ssh } });
      await hoverLine(0);
      expect(screen.getByTestId("netcheck-delete-line").style.top).toBe("7px");
      await hoverLine(1);
      expect(screen.queryByTestId("netcheck-delete-line")).toBeNull();
      await hoverLine(2);
      expect(screen.getByTestId("netcheck-delete-line").style.top).toBe("55px");
    });

    it("deletes through the editor's delete command, so ⌘Z can restore it", async () => {
      serve();
      netcheckState.draft = "a.corp:1\nb.corp:2\nc.corp:3";
      render(UtilNetCheck, { props: { session: ssh } });
      const box = await hoverLine(1);
      const exec = vi.fn(() => true);
      (document as unknown as { execCommand: typeof exec }).execCommand = exec;
      try {
        await fireEvent.click(screen.getByTestId("netcheck-delete-line"));
        expect(exec).toHaveBeenCalledWith("delete");
        // The whole line and its break were selected for that command.
        expect([box.selectionStart, box.selectionEnd]).toEqual([9, 18]);
      } finally {
        delete (document as unknown as { execCommand?: unknown }).execCommand;
      }
    });

    it("falls back to rewriting the text when the command isn't available", async () => {
      serve();
      netcheckState.draft = "a.corp:1\nb.corp:2\nc.corp:3";
      render(UtilNetCheck, { props: { session: ssh } });
      await hoverLine(1);
      await fireEvent.click(screen.getByTestId("netcheck-delete-line"));
      expect(netcheckState.draft).toBe("a.corp:1\nc.corp:3");
      expect(screen.queryByTestId("netcheck-delete-line")).toBeNull();
    });
  });

  describe("probe method tiles", () => {
    const TOOLS = "C\tbash\tok\nC\tnc\tok\nC\ttelnet\tmissing\nC\tcurl\tnotimeout\n";
    function serveTools() {
      netcheckRun.mockImplementation(async (_id: string, _args: string[], targets: unknown[]) =>
        ok(identity() + TOOLS + (targets.length ? "R\t10.70.39.10\t22\t0\t1\t1\t\n" : "") + "E\n"),
      );
    }

    it("marks each tool usable or not; unusable ones are struck through", async () => {
      serveTools();
      render(UtilNetCheck, { props: { session: ssh } });
      await waitFor(() =>
        expect(screen.getByTestId("netcheck-method-telnet").innerHTML).toContain("bg-bad"),
      );
      expect(screen.getByTestId("netcheck-method-bash").innerHTML).toContain("bg-ok");
      expect(screen.getByTestId("netcheck-method-telnet").innerHTML).toContain("line-through");
      expect(screen.getByTestId("netcheck-method-curl").innerHTML).toContain("line-through");
      expect(screen.getByTestId("netcheck-method-auto")).toHaveAttribute("aria-checked", "true");
    });

    it("picking a missing tool says so, offers the install and blocks the run", async () => {
      serveTools();
      const onInstallTool = vi.fn();
      netcheckState.draft = "10.70.39.10:22";
      render(UtilNetCheck, { props: { session: ssh, onInstallTool } });
      await screen.findByTestId("netcheck-hostname");
      await waitFor(() => expect(screen.getByTestId("netcheck-run")).not.toBeDisabled());
      await fireEvent.click(screen.getByTestId("netcheck-method-telnet"));
      expect(screen.getByTestId("netcheck-method-missing")).toHaveTextContent("telnet isn't installed");
      expect(screen.getByTestId("netcheck-run")).toBeDisabled();
      await fireEvent.click(screen.getByTestId("netcheck-method-install"));
      expect(onInstallTool).toHaveBeenCalledWith("telnet");
      // Remembered for this checking host.
      expect(netcheckState.methods).toEqual({ "10.64.48.180": "telnet" });
    });

    it("explains a tool that's there but can't be bounded, without an install button", async () => {
      serveTools();
      render(UtilNetCheck, { props: { session: ssh, onInstallTool: vi.fn() } });
      await screen.findByTestId("netcheck-hostname");
      await fireEvent.click(screen.getByTestId("netcheck-method-curl"));
      expect(screen.getByTestId("netcheck-method-missing")).toHaveTextContent("timeout");
      expect(screen.queryByTestId("netcheck-method-install")).toBeNull();
    });

    it("runs with the picked tool and shows it as the method", async () => {
      serveTools();
      netcheckState.methods = { "10.64.48.180": "nc" };
      netcheckState.draft = "10.70.39.10:22";
      render(UtilNetCheck, { props: { session: ssh } });
      await waitFor(() => expect(screen.getByTestId("netcheck-method")).toHaveTextContent("nc"));
      expect(screen.getByTestId("netcheck-method-nc")).toHaveAttribute("aria-checked", "true");
      await fireEvent.click(screen.getByTestId("netcheck-run"));
      await waitFor(() => expect(netcheckRun.mock.calls.length).toBeGreaterThan(1));
      const script = (netcheckRun.mock.calls.at(-1)![1] as string[])[2];
      expect(script).toContain(`[ "$Cn" = ok ] && M=nc`);
    });

    it("arrow keys move the choice like a radio group", async () => {
      serveTools();
      render(UtilNetCheck, { props: { session: ssh } });
      await screen.findByTestId("netcheck-hostname");
      await fireEvent.keyDown(screen.getByTestId("netcheck-method-auto"), { key: "ArrowRight" });
      expect(screen.getByTestId("netcheck-method-bash")).toHaveAttribute("aria-checked", "true");
    });

    it("is not offered on a local tab — the check is native there", async () => {
      serve();
      render(UtilNetCheck, { props: { session: { ...ssh, kind: "local" } } });
      await screen.findByTestId("netcheck-hostname");
      expect(screen.queryByTestId("netcheck-methods")).toBeNull();
    });
  });
});
