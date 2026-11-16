#!/usr/bin/env node
// Vendor the JSON schemas the editor validates YAML against offline (ADR 0078).
// Run by hand when a schema should be refreshed: `node scripts/schemas.mjs`.
// The network is used here, at development time only — the app never fetches a
// schema (principle 6). Every source and its license is listed in
// src/lib/editor/schemas/NOTICE.md; a source that is not MIT/Apache-2.0 is not
// vendored (the Ansible schemas of ansible-lint are GPL-3.0 — not here).
//
// Every source is pinned: a URL at one commit, and the SHA-256 of the bytes it
// served when it was reviewed. A download that does not match writes nothing —
// a source replaced upstream cannot slip into the repository unnoticed. To
// move to newer schemas on purpose: change the commits, run with
// `--print-hashes`, review what came, put the new hashes here, run again.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "src/lib/editor/schemas");
const K8S_VERSION = "v1.31.0";

const SCHEMASTORE = "202f2efd45e52dcd83acdf3f684489fa78868338";
const COMPOSE_SPEC = "3a4a6995e4a971f6173dff9130cb3e38e6738651";
const GITLAB = "1a00245cce8d16457ec942b2f26aed1c3f875afd";
const KUBERNETES = "9edcffcde5595e8a5b1a35f88c421764e575afce"; // the commit of tag v1.31.0

const SOURCES = {
  compose: {
    url: `https://raw.githubusercontent.com/compose-spec/compose-spec/${COMPOSE_SPEC}/schema/compose-spec.json`,
    sha256: "d549057ebc2925f39f62799eab0db7b9e2c18b35b6c00595199116da3ed10e64",
  },
  "gh-workflow": {
    url: `https://raw.githubusercontent.com/SchemaStore/schemastore/${SCHEMASTORE}/src/schemas/json/github-workflow.json`,
    sha256: "0528a890c1a6f4209444c421dbb752888a934a540f2a677146d78ed7f2321cbf",
  },
  "gh-action": {
    url: `https://raw.githubusercontent.com/SchemaStore/schemastore/${SCHEMASTORE}/src/schemas/json/github-action.json`,
    sha256: "224326cc5a334bdb97b56b6fc320cd4381ba7d61b477b425ed506e6a420b52ba",
  },
  "gitlab-ci": {
    url: `https://gitlab.com/gitlab-org/gitlab/-/raw/${GITLAB}/app/assets/javascripts/editor/schema/ci.json`,
    sha256: "ee4677b5c6f5e15e4379f206c06c8405be433d6297d36f45e13e7ea39583f524",
  },
  kustomization: {
    url: `https://raw.githubusercontent.com/SchemaStore/schemastore/${SCHEMASTORE}/src/schemas/json/kustomization.json`,
    sha256: "d3814c6203396fb1251f517fa33d1427f7468e25e639b270f692800b51b51cfb",
  },
  chart: {
    url: `https://raw.githubusercontent.com/SchemaStore/schemastore/${SCHEMASTORE}/src/schemas/json/chart.json`,
    sha256: "632ece859517b2d133950300c43c6180503a5a83a21fb5389fccc1dfb757f826",
  },
};

const SWAGGER = {
  url: `https://raw.githubusercontent.com/kubernetes/kubernetes/${KUBERNETES}/api/openapi-spec/swagger.json`,
  sha256: "ac357350d9d00ee233ea9a172d7c868201ff405332fec8ffe0fda25dee3e41b4",
};

const printHashes = process.argv.includes("--print-hashes");

/** The kinds people write by hand; their definitions and what they reach are kept. */
const K8S_KINDS = [
  ["v1", "Pod"],
  ["v1", "Service"],
  ["v1", "ConfigMap"],
  ["v1", "Secret"],
  ["v1", "Namespace"],
  ["v1", "PersistentVolumeClaim"],
  ["v1", "PersistentVolume"],
  ["v1", "ServiceAccount"],
  ["v1", "LimitRange"],
  ["v1", "ResourceQuota"],
  ["apps/v1", "Deployment"],
  ["apps/v1", "StatefulSet"],
  ["apps/v1", "DaemonSet"],
  ["apps/v1", "ReplicaSet"],
  ["batch/v1", "Job"],
  ["batch/v1", "CronJob"],
  ["networking.k8s.io/v1", "Ingress"],
  ["networking.k8s.io/v1", "IngressClass"],
  ["networking.k8s.io/v1", "NetworkPolicy"],
  ["rbac.authorization.k8s.io/v1", "Role"],
  ["rbac.authorization.k8s.io/v1", "RoleBinding"],
  ["rbac.authorization.k8s.io/v1", "ClusterRole"],
  ["rbac.authorization.k8s.io/v1", "ClusterRoleBinding"],
  ["autoscaling/v2", "HorizontalPodAutoscaler"],
  ["policy/v1", "PodDisruptionBudget"],
  ["storage.k8s.io/v1", "StorageClass"],
];

const MAX_DESCRIPTION = 280;

/**
 * The bytes of a pinned source, parsed — or an error when they are not the
 * bytes that were reviewed. With `--print-hashes` it says what it got instead.
 */
async function get(name, { url, sha256 }) {
  const res = await fetch(url, { headers: { "User-Agent": "schema-vendoring" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (printHashes) console.log(name, got);
  else if (got !== sha256) throw new Error(`${name}: sha256 ${got}, pinned ${sha256} — nothing is written`);
  return JSON.parse(bytes.toString("utf8"));
}

/** Descriptions cut to a sentence or two — they are completion hints, not documentation. */
function trimDescriptions(node) {
  if (Array.isArray(node)) return node.map(trimDescriptions);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("x-kubernetes-") || k === "markdownDescription" || k === "examples") continue;
    if (k === "description" && typeof v === "string") {
      out[k] = v.length > MAX_DESCRIPTION ? v.slice(0, MAX_DESCRIPTION).replace(/\s+\S*$/, "") + "…" : v;
      continue;
    }
    out[k] = trimDescriptions(v);
  }
  return out;
}

/** The definitions reachable from `roots` by `$ref`. */
function reachable(defs, roots) {
  const seen = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")) {
        const name = v.slice("#/definitions/".length);
        if (!seen.has(name) && defs[name]) {
          seen.add(name);
          walk(defs[name]);
        }
      } else walk(v);
    }
  };
  roots.forEach((r) => {
    seen.add(r);
    walk(defs[r]);
  });
  return seen;
}

/** Kubernetes' OpenAPI definitions as JSON Schema: strict objects, int-or-string as both. */
function k8sSchema(swagger) {
  const defs = swagger.definitions;
  const index = {};
  const roots = [];
  for (const [name, def] of Object.entries(defs)) {
    for (const gvk of def["x-kubernetes-group-version-kind"] ?? []) {
      const apiVersion = gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
      if (K8S_KINDS.some(([v, k]) => v === apiVersion && k === gvk.kind)) {
        index[`${apiVersion}|${gvk.kind}`] = name;
        roots.push(name);
      }
    }
  }
  const keep = reachable(defs, roots);
  const out = {};
  for (const name of [...keep].sort()) {
    let def = defs[name];
    if (def.format === "int-or-string") def = { description: def.description, oneOf: [{ type: "string" }, { type: "integer" }] };
    else if (name.endsWith(".api.resource.Quantity")) def = { description: def.description, oneOf: [{ type: "string" }, { type: "number" }] };
    else if (def.type === "object" && def.properties && def.additionalProperties === undefined) def = { ...def, additionalProperties: false };
    // `apiVersion` and `kind` are checked by the index, not by an enum the swagger lacks.
    out[name] = def;
  }
  return { index, definitions: trimDescriptions(out) };
}

// Everything is fetched and checked before anything is written.
const out = {};
for (const [name, source] of Object.entries(SOURCES)) out[name] = trimDescriptions(await get(name, source));
const k8s = k8sSchema(await get("swagger", SWAGGER));
if (printHashes) process.exit(0);

mkdirSync(OUT, { recursive: true });
for (const [name, schema] of Object.entries(out)) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(schema));
  console.log(name, JSON.stringify(schema).length);
}
writeFileSync(join(OUT, "k8s.json"), JSON.stringify({ version: K8S_VERSION, ...k8s }));
console.log("k8s", JSON.stringify(k8s).length, Object.keys(k8s.index).length, "kinds");
