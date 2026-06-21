// Autonomy guard (Phase 6.2): vterm must be fully offline except outbound SSH to
// the user's own servers. This test scans the frontend source for runtime network
// access (HTTP/WebSocket/CDN/telemetry) and fails if any is introduced.
//
// Allowed: external links opened via the Tauri opener on an explicit user action
// (HelpPanel "About"), and bundled @fontsource fonts (no network at runtime).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs with the project root as cwd.
const SRC = join(process.cwd(), "src");

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bfetch\s*\(/, why: "fetch() — no runtime HTTP" },
  { pattern: /XMLHttpRequest/, why: "XMLHttpRequest — no runtime HTTP" },
  { pattern: /new\s+WebSocket/, why: "WebSocket — no runtime sockets" },
  { pattern: /import\.meta\.env\.\w*URL/, why: "remote URL env" },
  { pattern: /fonts\.googleapis|fonts\.gstatic/, why: "Google Fonts CDN" },
  { pattern: /cdn\.jsdelivr|unpkg\.com|cdnjs/, why: "JS CDN" },
  { pattern: /google-analytics|googletagmanager|mixpanel|segment\.com|sentry/, why: "telemetry/analytics" },
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("offline autonomy", () => {
  it("no frontend source makes runtime network calls", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file}: ${why}`);
      }
    }
    expect(offenders, `forbidden network references found:\n${offenders.join("\n")}`).toEqual([]);
  });
});
