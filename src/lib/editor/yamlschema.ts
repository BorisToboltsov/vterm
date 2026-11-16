// YAML checked against its JSON Schema, offline (ADR 0078): Compose, GitHub
// Actions (workflows and actions), GitLab CI, kustomization, Chart.yaml and the
// common Kubernetes kinds, vendored with the app (`schemas/`, NOTICE.md); a
// chart's own `values.schema.json` and a `# yaml-language-server: $schema=`
// line that names a file beside it are read through the file's connection.
// A schema named by URL is never fetched (principle 6). The validator is an
// interpreter (`@cfworker/json-schema`): the packaged CSP has no `eval`.
// What a schema says is a hint beside the server's linter, not a gate.

import type { MessageKey } from "../i18n";
import { loadYaml, type Yaml } from "../pipeline/yamldoc";
import type { EditorLangKind } from "./editorlang";

/** Which schema a file is checked against. */
export type SchemaRef =
  | { kind: "bundled"; id: BundledId; label: string }
  | { kind: "k8s"; label: string }
  | { kind: "file"; path: string; label: string }
  | { kind: "url"; url: string; label: string };

export type BundledId = "compose" | "gh-workflow" | "gh-action" | "gitlab-ci" | "kustomization" | "chart";

const BUNDLED_LABEL: Record<BundledId, string> = {
  compose: "Compose",
  "gh-workflow": "GitHub Actions",
  "gh-action": "GitHub Action",
  "gitlab-ci": "GitLab CI",
  kustomization: "Kustomize",
  chart: "Chart.yaml",
};

const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? "";
const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "" : p.slice(0, i);
};

/** A `# yaml-language-server: $schema=…` line in the first lines, as written. */
export function modelineSchema(text: string): string | null {
  const m = /^#\s*yaml-language-server:\s*\$schema=(\S+)/m.exec(text.split("\n").slice(0, 10).join("\n"));
  return m ? m[1] : null;
}

/** Resolve a modeline's target against the file's folder; a URL stays a URL (and is not fetched). */
export function resolveModeline(target: string, filePath: string): SchemaRef {
  if (/^[a-z]+:\/\//i.test(target)) return { kind: "url", url: target, label: base(target) || target };
  const sep = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
  const abs = /^([/\\]|[A-Za-z]:)/.test(target) ? target : `${dirOf(filePath)}${sep}${target.replace(/^\.[/\\]/, "")}`;
  return { kind: "file", path: abs, label: base(abs) };
}

/**
 * The schema of a YAML file, or null. A modeline wins; then the file's name or
 * dialect; a `values*.yaml` beside a `values.schema.json` (`siblings`) takes
 * its chart's schema.
 */
export function schemaFor(path: string, kind: EditorLangKind, text: string, siblings: readonly string[] = []): SchemaRef | null {
  const line = modelineSchema(text);
  if (line) return resolveModeline(line, path);
  const name = base(path);
  const bundled = (id: BundledId): SchemaRef => ({ kind: "bundled", id, label: BUNDLED_LABEL[id] });
  if (kind === "compose") return bundled("compose");
  if (kind === "ghactions") return bundled("gh-workflow");
  if (name === "action.yml" || name === "action.yaml") return bundled("gh-action");
  if (name === ".gitlab-ci.yml" || name === ".gitlab-ci.yaml") return bundled("gitlab-ci");
  if (name === "kustomization.yaml" || name === "kustomization.yml") return bundled("kustomization");
  if (name === "chart.yaml") return bundled("chart");
  if (kind === "k8s") return { kind: "k8s", label: "Kubernetes" };
  if (/^values.*\.ya?ml$/.test(name) && siblings.some((s) => s.toLowerCase() === "values.schema.json")) {
    const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    return { kind: "file", path: `${dirOf(path)}${sep}values.schema.json`, label: "values.schema.json" };
  }
  return null;
}

/** A finding of the check: where, and what — as a message key for the caller's `t()`. */
export interface SchemaIssue {
  from: number;
  to: number;
  key: MessageKey;
  params: Record<string, string | number>;
  severity: "error" | "warning";
}

type Json = unknown;
type Schema = Record<string, unknown>;

interface K8sBundle {
  version: string;
  index: Record<string, string>;
  definitions: Record<string, Schema>;
}

let validatorMod: Promise<typeof import("@cfworker/json-schema")> | null = null;
const loadValidator = () => (validatorMod ??= import("@cfworker/json-schema"));

const BUNDLES: Record<BundledId, () => Promise<{ default: Json }>> = {
  compose: () => import("./schemas/compose.json"),
  "gh-workflow": () => import("./schemas/gh-workflow.json"),
  "gh-action": () => import("./schemas/gh-action.json"),
  "gitlab-ci": () => import("./schemas/gitlab-ci.json"),
  kustomization: () => import("./schemas/kustomization.json"),
  chart: () => import("./schemas/chart.json"),
};
const k8sBundle = () => import("./schemas/k8s.json") as Promise<{ default: K8sBundle }>;

/** A bundled schema, parsed once. */
const cache = new Map<string, Promise<Json>>();
export function bundledSchema(id: BundledId): Promise<Json> {
  let p = cache.get(id);
  if (!p) {
    p = BUNDLES[id]().then((m) => m.default);
    cache.set(id, p);
  }
  return p;
}

/**
 * A schema that came from the server is not trusted: its patterns would run in
 * the window (`pattern` is a regular expression — a slow one stalls the
 * editor), so they are dropped; the rest is checked as given.
 */
export function untrustedSchema(raw: Json): Json {
  if (Array.isArray(raw)) return raw.map(untrustedSchema);
  if (!raw || typeof raw !== "object") return raw;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(raw as Record<string, Json>)) {
    if (k === "pattern" || k === "format") continue;
    if (k === "patternProperties") {
      out.additionalProperties = true;
      continue;
    }
    out[k] = untrustedSchema(v);
  }
  return out;
}

function draftOf(schema: Json): "4" | "7" | "2019-09" | "2020-12" {
  const s = (schema as Schema)?.$schema;
  if (typeof s !== "string") return "7";
  if (s.includes("2020-12")) return "2020-12";
  if (s.includes("2019-09")) return "2019-09";
  if (s.includes("draft-04")) return "4";
  return "7";
}

/** The path of a JSON pointer (`#/services/web/ports/0`). */
export function pointerPath(ptr: string): string[] {
  const p = ptr.replace(/^#/, "");
  if (p === "" || p === "/") return [];
  return p
    .slice(1)
    .split("/")
    .map((s) => decodeURIComponent(s).replace(/~1/g, "/").replace(/~0/g, "~"));
}

interface Unit {
  keyword: string;
  keywordLocation: string;
  instanceLocation: string;
  error: string;
}

/** Keywords that say something by themselves; the rest only carry a deeper error. */
const LEAF = new Set(["required", "type", "enum", "const", "false", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "uniqueItems", "minProperties", "maxProperties"]);

function issueOf(u: Unit): { key: MessageKey; params: Record<string, string | number> } {
  switch (u.keyword) {
    case "required": {
      const prop = /"([^"]+)"/.exec(u.error)?.[1] ?? "";
      return { key: "schema.required", params: { prop } };
    }
    case "type": {
      const t = /type "([^"]+)"/.exec(u.error)?.[1] ?? /must be (\w+)/.exec(u.error)?.[1] ?? "";
      return { key: "schema.type", params: { type: t } };
    }
    case "enum":
    case "const":
      return { key: "schema.enum", params: {} };
    case "false":
      return { key: "schema.unknownKey", params: { key: pointerPath(u.instanceLocation).pop() ?? "" } };
    case "minItems":
    case "minLength":
    case "minProperties":
    case "minimum":
      return { key: "schema.tooSmall", params: {} };
    case "maxItems":
    case "maxLength":
    case "maxProperties":
    case "maximum":
      return { key: "schema.tooLarge", params: {} };
    default:
      return { key: "schema.invalid", params: { detail: u.error.slice(0, 160) } };
  }
}

/** The YAML node at a path, its key's range for an unknown key, else its value's range. */
function rangeAt(doc: ReturnType<Yaml["parseDocument"]>, path: string[], onKey: boolean, length: number): [number, number] {
  const Y = doc as unknown as { getIn: (p: unknown[], keep: boolean) => { range?: [number, number, number] } | undefined; contents: { range?: [number, number, number]; items?: unknown[] } | null };
  const keys = path.map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  if (onKey && keys.length > 0) {
    const parent = keys.length > 1 ? (Y.getIn(keys.slice(0, -1), true) as { items?: { key?: { value?: unknown; range?: [number, number, number] } }[] } | undefined) : (Y.contents as { items?: { key?: { value?: unknown; range?: [number, number, number] } }[] } | null);
    const pair = parent?.items?.find((it) => String(it.key?.value) === String(keys[keys.length - 1]));
    if (pair?.key?.range) return [pair.key.range[0], pair.key.range[1]];
  }
  for (let n = keys.length; n >= 0; n--) {
    const node = n === 0 ? Y.contents : Y.getIn(keys.slice(0, n), true);
    if (node?.range) {
      const [a, b] = node.range;
      // A map or a list: mark its first line only, not the whole block.
      return [a, Math.min(b, a + 80, length)];
    }
  }
  return [0, Math.min(1, length)];
}

/**
 * Check one YAML document's value against `schema`; issues are placed by the
 * document's own ranges. Several errors at one place keep the most telling.
 */
export async function checkDocument(
  schema: Json,
  doc: ReturnType<Yaml["parseDocument"]>,
  value: Json,
  offset: number,
  length: number,
): Promise<SchemaIssue[]> {
  const { Validator } = await loadValidator();
  const v = new Validator(schema as never, draftOf(schema), false);
  const res = v.validate(value);
  if (res.valid) return [];
  const units = (res.errors as Unit[]).filter((u) => LEAF.has(u.keyword));
  // One finding per place, the most telling: a key is «unknown» (`false`) only
  // when nothing else is wrong there — 2020-12's `unevaluatedProperties` also
  // calls a known key that failed its own schema unevaluated.
  const RANK: Record<string, number> = { required: 0, type: 1, enum: 2, const: 2, false: 9 };
  const rank = (u: Unit) => RANK[u.keyword] ?? 5;
  const byPlace = new Map<string, Unit>();
  for (const u of units) {
    const k = u.instanceLocation;
    const prev = byPlace.get(k);
    if (!prev || rank(u) < rank(prev)) byPlace.set(k, u);
  }
  const out: SchemaIssue[] = [];
  for (const u of byPlace.values()) {
    const path = pointerPath(u.instanceLocation);
    const [from, to] = rangeAt(doc, path, u.keyword === "false", length);
    const { key, params } = issueOf(u);
    out.push({ from: offset + from, to: offset + Math.max(to, from + 1), key, params, severity: u.keyword === "false" ? "warning" : "error" });
  }
  return out.sort((a, b) => a.from - b.from).slice(0, 200);
}

/** The Kubernetes definition of a document's `apiVersion`/`kind`, as a schema; null — not a kind we carry. */
export function k8sSchemaOf(bundle: K8sBundle, value: Json): Json | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const def = bundle.index[`${String(v.apiVersion)}|${String(v.kind)}`];
  if (!def) return null;
  return { $ref: `#/definitions/${def}`, definitions: bundle.definitions };
}

/**
 * Check a YAML text against `ref`. `read` reads a schema file beside the file
 * (through its connection). Syntax errors are the editor's own linter's to say;
 * a document that does not parse is skipped. Returns null when the schema could
 * not be had — the status bar says why.
 */
export async function checkYaml(
  ref: SchemaRef,
  text: string,
  read: (path: string) => Promise<string>,
): Promise<{ issues: SchemaIssue[] } | { unavailable: "url" | "unread" }> {
  if (ref.kind === "url") return { unavailable: "url" };
  const Y = await loadYaml();
  let schema: Json | null = null;
  let k8s: K8sBundle | null = null;
  if (ref.kind === "bundled") schema = await bundledSchema(ref.id);
  else if (ref.kind === "k8s") k8s = (await k8sBundle()).default;
  else {
    try {
      schema = untrustedSchema(JSON.parse(await read(ref.path)));
    } catch {
      return { unavailable: "unread" };
    }
  }
  const docs = Y.parseAllDocuments(text, { uniqueKeys: false, maxAliasCount: 200 } as never) as unknown as ReturnType<Yaml["parseDocument"]>[];
  const issues: SchemaIssue[] = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    const d = doc as unknown as { errors: unknown[]; toJS: (o?: unknown) => Json; range?: [number, number, number] };
    if (d.errors.length > 0) continue;
    let value: Json;
    try {
      value = d.toJS({ maxAliasCount: 200 });
    } catch {
      continue;
    }
    if (value === null || value === undefined) continue;
    const s = k8s ? k8sSchemaOf(k8s, value) : schema;
    if (!s) continue;
    issues.push(...(await checkDocument(s, doc, value, 0, text.length)));
  }
  return { issues };
}

// ── Completion from the schema ───────────────────────────────────────────────

/** A schema with its `$ref`s followed and `allOf` merged — enough to list keys and values. */
function resolve(schema: Schema | undefined, root: Schema, depth = 0): Schema[] {
  if (!schema || typeof schema !== "object" || depth > 12) return [];
  if (typeof schema.$ref === "string") {
    const target = pointerPath(schema.$ref).reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), root);
    return resolve(target as Schema, root, depth + 1);
  }
  const out: Schema[] = [schema];
  for (const k of ["allOf", "anyOf", "oneOf"] as const) {
    const list = schema[k];
    if (Array.isArray(list)) for (const s of list) out.push(...resolve(s as Schema, root, depth + 1));
  }
  return out;
}

/** The schema at a key path (`["services", "web"]`), followed through properties, items and patterns. */
export function schemaAt(root: Schema, path: readonly (string | number)[]): Schema[] {
  let cur = resolve(root, root);
  for (const seg of path) {
    const next: Schema[] = [];
    for (const s of cur) {
      if (typeof seg === "number") {
        const items = s.items;
        if (items && typeof items === "object" && !Array.isArray(items)) next.push(...resolve(items as Schema, root));
        continue;
      }
      const props = s.properties as Record<string, Schema> | undefined;
      if (props?.[seg]) next.push(...resolve(props[seg], root));
      const pats = s.patternProperties as Record<string, Schema> | undefined;
      if (pats) for (const [re, ps] of Object.entries(pats)) if (safeTest(re, seg)) next.push(...resolve(ps, root));
      if (!props?.[seg] && s.additionalProperties && typeof s.additionalProperties === "object") next.push(...resolve(s.additionalProperties as Schema, root));
    }
    cur = next;
    if (cur.length === 0) break;
  }
  return cur;
}

/** A vendored pattern, tried on a short key; a pattern that will not compile matches nothing. */
function safeTest(re: string, s: string): boolean {
  if (re.length > 200 || s.length > 200) return false;
  try {
    return new RegExp(re, "u").test(s);
  } catch {
    return false;
  }
}

export interface KeyOption {
  label: string;
  detail: string | null;
  info: string | null;
}

/** The keys a mapping at `path` may still take, with their descriptions. */
export function keyOptions(root: Schema, path: readonly (string | number)[], present: ReadonlySet<string>): KeyOption[] {
  const seen = new Map<string, KeyOption>();
  for (const s of schemaAt(root, path)) {
    const props = s.properties as Record<string, Schema> | undefined;
    if (!props) continue;
    for (const [k, v] of Object.entries(props)) {
      if (present.has(k) || seen.has(k)) continue;
      const rs = resolve(v, root);
      const desc = rs.map((x) => x.description).find((d): d is string => typeof d === "string") ?? null;
      const type = rs.map((x) => x.type).find((t): t is string => typeof t === "string") ?? null;
      seen.set(k, { label: k, detail: type, info: desc });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The values a scalar at `path` may take: an enum's, a const, or true/false. */
export function valueOptions(root: Schema, path: readonly (string | number)[]): string[] {
  const out = new Set<string>();
  for (const s of schemaAt(root, path)) {
    if (Array.isArray(s.enum)) for (const v of s.enum) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.add(String(v));
    if (s.const !== undefined && typeof s.const !== "object") out.add(String(s.const));
    if (s.type === "boolean") {
      out.add("true");
      out.add("false");
    }
  }
  return [...out].slice(0, 100);
}

/**
 * Where the cursor is in a YAML text, for completion: the key path of the
 * mapping it stands in (a list item is `0` — its schema is the list's items),
 * the key whose value it is after (`key: │`), and the keys that mapping
 * already has. Indentation only — the line being typed does not parse yet.
 */
export function cursorPath(text: string, pos: number): { path: (string | number)[]; atValue: string | null; present: Set<string> } {
  const before = text.slice(0, pos);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const lead = (/^\s*/.exec(line)?.[0] ?? "").length;
  const dash = /^\s*-\s+/.exec(line);
  const keyCol = dash ? dash[0].length : lead;
  const value = /^\s*(?:-\s+)?([\w.$/-]+):\s+\S*$/.exec(line);
  const indentOf = (l: string) => (/^\s*/.exec(l)?.[0] ?? "").length;
  const skip = (l: string) => l.trim() === "" || /^\s*#/.test(l);

  const above = text.slice(0, lineStart).split("\n");
  const path: (string | number)[] = dash ? [0] : [];
  let limit = lead;
  for (let i = above.length - 1; i >= 0 && limit > 0; i--) {
    const l = above[i];
    if (/^---/.test(l)) break;
    if (skip(l)) continue;
    const ind = indentOf(l);
    if (ind >= limit) continue;
    if (/^\s*-(\s|$)/.test(l)) {
      path.unshift(0);
      limit = ind;
      continue;
    }
    const key = /^\s*([\w.$/-]+):/.exec(l);
    if (key) {
      path.unshift(key[1]);
      limit = ind;
    }
  }

  const present = new Set<string>();
  const all = text.split("\n");
  const here = above.length - 1;
  for (let i = here - 1; i >= 0; i--) {
    const l = all[i];
    if (skip(l)) continue;
    const ind = indentOf(l);
    const item = /^(\s*-\s+)([\w.$/-]+):/.exec(l);
    if (item && item[1].length === keyCol) {
      present.add(item[2]);
      break;
    }
    if (ind < keyCol) break;
    const k = ind === keyCol ? /^\s*([\w.$/-]+):/.exec(l) : null;
    if (k) present.add(k[1]);
  }
  for (let i = here + 1; i < all.length; i++) {
    const l = all[i];
    if (skip(l)) continue;
    const ind = indentOf(l);
    // A shallower line ends the mapping — the next list item's dash included.
    if (ind < keyCol) break;
    const k = ind === keyCol ? /^\s*([\w.$/-]+):/.exec(l) : null;
    if (k) present.add(k[1]);
  }
  if (value) present.delete(value[1]);
  return { path, atValue: value ? value[1] : null, present };
}

/**
 * The schema a completion at `pos` reads: the bundled or read one, or — for
 * Kubernetes — the kind of the document the cursor is in (its `apiVersion` and
 * `kind` lines). Null — nothing to offer from.
 */
export async function schemaRoot(ref: SchemaRef, text: string, pos: number, read: (path: string) => Promise<string>): Promise<Schema | null> {
  if (ref.kind === "url") return null;
  if (ref.kind === "bundled") return (await bundledSchema(ref.id)) as Schema;
  if (ref.kind === "file") {
    try {
      return untrustedSchema(JSON.parse(await read(ref.path))) as Schema;
    } catch {
      return null;
    }
  }
  const start = text.lastIndexOf("\n---", pos);
  const end = text.indexOf("\n---", pos);
  const docText = text.slice(start < 0 ? 0 : start, end < 0 ? text.length : end);
  const apiVersion = /^apiVersion:\s*["']?([^"'\s#]+)/m.exec(docText)?.[1];
  const kind = /^kind:\s*["']?([^"'\s#]+)/m.exec(docText)?.[1];
  if (!apiVersion || !kind) return null;
  const bundle = (await k8sBundle()).default;
  return k8sSchemaOf(bundle, { apiVersion, kind }) as Schema | null;
}

/** Completions at `pos` from `root`: the keys the mapping may still take, or a value's choices. */
export function schemaCompletions(root: Schema, text: string, pos: number): { from: number; options: { label: string; detail?: string; info?: string; type: string }[] } | null {
  const where = cursorPath(text, pos);
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const line = text.slice(lineStart, pos);
  if (where.atValue) {
    const values = valueOptions(root, [...where.path, where.atValue]);
    if (values.length === 0) return null;
    const word = /[\w.-]*$/.exec(line)?.[0] ?? "";
    return { from: pos - word.length, options: values.map((v) => ({ label: v, type: "enum" })) };
  }
  if (/:\s/.test(line) || /^\s*#/.test(line)) return null;
  const word = /[\w.$/-]*$/.exec(line)?.[0] ?? "";
  const opts = keyOptions(root, where.path, where.present);
  if (opts.length === 0) return null;
  return {
    from: pos - word.length,
    options: opts.map((o) => ({ label: o.label, detail: o.detail ?? undefined, info: o.info ?? undefined, type: "property" })),
  };
}
