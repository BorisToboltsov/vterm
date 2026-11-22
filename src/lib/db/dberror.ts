// What a database command's refusal means (ADR 0080): the markers of
// `error.rs` read into a kind, and the kind into words — a password to ask, a
// tunnel the server did not open, a connection that is gone.

import { t } from "../i18n";
import type { DbApplyFailure } from "../types";

export type DbFailure =
  | { kind: "auth" }
  | { kind: "tunnel"; detail: string }
  | { kind: "closed" }
  | { kind: "busy" }
  | { kind: "unknown" }
  | { kind: "readOnly" }
  | { kind: "liftScope" }
  | { kind: "txOpen" }
  | { kind: "many" }
  | { kind: "notEdit" }
  | { kind: "notLocal" }
  | { kind: "badProfile" }
  | { kind: "noSession" }
  | { kind: "other"; detail: string };

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The kind of a refusal, by its marker. */
export function dbFailure(err: unknown): DbFailure {
  const s = text(err);
  const after = (marker: string) => s.slice(s.indexOf(marker) + marker.length).replace(/^:\s*/, "");
  if (s.includes("db-auth-rejected")) return { kind: "auth" };
  if (s.includes("db-tunnel-refused")) return { kind: "tunnel", detail: after("db-tunnel-refused") };
  if (s.includes("db-closed")) return { kind: "closed" };
  if (s.includes("db-busy")) return { kind: "busy" };
  if (s.includes("unknown-database")) return { kind: "unknown" };
  if (s.includes("db-read-only")) return { kind: "readOnly" };
  if (s.includes("db-lift-scope")) return { kind: "liftScope" };
  if (s.includes("db-tx-open")) return { kind: "txOpen" };
  if (s.includes("db-many-statements")) return { kind: "many" };
  if (s.includes("db-not-an-edit")) return { kind: "notEdit" };
  if (s.includes("db-not-local")) return { kind: "notLocal" };
  if (s.includes("db-bad-profile")) return { kind: "badProfile" };
  if (s.includes("no active session")) return { kind: "noSession" };
  return { kind: "other", detail: s };
}

/** A refusal in the reader's words. */
export function failureText(f: DbFailure): string {
  switch (f.kind) {
    case "auth":
      return t("db.err.auth");
    case "tunnel":
      return t("db.err.tunnel", { detail: f.detail });
    case "closed":
      return t("db.err.closed");
    case "busy":
      return t("db.err.busy");
    case "unknown":
      return t("db.err.unknown");
    case "readOnly":
      return t("db.err.readOnly");
    case "liftScope":
      return t("db.err.liftScope");
    case "txOpen":
      return t("db.err.txOpen");
    case "many":
      return t("db.err.many");
    case "notEdit":
      return t("db.err.notEdit");
    case "notLocal":
      return t("db.err.notLocal");
    case "badProfile":
      return t("db.err.badProfile");
    case "noSession":
      return t("db.err.noSession");
    case "other":
      return f.detail;
  }
}

/** Why edits were not applied, in the reader's words — the database's where it said why. */
export function applyFailureText(f: DbApplyFailure): string {
  const why = f.error ? f.error.message : t("db.err.notOneRow", { n: f.changed ?? 0 });
  const detail = f.statement === null ? why : t("db.err.atStatement", { i: f.statement, why });
  return t("db.err.mismatch", { detail });
}
