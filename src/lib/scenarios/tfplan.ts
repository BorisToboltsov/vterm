// A saved Terraform plan as its view draws it (ADR 0071): from `terraform show
// -json <plan>`, what is created, changed, replaced, destroyed — by module —
// and, for a change, which attributes and how. A plan holds the secrets of the
// infrastructure: a value Terraform marks sensitive is never carried out of
// here, and a value it does not know yet is said to be so. Pure.

export type ChangeKind = "create" | "update" | "replace" | "delete" | "read" | "noop";

/** Why a value is not shown: Terraform marks it sensitive, or knows it only after apply. */
export type ValueMask = "sensitive" | "unknown" | null;

export interface AttrChange {
  path: string;
  /** The value as JSON, "" when masked or absent. */
  before: string;
  after: string;
  beforeMask: ValueMask;
  afterMask: ValueMask;
  /** Part of the new value is known only after apply (the rest is shown). */
  partlyUnknown: boolean;
}

export interface ResourceChange {
  address: string;
  module: string | null;
  type: string;
  name: string;
  kind: ChangeKind;
  /** For an update or a replacement: the attributes that change (masked as Terraform says). */
  attrs: AttrChange[];
  /** Attributes that force the replacement. */
  replacing: string[];
}

export interface TfPlan {
  changes: ResourceChange[];
  counts: Record<"create" | "update" | "replace" | "delete", number>;
  outputs: { name: string; kind: ChangeKind; sensitive: boolean }[];
  /** `terraform show` answered a plan with errors, or no plan at all. */
  errored: boolean;
}

const MAX_ATTRS = 40;
const MAX_VALUE = 200;

type J = unknown;
const isObj = (v: J): v is Record<string, J> => typeof v === "object" && v !== null && !Array.isArray(v);

export function changeKind(actions: unknown): ChangeKind {
  const a = Array.isArray(actions) ? actions.join(",") : "";
  switch (a) {
    case "create":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "delete,create":
    case "create,delete":
      return "replace";
    case "read":
      return "read";
    default:
      return "noop";
  }
}

function show(v: J): string {
  if (v === undefined) return "";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
}

/** Whether `marks` (before/after_sensitive, after_unknown) flags `path` or something above it. */
function marked(marks: J, path: readonly (string | number)[]): boolean {
  let cur = marks;
  for (const k of path) {
    if (cur === true) return true;
    if (Array.isArray(cur) && typeof k === "number") cur = cur[k];
    else if (isObj(cur) && typeof k === "string") cur = cur[k];
    else return false;
  }
  return cur === true;
}

/** Whether `marks` flags anything at or under `path`. */
function markedBelow(marks: J, path: readonly (string | number)[]): boolean {
  let cur = marks;
  for (const k of path) {
    if (cur === true) return true;
    if (Array.isArray(cur) && typeof k === "number") cur = cur[k];
    else if (isObj(cur) && typeof k === "string") cur = cur[k];
    else return false;
  }
  const any = (v: J): boolean => v === true || (Array.isArray(v) ? v.some(any) : isObj(v) ? Object.values(v).some(any) : false);
  return any(cur);
}

/** The top-level attributes that differ, masked. */
function diffAttrs(change: Record<string, J>): AttrChange[] {
  const before = isObj(change.before) ? change.before : {};
  const after = isObj(change.after) ? change.after : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...(isObj(change.after_unknown) ? Object.keys(change.after_unknown) : [])])].sort();
  const out: AttrChange[] = [];
  for (const k of keys) {
    const unknown = marked(change.after_unknown, [k]);
    const partly = !unknown && markedBelow(change.after_unknown, [k]);
    const sBefore = markedBelow(change.before_sensitive, [k]);
    const sAfter = markedBelow(change.after_sensitive, [k]);
    const same = !unknown && !partly && JSON.stringify(before[k]) === JSON.stringify(after[k]);
    if (same) continue;
    const afterMask: ValueMask = unknown ? "unknown" : sAfter ? "sensitive" : null;
    const beforeMask: ValueMask = sBefore ? "sensitive" : null;
    out.push({
      path: k,
      before: beforeMask ? "" : show(before[k]),
      after: afterMask ? "" : show(after[k]),
      beforeMask,
      afterMask,
      partlyUnknown: partly && !sAfter,
    });
    if (out.length >= MAX_ATTRS) break;
  }
  return out;
}

const pathText = (p: J): string =>
  Array.isArray(p) ? p.map((x) => (typeof x === "number" ? `[${x}]` : String(x))).join(".").replace(/\.\[/g, "[") : "";

/** The plan from `terraform show -json`; `errored` when the text is not one. */
export function parsePlan(text: string): TfPlan {
  const plan: TfPlan = { changes: [], counts: { create: 0, update: 0, replace: 0, delete: 0 }, outputs: [], errored: false };
  let doc: J;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ...plan, errored: true };
  }
  if (!isObj(doc) || typeof doc.format_version !== "string") return { ...plan, errored: true };
  plan.errored = doc.errored === true;
  for (const rc of Array.isArray(doc.resource_changes) ? doc.resource_changes : []) {
    if (!isObj(rc) || !isObj(rc.change)) continue;
    const kind = changeKind(rc.change.actions);
    if (kind === "noop") continue;
    plan.changes.push({
      address: String(rc.address ?? ""),
      module: typeof rc.module_address === "string" ? rc.module_address : null,
      type: String(rc.type ?? ""),
      name: String(rc.name ?? ""),
      kind,
      attrs: kind === "update" || kind === "replace" ? diffAttrs(rc.change) : [],
      replacing: Array.isArray(rc.change.replace_paths) ? rc.change.replace_paths.map(pathText).filter(Boolean) : [],
    });
    if (kind === "create" || kind === "update" || kind === "replace" || kind === "delete") plan.counts[kind]++;
  }
  if (isObj(doc.output_changes)) {
    for (const [name, oc] of Object.entries(doc.output_changes)) {
      if (!isObj(oc)) continue;
      const kind = changeKind(oc.actions);
      if (kind === "noop") continue;
      plan.outputs.push({ name, kind, sensitive: oc.after_sensitive === true || oc.before_sensitive === true });
    }
  }
  return plan;
}

/** Whether applying the plan destroys anything: the apply question is red then. */
export const destroys = (plan: TfPlan): boolean => plan.counts.delete > 0 || plan.counts.replace > 0;

/** The changes grouped by module, the root first. */
export function byModule(plan: TfPlan): { module: string | null; changes: ResourceChange[] }[] {
  const groups = new Map<string | null, ResourceChange[]>();
  for (const c of plan.changes) groups.set(c.module, [...(groups.get(c.module) ?? []), c]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([module, changes]) => ({ module, changes }));
}

/** `terraform plan` for the run: the plan saved to `planPath`, the values files chosen. */
export function planArgv(root: string, planPath: string, varFiles: readonly string[]): string[] {
  const argv = ["terraform", `-chdir=${root}`, "plan", "-input=false", `-out=${planPath}`];
  for (const f of varFiles) argv.push(`-var-file=${f}`);
  return argv;
}

/** `terraform apply` of exactly the saved plan: what was shown is what is applied. */
export const applyArgv = (root: string, planPath: string): string[] => ["terraform", `-chdir=${root}`, "apply", "-input=false", planPath];

/** `terraform init` and `terraform validate` of the project. */
export const initArgv = (root: string): string[] => ["terraform", `-chdir=${root}`, "init", "-input=false"];
export const validateArgv = (root: string): string[] => ["terraform", `-chdir=${root}`, "validate"];

/** `terraform show -json` of the saved plan — a check the backend lets through. */
export const showArgv = (root: string, planPath: string): string[] => ["terraform", `-chdir=${root}`, "show", "-json", planPath];
