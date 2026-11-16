import { describe, expect, it } from "vitest";
import { renderArgv } from "../terminal/termcmd";
import { asks, commandLine, helmInstallArgv, justRecipes, packageScripts, projectActions, projectTasks, rowActions, taskfileTasks } from "./projectactions";

const cmd = (kind: Parameters<typeof projectActions>[0], id: string, ctx = {}) => {
  const a = projectActions(kind, ctx).find((x) => x.id === id)!;
  return commandLine(a.cmd, "posix", renderArgv);
};

describe("projectActions", () => {
  it("builds each kind's commands", () => {
    expect(cmd("python", "test", { manager: "uv" })).toBe("uv run pytest");
    expect(cmd("python", "test", { manager: "pip" })).toBe("python3 -m pytest");
    expect(cmd("python", "venv")).toBe(". .venv/bin/activate");
    expect(cmd("rust", "test")).toBe("cargo test");
    expect(cmd("go", "test")).toBe("go test ./...");
    expect(cmd("node", "install", { manager: "pnpm" })).toBe("pnpm install --frozen-lockfile");
    expect(cmd("compose", "up")).toBe("docker compose up -d");
    expect(cmd("kustomize", "apply", { kubeContext: "prod-eu" })).toBe("kubectl --context prod-eu apply -k .");
    expect(cmd("kustomize", "apply")).toBe("kubectl apply -k .");
    expect(cmd("nginx", "reload")).toBe("sudo nginx -t && sudo systemctl reload nginx");
    expect(cmd("docker", "build", { folder: "Web App" })).toBe("docker build .");
    expect(cmd("docker", "build", { folder: "api" })).toBe("docker build -t api:dev .");
  });

  it("asks before what stops or replaces, and on prod before what starts", () => {
    const by = (kind: Parameters<typeof projectActions>[0], id: string) => projectActions(kind).find((a) => a.id === id)!;
    expect(asks(by("compose", "down"), false)).toBe(true);
    expect(asks(by("compose", "up"), false)).toBe(false);
    expect(asks(by("compose", "up"), true)).toBe(true);
    expect(asks(by("kustomize", "apply"), false)).toBe(true);
    expect(asks(by("helm", "install"), false)).toBe(true);
    expect(asks(by("nginx", "reload"), true)).toBe(true);
    expect(asks(by("rust", "test"), true)).toBe(false);
  });

  it("has one main button per kind and puts init first in an uninitialised Terraform folder", () => {
    for (const kind of ["ansible", "terraform", "python", "rust", "go", "compose", "docker", "kustomize", "k8s", "helm", "nginx", "systemd"] as const) {
      expect(projectActions(kind).filter((a) => a.primary).length, kind).toBe(1);
    }
    expect(projectActions("terraform", { initialised: false })[0].id).toBe("init");
    expect(projectActions("terraform", { initialised: true })[0].id).toBe("validate");
  });

  it("refuses a shell a line has no form in", () => {
    const reload = projectActions("nginx").find((a) => a.id === "reload")!;
    expect(commandLine(reload.cmd, "powershell", renderArgv)).toBeNull();
    const venv = projectActions("python").find((a) => a.id === "venv")!;
    expect(commandLine(venv.cmd, "powershell", renderArgv)).toBe(".venv\\Scripts\\Activate.ps1");
  });
});

describe("rowActions", () => {
  it("gives a unit its status, journal and switches", () => {
    const acts = rowActions("systemd", "/etc/systemd/system", { name: "agent.service", isDir: false });
    expect(acts.map((a) => [a.id, a.ask])).toEqual([
      ["status", "none"],
      ["journal", "none"],
      ["verify", "none"],
      ["restart", "always"],
      ["enable", "prod"],
      ["disable", "always"],
    ]);
    expect(commandLine(acts[2].cmd, "posix", renderArgv)).toBe("systemd-analyze verify /etc/systemd/system/agent.service");
    expect(rowActions("systemd", "/etc/systemd/system", { name: "x.d", isDir: true })).toEqual([]);
  });

  it("enables a site from sites-available and disables it from sites-enabled", () => {
    const en = rowActions("nginx", "/etc/nginx/sites-available", { name: "app", isDir: false });
    expect(commandLine(en[0].cmd, "posix", renderArgv)).toBe("sudo ln -s /etc/nginx/sites-available/app /etc/nginx/sites-enabled/app");
    const dis = rowActions("nginx", "/etc/nginx/sites-enabled", { name: "app", isDir: false });
    expect(dis[0].ask).toBe("always");
    expect(rowActions("nginx", "/etc/nginx", { name: "nginx.conf", isDir: false })).toEqual([]);
  });
});

describe("tasks", () => {
  it("reads justfiles, Taskfiles and package.json scripts", () => {
    expect(justRecipes("set shell := [\"bash\"]\nalias b := build\nbuild:\n  cargo build\n@test arg='x':\n  cargo test\n_private:\n")).toEqual(["build", "test"]);
    expect(taskfileTasks("version: '3'\ntasks:\n  build:\n    cmds: [x]\n  lint:\n    cmds: [y]\nvars:\n  a: 1\n")).toEqual(["build", "lint"]);
    expect(packageScripts('{"scripts":{"dev":"vite","build":"vite build"}}')).toEqual(["dev", "build"]);
    expect(packageScripts("nope")).toEqual([]);
  });

  it("turns them into commands", () => {
    expect(projectTasks("Makefile", "build:\n\tgo build\n", null)).toEqual([{ name: "build", argv: ["make", "build"] }]);
    expect(projectTasks("package.json", '{"scripts":{"test":"vitest"}}', "pnpm")).toEqual([{ name: "test", argv: ["pnpm", "run", "test"] }]);
    expect(projectTasks("notes.txt", "x", null)).toEqual([]);
  });
});

describe("helmInstallArgv", () => {
  it("builds the install from the form and refuses what helm would not take", () => {
    expect(helmInstallArgv({ release: "api", namespace: "api", values: "values-prod.yaml" }, "prod-eu")).toEqual([
      "helm", "upgrade", "--install", "api", ".", "-n", "api", "-f", "values-prod.yaml", "--kube-context", "prod-eu",
    ]);
    expect(helmInstallArgv({ release: "api", namespace: "default", values: null }, null)).toEqual(["helm", "upgrade", "--install", "api", ".", "-n", "default"]);
    expect(helmInstallArgv({ release: "Api", namespace: "x", values: null }, null)).toBeNull();
    expect(helmInstallArgv({ release: "api", namespace: "x", values: "--set=a" }, null)).toBeNull();
  });
});
