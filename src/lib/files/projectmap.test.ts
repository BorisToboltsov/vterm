import { describe, expect, it } from "vitest";
import { KIND_ICON, fileGlyph, manifestFacts, packageManager, projectOf, roleOf, rowLook, type ProjectEntry } from "./projectmap";

const ls = (dirs: string[], files: string[]): ProjectEntry[] => [
  ...dirs.map((name) => ({ name, isDir: true })),
  ...files.map((name) => ({ name, isDir: false })),
];

describe("projectOf", () => {
  it("knows each kind by its signs", () => {
    const cases: [string, ProjectEntry[], string][] = [
      ["/srv/a", ls(["roles"], ["ansible.cfg", "site.yml"]), "ansible"],
      ["/srv/a", ls(["group_vars", "host_vars"], []), "ansible"],
      ["/srv/t", ls([".terraform"], ["main.tf", ".terraform.lock.hcl"]), "terraform"],
      ["/srv/c", ls(["templates"], ["Chart.yaml", "values.yaml"]), "helm"],
      ["/srv/k", ls([], ["kustomization.yaml", "hpa.yaml"]), "kustomize"],
      ["/srv/r", ls(["src"], ["Cargo.toml", "Dockerfile"]), "rust"],
      ["/srv/g", ls(["cmd"], ["go.mod", "Makefile"]), "go"],
      ["/srv/p", ls([], ["requirements.txt", "app.py"]), "python"],
      ["/srv/n", ls(["src"], ["package.json"]), "node"],
      ["/opt/stack", ls([], ["compose.yaml", ".env"]), "compose"],
      ["/srv/d", ls([], ["Dockerfile"]), "docker"],
      ["/srv/m", ls([], ["deployment.yaml", "service.yaml"]), "k8s"],
      ["/etc/nginx", ls(["sites-enabled"], ["mime.types"]), "nginx"],
      ["/etc/systemd/system", ls([], ["x.service"]), "systemd"],
      ["/home/u/units", ls([], ["a.service", "a.timer"]), "systemd"],
    ];
    for (const [path, entries, kind] of cases) expect(projectOf(path, entries)?.kind, `${path} ${kind}`).toBe(kind);
    expect(projectOf("/home/u", ls(["Documents"], ["notes.txt"]))).toBeNull();
  });

  it("prefers the stronger sign and names the manifest and the task file", () => {
    const p = projectOf("/srv/g", ls([], ["go.mod", "Dockerfile", "compose.yaml", "Makefile"]))!;
    expect(p.kind).toBe("go");
    expect(p.manifest).toBe("go.mod");
    expect(p.tasksFile).toBe("Makefile");
    expect(projectOf("/srv/n", ls([], ["package.json"]))!.tasksFile).toBe("package.json");
    expect(projectOf("/srv/a", ls(["roles"], ["ansible.cfg", "main.tf"]))!.kind).toBe("ansible");
  });
});

describe("roleOf", () => {
  const r = (kind: Parameters<typeof roleOf>[0], name: string, isDir = false) => roleOf(kind, { name, isDir });
  it("marks what each kind holds", () => {
    expect(r("rust", "target", true)).toBe("gen");
    expect(r("rust", "Cargo.lock")).toBe("lock");
    expect(r("go", "cmd", true)).toBe("entrydir");
    expect(r("go", "server_test.go")).toBe("tests");
    expect(r("terraform", "terraform.tfstate")).toBe("secret");
    expect(r("terraform", "prod.tfvars")).toBe("secret");
    expect(r("terraform", "main.tf")).toBe("entry");
    expect(r("ansible", "vault.yml")).toBe("secret");
    expect(r("ansible", "group_vars", true)).toBe("vars");
    expect(r("helm", "values-prod.yaml")).toBe("vars");
    expect(r("nginx", "sites-enabled", true)).toBe("active");
    expect(r("systemd", "backup.timer")).toBe("timer");
    expect(r("systemd", "agent.service.d", true)).toBe("vars");
    expect(r("python", ".venv", true)).toBe("gen");
    expect(r("node", "node_modules", true)).toBe("gen");
  });

  it("says what any folder says outside a project", () => {
    expect(r(null, ".env")).toBe("secret");
    expect(r(null, ".env.example")).toBe("cfg");
    expect(r(null, "id_ed25519")).toBe("secret");
    expect(r(null, "README.md")).toBe("doc");
    expect(r(null, "Makefile")).toBe("tasks");
    expect(r(null, "notes.txt")).toBe("plain");
  });
});

describe("rowLook", () => {
  it("draws each role with its icon and tone", () => {
    expect(rowLook({ name: "Cargo.toml", isDir: false }, "manifest", "rust")).toMatchObject({ icon: "manifest", tone: "accent", strong: true });
    expect(rowLook({ name: "target", isDir: true }, "gen", "rust")).toMatchObject({ icon: "folderOff", dim: true });
    expect(rowLook({ name: ".env", isDir: false }, "secret", null)).toMatchObject({ icon: "lock", warnName: true });
    expect(rowLook({ name: "src", isDir: true }, "src", "rust").icon).toBe("folderCode");
    expect(rowLook({ name: "deploy.yml", isDir: false }, "entry", "ansible")).toMatchObject({ icon: "gearPlay", tone: "warn", after: "entry" });
    expect(rowLook({ name: "sites-enabled", isDir: true }, "active", "nginx").after).toBe("link");
    expect(fileGlyph("main.go").icon).toBe("langGo");
    expect(fileGlyph("x.bin").icon).toBe("file");
    expect(KIND_ICON.helm.icon).toBe("helm");
  });
});

describe("manifestFacts", () => {
  it("reads name, version and facts of each manifest", () => {
    expect(manifestFacts("rust", "Cargo.toml", '[package]\nname = "collector"\nversion = "1.3.0"\nedition = "2021"\n')).toEqual({
      name: "collector",
      version: "1.3.0",
      edition: "2021",
      facts: ["Cargo.toml", "edition 2021"],
    });
    expect(manifestFacts("python", "pyproject.toml", '[project]\nname = "agent"\nversion = "0.4.2"\nrequires-python = ">=3.11"\n[tool.pytest.ini_options]\n[tool.ruff]\n')).toMatchObject({
      name: "agent",
      facts: ["pyproject.toml", "Python >=3.11", "pytest", "ruff"],
    });
    expect(manifestFacts("go", "go.mod", "module example.com/gateway\n\ngo 1.23\n")).toMatchObject({ name: "gateway", facts: ["go.mod", "example.com/gateway", "go 1.23"] });
    expect(manifestFacts("node", "package.json", '{"name":"web","version":"2.8.0","engines":{"node":">=22"}}')).toMatchObject({ name: "web", version: "2.8.0", facts: ["package.json", "node >=22"] });
    expect(manifestFacts("node", "package.json", "{oops").name).toBeNull();
    expect(manifestFacts("helm", "Chart.yaml", "name: api\nversion: 2.4.1\nappVersion: \"1.9.0\"\ndependencies:\n  - name: postgresql\n")).toMatchObject({
      name: "api",
      version: "2.4.1",
      facts: ["Chart.yaml", "appVersion 1.9.0", "postgresql"],
    });
    expect(manifestFacts("compose", "compose.yaml", "services:\n  api:\n    image: x\n  db:\n    image: y\nvolumes: {}\n").facts).toEqual(["compose.yaml", "api, db"]);
  });

  it("names the package manager by the lock file", () => {
    expect(packageManager("python", ls([], ["uv.lock"]))).toBe("uv");
    expect(packageManager("python", ls([], ["requirements.txt"]))).toBe("pip");
    expect(packageManager("node", ls([], ["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(packageManager("node", ls([], []))).toBe("npm");
    expect(packageManager("rust", ls([], []))).toBeNull();
  });
});
