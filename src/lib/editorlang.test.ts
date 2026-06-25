import { describe, expect, it } from "vitest";
import { baseName, fileExt, editorLangFor, isEditable } from "./editorlang";

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

describe("isEditable", () => {
  it("is true exactly when a language is resolved", () => {
    expect(isEditable("values.yaml")).toBe(true);
    expect(isEditable("/etc/hosts.bin")).toBe(false);
    expect(isEditable("archive.zip")).toBe(false);
  });
});
