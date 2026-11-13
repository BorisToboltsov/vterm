// Pipeline-schema guard (ADR 0068): the contracts that tie several files.
//
//  * The schema reaches files only through the reader of its connection:
//    pipeline components take `connectionFiles` from the API and nothing else
//    that reads or lists, and `connectionFiles` itself is the editor's and the
//    file panel's own commands. A component that called `sftpReadText` on its
//    own would read past the budget and the depth the loader keeps.
//  * Job names, steps and file paths come from a file on a server: the
//    components draw them as text — no `{@html}` anywhere in the subsystem.
//  * The editor's CodeMirror stays mounted whatever the file shows: switching
//    Code ⇄ Schema ⇄ Side by side must not lose the undo history and the cursor
//    (the host is hidden, never inside an `{#if}`).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(process.cwd(), "src/lib");
const read = (rel: string) => readFileSync(join(LIB, rel), "utf8");

/** Drop `<!-- … -->` blocks by scanning (CodeQL: no regex over markup comments). */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("<!--", i);
    if (open < 0) return out + src.slice(i);
    out += src.slice(i, open);
    const close = src.indexOf("-->", open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
  return out;
}

/** The markup of a component: what follows its last `</script>`. */
const markupOf = (src: string): string => stripHtmlComments(src.slice(src.lastIndexOf("</script>") + 9));

/** The names a source imports from the API layer (`../api`, `#lib/api`), type imports aside. */
export function apiImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["'](?:\.\.\/api|#lib\/api)(?:\/index(?:\.ts)?)?["']/g)) {
    if (m[1]) continue;
    for (const name of m[2].split(",")) {
      const n = name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (n && !name.trim().startsWith("type ")) out.push(n);
    }
  }
  return out;
}

/** The API calls a function body makes, from the names given. */
const callsIn = (body: string, names: readonly string[]): string[] => names.filter((n) => new RegExp(`\\b${n}\\(`).test(body));

/** Whether markup puts raw HTML anywhere. */
const rawHtml = (markup: string): boolean => markup.includes("{@html");

/** Whether the element bound to `host` stands inside an unclosed `{#if}` of the markup. */
export function hostInsideIf(markup: string): boolean {
  const at = markup.indexOf("bind:this={host}");
  if (at < 0) return true;
  const before = markup.slice(0, at);
  const opens = before.split("{#if").length - 1;
  const closes = before.split("{/if}").length - 1;
  return opens > closes;
}

const components = readdirSync(join(LIB, "pipeline")).filter((f) => f.endsWith(".svelte"));

describe("pipeline guard", () => {
  it("catches what it is for", () => {
    expect(apiImports(`import { connectionFiles, sftpReadText } from "../api";\nimport type { X } from "../api";`)).toEqual([
      "connectionFiles",
      "sftpReadText",
    ]);
    expect(apiImports(`import { diag } from "../api/diag";`)).toEqual([]);
    expect(callsIn("read(p) { return fetch(p); }", ["sftpReadText", "fetch"])).toEqual(["fetch"]);
    expect(rawHtml("<p>{@html job.name}</p>")).toBe(true);
    expect(hostInsideIf(`{#if pipelineKind}<div bind:this={host}></div>{/if}`)).toBe(true);
    expect(hostInsideIf(`{#if a}x{/if}<div bind:this={host}></div>{#if b}y{/if}`)).toBe(false);
    expect(hostInsideIf("<div></div>")).toBe(true);
  });

  it("pipeline components read files only through the connection's reader", () => {
    expect(components.length).toBeGreaterThan(0);
    for (const file of components) {
      const used = apiImports(read(`pipeline/${file}`));
      expect(used.filter((n) => n !== "connectionFiles"), file).toEqual([]);
    }
    const editor = read("editor/EditorTab.svelte");
    expect(editor).toMatch(/const pipeReader = \$derived\(connectionFiles\(/);
    expect(markupOf(editor)).toMatch(/reader=\{pipeReader\}/);
  });

  it("the connection's reader is the editor's and the file panel's own commands", () => {
    const api = read("api/files.ts");
    const start = api.indexOf("export function connectionFiles");
    expect(start, "connectionFiles is gone from api/files.ts — update this guard").toBeGreaterThan(-1);
    const body = api.slice(start, api.indexOf("\n}\n", start));
    expect(callsIn(body, ["sftpReadText", "readLocalText", "sftpList", "localList"]).sort()).toEqual([
      "localList",
      "readLocalText",
      "sftpList",
      "sftpReadText",
    ]);
    expect(callsIn(body, ["fetch", "call", "invoke"])).toEqual([]);
  });

  it("draws what a server's file says as text, never as markup", () => {
    for (const file of components) expect(rawHtml(markupOf(read(`pipeline/${file}`))), file).toBe(false);
  });

  it("keeps the editor mounted whatever the file shows", () => {
    expect(hostInsideIf(markupOf(read("editor/EditorTab.svelte")))).toBe(false);
  });
});
