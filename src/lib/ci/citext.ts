// How the CI panel says things (ADR 0069): a state as an icon, a tone and a
// word; a failure as what happened and what to do; a duration and a run's name.

import { t, type MessageKey } from "../i18n";
import type { IconName } from "../ui/icons";
import type { CiFailure, CiRun, CiState } from "./ciparse";
import { durationParts } from "./cirun";

export const STATE_ICON: Record<CiState, IconName> = {
  queued: "circleDashed",
  running: "loader",
  waiting: "shield",
  manual: "play",
  ok: "circleCheck",
  failed: "circleX",
  cancelled: "circleOff",
  skipped: "circleOff",
  neutral: "circle",
};

export const STATE_TONE: Record<CiState, string> = {
  queued: "text-muted",
  running: "text-accent",
  waiting: "text-warn",
  manual: "text-warn",
  ok: "text-ok",
  failed: "text-bad",
  cancelled: "text-muted",
  skipped: "text-muted",
  neutral: "text-muted",
};

/** A run's state as a filled mark — the squares of a pipeline's recent runs (ADR 0070). */
export const STATE_FILL: Record<CiState, string> = {
  queued: "bg-muted/50",
  running: "bg-accent",
  waiting: "bg-warn",
  manual: "bg-warn",
  ok: "bg-ok",
  failed: "bg-bad",
  cancelled: "bg-edge",
  skipped: "bg-edge",
  neutral: "bg-muted/50",
};

export const stateText = (s: CiState): string => t(`ci.state.${s}` as const);

const PROBLEM_TITLE: Record<CiFailure["kind"], MessageKey> = {
  missing: "ci.problem.missing",
  signedOut: "ci.problem.signedOut",
  notFound: "ci.problem.notFound",
  rateLimit: "ci.problem.rateLimit",
  offline: "ci.problem.offline",
  failed: "ci.problem.failed",
};

const PROBLEM_HINT: Record<CiFailure["kind"], MessageKey> = {
  missing: "ci.problem.missingHint",
  signedOut: "ci.problem.signedOutHint",
  notFound: "ci.problem.notFoundHint",
  rateLimit: "ci.problem.rateLimitHint",
  offline: "ci.problem.offlineHint",
  failed: "ci.problem.failedHint",
};

/** What happened, with the program and the host named. */
export const problemTitle = (f: CiFailure, cli: string, host: string): string => t(PROBLEM_TITLE[f.kind], { cli, host });

/** What to do about it. */
export const problemHint = (f: CiFailure, cli: string, host: string): string => t(PROBLEM_HINT[f.kind], { cli, host, text: f.text });

/** `4 s`, `8 min 12 s`, `1 h 2 min`. */
export function durationText(ms: number): string {
  const { h, m, s } = durationParts(ms);
  if (h) return t("ci.dur.hm", { h, m });
  if (m) return s ? t("ci.dur.ms", { m, s }) : t("ci.dur.m", { m });
  return t("ci.dur.s", { s });
}

/** `CI #422`, `Pipeline #12`. */
export function runName(run: Pick<CiRun, "workflow" | "number" | "id" | "forge">): string {
  const name = run.workflow || (run.forge === "gitlab" ? t("ci.pipeline") : "");
  return `${name} #${run.number ?? run.id}`.trim();
}
