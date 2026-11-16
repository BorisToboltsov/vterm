import { describe, expect, it } from "vitest";
import { ancestors, fileUri, findRoot, languageId, lspKey, rootMarkers, serversFor } from "./lspservers";

describe("serversFor", () => {
  it("names the servers of each language, in order", () => {
    expect(serversFor("python", "/a.py").map((s) => s.id)).toEqual(["basedpyright", "pyright", "pylsp"]);
    expect(serversFor("ansible", "/p.yml").map((s) => s.id)).toEqual(["ansible-language-server", "yaml-language-server"]);
    expect(serversFor("yaml", "/srv/charts/api/templates/svc.yaml")[0].id).toBe("helm_ls");
    expect(serversFor("nginx", "/etc/nginx/nginx.conf")).toEqual([]);
  });
});

describe("findRoot", () => {
  const tree: Record<string, string[]> = {
    "/srv/ws": ["Cargo.toml", "crates"],
    "/srv/ws/crates/a": ["Cargo.toml", "src"],
    "/srv/ws/crates/a/src": ["main.rs"],
    "/srv/app": ["pyproject.toml", "pkg"],
    "/srv/app/pkg": ["mod.py"],
  };
  const list = (dir: string) => (tree[dir] ? Promise.resolve(tree[dir]) : Promise.reject(new Error("no")));

  it("takes the nearest marker, the outermost crate for Rust", async () => {
    expect(await findRoot("/srv/app/pkg/mod.py", "python", list)).toBe("/srv/app");
    expect(await findRoot("/srv/ws/crates/a/src/main.rs", "rust", list)).toBe("/srv/ws");
    expect(await findRoot("/elsewhere/x.go", "go", list)).toBe("/elsewhere");
  });

  it("walks a bounded number of folders and knows the markers", () => {
    expect(ancestors("/a/b/c/d.txt")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    expect(ancestors("C:\\w\\x.py")).toEqual(["C:\\w", "C:\\"]);
    expect(rootMarkers("go")).toContain("go.mod");
  });
});

describe("uris and ids", () => {
  it("builds file URIs and language ids", () => {
    expect(fileUri("/srv/my app/x.py")).toBe("file:///srv/my%20app/x.py");
    expect(fileUri("C:\\work\\x.ts")).toBe("file:///C:/work/x.ts");
    expect(languageId("hcl")).toBe("terraform");
    expect(languageId("k8s")).toBe("yaml");
    expect(languageId("python")).toBe("python");
    expect(lspKey("web-1", "/srv/app", "pyright")).toBe("web-1|/srv/app|pyright");
  });
});
