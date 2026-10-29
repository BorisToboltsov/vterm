// In a narrow SFTP dock the Upload button must stay in the toolbar, while
// secondary actions move to the existing dots menu. Check the source contract
// as well as the rendered behaviour covered by sftptransfers.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/files/FileBrowser.svelte", "utf8");

function violations(code: string): string[] {
  const out: string[] = [];
  if (!/const compactToolbar = \$derived\(!!adapter\.upload && toolbarWidth > 0 && toolbarWidth < 320\)/.test(code)) {
    out.push("compact SFTP breakpoint");
  }
  if (!/\{#if adapter\.upload\}\s*<button[\s\S]*?<Icon name="upload"[\s\S]*?<\/button>\s*\{\/if\}/.test(code)) {
    out.push("Upload stays a direct button");
  }
  if (!/\{#if compactToolbar\}[\s\S]*?<Icon name="dots"[^>]*\/>[\s\S]*?<\/button>\s*\{\/if\}/.test(code)) {
    out.push("existing dots icon opens compact menu");
  }
  return out;
}

describe("compact file toolbar contract", () => {
  it("keeps Upload directly visible and reuses the existing dots icon", () => {
    expect(violations(source)).toEqual([]);
  });

  it("catches a live regression that hides Upload with the other actions", () => {
    const broken = source.replace("{#if adapter.upload}", "{#if adapter.upload && !compactToolbar}");
    expect(violations(broken)).toContain("Upload stays a direct button");
  });
});
