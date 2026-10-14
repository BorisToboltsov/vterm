import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = join(process.cwd(), "src", "routes", "+page.svelte");

export function tabOverflowViolations(source: string): string[] {
  const out: string[] = [];
  const strip =
    source.match(/<div\s+data-tabstrip=\{stripId\}\s+class="([^"]+)"/)?.[1] ?? "";
  if (!["min-w-0", "flex-1", "overflow-x-auto"].every((cls) => strip.includes(cls))) {
    out.push("the session tabs have no bounded horizontal scroller");
  }
  const tab = source.match(/data-tab=\{tab\.sessionId\}[\s\S]*?class="([^"]+)"/)?.[1] ?? "";
  for (const cls of ["min-w-16", "max-w-48", "flex-1", "basis-0", "overflow-hidden"]) {
    if (!tab.includes(cls)) out.push(`session tabs do not carry ${cls}`);
  }
  if (!/scrollIntoView\?\.\(\{[\s\S]*?inline:\s*"nearest"/.test(source)) {
    out.push("the shown tab is not revealed after programmatic activation");
  }
  return out;
}

describe("session tab overflow guard", () => {
  const page = readFileSync(PAGE, "utf8");

  it("tabs shrink to a minimum, then scroll inside the window", () => {
    expect(tabOverflowViolations(page)).toEqual([]);
  });

  it("catches a strip that lets its tabs escape again", () => {
    const broken = page.replace("items-stretch overflow-x-auto", "items-stretch overflow-x-visible");
    expect(tabOverflowViolations(broken)).toContain(
      "the session tabs have no bounded horizontal scroller",
    );
  });
});
