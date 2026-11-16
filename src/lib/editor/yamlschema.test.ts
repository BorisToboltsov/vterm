import { describe, expect, it } from "vitest";
import {
  bundledSchema,
  checkYaml,
  cursorPath,
  keyOptions,
  modelineSchema,
  pointerPath,
  resolveModeline,
  schemaFor,
  untrustedSchema,
  valueOptions,
} from "./yamlschema";

const never = () => Promise.reject(new Error("not read"));

describe("schemaFor", () => {
  it("picks the schema by dialect, name and sibling", () => {
    expect(schemaFor("/opt/stack/compose.yaml", "compose", "")).toMatchObject({ kind: "bundled", id: "compose" });
    expect(schemaFor("/r/.github/workflows/ci.yml", "ghactions", "")).toMatchObject({ id: "gh-workflow" });
    expect(schemaFor("/r/action.yml", "yaml", "")).toMatchObject({ id: "gh-action" });
    expect(schemaFor("/r/.gitlab-ci.yml", "yaml", "")).toMatchObject({ id: "gitlab-ci" });
    expect(schemaFor("/k/kustomization.yaml", "yaml", "")).toMatchObject({ id: "kustomization" });
    expect(schemaFor("/c/Chart.yaml", "yaml", "")).toMatchObject({ id: "chart" });
    expect(schemaFor("/k/deploy.yaml", "k8s", "")).toMatchObject({ kind: "k8s" });
    expect(schemaFor("/c/values-prod.yaml", "yaml", "", ["Chart.yaml", "values.schema.json"])).toEqual({
      kind: "file",
      path: "/c/values.schema.json",
      label: "values.schema.json",
    });
    expect(schemaFor("/c/values.yaml", "yaml", "", ["Chart.yaml"])).toBeNull();
    expect(schemaFor("/x/plain.yaml", "yaml", "a: 1")).toBeNull();
  });

  it("lets a modeline name the schema — a file beside it, never a URL to fetch", () => {
    const text = "# yaml-language-server: $schema=./schema.json\na: 1\n";
    expect(modelineSchema(text)).toBe("./schema.json");
    expect(schemaFor("/srv/app/conf.yaml", "yaml", text)).toEqual({ kind: "file", path: "/srv/app/schema.json", label: "schema.json" });
    expect(resolveModeline("https://json.schemastore.org/x.json", "/a/b.yaml")).toMatchObject({ kind: "url" });
    expect(resolveModeline("/abs/s.json", "/a/b.yaml")).toMatchObject({ kind: "file", path: "/abs/s.json" });
  });

  it("reads JSON pointers", () => {
    expect(pointerPath("#/services/web/ports/0")).toEqual(["services", "web", "ports", "0"]);
    expect(pointerPath("#")).toEqual([]);
    expect(pointerPath("#/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });
});

describe("checkYaml", () => {
  it("flags an unknown key and a wrong type in Compose", async () => {
    const text = "services:\n  web:\n    image: nginx\n    restartt: always\n    ports: 80\n";
    const res = await checkYaml({ kind: "bundled", id: "compose", label: "Compose" }, text, never);
    expect("issues" in res).toBe(true);
    const issues = "issues" in res ? res.issues : [];
    const unknown = issues.find((i) => i.key === "schema.unknownKey");
    expect(unknown?.params).toEqual({ key: "restartt" });
    expect(text.slice(unknown!.from, unknown!.to)).toBe("restartt");
    expect(issues.some((i) => i.key === "schema.type" && text.slice(i.from, i.to).startsWith("80"))).toBe(true);
  });

  it("checks each Kubernetes document by its kind", async () => {
    const text = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      "  replicas: three",
      "  selector:",
      "    matchLabels: {app: api}",
      "  template:",
      "    metadata:",
      "      labels: {app: api}",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          imagee: x",
      "---",
      "apiVersion: example.com/v1",
      "kind: Widget",
      "spec: {anything: 1}",
      "",
    ].join("\n");
    const res = await checkYaml({ kind: "k8s", label: "Kubernetes" }, text, never);
    const issues = "issues" in res ? res.issues : [];
    expect(issues.find((i) => i.key === "schema.type")).toBeTruthy();
    const unknown = issues.find((i) => i.key === "schema.unknownKey");
    expect(unknown?.params).toEqual({ key: "imagee" });
    // A custom resource the bundle does not carry is not checked at all.
    expect(issues.every((i) => i.from < text.indexOf("---"))).toBe(true);
  });

  it("is quiet on a valid file and on one that does not parse", async () => {
    const ok = await checkYaml({ kind: "bundled", id: "compose", label: "Compose" }, "services:\n  web:\n    image: nginx\n", never);
    expect(ok).toEqual({ issues: [] });
    const broken = await checkYaml({ kind: "bundled", id: "compose", label: "Compose" }, "services: [\n", never);
    expect(broken).toEqual({ issues: [] });
  });

  it("does not fetch a URL and says when a schema file could not be read", async () => {
    expect(await checkYaml({ kind: "url", url: "https://x/y.json", label: "y.json" }, "a: 1", never)).toEqual({ unavailable: "url" });
    expect(await checkYaml({ kind: "file", path: "/x/s.json", label: "s.json" }, "a: 1", never)).toEqual({ unavailable: "unread" });
  });

  it("checks against a chart's own schema, without its patterns", async () => {
    const schema = JSON.stringify({ type: "object", properties: { replicas: { type: "integer" }, name: { type: "string", pattern: "(a+)+$" } } });
    const res = await checkYaml({ kind: "file", path: "/c/values.schema.json", label: "values.schema.json" }, "replicas: many\nname: aaaa!\n", () => Promise.resolve(schema));
    const issues = "issues" in res ? res.issues : [];
    expect(issues.map((i) => i.key)).toEqual(["schema.type"]);
  });
});

describe("untrustedSchema", () => {
  it("drops what would run a server's regular expression in the window", () => {
    expect(untrustedSchema({ type: "string", pattern: "x", format: "email", properties: { a: { patternProperties: { ".*": {} } } } })).toEqual({
      type: "string",
      properties: { a: { additionalProperties: true } },
    });
  });
});

describe("completion", () => {
  it("offers the keys a Compose service may still take", async () => {
    const root = (await bundledSchema("compose")) as Record<string, unknown>;
    const opts = keyOptions(root, ["services", "web"], new Set(["image"]));
    const labels = opts.map((o) => o.label);
    expect(labels).toContain("ports");
    expect(labels).toContain("environment");
    expect(labels).not.toContain("image");
  });

  it("offers an enum's values, true and false", () => {
    const root = { type: "object", properties: { mode: { enum: ["fast", "safe"] }, on: { type: "boolean" } } };
    expect(valueOptions(root, ["mode"])).toEqual(["fast", "safe"]);
    expect(valueOptions(root, ["on"])).toEqual(["true", "false"]);
  });

  it("finds the cursor's place by indentation", () => {
    const t1 = "services:\n  web:\n    image: x\n    po";
    expect(cursorPath(t1, t1.length)).toMatchObject({ path: ["services", "web"], atValue: null });
    expect([...cursorPath(t1, t1.length).present]).toEqual(["image"]);
    const t2 = "- name: x\n  hosts: web\n  tasks:\n    - name: Install\n      ap";
    expect(cursorPath(t2, t2.length).path).toEqual([0, "tasks", 0]);
    expect([...cursorPath(t2, t2.length).present]).toEqual(["name"]);
    const t3 = "services:\n  web:\n    restart: al";
    expect(cursorPath(t3, t3.length)).toMatchObject({ path: ["services", "web"], atValue: "restart" });
    const t4 = "steps:\n  - na";
    expect(cursorPath(t4, t4.length).path).toEqual(["steps", 0]);
  });
});

describe("schemaCompletions", () => {
  it("offers keys at a key and values after a colon", async () => {
    const { schemaCompletions, schemaRoot } = await import("./yamlschema");
    const text = "apiVersion: apps/v1\nkind: Deployment\nspec:\n  repl";
    const root = await schemaRoot({ kind: "k8s", label: "Kubernetes" }, text, text.length, never);
    const res = schemaCompletions(root!, text, text.length);
    expect(res?.from).toBe(text.length - 4);
    expect(res?.options.map((o) => o.label)).toContain("replicas");
    const enumRoot = { type: "object", properties: { mode: { enum: ["fast", "safe"] } } };
    const t2 = "mode: fa";
    expect(schemaCompletions(enumRoot, t2, t2.length)).toEqual({ from: 6, options: [{ label: "fast", type: "enum" }, { label: "safe", type: "enum" }] });
    expect(await schemaRoot({ kind: "k8s", label: "Kubernetes" }, "kind: Nope\n", 3, never)).toBeNull();
  });
});
