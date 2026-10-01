import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { createRawSnippet } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeRun = vi.fn();
const writeToTerminal = vi.fn();
vi.mock("./api", () => ({
  probeRun: (...a: unknown[]) => probeRun(...a),
  writeToTerminal: (...a: unknown[]) => writeToTerminal(...a),
}));

import UtilProbeRunner from "./UtilProbeRunner.svelte";
import type { ProbeSession } from "./probe";

const form = createRawSnippet(() => ({ render: () => "<span>form</span>" }));
const result = createRawSnippet((out: () => { stdout: string }) => ({
  render: () => `<pre data-testid="out">${out().stdout}</pre>`,
}));
const ssh: ProbeSession = { id: "s1", kind: "ssh", live: true, host: "srv", isProd: false, shell: "posix" };
const local: ProbeSession = { ...ssh, id: "l1", kind: "local", host: "local", shell: "powershell" };
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

beforeEach(() => {
  probeRun.mockReset();
  writeToTerminal.mockReset();
});

describe("UtilProbeRunner", () => {
  it("SSH: runs the argv on the server, no terminal button", async () => {
    probeRun.mockResolvedValue(ok("remote"));
    render(UtilProbeRunner, { props: { session: ssh, args: ["curl", "x"], form, result } });
    expect(screen.queryByTestId("probe-terminal")).toBeNull();
    await userEvent.click(screen.getByTestId("probe-run"));
    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("remote"));
    expect(probeRun).toHaveBeenCalledWith("s1", ["curl", "x"], 20);
  });

  it("local: Run captures the result, piping each step into the next", async () => {
    probeRun.mockResolvedValueOnce(ok("PEM")).mockResolvedValueOnce(ok("subject=CN=x"));
    const steps = [["openssl", "s_client"], ["openssl", "x509"]];
    render(UtilProbeRunner, { props: { session: local, args: ["sh"], steps, form, result } });
    await userEvent.click(screen.getByTestId("probe-run"));
    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("subject=CN=x"));
    expect(probeRun.mock.calls).toEqual([
      ["l1", ["openssl", "s_client"], 20, true, null],
      ["l1", ["openssl", "x509"], 20, true, "PEM"],
    ]);
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("local: a failed step ends the chain with its own message", async () => {
    probeRun.mockResolvedValueOnce({ stdout: "", stderr: "connect: refused", exitCode: 1 });
    const steps = [["openssl", "s_client"], ["openssl", "x509"]];
    render(UtilProbeRunner, { props: { session: local, args: ["sh"], steps, form, result } });
    await userEvent.click(screen.getByTestId("probe-run"));
    await waitFor(() => expect(probeRun).toHaveBeenCalledOnce());
  });

  it("local: says the tool is missing on this computer", async () => {
    probeRun.mockResolvedValue({ stdout: "", stderr: "openssl: not found", exitCode: 127 });
    render(UtilProbeRunner, { props: { session: local, args: ["openssl", "x"], form, result } });
    await userEvent.click(screen.getByTestId("probe-run"));
    await waitFor(() => expect(screen.getByTestId("probe-missing")).toHaveTextContent("openssl"));
  });

  it("local: Run in terminal types the shell-specific command with CR", async () => {
    render(UtilProbeRunner, {
      props: { session: local, args: ["curl", "x"], terminalCommand: "curl.exe -sS x", form, result },
    });
    await userEvent.click(screen.getByTestId("probe-terminal"));
    expect(writeToTerminal).toHaveBeenCalledOnce();
    const [id, bytes] = writeToTerminal.mock.calls[0] as [string, Uint8Array];
    expect(id).toBe("l1");
    expect(new TextDecoder().decode(bytes)).toBe("curl.exe -sS x\r");
    expect(probeRun).not.toHaveBeenCalled();
  });

  it("local: no terminal command for this shell → the button is disabled", () => {
    render(UtilProbeRunner, { props: { session: local, args: ["curl", "x"], form, result } });
    expect(screen.getByTestId("probe-terminal")).toBeDisabled();
    expect(screen.getByTestId("probe-run")).toBeEnabled();
  });
});
