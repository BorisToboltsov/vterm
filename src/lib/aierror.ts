// Localized, app-consistent messages for AI request failures (Phase 17).
// Kept out of ai.ts to avoid an import cycle (ai.ts is in settings' import chain,
// and i18n imports settings). `aiErrorKind` does the pure classification; here we
// map it to a user-facing string — auth/unreachable get a friendly hint, anything
// else falls back to the raw detail (e.g. an HTTP status body) or a generic line.

import { aiErrorKind } from "./ai";
import { t } from "./i18n";

export function describeAiError(err: unknown): string {
  switch (aiErrorKind(err)) {
    case "auth":
      return t("ai.err.auth");
    case "unreachable":
      return t("ai.err.unreachable");
    case "billing":
      return t("ai.err.billing");
    case "rate":
      return t("ai.err.rate");
    default: {
      const raw = err instanceof Error ? err.message : String(err ?? "");
      return raw.trim() || t("ai.errorGeneric");
    }
  }
}
