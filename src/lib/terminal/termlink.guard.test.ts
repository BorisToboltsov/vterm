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
//    URL provider (`createUrlLinks`, urllinks.ts) hands the link to `clickLink`
//    — and xterm's own URL addon, which never made a non-Latin host a link,
//    stays out;
//  - every click on a link passes the terminal's one link gate first (v1.36,
//    linkgate.ts): the component builds it with `terminalLinkGate` and gives it
//    to the OSC 8 handler and the URL provider alike, so ⌘-click means the same
//    on every link; the gate never acts with a selection, never on the first
//    click of a double-click, and asks about the selection again after its wait;
//  - in the store the opener is reached only from `open`, which is called only
//    for what `linkClick` said to open and for an answered question;
//  - an answer opens only a link the opener may open — http or https, as its
//    capability allows (ADR 0055) — and "don't ask again" switches the setting only where it was
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
  if (
    calls.some((c) => !/linkHandler:\s*terminalLinkHandler\([^\n]*,\s*linkGate\),/.test(c)) ||
    (calls.length > 0 && !/const linkGate = terminalLinkGate\(/.test(src))
  ) {
    out.push("OSC 8 links skip the terminal's link gate");
  }
  if (/plugin-opener|openUrl\s*\(/.test(src)) {
    out.push("a terminal component calls the opener itself");
  }
  if (/new WebLinksAddon\(/.test(src)) {
    out.push("xterm's URL addon is back — it drops every address with a non-Latin host");
  }
  const viaGate = /createUrlLinks\(term, \(event, uri\) => linkGate\.activate\(event, "web", \(\) => clickLink\(uri\)\)\)/g;
  if ((src.match(/createUrlLinks\(/g) ?? []).length !== (src.match(viaGate) ?? []).length) {
    out.push("the URL provider does not hand the link to clickLink through the link gate");
  }
  return out;
}

/** Violations in the gate every click on a link passes (linkgate.ts). */
export function gateViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const at = src.indexOf("activate(event, kind, act) {");
  const activate = at < 0 ? "" : src.slice(at, src.indexOf("dispose: cancel", at));
  if (!/^activate\(event, kind, act\) \{\s*cancel\(\);\s*if \(host\.selected\(\)\) return;/.test(activate)) {
    out.push("a click acts without asking about the selection first");
  }
  if (!/if \(event\.detail > 1\) return;/.test(activate)) {
    out.push("the first click of a double-click acts on the name it selects");
  }
  if (!/pending = setTimeout\(\(\) => \{\s*pending = undefined;\s*if \(host\.selected\(\)\) return;/.test(activate)) {
    out.push("the delayed click does not ask about the selection again");
  }
  if ((activate.match(/\bact\(\)/g) ?? []).length !== 2 || (activate.match(/host\.hint\(/g) ?? []).length !== 1) {
    out.push("the gate opens or hints past its gesture");
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
      [join("lib", "recording", "RecordingPlayer.svelte"), join("lib", "terminal", "Terminal.svelte")].sort(),
    );
    for (const { rel, src } of creators) expect(terminalViolations(src), rel).toEqual([]);
  });

  it("every click on a link passes the gate, which leaves selections and double-clicks alone", () => {
    expect(gateViolations(read("lib/terminal/linkgate.ts"))).toEqual([]);
  });

  it("the store opens only what linkClick or an answer decided", () => {
    expect(storeViolations(read("lib/stores/linkopen.svelte.ts"))).toEqual([]);
  });

  // Nothing else switches the link mode: the lint rule `vterm/owned-writes`.

  it("catches an xterm without the handler", () => {
    const src = read("lib/recording/RecordingPlayer.svelte").replace(
      /\s*linkHandler: terminalLinkHandler\([^\n]*\n/,
      "\n",
    );
    expect(terminalViolations(src)).toContain(
      "an xterm is created without terminalLinkHandler — OSC 8 links fall back to xterm's own",
    );
  });

  it("catches a terminal that opens links itself", () => {
    const src = read("lib/terminal/Terminal.svelte").replace(
      'createUrlLinks(term, (event, uri) => linkGate.activate(event, "web", () => clickLink(uri)))',
      "createUrlLinks(term, (_event, uri) => openUrl(uri))",
    );
    const found = terminalViolations(src);
    expect(found).toContain("a terminal component calls the opener itself");
    expect(found).toContain("the URL provider does not hand the link to clickLink through the link gate");
  });

  it("catches a URL provider that opens past the gate", () => {
    const src = read("lib/terminal/Terminal.svelte").replace(
      'createUrlLinks(term, (event, uri) => linkGate.activate(event, "web", () => clickLink(uri)))',
      "createUrlLinks(term, (_event, uri) => clickLink(uri))",
    );
    expect(terminalViolations(src)).toContain("the URL provider does not hand the link to clickLink through the link gate");
  });

  it("catches OSC 8 links handled past the gate", () => {
    const src = read("lib/recording/RecordingPlayer.svelte").replace(
      "terminalLinkHandler(() => term?.buffer.active, linkGate)",
      "terminalLinkHandler(() => term?.buffer.active, terminalLinkGate(() => false))",
    );
    expect(terminalViolations(src)).toContain("OSC 8 links skip the terminal's link gate");
  });

  it("catches a gate that forgets the selection or the double-click", () => {
    const gate = read("lib/terminal/linkgate.ts");
    expect(gateViolations(gate.replace("      if (host.selected()) return;\n      const gesture", "      const gesture"))).toContain(
      "a click acts without asking about the selection first",
    );
    expect(gateViolations(gate.replace("if (event.detail > 1) return;", ""))).toContain(
      "the first click of a double-click acts on the name it selects",
    );
    expect(
      gateViolations(gate.replace("pending = undefined;\n        if (host.selected()) return;", "pending = undefined;")),
    ).toContain("the delayed click does not ask about the selection again");
    expect(gateViolations(gate.replace('if (gesture === "none") return;', 'if (gesture === "none") act();'))).toContain(
      "the gate opens or hints past its gesture",
    );
  });

  it("catches xterm's URL addon coming back", () => {
    const src = read("lib/terminal/Terminal.svelte").replace(
      /term\.registerLinkProvider\(\s*createUrlLinks\([^\n]*\n\s*\)/,
      "new WebLinksAddon((_event, uri) => clickLink(uri))",
    );
    expect(terminalViolations(src)).toContain(
      "xterm's URL addon is back — it drops every address with a non-Latin host",
    );
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

  it("catches an answer that opens a link the opener may not open", () => {
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
