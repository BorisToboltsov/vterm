// What the project strip offers (ADR 0077): per kind, the commands a person
// runs in a project of that kind, typed into the connection's terminal — the
// user sees the command, can stop it, and answers its questions. The backend
// runs none of them. What changes a running system asks first: «always» for
// what stops or replaces (`down`, `apply`, `restart`), «on prod» for what
// starts or reloads. A task of a Makefile asks on prod: only the Makefile knows
// what it does.

import type { MessageKey } from "../i18n";
import type { CdShell } from "../pathsync/cdterminal";
import { makeTargets } from "../editor/outline";
import type { ProjectKind } from "./projectmap";

/** When a command asks before it is typed: never, on a prod server, or always. */
export type Ask = "none" | "prod" | "always";

/** A command: an argv quoted for whatever shell the tab runs, or ready lines per shell (a builtin, a chain). */
export type ProjectCommand = { argv: string[] } | { line: Partial<Record<CdShell, string>> };

export interface ProjectAction {
  id: string;
  label: MessageKey;
  cmd: ProjectCommand;
  ask: Ask;
  /** On the strip itself (the rest are under ▾). */
  strip?: boolean;
  /** The strip's main button. */
  primary?: boolean;
  /** Opens a panel or a dialog of the app instead of typing (Scenarios, Docker, k8s). */
  opens?: "scenarios-check" | "scenarios-run" | "scenarios-plan" | "docker" | "k8s";
}

/** What the strip knows beyond the listing. */
export interface ActionContext {
  /** uv / poetry / pipenv / pip; pnpm / yarn / npm / bun. */
  manager?: string | null;
  /** The folder holds `.terraform/` (initialised). */
  initialised?: boolean;
  /** The context kubectl and helm are told (the k8s panel's), when one is chosen. */
  kubeContext?: string | null;
  /** A main package at the top (`main.go`), and the commands under `cmd/`. */
  goMain?: boolean;
  /** Playbooks at the top, for the syntax check. */
  playbook?: string | null;
  /** The inventory of an Ansible project, as the user would pass it. */
  inventory?: string | null;
  /** The folder's name — the tag of an image built from it. */
  folder?: string;
}

const argv = (...a: string[]): ProjectCommand => ({ argv: a });
const posix = (line: string): ProjectCommand => ({ line: { posix: line } });

function ctxArgs(tool: "kubectl" | "helm", context: string | null | undefined): string[] {
  if (!context) return [];
  return tool === "kubectl" ? ["--context", context] : ["--kube-context", context];
}

function pyRun(manager: string | null | undefined, ...tool: string[]): string[] {
  switch (manager) {
    case "uv":
      return ["uv", "run", ...tool];
    case "poetry":
      return ["poetry", "run", ...tool];
    case "pdm":
      return ["pdm", "run", ...tool];
    case "pipenv":
      return ["pipenv", "run", ...tool];
    default:
      return tool[0] === "pytest" ? ["python3", "-m", "pytest", ...tool.slice(1)] : tool;
  }
}

function pyInstall(manager: string | null | undefined, requirements: boolean): string[] {
  switch (manager) {
    case "uv":
      return ["uv", "sync"];
    case "poetry":
      return ["poetry", "install"];
    case "pdm":
      return ["pdm", "install"];
    case "pipenv":
      return ["pipenv", "install"];
    default:
      return requirements ? ["pip", "install", "-r", "requirements.txt"] : ["pip", "install", "-e", "."];
  }
}

/** The actions of a project of `kind`, in the order the strip and its menu show them. */
export function projectActions(kind: ProjectKind, ctx: ActionContext = {}): ProjectAction[] {
  switch (kind) {
    case "ansible":
      return [
        { id: "check", label: "project.act.check", cmd: argv(), ask: "none", strip: true, opens: "scenarios-check" },
        { id: "run", label: "project.act.run", cmd: argv(), ask: "none", strip: true, primary: true, opens: "scenarios-run" },
        { id: "galaxy", label: "project.act.galaxy", cmd: argv("ansible-galaxy", "install", "-r", "requirements.yml"), ask: "none" },
        ...(ctx.inventory
          ? [{ id: "graph", label: "project.act.inventoryGraph" as const, cmd: argv("ansible-inventory", "-i", ctx.inventory, "--graph"), ask: "none" as const }]
          : []),
        ...(ctx.playbook
          ? [{ id: "syntax", label: "project.act.syntax" as const, cmd: argv("ansible-playbook", "--syntax-check", ctx.playbook), ask: "none" as const }]
          : []),
      ];
    case "terraform":
      return [
        ...(ctx.initialised === false
          ? [{ id: "init", label: "project.act.init" as const, cmd: argv("terraform", "init"), ask: "none" as const, strip: true }]
          : []),
        { id: "validate", label: "project.act.validate", cmd: argv("terraform", "validate"), ask: "none", strip: true },
        { id: "plan", label: "project.act.plan", cmd: argv(), ask: "none", strip: true, primary: true, opens: "scenarios-plan" },
        ...(ctx.initialised !== false ? [{ id: "init", label: "project.act.init" as const, cmd: argv("terraform", "init"), ask: "none" as const }] : []),
        { id: "upgrade", label: "project.act.initUpgrade", cmd: argv("terraform", "init", "-upgrade"), ask: "none" },
        { id: "output", label: "project.act.output", cmd: argv("terraform", "output"), ask: "none" },
      ];
    case "python":
      return [
        {
          id: "venv",
          label: "project.act.venv",
          cmd: { line: { posix: ". .venv/bin/activate", powershell: ".venv\\Scripts\\Activate.ps1", cmd: ".venv\\Scripts\\activate.bat" } },
          ask: "none",
          strip: true,
        },
        { id: "test", label: "project.act.test", cmd: argv(...pyRun(ctx.manager, "pytest")), ask: "none", strip: true, primary: true },
        { id: "deps", label: "project.act.deps", cmd: argv(...pyInstall(ctx.manager, true)), ask: "none" },
        { id: "lint", label: "project.act.lint", cmd: argv(...pyRun(ctx.manager, "ruff", "check", ".")), ask: "none" },
        { id: "types", label: "project.act.types", cmd: argv(...pyRun(ctx.manager, "mypy", ".")), ask: "none" },
      ];
    case "rust":
      return [
        { id: "check", label: "project.act.cargoCheck", cmd: argv("cargo", "check"), ask: "none", strip: true },
        { id: "test", label: "project.act.test", cmd: argv("cargo", "test"), ask: "none", strip: true, primary: true },
        { id: "clippy", label: "project.act.clippy", cmd: argv("cargo", "clippy", "--all-targets"), ask: "none" },
        { id: "release", label: "project.act.release", cmd: argv("cargo", "build", "--release"), ask: "none" },
        { id: "run", label: "project.act.start", cmd: argv("cargo", "run"), ask: "none" },
      ];
    case "go":
      return [
        { id: "build", label: "project.act.build", cmd: argv("go", "build", "./..."), ask: "none", strip: true },
        { id: "test", label: "project.act.test", cmd: argv("go", "test", "./..."), ask: "none", strip: true, primary: true },
        { id: "vet", label: "project.act.vet", cmd: argv("go", "vet", "./..."), ask: "none" },
        { id: "tidy", label: "project.act.tidy", cmd: argv("go", "mod", "tidy"), ask: "none" },
        ...(ctx.goMain ? [{ id: "run", label: "project.act.start" as const, cmd: argv("go", "run", "."), ask: "none" as const }] : []),
      ];
    case "node": {
      const m = ctx.manager ?? "npm";
      const install = m === "npm" ? argv("npm", "ci") : m === "yarn" ? argv("yarn", "install", "--frozen-lockfile") : m === "bun" ? argv("bun", "install") : argv("pnpm", "install", "--frozen-lockfile");
      return [
        { id: "install", label: "project.act.install", cmd: install, ask: "none", strip: true },
        { id: "update", label: "project.act.update", cmd: argv(m, m === "npm" || m === "pnpm" || m === "bun" ? "update" : "upgrade"), ask: "none" },
        { id: "audit", label: "project.act.audit", cmd: argv(m, "audit"), ask: "none" },
      ];
    }
    case "compose":
      return [
        { id: "ps", label: "project.act.status", cmd: argv("docker", "compose", "ps"), ask: "none", strip: true },
        { id: "up", label: "project.act.up", cmd: argv("docker", "compose", "up", "-d"), ask: "prod", strip: true, primary: true },
        { id: "logs", label: "project.act.logs", cmd: argv("docker", "compose", "logs", "-f", "--tail", "200"), ask: "none" },
        { id: "pull", label: "project.act.pull", cmd: argv("docker", "compose", "pull"), ask: "none" },
        { id: "build", label: "project.act.build", cmd: argv("docker", "compose", "build"), ask: "none" },
        { id: "config", label: "project.act.checkFile", cmd: argv("docker", "compose", "config", "--quiet"), ask: "none" },
        { id: "panel", label: "project.act.openDocker", cmd: argv(), ask: "none", opens: "docker" },
        { id: "down", label: "project.act.down", cmd: argv("docker", "compose", "down"), ask: "always" },
      ];
    case "docker":
      return [
        {
          id: "build",
          label: "project.act.build",
          cmd: argv("docker", "build", ...(ctx.folder && /^[a-z0-9][a-z0-9._-]*$/.test(ctx.folder.toLowerCase()) ? ["-t", `${ctx.folder.toLowerCase()}:dev`] : []), "."),
          ask: "none",
          strip: true,
          primary: true,
        },
      ];
    case "kustomize": {
      const c = ctxArgs("kubectl", ctx.kubeContext);
      return [
        { id: "show", label: "project.act.render", cmd: argv("kubectl", "kustomize", "."), ask: "none", strip: true },
        { id: "diff", label: "project.act.diff", cmd: argv("kubectl", ...c, "diff", "-k", "."), ask: "none", strip: true },
        { id: "apply", label: "project.act.apply", cmd: argv("kubectl", ...c, "apply", "-k", "."), ask: "always", strip: true, primary: true },
        { id: "dry", label: "project.act.dryRun", cmd: argv("kubectl", ...c, "apply", "-k", ".", "--dry-run=server"), ask: "none" },
        { id: "panel", label: "project.act.openK8s", cmd: argv(), ask: "none", opens: "k8s" },
      ];
    }
    case "k8s": {
      const c = ctxArgs("kubectl", ctx.kubeContext);
      return [
        { id: "diff", label: "project.act.diff", cmd: argv("kubectl", ...c, "diff", "-f", "."), ask: "none", strip: true },
        { id: "apply", label: "project.act.apply", cmd: argv("kubectl", ...c, "apply", "-f", "."), ask: "always", strip: true, primary: true },
        { id: "dry", label: "project.act.dryRun", cmd: argv("kubectl", ...c, "apply", "-f", ".", "--dry-run=server"), ask: "none" },
        { id: "panel", label: "project.act.openK8s", cmd: argv(), ask: "none", opens: "k8s" },
      ];
    }
    case "helm": {
      const c = ctxArgs("helm", ctx.kubeContext);
      return [
        { id: "lint", label: "project.act.lint", cmd: argv("helm", "lint", "."), ask: "none", strip: true },
        { id: "template", label: "project.act.render", cmd: argv("helm", "template", "."), ask: "none", strip: true },
        { id: "install", label: "project.act.helmInstall", cmd: argv("helm", "upgrade", "--install", ...c), ask: "always", strip: true, primary: true },
        { id: "deps", label: "project.act.helmDeps", cmd: argv("helm", "dependency", "update"), ask: "none" },
      ];
    }
    case "nginx":
      return [
        { id: "test", label: "project.act.check", cmd: argv("sudo", "nginx", "-t"), ask: "none", strip: true },
        { id: "reload", label: "project.act.reload", cmd: posix("sudo nginx -t && sudo systemctl reload nginx"), ask: "prod", strip: true, primary: true },
        { id: "dump", label: "project.act.nginxDump", cmd: argv("sudo", "nginx", "-T"), ask: "none" },
        { id: "errors", label: "project.act.errorLog", cmd: argv("sudo", "tail", "-n", "100", "-f", "/var/log/nginx/error.log"), ask: "none" },
      ];
    case "systemd":
      return [{ id: "reload", label: "project.act.daemonReload", cmd: argv("sudo", "systemctl", "daemon-reload"), ask: "prod", strip: true, primary: true }];
  }
}

/** What the Helm install form gives: the release, its namespace, a values file (or none). */
export interface HelmInstall {
  release: string;
  namespace: string;
  values: string | null;
}

/** `helm upgrade --install` for the form's answers; null while a field is not a name helm takes. */
export function helmInstallArgv(form: HelmInstall, kubeContext: string | null | undefined): string[] | null {
  const name = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
  if (!name.test(form.release) || !name.test(form.namespace)) return null;
  if (form.values !== null && (form.values === "" || form.values.startsWith("-") || /[\r\n]/.test(form.values))) return null;
  return [
    "helm",
    "upgrade",
    "--install",
    form.release,
    ".",
    "-n",
    form.namespace,
    ...(form.values ? ["-f", form.values] : []),
    ...ctxArgs("helm", kubeContext),
  ];
}

/** The actions of one row: a unit of systemd, a site of nginx. */
export function rowActions(kind: ProjectKind, cwd: string, entry: { name: string; isDir: boolean }): ProjectAction[] {
  const n = entry.name;
  if (entry.isDir) return [];
  const dir = cwd.replace(/\/+$/, "");
  if (kind === "systemd" && (/\.(service|socket|mount|timer|path|target)$/.test(n))) {
    return [
      { id: "status", label: "project.unit.status", cmd: argv("systemctl", "status", n), ask: "none" },
      { id: "journal", label: "project.unit.journal", cmd: argv("journalctl", "-u", n, "-n", "200", "-f"), ask: "none" },
      { id: "verify", label: "project.unit.verify", cmd: argv("systemd-analyze", "verify", `${dir}/${n}`), ask: "none" },
      { id: "restart", label: "project.unit.restart", cmd: argv("sudo", "systemctl", "restart", n), ask: "always" },
      { id: "enable", label: "project.unit.enable", cmd: argv("sudo", "systemctl", "enable", "--now", n), ask: "prod" },
      { id: "disable", label: "project.unit.disable", cmd: argv("sudo", "systemctl", "disable", "--now", n), ask: "always" },
    ];
  }
  if (kind === "nginx" && /\/sites-available$/.test(dir)) {
    const root = dir.slice(0, -"/sites-available".length);
    return [
      { id: "enable", label: "project.site.enable", cmd: argv("sudo", "ln", "-s", `${dir}/${n}`, `${root}/sites-enabled/${n}`), ask: "prod" },
    ];
  }
  if (kind === "nginx" && /\/sites-enabled$/.test(dir)) {
    return [{ id: "disable", label: "project.site.disable", cmd: argv("sudo", "rm", `${dir}/${n}`), ask: "always" }];
  }
  return [];
}

/** A task of the project's task file: its name and the command that runs it. */
export interface ProjectTask {
  name: string;
  argv: string[];
}

/** The recipes of a justfile (no settings, aliases, imports, private `_` recipes). */
export function justRecipes(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s/.test(line) || line.startsWith("#")) continue;
    if (/^(set|alias|export|import|mod)\s/.test(line)) continue;
    const m = /^@?([A-Za-z][\w-]*)(?:\s+[^:]*)?:(?!=)/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The tasks of a Taskfile (`tasks:` children). */
export function taskfileTasks(text: string): string[] {
  const out: string[] = [];
  let inTasks = false;
  for (const line of text.split("\n")) {
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true;
      continue;
    }
    if (/^\S/.test(line)) inTasks = false;
    const m = inTasks ? /^ {2}([\w:.-]+):/.exec(line) : null;
    if (m) out.push(m[1]);
  }
  return out;
}

/** The scripts of a package.json, or none when it is not JSON. */
export function packageScripts(text: string): string[] {
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts).slice(0, 40) : [];
  } catch {
    return [];
  }
}

/** The tasks of a task file, as commands; `manager` runs package.json's scripts. */
export function projectTasks(file: string, text: string, manager: string | null): ProjectTask[] {
  const n = file.toLowerCase();
  if (n === "makefile" || n === "gnumakefile") return makeTargets(text).slice(0, 40).map((t) => ({ name: t.name, argv: ["make", t.name] }));
  if (n === "justfile" || n === ".justfile") return justRecipes(text).slice(0, 40).map((r) => ({ name: r, argv: ["just", r] }));
  if (n === "taskfile.yml" || n === "taskfile.yaml") return taskfileTasks(text).slice(0, 40).map((r) => ({ name: r, argv: ["task", r] }));
  if (n === "package.json") return packageScripts(text).map((s) => ({ name: s, argv: [manager ?? "npm", "run", s] }));
  return [];
}

/** Whether an action asks first on this server. */
export function asks(a: Pick<ProjectAction, "ask">, prod: boolean): boolean {
  return a.ask === "always" || (a.ask === "prod" && prod);
}

/** The line typed for a command in `shell`, or null when it has no form there. */
export function commandLine(cmd: ProjectCommand, shell: CdShell, render: (argv: string[], shell: CdShell) => string | null): string | null {
  if ("argv" in cmd) return cmd.argv.length ? render(cmd.argv, shell) : null;
  return cmd.line[shell] ?? null;
}
