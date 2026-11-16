import { describe, expect, it } from "vitest";
import { blockEnd, breadcrumbs, makeTargets, outline } from "./outline";

const names = (kind: Parameters<typeof outline>[0], text: string, name = "") =>
  outline(kind, text, name).map((s) => `${"  ".repeat(s.depth)}${s.kind}:${s.name}@${s.line}`);

describe("outline", () => {
  it("lists an Ansible playbook's plays and tasks", () => {
    const pb = "- name: Web servers\n  hosts: web\n  tasks:\n    - name: Install nginx\n      apt: name=nginx\n    - name: Start it\n      service: name=nginx\n- hosts: db\n  tasks: []\n";
    expect(names("ansible", pb)).toEqual(["play:Web servers@1", "  task:Install nginx@4", "  task:Start it@6", "play:db@8"]);
  });

  it("names each Kubernetes document by kind and name", () => {
    const k = "apiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec: {}\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels:\n    app: x\n  name: api\n";
    expect(names("k8s", k)).toEqual(["document:Service/api@1", "document:Deployment/api@7"]);
  });

  it("lists compose services and workflow jobs with their steps", () => {
    expect(names("compose", "services:\n  web:\n    image: nginx\n  db:\n    image: pg\nvolumes:\n  data: {}\n")).toEqual([
      "key:services@1",
      "  service:web@2",
      "  service:db@4",
      "key:volumes@6",
    ]);
    const wf = "on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - name: Checkout\n        uses: a\n  test:\n    steps: []\n";
    expect(names("ghactions", wf)).toEqual(["key:on@1", "key:jobs@2", "  job:build@3", "    task:Checkout@6", "  job:test@8"]);
  });

  it("keeps two levels of a plain YAML's keys", () => {
    expect(names("yaml", "a:\n  b:\n    c: 1\nd: 2\n")).toEqual(["key:a@1", "  key:b@2", "key:d@4"]);
  });

  it("reads Terraform blocks", () => {
    const tf = 'resource "aws_instance" "web" {\n  ami = "x"\n}\ndata "aws_ami" "u" {}\nmodule "vpc" {}\nvariable "region" {}\nlocals {\n}\n';
    expect(names("hcl", tf)).toEqual(["resource:aws_instance.web@1", "resource:data.aws_ami.u@4", "resource:module vpc@5", "resource:variable region@6", "block:locals@7"]);
  });

  it("reads Python, Rust and Go definitions with their nesting", () => {
    expect(names("python", "class A:\n    def f(self):\n        pass\nasync def g():\n    pass\n")).toEqual(["class:A@1", "  function:f@2", "function:g@4"]);
    expect(names("rust", "pub struct S;\nimpl S {\n    pub fn new() -> Self { S }\n}\nfn main() {}\n")).toEqual([
      "type:struct S@1",
      "class:impl S@2",
      "  function:new@3",
      "function:main@5",
    ]);
    expect(names("go", "type Server struct {}\nfunc (s *Server) Run() {}\nfunc main() {}\n")).toEqual(["type:Server@1", "function:Server.Run@2", "function:main@3"]);
  });

  it("reads nginx blocks, Dockerfile stages, Markdown headings, sections and make targets", () => {
    expect(names("nginx", "http {\n  server {\n    location /api/ {\n    }\n  }\n}\n")).toEqual(["block:http@1", "  block:server@2", "    block:location /api/@3"]);
    expect(names("dockerfile", "FROM golang:1.23 AS build\nRUN x\nFROM alpine\n")).toEqual(["stage:build (golang:1.23)@1", "stage:alpine@3"]);
    expect(names("markdown", "# A\n```\n# not\n```\n## B\n")).toEqual(["heading:A@1", "  heading:B@5"]);
    expect(names("systemd", "[Unit]\nA=1\n[Service]\n")).toEqual(["section:Unit@1", "section:Service@3"]);
    expect(names("plain", ".PHONY: all\nall: build\nbuild:\n\tgo build\nX := 1\n%.o: %.c\n", "Makefile")).toEqual(["target:all@2", "target:build@3"]);
    expect(names("plain", "all:\n", "notes.txt")).toEqual([]);
  });
});

describe("makeTargets", () => {
  it("skips special targets, patterns and assignments", () => {
    expect(makeTargets("a: b\n.PHONY: a\nX:=1\nY ::= 2\n%.o:\nbin/tool: x\n").map((t) => t.name)).toEqual(["a", "bin/tool"]);
  });
});

describe("blockEnd", () => {
  it("runs to the last deeper line, a closing bracket at the same indent included", () => {
    const lines = ["fn a() {", "    x();", "", "}", "fn b() {}"];
    expect(blockEnd(lines, 1)).toBe(4);
    expect(blockEnd(lines, 5)).toBe(5);
  });
});

describe("breadcrumbs", () => {
  it("gives the YAML key path, a list item by its name", () => {
    const pb = "- name: Web\n  hosts: web\n  tasks:\n    - name: Install\n      apt:\n        name: nginx\n";
    expect(breadcrumbs("ansible", pb, 6).map((c) => c.name)).toEqual(["Web", "tasks", "Install", "apt", "name"]);
    expect(breadcrumbs("yaml", "a:\n  b:\n\n    c: 1\n", 4).map((c) => `${c.name}@${c.line}`)).toEqual(["a@1", "b@2", "c@4"]);
    expect(breadcrumbs("yaml", "", 1)).toEqual([]);
  });

  it("gives the enclosing definitions elsewhere", () => {
    const py = "class A:\n    def f(self):\n        x = 1\n\n    def g(self):\n        pass\ny = 2\n";
    expect(breadcrumbs("python", py, 3).map((c) => c.name)).toEqual(["A", "f"]);
    expect(breadcrumbs("python", py, 6).map((c) => c.name)).toEqual(["A", "g"]);
    expect(breadcrumbs("python", py, 7)).toEqual([]);
    expect(breadcrumbs("markdown", "# A\n## B\ntext\n# C\n", 3).map((c) => c.name)).toEqual(["A", "B"]);
    expect(breadcrumbs("nginx", "server {\n  location / {\n    root x;\n  }\n}\n", 3).map((c) => c.name)).toEqual(["server", "location /"]);
  });
});
