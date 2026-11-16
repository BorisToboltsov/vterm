// Editor and project guard (ADR 0076–0079): the contracts that live across
// files of the editor's working set and the file panel's project view.
//
//   1. A language server's HTML reaches the page only through `sanitizeLspHtml`
//      (the client is configured with it) — a server is a program on a host we
//      do not control, and the window can `invoke()` every command.
//   2. A schema read from the server is `untrustedSchema` before it is used —
//      its regular expressions would otherwise run in the window.
//   3. A format lands as one change (`minimalChange`), after checking the
//      buffer did not move on while the tool ran.
//   4. The project strip draws no menu and no dialog: it stands in the panel's
//      `@container`, so the panel draws them (panelcontainer.guard's reason).
//   5. A project's command reaches the terminal through the page only: nothing
//      in `files/` writes to a terminal.
//   6. Every vendored schema is named, with its source and license, in NOTICE.md.
//   7. The script that vendors them takes each source at one commit and checks
//      its SHA-256 before writing anything — a source replaced upstream cannot
//      slip into the repository (CodeQL #497).
//
// Every check is a function over source text with comments stripped, and the
// second `describe` shows each one catching the violation it exists for.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(process.cwd(), "src/lib");
const read = (rel: string) => readFileSync(join(LIB, rel), "utf8");

function stripBlocks(src: string, open: string, close: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(open, i)) {
      const end = src.indexOf(close, i + open.length);
      i = end < 0 ? src.length : end + close.length;
      continue;
    }
    out += src[i++];
  }
  return out;
}
const code = (src: string) =>
  stripBlocks(stripBlocks(src, "<!--", "-->"), "/*", "*/")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");

/** The body of `function name` (or `async function name`) in a source, to its closing brace. */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\b`));
  if (at < 0) return "";
  // Past the parameters (they may hold a `{}` type or default), to the body's brace.
  let p = src.indexOf("(", at);
  for (let depth = 0; p < src.length; p++) {
    if (src[p] === "(") depth++;
    else if (src[p] === ")" && --depth === 0) break;
  }
  const open = src.indexOf("{", p);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

export function sanitizedClient(lspclient: string): string[] {
  return /sanitizeHTML:\s*sanitizeLspHtml\b/.test(code(lspclient)) ? [] : ["lspclient.ts does not pass the server's HTML through sanitizeLspHtml"];
}

export function untrustedSchemas(yamlschema: string): string[] {
  const c = code(yamlschema);
  const reads = c.match(/JSON\.parse\(await read\(/g)?.length ?? 0;
  const wrapped = c.match(/untrustedSchema\(JSON\.parse\(await read\(/g)?.length ?? 0;
  return reads === wrapped && reads > 0 ? [] : [`${reads - wrapped} schema(s) read from the server are used as given`];
}

export function oneChangeFormat(editorTab: string): string[] {
  const body = fnBody(code(editorTab), "formatBuffer");
  const out: string[] = [];
  if (!/minimalChange\(before, next\)/.test(body)) out.push("formatBuffer does not apply one minimal change");
  if (!/view\.state\.doc\.toString\(\) !== before/.test(body)) out.push("formatBuffer does not check that the buffer stayed as it was");
  return out;
}

export function stripDrawsNoDialog(strip: string): string[] {
  const imports = code(strip).match(/import\s+\w+\s+from\s+"[^"]*(ContextMenu|ConfirmDialog|Modal)\.svelte"/g) ?? [];
  return imports.map((i) => `ProjectStrip renders a fixed element: ${i}`);
}

export function filesWriteNoTerminal(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([, src]) => /\bwriteToTerminal\b|terminal\/termwrite/.test(code(src)))
    .map(([rel]) => `${rel} writes to a terminal — a project's command goes through the page`);
}

export function schemasNamed(files: string[], notice: string): string[] {
  return files.filter((f) => f.endsWith(".json") && !notice.includes(f)).map((f) => `${f} is not named in NOTICE.md`);
}

/** The host of a source URL whose `${…}` parts are not filled in yet; "" when it is not a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url.replace(/\$\{\w+\}/g, "x")).hostname;
  } catch {
    return "";
  }
}

export function pinnedSources(script: string): string[] {
  const c = code(script);
  const out: string[] = [];
  const urls = [...c.matchAll(/url:\s*`([^`]+)`/g)].map((m) => m[1]);
  const hashes = c.match(/sha256:\s*"[0-9a-f]{64}"/g) ?? [];
  if (urls.length === 0) out.push("no source is listed");
  if (urls.length !== hashes.length) out.push(`${urls.length} sources, ${hashes.length} pinned hashes`);
  for (const u of urls) {
    if (/\/(master|main|latest|HEAD)\//.test(u) || hostOf(u) === "json.schemastore.org") out.push(`a floating source: ${u}`);
    const consts = [...u.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
    const pinned = consts.some((name) => new RegExp(`const ${name} = "[0-9a-f]{40}"`).test(c));
    if (!pinned) out.push(`a source not at a commit: ${u}`);
  }
  if (!/got !== sha256/.test(c)) out.push("a download is not checked against its hash");
  const firstWrite = c.indexOf("writeFileSync(join(OUT");
  const lastGet = c.lastIndexOf("await get(");
  if (firstWrite >= 0 && lastGet > firstWrite) out.push("a file is written before every source was checked");
  return out;
}

const filesDir = () => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(join(LIB, "files"))) {
    if (/\.(ts|svelte)$/.test(f) && !/\.test\.ts$/.test(f)) out[`files/${f}`] = read(`files/${f}`);
  }
  return out;
};

describe("editor and project guard", () => {
  it("a language server's HTML is sanitised", () => {
    expect(sanitizedClient(read("editor/lspclient.ts"))).toEqual([]);
  });
  it("a schema from the server is untrusted", () => {
    expect(untrustedSchemas(read("editor/yamlschema.ts"))).toEqual([]);
  });
  it("a format is one change on the text it was made for", () => {
    expect(oneChangeFormat(read("editor/EditorTab.svelte"))).toEqual([]);
  });
  it("the project strip draws no menu or dialog", () => {
    expect(stripDrawsNoDialog(read("files/ProjectStrip.svelte"))).toEqual([]);
  });
  it("nothing in files/ writes to a terminal", () => {
    expect(filesWriteNoTerminal(filesDir())).toEqual([]);
  });
  it("every vendored schema is named with its license", () => {
    expect(schemasNamed(readdirSync(join(LIB, "editor/schemas")), read("editor/schemas/NOTICE.md"))).toEqual([]);
  });
  it("the schemas come from pinned, checked sources", () => {
    expect(pinnedSources(readFileSync(join(process.cwd(), "scripts/schemas.mjs"), "utf8"))).toEqual([]);
  });
});

describe("editor and project guard — catches what it exists for", () => {
  it("each check fails on its violation", () => {
    expect(sanitizedClient("new LSPClient({ rootUri })")).not.toEqual([]);
    expect(untrustedSchemas("schema = JSON.parse(await read(ref.path));")).not.toEqual([]);
    expect(oneChangeFormat("async function formatBuffer() { view.dispatch({ changes: { from: 0, insert: next } }); }")).toHaveLength(2);
    expect(stripDrawsNoDialog('import ContextMenu from "../ui/ContextMenu.svelte";')).toHaveLength(1);
    expect(filesWriteNoTerminal({ "files/x.ts": 'import { writeToTerminal } from "../terminal/termwrite";' })).toHaveLength(1);
    expect(schemasNamed(["a.json", "NOTICE.md"], "nothing")).toEqual(["a.json is not named in NOTICE.md"]);
    const pinned = 'const C = "' + "a".repeat(40) + '";\nconst S = { x: { url: `https://h/${C}/x.json`, sha256: "' + "b".repeat(64) + '" } };\nif (got !== sha256) throw 1;\nawait get(1);\nwriteFileSync(join(OUT, 1));';
    expect(pinnedSources(pinned)).toEqual([]);
    expect(pinnedSources(pinned.replace("${C}", "master"))).toHaveLength(2);
    expect(pinnedSources(pinned.replace("https://h/${C}/x.json", "https://json.schemastore.org/x.json"))).toHaveLength(2);
    expect(pinnedSources(pinned.replace(/sha256: "b+"/, ""))).toEqual(["1 sources, 0 pinned hashes"]);
    expect(pinnedSources(pinned.replace("got !== sha256", "true"))).toEqual(["a download is not checked against its hash"]);
    expect(pinnedSources(pinned.replace("await get(1);\nwriteFileSync(join(OUT, 1));", "writeFileSync(join(OUT, 1));\nawait get(1);"))).toEqual([
      "a file is written before every source was checked",
    ]);
  });

  it("comments do not count", () => {
    expect(sanitizedClient("// sanitizeHTML: sanitizeLspHtml\nnew LSPClient({})")).not.toEqual([]);
  });
});
