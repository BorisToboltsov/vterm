import type { MessageKey } from "../i18n/messages";
/** Backend errors are markers; raw network/OS messages never become UI copy. */
export function updateError(error: unknown): MessageKey {
  const text = String(error);
  const codes: [string, MessageKey][] = [
    ["update-key", "updates.errorKey"],
    ["update-unpublished", "updates.errorUnpublished"],
    ["update-network", "updates.errorNetwork"],
    ["update-signature", "updates.errorSignature"],
    ["update-manifest", "updates.errorSignature"],
    ["update-format", "updates.errorFormat"],
    ["update-unsaved", "updates.errorUnsaved"],
    ["update-busy", "updates.errorBusy"],
    ["update-window-timeout", "updates.errorWindows"],
    ["update-rolled-back", "updates.rolledBack"],
    ["update-recovery-required", "updates.errorRecovery"],
    ["update-start-timeout", "updates.errorRecovery"],
  ];
  return codes.find(([code]) => text.includes(code))?.[1] ?? "updates.errorInstall";
}
export interface ChangeEntry { version: string; title: string; markdown: string }
/** Keep the repository document as the source of history, with stable release sections. */
export function changeEntries(markdown: string): ChangeEntry[] {
  const headers = [...markdown.matchAll(/^## (v\d+\.\d+\.\d+)([^\n]*)$/gm)];
  return headers.map((h, index) => ({
    version: h[1].slice(1), title: h[1] + h[2],
    markdown: markdown.slice(h.index! + h[0].length, headers[index + 1]?.index ?? markdown.length).trim(),
  }));
}
export function downloadPercent(downloaded: number, total: number): number | null {
  return total > 0 ? Math.max(0, Math.min(100, Math.floor(downloaded * 100 / total))) : null;
}
