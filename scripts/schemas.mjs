#!/usr/bin/env node
// Vendor the JSON schemas the editor validates YAML against offline (ADR 0078).
// Run by hand when a schema should be refreshed: `node scripts/schemas.mjs`.
// The network is used here, at development time only — the app never fetches a
// schema (principle 6). Every source and its license is listed in
// src/lib/editor/schemas/NOTICE.md; a source that is not MIT/Apache-2.0 is not
// vendored (the Ansible schemas of ansible-lint are GPL-3.0 — not here).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "src/lib/editor/schemas");
const K8S_VERSION = "v1.31.0";

const SOURCES = {
  compose: "https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json",
  "gh-workflow": "https://json.schemastore.org/github-workflow.json",
  "gh-action": "https://json.schemastore.org/github-action.json",
  "gitlab-ci": "https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json",
  kustomization: "https://json.schemastore.org/kustomization.json",
  chart: "https://json.schemastore.org/chart.json",
};

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

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": "schema-vendoring" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
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

mkdirSync(OUT, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  const schema = trimDescriptions(await get(url));
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(schema));
  console.log(name, JSON.stringify(schema).length);
}
const swagger = await get(`https://raw.githubusercontent.com/kubernetes/kubernetes/${K8S_VERSION}/api/openapi-spec/swagger.json`);
const k8s = k8sSchema(swagger);
writeFileSync(join(OUT, "k8s.json"), JSON.stringify({ version: K8S_VERSION, ...k8s }));
console.log("k8s", JSON.stringify(k8s).length, Object.keys(k8s.index).length, "kinds");
