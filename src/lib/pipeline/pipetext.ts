// The words of the pipeline schema (ADR 0068): the model speaks in codes and
// parameters (`pipesim.ts`, `pipeline.ts`), and these put them into the
// reader's language. A key per code — the type of the key template makes a code
// without a translation a compile error.

import { t } from "../i18n";
import type { PipelineKind, Problem } from "./pipeline";
import type { PipeEvent, Reason } from "./pipesim";

export function pipelineReasonText(reason: Reason): string {
  return t(`pipeline.reason.${reason.code}` as const, reason.params);
}

export function pipelineProblemText(problem: Problem): string {
  return t(`pipeline.problem.${problem.code}` as const, problem.params);
}

/** An event as its button says it: `push · main`, `merge request → main`. */
export function pipelineEventText(kind: PipelineKind, e: Pick<PipeEvent, "kind" | "ref">): string {
  if (e.kind === "pr") return t(kind === "gitlab" ? "pipeline.event.mr" : "pipeline.event.pr", { ref: e.ref });
  if (e.kind === "push" || e.kind === "tag") return t(`pipeline.event.${e.kind}`, { ref: e.ref });
  return t(`pipeline.event.${e.kind}`);
}
