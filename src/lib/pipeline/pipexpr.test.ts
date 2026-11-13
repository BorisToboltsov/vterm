import { describe, expect, it } from "vitest";
import { evalGithub, evalGitlab, ghRefFilter, hasStatusCheck, safeRegex, truth, UNKNOWN, unwrapExpr, type ExprValue, type GhScope } from "./pipexpr";

const ctx: Record<string, ExprValue> = {
  "github.event_name": "push",
  "github.ref": "refs/heads/main",
  "github.ref_name": "main",
  "env.MODE": "fast",
  "env.N": "3",
};
const scope = (over: Partial<GhScope> = {}): GhScope => ({
  lookup: (path) => (path.join(".") in ctx ? ctx[path.join(".")] : UNKNOWN),
  success: true,
  ...over,
});
const gh = (src: string, s = scope()) => evalGithub(src, s);

describe("truth", () => {
  it("reads values as an if does", () => {
    expect(truth("")).toBe(false);
    expect(truth(0)).toBe(false);
    expect(truth(Number.NaN)).toBe(false);
    expect(truth(null)).toBe(false);
    expect(truth("false")).toBe(true);
    expect(truth({})).toBe(true);
    expect(truth(UNKNOWN)).toBe(UNKNOWN);
  });
});

describe("evalGithub", () => {
  it("compares as GitHub does: strings ignoring case, others as numbers", () => {
    expect(gh("github.ref == 'refs/heads/main'").value).toBe(true);
    expect(gh("${{ github.ref_name == 'MAIN' }}").value).toBe(true);
    expect(gh("github.ref_name == 'MAIN'").value).toBe(true);
    expect(gh("env.N == 3").value).toBe(true);
    expect(gh("env.N > 2 && env.N <= 3 && 1 < 2 && 2 >= 2").value).toBe(true);
    expect(gh("'b' > 'A'").value).toBe(true);
    expect(gh("null == 0 && true == 1 && '' == 0").value).toBe(true);
    expect(gh("github.event_name != 'pull_request'").value).toBe(true);
    expect(gh("0x10 == 16").value).toBe(true);
  });

  it("knows the functions an if uses", () => {
    expect(gh("startsWith(github.ref, 'REFS/heads/')").value).toBe(true);
    expect(gh("endsWith(github.ref, '/main')").value).toBe(true);
    expect(gh("contains(github.ref, 'heads')").value).toBe(true);
    expect(gh("format('{0}-{1}', 'a', 'b') == 'a-b'").value).toBe(true);
    expect(gh("always()").value).toBe(true);
    expect(gh("failure() || cancelled()").value).toBe(false);
    expect(gh("success()", scope({ success: false })).value).toBe(false);
    const r = gh("hashFiles('**/x') != ''");
    expect(r.value).toBe(UNKNOWN);
    expect(r.unknowns).toEqual(["hashFiles()"]);
  });

  it("keeps an unknown unknown unless the other side settles it", () => {
    expect(gh("secrets.TOKEN != ''").unknowns).toEqual(["secrets.TOKEN"]);
    expect(gh("github.event_name == 'pull_request' && secrets.TOKEN").value).toBe(false);
    expect(gh("secrets.TOKEN && github.event_name == 'pull_request'").value).toBe(false);
    expect(gh("github.event_name == 'push' || vars.X").value).toBe(true);
    expect(gh("vars.X || github.event_name == 'push'").value).toBe(true);
    expect(gh("vars.X || false").value).toBe(UNKNOWN);
    expect(gh("vars.X && true").value).toBe(UNKNOWN);
    expect(gh("!vars.X").value).toBe(UNKNOWN);
    expect(gh("vars.X > 1").value).toBe(UNKNOWN);
    expect(gh("!(github.ref == 'x')").value).toBe(true);
    expect(gh("github.event.commits[0].message").unknowns).toEqual(["github.event.commits.0.message"]);
    expect(gh("github.event.*.x").value).toBe(UNKNOWN);
    expect(gh("needs[vars.X]").value).toBe(UNKNOWN);
  });

  it("returns the value an operator chose, and says when it cannot parse", () => {
    expect(gh("env.MODE || 'slow'").value).toBe("fast");
    expect(gh("'it''s'").value).toBe("it's");
    expect(gh("true && false").value).toBe(false);
    expect(gh("null").value).toBeNull();
    expect(gh("contains(fromJSON('[1]'), 1)").value).toBe(UNKNOWN);
    for (const bad of ["github.ref ==", "'open", "(a", "a b", "@", "", "f(a b)", "a.", "a[1"]) expect(gh(bad).invalid).toBe(true);
  });

  it("strips a wrapping ${{ }} and sees status functions", () => {
    expect(unwrapExpr("${{ a }}")).toBe(" a ");
    expect(unwrapExpr("a")).toBe("a");
    expect(hasStatusCheck("always() && x")).toBe(true);
    expect(hasStatusCheck("!cancelled ()")).toBe(true);
    expect(hasStatusCheck("github.ref == 'x'")).toBe(false);
  });
});

const vars = (known: Record<string, string | null>) => (name: string) => (name in known ? known[name] : UNKNOWN);
const gl = (src: string, known: Record<string, string | null> = {}) => evalGitlab(src, vars(known));

describe("evalGitlab", () => {
  const branch = { CI_COMMIT_BRANCH: "main", CI_COMMIT_TAG: null, CI_PIPELINE_SOURCE: "push" };

  it("compares variables with strings and null", () => {
    expect(gl('$CI_COMMIT_BRANCH == "main"', branch).value).toBe(true);
    expect(gl("${CI_COMMIT_BRANCH} == 'main'", branch).value).toBe(true);
    expect(gl("$CI_COMMIT_TAG == null", branch).value).toBe(true);
    expect(gl('$CI_PIPELINE_SOURCE != "schedule"', branch).value).toBe(true);
    expect(gl("$CI_COMMIT_TAG", branch).value).toBe(false);
    expect(gl("$CI_COMMIT_BRANCH", branch).value).toBe(true);
  });

  it("matches patterns, from the text or from a variable", () => {
    expect(gl("$CI_COMMIT_BRANCH =~ /^ma/", branch).value).toBe(true);
    expect(gl("$CI_COMMIT_BRANCH !~ /^MA/i", branch).value).toBe(false);
    expect(gl("$CI_COMMIT_TAG =~ /^v/", branch).value).toBe(false);
    expect(gl("$CI_COMMIT_BRANCH =~ $P", { ...branch, P: "/ain$/" }).value).toBe(true);
    expect(gl("$CI_COMMIT_BRANCH =~ $P", { ...branch, P: null }).value).toBe(UNKNOWN);
    expect(gl("$CI_COMMIT_BRANCH =~ $Q", branch).value).toBe(UNKNOWN);
    expect(gl("$CI_COMMIT_BRANCH =~ /(a+)+$/", branch).unknowns).toEqual(["regex"]);
    expect(gl("$CI_COMMIT_BRANCH == /x/", branch).value).toBe(false);
  });

  it("joins with && and || in three values, and groups", () => {
    expect(gl('$CI_COMMIT_BRANCH == "main" && $DEPLOY', branch).unknowns).toEqual(["$DEPLOY"]);
    expect(gl('$CI_COMMIT_TAG && $DEPLOY', branch).value).toBe(false);
    expect(gl('$DEPLOY && $CI_COMMIT_TAG', branch).value).toBe(false);
    expect(gl('$DEPLOY || $CI_COMMIT_BRANCH == "main"', branch).value).toBe(true);
    expect(gl('$CI_COMMIT_BRANCH == "main" || $DEPLOY', branch).value).toBe(true);
    expect(gl('$DEPLOY || $CI_COMMIT_TAG', branch).value).toBe(UNKNOWN);
    expect(gl('($CI_COMMIT_TAG || $CI_COMMIT_BRANCH == "main") && $CI_PIPELINE_SOURCE == "push"', branch).value).toBe(true);
    expect(gl("/x/", branch).value).toBe(true);
  });

  it("says when it cannot parse", () => {
    for (const bad of ['$A == "x', "$A ==", "($A", "$A $B", "&", "", "$A =~ /x"]) expect(gl(bad).invalid).toBe(true);
  });
});

describe("safeRegex", () => {
  it("refuses patterns that could hang on a short name", () => {
    expect(safeRegex("^v\\d+", "")?.test("v12")).toBe(true);
    expect(safeRegex("(a+)+$", "")).toBeNull();
    expect(safeRegex("x".repeat(201), "")).toBeNull();
    expect(safeRegex("[", "")).toBeNull();
    expect(safeRegex("a", "gx")?.flags).toBe("");
  });
});

describe("ghRefFilter", () => {
  it("matches GitHub's branch and tag patterns", () => {
    expect(ghRefFilter(["main"])("main")).toBe(true);
    expect(ghRefFilter(["main"])("main2")).toBe(false);
    expect(ghRefFilter(["release/*"])("release/1.0")).toBe(true);
    expect(ghRefFilter(["release/*"])("release/1/hotfix")).toBe(false);
    expect(ghRefFilter(["release/**"])("release/1/hotfix")).toBe(true);
    expect(ghRefFilter(["v?.0"])("v1.0")).toBe(true);
    expect(ghRefFilter(["v[12].*"])("v2.5")).toBe(true);
    expect(ghRefFilter(["v[12].*"])("v3.5")).toBe(false);
    expect(ghRefFilter(["v[0-9]+"])("v123")).toBe(true);
    expect(ghRefFilter(["a.b"])("aXb")).toBe(false);
    expect(ghRefFilter(["x["])("x[")).toBe(true);
  });

  it("lets a later negation take back what an earlier pattern let in", () => {
    const f = ghRefFilter(["feature/**", "!feature/wip/**"]);
    expect(f("feature/a")).toBe(true);
    expect(f("feature/wip/a")).toBe(false);
    expect(ghRefFilter(["!x"])("y")).toBe(false);
  });
});
