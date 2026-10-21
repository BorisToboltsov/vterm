// The localized words of an access-check report (v1.21): the copyable report,
// the Markdown table and the recording's audit block all say the same things,
// so they come from one place. The formatting itself stays pure in netcheck.ts.
import { t, type MessageKey } from "./i18n";
import type { Method, PortStatus, ReportWords } from "./netcheck";

export const STATUS_KEY: Record<PortStatus, MessageKey> = {
  open: "util.netcheck.st.open",
  refused: "util.netcheck.st.refused",
  timeout: "util.netcheck.st.timeout",
  unreachable: "util.netcheck.st.unreachable",
  dns: "util.netcheck.st.dns",
  error: "util.netcheck.st.error",
  udp: "util.netcheck.st.udp",
  missing: "util.netcheck.st.missing",
};

/** Tool names are domain terms; only the native method needs words. */
export function methodLabel(m: Method): string {
  if (m === "native") return t("util.netcheck.methodNative");
  if (m === "bash") return "bash /dev/tcp";
  return m === "none" ? "—" : m;
}

/** The report's words for one server's run: its method and timeout in the header. */
export function reportWords(method: Method | null, timeoutSecs: number): ReportWords {
  return {
    title: t("util.netcheck.title"),
    tally: (open, total) => t("util.netcheck.reportTally", { open, total }),
    method: t("util.netcheck.reportMethod", { method: method ? methodLabel(method) : "—", n: timeoutSecs }),
    ms: (n) => t("util.netcheck.ms", { n }),
    ruleSource: (source) => t("util.netcheck.reportRuleSource", { source }),
    rest: (n, parts) => t("util.netcheck.reportRest", { n, parts }),
    status: Object.fromEntries(
      (Object.keys(STATUS_KEY) as PortStatus[]).map((s) => [s, t(STATUS_KEY[s])]),
    ) as Record<PortStatus, string>,
    cols: {
      source: t("util.netcheck.col.source"),
      target: t("util.netcheck.col.target"),
      port: t("util.netcheck.col.port"),
      status: t("util.netcheck.col.status"),
      time: t("util.netcheck.col.time"),
      service: t("util.netcheck.col.service"),
    },
  };
}
