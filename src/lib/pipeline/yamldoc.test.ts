import { beforeAll, describe, expect, it } from "vitest";
import { isObj, loadYaml, oneLine, parseYaml, str, strList, strMap, YamlReference, type Yaml } from "./yamldoc";

let Y: Yaml;
beforeAll(async () => {
  Y = await loadYaml();
});

describe("parseYaml", () => {
  it("reads values with the lines their keys stand on", () => {
    const doc = parseYaml(Y, "name: CI\njobs:\n  build:\n    runs-on: x\n    steps: []\n  test:\n    needs: build\n");
    expect(doc.error).toBeNull();
    expect(doc.value).toEqual({ name: "CI", jobs: { build: { "runs-on": "x", steps: [] }, test: { needs: "build" } } });
    expect(doc.span(["jobs", "build"])).toEqual({ line: 3, endLine: 5 });
    expect(doc.span(["jobs", "test"])).toEqual({ line: 6, endLine: 7 });
    expect(doc.span(["jobs", "nope"])).toBeNull();
    expect(doc.span(["name", "deeper"])).toBeNull();
    expect(doc.keys(["jobs"])).toEqual(["build", "test"]);
    expect(doc.keys([])).toEqual(["name", "jobs"]);
    expect(doc.keys(["name"])).toEqual([]);
  });

  it("keeps the written order of keys a JS object would reorder", () => {
    const doc = parseYaml(Y, "jobs:\n  b: {}\n  '2': {}\n  a: {}\n");
    expect(doc.keys(["jobs"])).toEqual(["b", "2", "a"]);
  });

  it("merges `<<` keys and keeps a !reference as what it names", () => {
    const doc = parseYaml(Y, ".base: &b\n  image: x\njob:\n  <<: *b\n  script:\n    - !reference [.base, script]\n    - echo\n");
    const job = (doc.value as Record<string, Record<string, unknown>>).job;
    expect(job.image).toBe("x");
    const ref = (job.script as unknown[])[0];
    expect(ref).toBeInstanceOf(YamlReference);
    expect((ref as YamlReference).path).toEqual([".base", "script"]);
  });

  it("refuses duplicate keys and says on which line", () => {
    const doc = parseYaml(Y, "a: 1\nb: 2\na: 3\n");
    expect(doc.value).toBeNull();
    expect(doc.error?.line).toBe(3);
  });

  it("refuses an alias bomb instead of expanding it", () => {
    const rows = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 0; i < 8; i++) rows.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`);
    const doc = parseYaml(Y, rows.join("\n"));
    expect(doc.value).toBeNull();
    expect(doc.error).not.toBeNull();
  });

  it("reads past GitLab's `spec:` header document", () => {
    const doc = parseYaml(Y, "spec:\n  inputs:\n    stage: {}\n---\nbuild:\n  script: [make]\n");
    expect(doc.value).toEqual({ build: { script: ["make"] } });
    expect(doc.span(["build"])?.line).toBe(5);
  });

  it("gives an empty file nothing, and no error", () => {
    expect(parseYaml(Y, "  \n").value).toBeNull();
    expect(parseYaml(Y, "  \n").error).toBeNull();
    expect(parseYaml(Y, "# only a comment\n").value).toBeNull();
  });

  it("loads the parser once", async () => {
    expect(await loadYaml()).toBe(Y);
  });
});

describe("value helpers", () => {
  it("tells maps from lists and references", () => {
    expect(isObj({})).toBe(true);
    expect(isObj([])).toBe(false);
    expect(isObj(null)).toBe(false);
    expect(isObj(new YamlReference([]))).toBe(false);
  });

  it("reads scalars, lists and plain maps", () => {
    expect(str("a")).toBe("a");
    expect(str(3)).toBe("3");
    expect(str(true)).toBe("true");
    expect(str({})).toBeNull();
    expect(strList("a")).toEqual(["a"]);
    expect(strList(["a", 2, {}])).toEqual(["a", "2"]);
    expect(strList(null)).toBeNull();
    expect(strList({ a: 1 })).toBeNull();
    expect(strMap({ A: "1", B: 2, C: { value: "x", description: "d" }, D: [1] })).toEqual({ A: "1", B: "2", C: "x" });
    expect(strMap("x")).toEqual({});
  });

  it("takes the first non-empty line", () => {
    expect(oneLine("\n  make build\nmake test")).toBe("make build");
    expect(oneLine("")).toBe("");
  });
});
