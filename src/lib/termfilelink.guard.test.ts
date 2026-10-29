import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A file named in terminal output opens through one path (v1.24, ADR 0035).
//
// What a wrong turn here costs: a click meant to select a name for copying
// opens it; a name read in the wrong folder — or on the wrong machine — opens
// another file, on a production server too; the off switch leaves the
// terminal doing work for nothing. So:
//  - the terminal registers a file-link provider only while the page gave it
//    `onfilelink` and the setting is not "off", and the page gives it only
//    under `fileLinksAllowed(tab)` (a shell inside a container lists the
//    container's files, which the session's SFTP does not read);
//  - a click never opens with a selection (dragging across a name selects it)
//    or on the second click of a double-click, and the delayed open asks
//    about the selection again; only `activate` opens;
//  - a block of output reads names in the folder taken when its line was sent:
//    on a local tab the backend's note (`submittedCwd`), never the folder the
//    shell stands in now (`localCwd`); over SSH the folder the shell reported
//    since the last line;
//  - the backend notes that folder before the bytes reach the shell, and only
//    while the shell itself holds the terminal (a line typed into `ssh` or a
//    REPL is that program's);
//  - a link opens only as `fileLinkClick` decided or as the question was
//    answered, a file through the editor's own path — on the line the output
//    named, if it named one — and a folder through the file panel: the file-link
//    flow (page/filelinkflow), held by its behaviour tests, opens past nothing
//    else. What stays here is how the page wires it: the flow gets the editor's
//    own ways in, the line passed through. "Don't ask again" is the only writer
//    of the setting — the lint rule `vterm/owned-writes`.
// Each check is a function over source text, run against a planted violation
// too. Checked without comments.

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const readRust = (rel: string) => readFileSync(join(process.cwd(), "src-tauri", "src", rel), "utf8");

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
  return stripHtmlComments(src.replace(/\r\n/g, "\n"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The text from `head` to the brace that closes the block it opens. */
function block(src: string, head: string | RegExp): string {
  const at = typeof head === "string" ? src.indexOf(head) : src.search(head);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** Violations in the terminal component. */
export function terminalViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  if (!/const fileLinksOn = \$derived\(!!onfilelink && settings\.terminalFileLinks !== "off"\);/.test(src)) {
    out.push("file links are on without the page's handler or past the setting");
  }
  const registered = block(src, "if (fileLinksOn && !fileLinks)");
  if (count(src, /registerLinkProvider\(/g) !== 1 || !/registerLinkProvider\(fileLinks\.provider\)/.test(registered)) {
    out.push("the file-link provider is registered other than while file links are on");
  }
  if (!/submittedCwd: \(\) => localSubmittedCwd\(sessionId\)/.test(registered) || /\blocalCwd\(/.test(src)) {
    out.push("a local block reads the shell's folder now, not the one noted when its line was sent");
  }
  if (count(src, /fileLinks\?\.noteCwd\(path\)/g) !== 2) {
    out.push("a folder the shell reported does not reach the file links");
  }
  if (!/onSessionSubmit\(sessionId, \(written\) => fileLinks\?\.noteSubmit\(written\)\)/.test(src)) {
    out.push("the lines sent to the session do not start blocks");
  }
  return out;
}

/** Violations in the provider. */
export function providerViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const activate = block(src, "function activate(");
  if (!/^[^]*?\{\s*clearTimeout\(pending\);\s*pending = undefined;\s*if \(term\.hasSelection\(\) \|\| !clickOpens\(/.test(activate)) {
    out.push("a click opens without asking about the selection first");
  }
  if (!/if \(event\.detail > 1\) return;/.test(activate)) {
    out.push("the first click of a double-click opens the name it selects");
  }
  if (!/pending = setTimeout\(\(\) => \{\s*pending = undefined;\s*if \(!term\.hasSelection\(\)\) host\.open\(target\);/.test(activate)) {
    out.push("the delayed open does not ask about the selection again");
  }
  if (count(src, /host\.open\(/g) !== count(activate, /host\.open\(/g)) {
    out.push("something other than a click opens a link");
  }
  if (!/if \(buf\.type !== "normal" \|\| term\.modes\.mouseTrackingMode !== "none"\) \{\s*callback\(undefined\);/.test(src)) {
    out.push("links are offered over a full-screen program or one that takes the mouse");
  }
  const submit = block(src, "noteSubmit(written)");
  if (!/const fromReport = armed \? reported : null;\s*armed = false;/.test(submit)) {
    out.push("a block over SSH borrows a folder the shell did not report since the last line");
  }
  if (!/written\.then\(\(\) => host\.submittedCwd\(\)\)/.test(submit)) {
    out.push("a local block does not take the folder noted when its line was sent");
  }
  return out;
}

/** Violations in the page: what it gives the terminal and the file-link flow. */
export function pageViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  if (!/onfilelink=\{fileLinksAllowed\(tab\)\s*\?\s*\(target\) => fileLinks\.clicked\(tab\.sessionId, target\)\s*:\s*undefined\}/.test(src)) {
    out.push("a terminal gets file links without asking whether its output is its session's files");
  }
  if (
    !/openFile: \(id, path, opts\) => void editors\.openFile\(id, path, baseName\(path\), opts\),/.test(src) ||
    !/openLocalFile: \(id, path, opts\) => void editors\.openLocal\(id, path, opts\),/.test(src)
  ) {
    out.push("a file link opens other than through the editor's own path, on its line");
  }
  return out;
}

/** Violations in the backend's note of the folder a line runs in. */
export function backendViolations(raw: string): string[] {
  const src = raw.replace(/\r\n/g, "\n").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  const write = block(src, "pub fn write_input(");
  const noted = write.indexOf("self.prompt_cwd()");
  const sent = write.indexOf("write_all(");
  if (noted < 0 || sent < 0 || noted > sent) {
    out.push("the folder is noted after the line reached the shell, which may be running it by then");
  }
  const prompt = block(src, "fn prompt_cwd(");
  const asked = prompt.indexOf("if !self.shell_in_foreground(pid) {");
  const read = prompt.indexOf("process_cwd(");
  if (asked < 0 || read < 0 || asked > read || !/if !self\.shell_in_foreground\(pid\) \{\s*return None;\s*\}/.test(prompt)) {
    out.push("the shell's folder is noted while a program it runs holds the terminal");
  }
  return out;
}

const TERMINAL = "lib/Terminal.svelte";
const PROVIDER = "lib/filelinkprovider.ts";
const PAGE = "routes/+page.svelte";

describe("terminal file link guard", () => {
  it("the terminal shows file links only where the page and the setting allow", () => {
    expect(terminalViolations(read(TERMINAL))).toEqual([]);
  });

  it("a click opens only without a selection and past a double-click", () => {
    expect(providerViolations(read(PROVIDER))).toEqual([]);
  });

  it("the page wires the terminal and the editor's own ways in to the file-link flow", () => {
    expect(pageViolations(read(PAGE))).toEqual([]);
  });

  it("the backend notes the folder before the line, and only at the shell's prompt", () => {
    expect(backendViolations(readRust("pty.rs"))).toEqual([]);
  });
});

describe("terminal file link guard — catches what it exists for", () => {
  const swap = (src: string, from: string, to: string) => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a provider registered whatever the setting", () => {
    const src = swap(
      read(TERMINAL),
      'const fileLinksOn = $derived(!!onfilelink && settings.terminalFileLinks !== "off");',
      "const fileLinksOn = $derived(true);",
    );
    expect(terminalViolations(src)).toContain(
      "file links are on without the page's handler or past the setting",
    );
  });

  it("a local block read in the folder the shell stands in now", () => {
    const src = swap(
      read(TERMINAL),
      "submittedCwd: () => localSubmittedCwd(sessionId)",
      "submittedCwd: () => localCwd(sessionId)",
    );
    expect(terminalViolations(src)).toContain(
      "a local block reads the shell's folder now, not the one noted when its line was sent",
    );
  });

  it("a click that opens what a drag selected", () => {
    const src = swap(read(PROVIDER), "if (term.hasSelection() || !clickOpens(", "if (!clickOpens(");
    expect(providerViolations(src)).toContain("a click opens without asking about the selection first");
  });

  it("a delayed open that forgets the double-click's selection", () => {
    const src = swap(
      read(PROVIDER),
      "if (!term.hasSelection()) host.open(target);",
      "host.open(target);",
    );
    expect(providerViolations(src)).toContain("the delayed open does not ask about the selection again");
  });

  it("a first click of a double-click that opens", () => {
    const src = swap(read(PROVIDER), "if (event.detail > 1) return;", "");
    expect(providerViolations(src)).toContain("the first click of a double-click opens the name it selects");
  });

  it("an SSH block that keeps the last folder after a line went to another program", () => {
    const src = swap(read(PROVIDER), "armed = false;\n      // Enter", "// Enter");
    expect(providerViolations(src)).toContain(
      "a block over SSH borrows a folder the shell did not report since the last line",
    );
  });

  it("a container shell with file links", () => {
    const src = swap(
      read(PAGE),
      "onfilelink={fileLinksAllowed(tab)\n                      ? (target) => fileLinks.clicked(tab.sessionId, target)\n                      : undefined}",
      "onfilelink={(target) => fileLinks.clicked(tab.sessionId, target)}",
    );
    expect(pageViolations(src)).toContain(
      "a terminal gets file links without asking whether its output is its session's files",
    );
  });

  it("a file opened past the editor's own path, or without its line", () => {
    const past = swap(
      read(PAGE),
      "openLocalFile: (id, path, opts) => void editors.openLocal(id, path, opts),",
      'openLocalFile: (id, path) => addEditor(id, path, baseName(path), editorLangOrPlain(path), "local"),',
    );
    expect(pageViolations(past)).toContain("a file link opens other than through the editor's own path, on its line");
    const lineless = swap(
      read(PAGE),
      "openFile: (id, path, opts) => void editors.openFile(id, path, baseName(path), opts),",
      "openFile: (id, path) => void editors.openFile(id, path, baseName(path)),",
    );
    expect(pageViolations(lineless)).toContain("a file link opens other than through the editor's own path, on its line");
  });

  it("a folder noted after the line went out", () => {
    const rust = readRust("pty.rs");
    const note = "        if self.watch_submits.load(Ordering::Relaxed) && data.contains(&b'\\r') {\n            *self.submitted.locked() = self.prompt_cwd();\n        }\n";
    const moved = swap(rust, note, "").replace(
      "        w.flush().map_err(|e| format!(\"local flush failed: {e}\"))?;\n",
      `        w.flush().map_err(|e| format!("local flush failed: {e}"))?;\n${note}`,
    );
    expect(backendViolations(moved)).toContain(
      "the folder is noted after the line reached the shell, which may be running it by then",
    );
  });

  it("a folder noted while a program holds the terminal", () => {
    const src = swap(
      readRust("pty.rs"),
      "        if !self.shell_in_foreground(pid) {\n            return None;\n        }\n",
      "",
    );
    expect(backendViolations(src)).toContain(
      "the shell's folder is noted while a program it runs holds the terminal",
    );
  });
});
