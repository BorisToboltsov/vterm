// A terminal tab opened INTO a container or pod ("Open shell" in the Docker/k8s
// panels). Pure and DOM-free (ADR 0003).
//
// Such a tab is still an ordinary SSH or local tab on the same host — no new
// backend. What makes it a container tab is that its shell is REPLACED by the
// `docker exec`/`kubectl exec` (see `renderSessionCommand` in termcmd.ts): the
// tab's session lives exactly as long as the container session. So the label
// "nginx · Rescalc dev" can never outlive it and sit over a plain host shell
// after `exit` (principle 5); re-entering is a reconnect that runs the same argv.
import type { IconName } from "./icons";

/** What a container/pod tab is attached to, as the panel knew it. */
export interface AttachTarget {
  kind: "container" | "pod";
  /** Container name (docker) or pod name (k8s) — the tab's main label. */
  name: string;
  /** Docker image, when known. */
  image?: string;
  /** k8s: the container inside the pod, when one was picked. */
  container?: string;
}

/** A tab's attachment: the target plus the argv that enters it (re-run on reconnect). */
export interface TabAttach extends AttachTarget {
  argv: string[];
}

/** Tab title: `nginx · Rescalc dev` for an attached tab, else the host alias. */
export function attachTitle(hostAlias: string, attach: AttachTarget | undefined): string {
  return attach ? `${attach.name} · ${hostAlias}` : hostAlias;
}

/** Icon marking an attached tab: the registry's Docker and Kubernetes marks. */
export function attachIcon(kind: AttachTarget["kind"]): IconName {
  return kind === "pod" ? "kubernetes" : "container";
}

/** Tooltip rows `[label, value]` — labels are i18n keys, values are data. */
export function attachRows(
  attach: AttachTarget,
  hostAlias: string,
): [key: "tab.attachImage" | "tab.attachContainer" | "tab.attachHost", value: string][] {
  const rows: ReturnType<typeof attachRows> = [];
  if (attach.image) rows.push(["tab.attachImage", attach.image]);
  if (attach.container) rows.push(["tab.attachContainer", attach.container]);
  rows.push(["tab.attachHost", hostAlias]);
  return rows;
}
