// How the Scenarios panel says things (ADR 0071): a built-in recipe in the
// reader's language (its file keeps the English header), a host's state as an
// icon, a tone and a word, a cell of a playbook run.

import { t, type MessageKey } from "../i18n";
import type { IconName } from "../ui/icons";
import type { CellStatus } from "./ansibleevents";
import type { RecipeParam } from "./recipe";
import { builtinId, type LibraryRecipe } from "./recipelib";
import type { ChangeKind } from "./tfplan";

/** A recipe's name as the list shows it: a built-in one translated, the user's as written. */
export function recipeName(r: LibraryRecipe): string {
  const id = builtinId(r);
  if (id) return t(`scenarios.builtin.${id}.name` as MessageKey);
  return r.meta?.name || r.file;
}

/** A recipe's description, the same way. */
export function recipeDescription(r: LibraryRecipe): string {
  const id = builtinId(r);
  if (id) return t(`scenarios.builtin.${id}.desc` as MessageKey);
  return r.meta?.description ?? "";
}

/** A parameter's label and hint; a built-in recipe's in the reader's language. */
export function paramText(r: LibraryRecipe, p: RecipeParam): { label: string; hint: string } {
  const id = builtinId(r);
  if (!id) return { label: p.label, hint: p.hint };
  return {
    label: t(`scenarios.builtin.${id}.${p.name}` as MessageKey),
    hint: p.hint ? t(`scenarios.builtin.${id}.${p.name}.hint` as MessageKey) : "",
  };
}

export type HostTone = "muted" | "accent" | "ok" | "warn" | "bad";

const HOST: Record<string, { icon: IconName; tone: HostTone; key: MessageKey }> = {
  waiting: { icon: "circleDashed", tone: "muted", key: "scenarios.host.waiting" },
  connecting: { icon: "loader", tone: "accent", key: "scenarios.host.connecting" },
  checking: { icon: "loader", tone: "accent", key: "scenarios.host.checking" },
  running: { icon: "loader", tone: "accent", key: "scenarios.host.running" },
  same: { icon: "circleCheck", tone: "ok", key: "scenarios.host.same" },
  change: { icon: "circle", tone: "warn", key: "scenarios.host.change" },
  ok: { icon: "circleCheck", tone: "ok", key: "scenarios.host.ok" },
  skipped: { icon: "circleOff", tone: "muted", key: "scenarios.host.skipped" },
  failed: { icon: "circleX", tone: "bad", key: "scenarios.host.failed" },
  stopped: { icon: "circleOff", tone: "muted", key: "scenarios.host.stopped" },
};

/** A host's state in a recipe run: icon, tone, word. */
export function hostLook(state: string): { icon: IconName; tone: HostTone; text: string } {
  const h = HOST[state] ?? HOST.waiting;
  return { icon: h.icon, tone: h.tone, text: t(h.key) };
}

/** The theme class of a tone. */
export const TONE_CLASS: Record<HostTone, string> = {
  muted: "text-muted",
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

/** A cell of a playbook run: its word (in a check, "changed" is what would change) and its colours. */
export function cellLook(status: CellStatus, check: boolean, ignored: boolean): { text: string; cls: string } {
  switch (status) {
    case "running":
      return { text: "…", cls: "bg-accent/15 text-accent animate-pulse" };
    case "ok":
      return { text: t("scenarios.cell.ok"), cls: "bg-ok/15 text-ok" };
    case "changed":
      return { text: check ? t("scenarios.cell.wouldChange") : t("scenarios.cell.changed"), cls: "bg-warn/15 text-warn" };
    case "failed":
      return ignored ? { text: t("scenarios.cell.ignored"), cls: "bg-edge text-muted" } : { text: t("scenarios.cell.failed"), cls: "bg-bad/15 text-bad" };
    case "skipped":
      return { text: t("scenarios.cell.skipped"), cls: "text-muted" };
    case "unreachable":
      return { text: t("scenarios.cell.unreachable"), cls: "bg-bad/15 text-bad" };
  }
}

/** A change of a plan: its sign, colour and word. */
export function changeLook(kind: ChangeKind): { sign: string; cls: string; text: string } {
  switch (kind) {
    case "create":
      return { sign: "+", cls: "text-ok", text: t("scenarios.plan.create") };
    case "update":
      return { sign: "~", cls: "text-warn", text: t("scenarios.plan.update") };
    case "replace":
      return { sign: "±", cls: "text-bad", text: t("scenarios.plan.replace") };
    case "delete":
      return { sign: "−", cls: "text-bad", text: t("scenarios.plan.delete") };
    case "read":
      return { sign: "≤", cls: "text-muted", text: t("scenarios.plan.read") };
    default:
      return { sign: "·", cls: "text-muted", text: "" };
  }
}
