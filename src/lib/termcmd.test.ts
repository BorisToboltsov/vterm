import { describe, expect, it } from "vitest";
import { renderArgv, SHELL_SCRIPT } from "./termcmd";
import { execShellArgv } from "./docker";
import { execShellArgv as kubeExecArgv, portForwardArgv } from "./k8s";

const SCOPE = { context: null, namespace: null, allNamespaces: false };

describe("renderArgv — docker exec in each dialect", () => {
  const argv = execShellArgv("451d79ad656d");

  it("posix: single-quotes the script", () => {
    expect(renderArgv(argv, "posix")).toBe(
      `docker exec -it 451d79ad656d sh -c '${SHELL_SCRIPT}'`,
    );
  });

  it("cmd: double-quotes the script, so cmd leaves `>` and `&&` alone", () => {
    const line = renderArgv(argv, "cmd")!;
    expect(line).toBe(`docker exec -it 451d79ad656d sh -c "${SHELL_SCRIPT}"`);
    // The regression: nothing of cmd's metacharacters may sit outside quotes.
    const outside = line.replace(/"[^"]*"/g, "");
    expect(outside).not.toMatch(/[<>&|']/);
  });

  it("powershell: single-quotes the script", () => {
    expect(renderArgv(argv, "powershell")).toBe(
      `docker exec -it 451d79ad656d sh -c '${SHELL_SCRIPT}'`,
    );
  });
});

describe("renderArgv — quoting rules", () => {
  it("leaves safe tokens bare and quotes the rest", () => {
    expect(renderArgv(["kubectl", "--context", "arn:aws:eks:eu/prod"], "posix")).toBe(
      "kubectl --context arn:aws:eks:eu/prod",
    );
    expect(renderArgv(["echo", "a b"], "cmd")).toBe('echo "a b"');
  });

  it("posix escapes an embedded single quote", () => {
    expect(renderArgv(["echo", "it's"], "posix")).toBe(`echo 'it'\\''s'`);
  });

  it("powershell doubles an embedded single quote", () => {
    expect(renderArgv(["echo", "it's"], "powershell")).toBe("echo 'it''s'");
  });

  it("powershell quotes a bare `--` (its own end-of-parameters marker)", () => {
    const line = renderArgv(kubeExecArgv(["kubectl"], "api-1", "web", null, SCOPE), "powershell");
    expect(line).toBe(`kubectl exec -it --namespace web api-1 '--' sh -c '${SHELL_SCRIPT}'`);
  });

  it("powershell runs a quoted program through the call operator", () => {
    const prog = "C:\\Program Files\\kubectl.exe";
    expect(renderArgv([prog, "version"], "powershell")).toBe(`& '${prog}' version`);
    expect(renderArgv([prog, "version"], "cmd")).toBe(`"${prog}" version`);
  });

  it("cmd refuses what it cannot quote (`\"`, `%VAR%`)", () => {
    expect(renderArgv(["echo", 'say "hi"'], "cmd")).toBeNull();
    expect(renderArgv(["echo", "%PATH%"], "cmd")).toBeNull();
    expect(renderArgv(["echo", 'say "hi"'], "posix")).toBe(`echo 'say "hi"'`);
  });

  it("refuses a newline or an empty argv", () => {
    expect(renderArgv(["echo", "a\nrm -rf /"], "posix")).toBeNull();
    expect(renderArgv([], "posix")).toBeNull();
  });

  it("port-forward needs no quoting anywhere", () => {
    const argv = portForwardArgv(["kubectl"], "svc/api", "web", 8080, 80, SCOPE);
    for (const shell of ["posix", "cmd"] as const)
      expect(renderArgv(argv, shell)).toBe(
        "kubectl port-forward --namespace web svc/api 8080:80",
      );
  });
});
