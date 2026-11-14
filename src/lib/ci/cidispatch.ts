// Starting a run by hand (ADR 0069): the form the file itself describes.
// GitHub — `on: workflow_dispatch: inputs:`, each with its type, choices,
// default and whether it is required; GitLab — the variables the file gives a
// `description:`, which GitLab's own "Run pipeline" prefills. What the form
// sends is what the forge accepts: strings, booleans as `true`/`false`. Pure.

import { isObj, str, type YamlFile } from "../pipeline/yamldoc";

export type FieldKind = "string" | "boolean" | "choice" | "number" | "environment";

export interface FormField {
  name: string;
  kind: FieldKind;
  description: string | null;
  required: boolean;
  /** As the form starts. */
  value: string;
  /** A choice's options. */
  options: string[];
}

const KINDS: readonly FieldKind[] = ["string", "boolean", "choice", "number", "environment"];

/** The inputs of `workflow_dispatch`; null — the workflow cannot be started by hand. */
export function dispatchFields(doc: YamlFile): FormField[] | null {
  const root = doc.value;
  if (!isObj(root)) return null;
  const on = root.on;
  const listed = typeof on === "string" ? on === "workflow_dispatch" : Array.isArray(on) ? on.includes("workflow_dispatch") : false;
  if (listed) return [];
  if (!isObj(on) || !("workflow_dispatch" in on)) return null;
  const wd = on.workflow_dispatch;
  if (!isObj(wd) || !isObj(wd.inputs)) return [];
  const out: FormField[] = [];
  for (const name of doc.keys(["on", "workflow_dispatch", "inputs"])) {
    const spec = wd.inputs[name];
    const s = isObj(spec) ? spec : {};
    const t = str(s.type);
    const kind: FieldKind = t && (KINDS as readonly string[]).includes(t) ? (t as FieldKind) : "string";
    const options = Array.isArray(s.options) ? s.options.map((o) => str(o)).filter((o): o is string => o !== null) : [];
    const given = str(s.default);
    out.push({
      name,
      kind,
      description: str(s.description),
      required: s.required === true,
      value: given ?? (kind === "boolean" ? "false" : kind === "choice" ? (options[0] ?? "") : ""),
      options,
    });
  }
  return out;
}

/** The variables a GitLab file offers in "Run pipeline": those it describes. */
export function pipelineFields(doc: YamlFile): FormField[] {
  const root = doc.value;
  if (!isObj(root) || !isObj(root.variables)) return [];
  const out: FormField[] = [];
  for (const name of doc.keys(["variables"])) {
    const v = root.variables[name];
    if (!isObj(v) || str(v.description) === null) continue;
    const options = Array.isArray(v.options) ? v.options.map((o) => str(o)).filter((o): o is string => o !== null) : [];
    out.push({
      name,
      kind: options.length ? "choice" : "string",
      description: str(v.description),
      required: false,
      value: str(v.value) ?? options[0] ?? "",
      options,
    });
  }
  return out;
}

export type FieldProblem = { name: string; kind: "required" | "number" | "choice" };

/** What stops the form from being sent. */
export function formProblems(fields: readonly FormField[], values: Readonly<Record<string, string>>): FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const f of fields) {
    const v = (values[f.name] ?? f.value).trim();
    if (f.required && v === "" && f.kind !== "boolean") out.push({ name: f.name, kind: "required" });
    else if (f.kind === "number" && v !== "" && !Number.isFinite(Number(v))) out.push({ name: f.name, kind: "number" });
    else if (f.kind === "choice" && v !== "" && f.options.length && !f.options.includes(v)) out.push({ name: f.name, kind: "choice" });
  }
  return out;
}

/** What is sent: every field with a value, booleans as `true`/`false`. */
export function formValues(fields: readonly FormField[], values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name] ?? f.value;
    if (f.kind === "boolean") out[f.name] = v === "true" ? "true" : "false";
    else if (v.trim() !== "") out[f.name] = v.trim();
  }
  return out;
}

/** The fields set to production — the question before the start says so in red. */
export function prodFields(fields: readonly FormField[], values: Readonly<Record<string, string>>): string[] {
  return fields.filter((f) => /^prod(uction)?$/i.test((values[f.name] ?? f.value).trim())).map((f) => f.name);
}
