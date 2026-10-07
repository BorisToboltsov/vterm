import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Who receives traffic is read, never inferred (v1.5).
//
// The route view answers "where does this request end up" for someone looking at
// a 502. The tempting shortcut is to match a service's selector against pod
// labels on the frontend — the data is already there. It is wrong exactly when
// it matters: a pod whose labels match is not an endpoint while it is not Ready,
// held back by a readiness gate, or terminating, and the view would paint
// "traffic goes here" onto it. So endpoints come from EndpointSlices only, and
// the selector is display text that is never matched against anything.
//
// The second half is the same rule from the other side: a list the cluster
// refused to give is not an empty list. "No endpoints" and "no ingress points
// here" are statements about the cluster; they may only be made about lists
// that were actually read.
//
// Each check is a function over source text and is shown to catch its own
// violation. Checked on the source with comments stripped, so a comment naming
// the rule can't satisfy it (and a comment naming the anti-pattern can't trip it).

const LIB = join(process.cwd(), "src", "lib");

function strip(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const read = (name: string) => strip(readFileSync(join(LIB, name), "utf8"));

/** Anything that could match pods to a service: pod data, labels, a selector as data. */
function infersEndpoints(src: string): string[] {
  const found: string[] = [];
  for (const [what, re] of [
    ["pod data", /\bK8sPod\b|\bparsePods\b|\bpodsArgs\b|\bgroupByOwner\b/],
    ["labels", /\blabels\b|\bmatchLabels\b|\bmatchExpressions\b/],
    ["a selector", /\bselector\b/i],
  ] as const) {
    if (re.test(src)) found.push(what);
  }
  return found;
}

/** The view may show the selector as text — and do nothing else with it. */
function selectorUses(src: string): string[] {
  return [...src.matchAll(/[^\n]*\bselector\b[^\n]*/gi)].map((m) => m[0].trim());
}

/** Every use of `parseEndpointSlices` must be conditional on the read having succeeded. */
function slicesTrustedUnread(src: string): string[] {
  return [...src.matchAll(/[^\n;]*\bparseEndpointSlices\([^\n]*/g)]
    .map((m) => m[0].trim())
    .filter((line) => !/slicesError\s*===\s*null\s*\?\s*parseEndpointSlices\(/.test(line))
    .filter((line) => !/^parseEndpointSlices,?$/.test(line)); // the import line
}

/** The arguments of the `buildRoutes(…)` call, or null when it is not called. */
function buildRoutesCall(src: string): string | null {
  const at = src.indexOf("buildRoutes(");
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + "buildRoutes".length; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  return null;
}

describe("route guard: endpoints are read from EndpointSlices", () => {
  it("the route model never sees a pod, a label or a selector", () => {
    expect(infersEndpoints(read("k8sroute.ts"))).toEqual([]);
  });

  it("the route view shows the selector as text and does nothing else with it", () => {
    const src = read("K8sRouteView.svelte");
    expect(infersEndpoints(src).filter((w) => w !== "a selector")).toEqual([]);
    // One place: the caption under "No endpoints", fed to the translation as is.
    expect(selectorUses(src)).toEqual([
      '{r.service.selector ? t("k8s.routeSelector", { selector: r.service.selector }) : t("k8s.routeNoSelector")}',
    ]);
  });

  it("a service carries its selector as display text, not as a label map", () => {
    const src = read("k8s.ts");
    const start = src.indexOf("export interface K8sService {");
    expect(start, "K8sService not found in k8s.ts").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toMatch(/^\s*selector: string;$/m);
  });

  it("the check catches the shortcut it exists to stop", () => {
    // Matching labels in the model, in any of the obvious spellings.
    expect(infersEndpoints("const mine = pods.filter((p) => matches(p.labels, svc.selector));")).toEqual([
      "labels",
      "a selector",
    ]);
    expect(infersEndpoints('import { parsePods, type K8sPod } from "./k8s";')).toEqual(["pod data"]);
    expect(infersEndpoints("const want = service.spec.Selector;")).toEqual(["a selector"]);
    // A second use of the selector in the view is a use beyond display.
    expect(selectorUses("{#if podMatches(pod, r.service.selector)}\n{r.service.selector}")).toHaveLength(2);
  });
});

describe("route guard: an unread list is not an empty one", () => {
  const panel = read("K8sPanel.svelte");

  it("the panel parses slices only when their read succeeded", () => {
    expect(panel).toMatch(/slicesError\s*=\s*eps\s*\?\s*listFailure\(eps\.stdout,\s*eps\.stderr,\s*eps\.exitCode\)\s*:\s*null/);
    expect(slicesTrustedUnread(panel)).toEqual([]);
    // …and they stay unknown (null) otherwise — not an empty list.
    expect(panel).toMatch(/slices\s*=\s*eps\s*&&\s*slicesError\s*===\s*null\s*\?\s*parseEndpointSlices\(eps\.stdout\)\s*:\s*null/);
  });

  it("the panel records why services and ingresses could not be read", () => {
    expect(panel).toMatch(/services:\s*listFailure\(svc\.stdout,\s*svc\.stderr,\s*svc\.exitCode\)/);
    expect(panel).toMatch(/ingress:\s*listFailure\(ing\.stdout,\s*ing\.stderr,\s*ing\.exitCode\)/);
  });

  it("the route is built from ingresses only when they were read", () => {
    const call = buildRoutesCall(panel);
    expect(call, "buildRoutes( not called in K8sPanel.svelte").not.toBeNull();
    expect(call).toMatch(/buildRoutes\(\s*services\s*,\s*netErrors\.ingress\s*===\s*null\s*\?\s*ingresses\s*:\s*null\s*,\s*slices\s*\)/);
  });

  it("unread services are an error on screen, in either view", () => {
    const src = read("K8sNetwork.svelte");
    const failed = src.indexOf("{#if servicesError !== null}");
    const empty = src.indexOf('t("k8s.noServices")');
    expect(failed, "the services-error branch is gone from K8sNetwork.svelte").toBeGreaterThan(-1);
    // Before "No services", so an unread list can never fall through to it.
    expect(failed).toBeLessThan(empty);
    expect(src.slice(failed, empty)).toMatch(/t\("k8s\.servicesFailed"\)/);
  });

  it("the check catches a read that is trusted without asking", () => {
    // The pre-guard shape: whatever came back is parsed, a refusal included.
    expect(slicesTrustedUnread("slices = parseEndpointSlices(eps.stdout);")).toEqual([
      "slices = parseEndpointSlices(eps.stdout);",
    ]);
    expect(slicesTrustedUnread("slices = eps ? parseEndpointSlices(eps.stdout) : [];")).toHaveLength(1);
    expect(buildRoutesCall("const routes = $derived(buildRoutes(services, ingresses, slices));")).not.toMatch(
      /netErrors\.ingress\s*===\s*null/,
    );
  });
});
