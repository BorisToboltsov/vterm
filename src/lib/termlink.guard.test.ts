import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A link clicked in terminal output reaches the browser through one path:
// `clickLink` (stores/linkopen.svelte.ts), which asks or opens as `linkClick`
// (termlink.ts) decides.
//
// Two ways round it existed. Found URLs went straight to `openUrl` on a plain
// click. OSC 8 hyperlinks — whose text is whatever the program printed, set
// apart from where they lead — went to xterm's default handler: an English
// `confirm()` and `window.open()`, past the opener and past i18n, in the live
// terminal and in the recording player alike. So:
//  - every xterm the app creates is given `terminalLinkHandler` — without one
//    xterm falls back to its own;
//  - a component that creates an xterm never calls the opener itself, and the
//    URL addon's callback hands the link to `clickLink`;
//  - in the store the opener is reached only from `open`, which is called only
//    for what `linkClick` said to open and for an answered question;
//  - an answer opens only an https link — the opener's capability allows no
//    other — and "don't ask again" switches the setting only where it was
//    offered: a link whose text names another site never silences the question;
//  - nothing else assigns `settings.terminalLinks`.
// Each check is a function over source text, run against a planted violation
// too. Checked without comments.

const SRC = join(process.cwd(), "src");

/** Drop `<!-- … -->` blocks (a scan: one regex pass leaves a nested opener behind). */
function stripHtmlComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    out += src[i++];
  }
  return out;
}

function strip(src: string): string {
  return stripHtmlComments(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

const allFiles = () =>
  sourceFiles(SRC).map((f) => ({ rel: f.slice(SRC.length + 1), src: readFileSync(f, "utf8") }));

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** The text of `new Terminal({ … })` calls, balanced on braces. */
function terminalOptions(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/new Terminal\(\s*\{/g)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

/** Violations in one component that creates an xterm. */
export function terminalViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const calls = terminalOptions(src);
  if (/new Terminal\(/.test(src) && calls.length !== (src.match(/new Terminal\(/g) ?? []).length) {
    out.push("an xterm is created without an options object");
  }
  if (calls.some((c) => !/linkHandler:\s*terminalLinkHandler\(/.test(c))) {
    out.push("an xterm is created without terminalLinkHandler — OSC 8 links fall back to xterm's own");
  }
  if (/plugin-opener|openUrl\s*\(/.test(src)) {
    out.push("a terminal component calls the opener itself");
  }
  for (const m of src.matchAll(/new WebLinksAddon\(([\s\S]*?)\);/g)) {
    if (!/=>\s*clickLink\(\s*uri\s*\)/.test(m[1])) {
      out.push("the URL addon does not hand the link to clickLink");
    }
  }
  return out;
}

/** Violations in the store that owns the opener. */
export function storeViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const calls = [...src.matchAll(/openUrl\(/g)].length;
  const inOpen = /function open\(href: string\): void \{\s*openUrl\(href\)/.test(src);
  if (calls !== 1 || !inOpen) out.push("the opener is reached other than through open()");
  const opens = [...src.matchAll(/\bopen\(([^)]*)\)/g)].map((m) => m[1]);
  const allowed = new Set(["href: string", "action.href", "asked.target.href"]);
  if (opens.some((arg) => !allowed.has(arg.trim()))) {
    out.push("open() is called with something linkClick did not decide");
  }
  if (!/const action = linkClick\(settings\.terminalLinks, uri, text\);\s*if \(action\.kind === "open"\) open\(action\.href\)/.test(src)) {
    out.push("clickLink does not act on linkClick");
  }
  if (!/if \(answer === "open"\) \{\s*if \(!asked\.target\.openable\) return;/.test(src)) {
    out.push("an answer can open a link the opener may not open");
  }
  const silence = /if \(silence && asked\.canSilence\) settings\.terminalLinks = "direct";/;
  if (!silence.test(src) || (src.match(/settings\.terminalLinks\s*=(?!=)/g) ?? []).length !== 1) {
    out.push("“don't ask again” can switch the setting where it was not offered");
  }
  return out;
}

describe("terminal link guard", () => {
  it("every component that creates an xterm routes its links through clickLink", () => {
    const creators = allFiles().filter(({ src }) => /new Terminal\(/.test(strip(src)));
    expect(creators.map((f) => f.rel).sort()).toEqual(
      [join("lib", "RecordingPlayer.svelte"), join("lib", "Terminal.svelte")].sort(),
    );
    for (const { rel, src } of creators) expect(terminalViolations(src), rel).toEqual([]);
  });

  it("the store opens only what linkClick or an answer decided", () => {
    expect(storeViolations(read("lib/stores/linkopen.svelte.ts"))).toEqual([]);
  });

  // Nothing else switches the link mode: the lint rule `vterm/owned-writes`.

  it("catches an xterm without the handler", () => {
    const src = read("lib/RecordingPlayer.svelte").replace(
      /\s*linkHandler: terminalLinkHandler\([^\n]*\n/,
      "\n",
    );
    expect(terminalViolations(src)).toContain(
      "an xterm is created without terminalLinkHandler — OSC 8 links fall back to xterm's own",
    );
  });

  it("catches a terminal that opens links itself", () => {
    const src = read("lib/Terminal.svelte").replace(
      "new WebLinksAddon((_event, uri) => clickLink(uri))",
      "new WebLinksAddon((_event, uri) => openUrl(uri))",
    );
    const found = terminalViolations(src);
    expect(found).toContain("a terminal component calls the opener itself");
    expect(found).toContain("the URL addon does not hand the link to clickLink");
  });

  it("catches a silence that ignores the misleading link", () => {
    const src = read("lib/stores/linkopen.svelte.ts").replace(
      "if (silence && asked.canSilence)",
      "if (silence)",
    );
    expect(storeViolations(src)).toContain(
      "“don't ask again” can switch the setting where it was not offered",
    );
  });

  it("catches an answer that opens an http link", () => {
    const src = read("lib/stores/linkopen.svelte.ts").replace(
      "if (!asked.target.openable) return;",
      "",
    );
    expect(storeViolations(src)).toContain("an answer can open a link the opener may not open");
  });

  it("catches the store opening a link past linkClick", () => {
    const src = read("lib/stores/linkopen.svelte.ts").replace(
      "const action = linkClick(settings.terminalLinks, uri, text);",
      "open(uri);\n  const action = linkClick(settings.terminalLinks, uri, text);",
    );
    expect(storeViolations(src)).toContain(
      "open() is called with something linkClick did not decide",
    );
  });
});
