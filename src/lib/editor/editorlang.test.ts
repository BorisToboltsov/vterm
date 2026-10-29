import { describe, expect, it } from "vitest";
import {
  baseName,
  fileExt,
  editorLangFor,
  editorLangOrPlain,
  editorLangWithIncludes,
  editorLangWithDialect,
  yamlDialectFromContent,
  couldBeNginxInclude,
  isEditable,
  isNginxConfigPath,
} from "./editorlang";

describe("baseName / fileExt", () => {
  it("baseName takes the last path segment", () => {
    expect(baseName("/etc/nginx/nginx.conf")).toBe("nginx.conf");
    expect(baseName("nginx.conf")).toBe("nginx.conf");
    expect(baseName("/")).toBe("");
  });

  it("fileExt lower-cases the extension and ignores leading-dot hidden files", () => {
    expect(fileExt("config.YAML")).toBe("yaml");
    expect(fileExt("/srv/app/main.tf")).toBe("tf");
    expect(fileExt("archive.tar.gz")).toBe("gz");
    expect(fileExt(".env")).toBe(""); // hidden file, not an extension
    expect(fileExt("Makefile")).toBe("");
  });
});

describe("editorLangFor", () => {
  it("maps known extensions to languages", () => {
    expect(editorLangFor("a.yaml")?.kind).toBe("yaml");
    expect(editorLangFor("a.yml")?.kind).toBe("yaml");
    expect(editorLangFor("pkg.json")?.kind).toBe("json");
    expect(editorLangFor("README.md")?.kind).toBe("markdown");
    expect(editorLangFor("deploy.sh")?.kind).toBe("shell");
    expect(editorLangFor("Cargo.toml")?.kind).toBe("toml");
    expect(editorLangFor("app.conf")?.kind).toBe("ini");
    expect(editorLangFor("main.tf")?.label).toBe("Terraform");
  });

  it("maps scripting / programming languages", () => {
    expect(editorLangFor("main.py")?.kind).toBe("python");
    expect(editorLangFor("app.js")?.kind).toBe("javascript");
    expect(editorLangFor("a.mjs")?.kind).toBe("javascript");
    expect(editorLangFor("comp.jsx")?.kind).toBe("javascript");
    expect(editorLangFor("index.ts")?.kind).toBe("typescript");
    expect(editorLangFor("App.tsx")?.kind).toBe("typescript");
    expect(editorLangFor("Main.java")?.kind).toBe("java");
    expect(editorLangFor("main.go")?.kind).toBe("go");
    expect(editorLangFor("lib.rs")?.kind).toBe("rust");
    expect(editorLangFor("script.rb")?.kind).toBe("ruby");
    expect(editorLangFor("a.c")?.kind).toBe("c");
    expect(editorLangFor("a.cpp")?.kind).toBe("cpp");
    expect(editorLangFor("a.hpp")?.kind).toBe("cpp");
    expect(editorLangFor("a.cs")?.kind).toBe("csharp");
    expect(editorLangFor("q.sql")?.kind).toBe("sql");
    expect(editorLangFor("deploy.ps1")?.kind).toBe("powershell");
    expect(editorLangFor("a.lua")?.kind).toBe("lua");
    expect(editorLangFor("a.pl")?.kind).toBe("perl");
  });

  it("maps markup / web languages", () => {
    expect(editorLangFor("index.html")?.kind).toBe("html");
    expect(editorLangFor("page.htm")?.kind).toBe("html");
    expect(editorLangFor("style.css")?.kind).toBe("css");
    expect(editorLangFor("style.scss")?.kind).toBe("scss");
    expect(editorLangFor("style.less")?.kind).toBe("less");
    expect(editorLangFor("pom.xml")?.kind).toBe("xml");
    expect(editorLangFor("icon.svg")?.kind).toBe("xml");
  });

  it("maps DevOps / config formats and many more languages", () => {
    expect(editorLangFor("api.proto")?.kind).toBe("protobuf");
    expect(editorLangFor("CMakeLists.txt")?.kind).toBe("cmake");
    expect(editorLangFor("change.diff")?.kind).toBe("diff");
    expect(editorLangFor("fix.patch")?.kind).toBe("diff");
    expect(editorLangFor("site.pp")?.kind).toBe("puppet");
    expect(editorLangFor("build.gradle")?.kind).toBe("groovy");
    expect(editorLangFor("App.scala")?.kind).toBe("scala");
    expect(editorLangFor("Main.kt")?.kind).toBe("kotlin");
    expect(editorLangFor("main.dart")?.kind).toBe("dart");
    expect(editorLangFor("App.swift")?.kind).toBe("swift");
    expect(editorLangFor("core.clj")?.kind).toBe("clojure");
    expect(editorLangFor("Main.hs")?.kind).toBe("haskell");
    expect(editorLangFor("app.erl")?.kind).toBe("erlang");
    expect(editorLangFor("Main.elm")?.kind).toBe("elm");
    expect(editorLangFor("plot.r")?.kind).toBe("r");
    expect(editorLangFor("calc.jl")?.kind).toBe("julia");
    expect(editorLangFor("app.coffee")?.kind).toBe("coffeescript");
    expect(editorLangFor("lib.ml")?.kind).toBe("ocaml");
    expect(editorLangFor("Program.fs")?.kind).toBe("fsharp");
    expect(editorLangFor("script.tcl")?.kind).toBe("tcl");
    expect(editorLangFor("nginx.conf")?.kind).toBe("nginx");
    expect(editorLangFor("Vagrantfile")?.kind).toBe("ruby");
  });

  it("recognises Dockerfile by name and extension", () => {
    expect(editorLangFor("Dockerfile")?.kind).toBe("dockerfile");
    expect(editorLangFor("/app/Dockerfile")?.label).toBe("Dockerfile");
    expect(editorLangFor("Containerfile")?.kind).toBe("dockerfile");
    expect(editorLangFor("api.dockerfile")?.kind).toBe("dockerfile");
    expect(editorLangFor("Gemfile")?.kind).toBe("ruby");
  });

  it("matches well-known extensionless / dotfile config names", () => {
    expect(editorLangFor("/app/.env")?.kind).toBe("ini");
    expect(editorLangFor(".bashrc")?.kind).toBe("shell");
    expect(editorLangFor("/build/Makefile")?.label).toBe("Text");
  });

  it("returns null for non-editable types", () => {
    expect(editorLangFor("photo.png")).toBeNull();
    expect(editorLangFor("server.bin")).toBeNull();
    expect(editorLangFor("noext")).toBeNull();
  });
});

describe("nginx config directory detection", () => {
  it("isNginxConfigPath matches an `nginx` path segment, case-insensitively", () => {
    expect(isNginxConfigPath("/etc/nginx/conf.d/app.conf")).toBe(true);
    expect(isNginxConfigPath("/etc/nginx/sites-available/site")).toBe(true);
    expect(isNginxConfigPath("/usr/local/NGINX/nginx.conf")).toBe(true);
    expect(isNginxConfigPath("C:\\nginx\\conf\\site.conf")).toBe(true);
    expect(isNginxConfigPath("/etc/apache2/conf.d/app.conf")).toBe(false);
    expect(isNginxConfigPath("/home/user/nginx-notes.txt")).toBe(false);
  });

  it("treats custom .conf / extensionless files under nginx/ as nginx", () => {
    expect(editorLangFor("/etc/nginx/conf.d/app.conf")?.kind).toBe("nginx");
    expect(editorLangFor("/etc/nginx/sites-available/mysite")?.kind).toBe("nginx");
    expect(editorLangFor("/etc/nginx/sites-enabled/default")?.kind).toBe("nginx");
    expect(editorLangFor("/etc/nginx/snippets/ssl.conf")?.kind).toBe("nginx");
    expect(editorLangFor("/etc/nginx/fastcgi_params")?.kind).toBe("nginx");
  });

  it("does not touch non-nginx dirs or files with a specific extension", () => {
    // apache dirs keep the generic Config(ini) mapping (apache is not wired).
    expect(editorLangFor("/etc/apache2/conf.d/app.conf")?.kind).toBe("ini");
    expect(editorLangFor("/etc/apache2/sites-available/site")).toBeNull();
    // A specific extension still wins even inside an nginx tree.
    expect(editorLangFor("/etc/nginx/vars.yaml")?.kind).toBe("yaml");
    // A bare filename with no directory context is unchanged.
    expect(editorLangFor("app.conf")?.kind).toBe("ini");
  });
});

describe("nginx include detection (nginx -T set)", () => {
  it("couldBeNginxInclude gates to .conf and extensionless files", () => {
    expect(couldBeNginxInclude("/srv/app/site.conf")).toBe(true);
    expect(couldBeNginxInclude("/srv/app/vhost")).toBe(true); // extensionless
    expect(couldBeNginxInclude("/srv/app/main.py")).toBe(false);
    expect(couldBeNginxInclude("/srv/app/values.yaml")).toBe(false);
  });

  it("upgrades a non-nginx file to nginx when it is in the loaded-config set", () => {
    const set = new Set(["/srv/app/nginx-site.conf"]);
    // Outside the /etc/nginx/ tree, so the path heuristic sees generic Config(ini)…
    expect(editorLangOrPlain("/srv/app/nginx-site.conf").kind).toBe("ini");
    // …but nginx -T reported it, so it becomes nginx.
    expect(editorLangWithIncludes("/srv/app/nginx-site.conf", set).kind).toBe("nginx");
  });

  it("leaves detection to the path heuristic when the set is null or misses", () => {
    expect(editorLangWithIncludes("/srv/app/site.conf", null).kind).toBe("ini");
    expect(editorLangWithIncludes("/srv/app/site.conf", new Set()).kind).toBe("ini");
    // Already nginx by directory — unchanged whether or not the set knows it.
    expect(editorLangWithIncludes("/etc/nginx/conf.d/x.conf", new Set()).kind).toBe("nginx");
  });
});

describe("isEditable", () => {
  it("is true exactly when a language is resolved", () => {
    expect(isEditable("values.yaml")).toBe(true);
    expect(isEditable("/etc/hosts.bin")).toBe(false);
    expect(isEditable("archive.zip")).toBe(false);
  });
});

describe("editorLangOrPlain", () => {
  it("returns the known language when recognised", () => {
    expect(editorLangOrPlain("a.yaml").kind).toBe("yaml");
    expect(editorLangOrPlain("Dockerfile").kind).toBe("dockerfile");
  });

  it("falls back to plain text for unknown / extensionless files", () => {
    expect(editorLangOrPlain("/etc/hosts")).toEqual({ kind: "plain", label: "Text" });
    expect(editorLangOrPlain("weird.qwerty")).toEqual({ kind: "plain", label: "Text" });
    expect(editorLangOrPlain("noext")).toEqual({ kind: "plain", label: "Text" });
  });
});

describe("editorLangFor — daemon config validators (Phase A)", () => {
  it("detects sshd_config and its drop-ins", () => {
    expect(editorLangFor("/etc/ssh/sshd_config")?.kind).toBe("sshdconfig");
    expect(editorLangFor("/etc/ssh/sshd_config.d/50-cloud.conf")?.kind).toBe("sshdconfig");
    // ssh_config (client) must NOT match sshd's validator.
    expect(editorLangFor("/etc/ssh/ssh_config")?.kind).not.toBe("sshdconfig");
  });

  it("detects sudoers and sudoers.d drop-ins (extensionless)", () => {
    expect(editorLangFor("/etc/sudoers")?.kind).toBe("sudoers");
    expect(editorLangFor("/etc/sudoers.d/90-users")?.kind).toBe("sudoers");
  });

  it("detects haproxy.cfg and configs under a haproxy tree", () => {
    expect(editorLangFor("/etc/haproxy/haproxy.cfg")?.kind).toBe("haproxy");
    expect(editorLangFor("/etc/haproxy/conf.d/site.cfg")?.kind).toBe("haproxy");
    // A lone .cfg outside a haproxy dir stays generic Config.
    expect(editorLangFor("/opt/app/app.cfg")?.kind).toBe("ini");
  });

  it("detects BIND named.conf and its includes", () => {
    expect(editorLangFor("/etc/bind/named.conf")?.kind).toBe("bind");
    expect(editorLangFor("/etc/named.conf.local")?.kind).toBe("bind");
    expect(editorLangFor("/etc/bind/named.conf.options")?.kind).toBe("bind");
  });

  it("detects systemd unit files by extension", () => {
    expect(editorLangFor("/etc/systemd/system/app.service")?.kind).toBe("systemd");
    expect(editorLangFor("backup.timer")?.kind).toBe("systemd");
    expect(editorLangFor("app.socket")?.kind).toBe("systemd");
    expect(editorLangFor("data.mount")?.kind).toBe("systemd");
  });

  it("keeps all daemon configs on the remote-linter list", () => {
    expect(isEditable("/etc/ssh/sshd_config")).toBe(true);
  });
});

describe("editorLangFor — YAML-family dialects (Phase B)", () => {
  it("detects docker-compose by name", () => {
    expect(editorLangFor("docker-compose.yml")?.kind).toBe("compose");
    expect(editorLangFor("/srv/app/compose.yaml")?.kind).toBe("compose");
    expect(editorLangFor("docker-compose.prod.yml")?.kind).toBe("compose");
  });

  it("detects GitHub Actions workflows by path", () => {
    expect(editorLangFor("/repo/.github/workflows/ci.yml")?.kind).toBe("ghactions");
    // A yaml elsewhere in the repo is not a workflow.
    expect(editorLangFor("/repo/config/ci.yml")?.kind).toBe("yaml");
  });

  it("detects Prometheus config and Ansible layouts", () => {
    expect(editorLangFor("/etc/prometheus/prometheus.yml")?.kind).toBe("prometheus");
    expect(editorLangFor("playbooks/deploy.yml")?.kind).toBe("ansible");
    expect(editorLangFor("/infra/roles/web/tasks/main.yml")?.kind).toBe("ansible");
    expect(editorLangFor("site.yaml")?.kind).toBe("ansible");
  });

  it("leaves a plain YAML file as yaml", () => {
    expect(editorLangFor("values.yaml")?.kind).toBe("yaml");
    expect(editorLangFor("/etc/app/config.yml")?.kind).toBe("yaml");
  });
});

describe("yamlDialectFromContent / editorLangWithDialect", () => {
  const K8S = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n";
  const PLAYBOOK = "- hosts: web\n  become: true\n  tasks:\n    - name: ping\n      ping:\n";

  it("recognises Kubernetes manifests by apiVersion + kind", () => {
    expect(yamlDialectFromContent(K8S)?.kind).toBe("k8s");
  });

  it("recognises Ansible playbooks by hosts + tasks", () => {
    expect(yamlDialectFromContent(PLAYBOOK)?.kind).toBe("ansible");
  });

  it("returns null for plain YAML", () => {
    expect(yamlDialectFromContent("name: app\nversion: 1\nport: 8080\n")).toBeNull();
  });

  it("upgrades only a generic yaml language, never a more specific one", () => {
    const yaml = editorLangOrPlain("values.yaml");
    expect(editorLangWithDialect(yaml, K8S).kind).toBe("k8s");
    // A name-detected compose stays compose even if content looks k8s-ish.
    const compose = editorLangOrPlain("docker-compose.yml");
    expect(editorLangWithDialect(compose, K8S).kind).toBe("compose");
  });
});
