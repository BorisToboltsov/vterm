// What the Git panel says about a commit, in the user's language. The arithmetic is
// pure and lives in `gitview.ts`; here it meets the translations.

import { t } from "../i18n";
import type { GitCommit } from "./git";
import { refLabels } from "./gitrefs";
import { clockTime, commitDay, commitMoment, commitTooltip } from "./gitview";

/** When a commit was made: `Today 14:03`, `Yesterday 22:18`, or the full moment. */
export function whenLabel(tsSec: number, now: number = Date.now()): string {
  const day = commitDay(tsSec, now);
  if (day === "today") return t("git.today", { time: clockTime(tsSec) });
  if (day === "yesterday") return t("git.yesterday", { time: clockTime(tsSec) });
  return commitMoment(tsSec);
}

/** A row's tooltip: the commit, who applied it if not its author, and every label it has. */
export function rowTooltip(commit: GitCommit): string {
  const lines = [commitTooltip(commit)];
  if (commit.committer && commit.committer !== commit.author) {
    lines.push(t("git.appliedBy", { name: commit.committer }));
  }
  const refs = refLabels(commit.refs).map((r) => r.name);
  if (refs.length) lines.push(refs.join(", "));
  return lines.join("\n");
}
