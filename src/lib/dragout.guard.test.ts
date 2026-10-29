// Drag-out guard (v1.14, ADR 0027).
//
// Files of a server are dragged onto the desktop by a drag of the system's own:
// when they leave the window, the page hands the drag over and lets go. The
// backend half is held by a gate of its own
// (`a_file_leaves_the_app_only_as_a_checked_promise`, dragout.rs); this one
// holds the page's. Each rule is a way the handing over quietly goes wrong:
//
//  1. One door. The command is called from one wrapper, the wrapper from one
//     function of the file-drag flow (`handToSystem`, page/filedragflow) — and
//     only after the pure model said these files can be handed over at all. A
//     second caller would hand over files of this machine, or of a session that
//     is down. Who imports the wrapper is the lint rule `vterm/owned-imports`;
//     that the flow asks the model first is its behaviour tests.
//  2. Asked once, in order. The store asks through `handOver` only, after what
//     was being said of the files has been heard, and says nothing more of
//     them while the question is out: a word that arrives after the system
//     took the drag puts the app's own label up beside the system's.
//  3. The pointer waits for the answer. Taking a drag over is exactly what
//     makes a page see its pointer let go of or taken away. A release handled
//     before the answer would be a drop of the page's own — the files copied
//     into whatever window happened to lie under them, while the user is still
//     carrying them to the desktop.
//  4. Taken means let go of: no drop, no release, nothing taken back. The
//     backend goes on telling the app's windows where the files are; a "the
//     drag is over" from the page would clear what they draw. And the hold on
//     selection is let go of there too: no release will come to the page to
//     end it, and the first selection after a drag-out would be swallowed.
//  5. What the system says of a drag that names no files is not the desktop's
//     business. The app's own promised files pass back over its windows as
//     exactly that — and must not clear what the backend has them draw. The
//     file-drag flow's, held by its behaviour tests.
//  6. The page claims no length. How long a file is, is the server's to say at
//     the moment the drag begins: a listing is minutes old, and gives a link
//     the length of its own text.
//  7. The page and the backend agree on where this can be done, and on where a
//     folder can be promised.
//  8. One picture at the pointer. The system draws what it carries; files it
//     carries back over a window of the app are marked as its own, and the
//     window draws where they would land — not a second label beside the
//     system's.
//
// Checked on the source with comments stripped; each check is a function over
// text, shown to catch its own violation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** Drop `<!-- … -->`, `/* … *\/` and `// …` (not the `//` of a URL). */
function code(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    out += source[i++];
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Body of `function name(` up to the line that closes it at its own depth. */
function fn(c: string, name: string): string {
  const at = c.search(new RegExp(`function ${name}\\(`));
  if (at < 0) return "";
  const indent = /(^|\n)([ \t]*)[^\n]*$/.exec(c.slice(0, at))?.[2] ?? "";
  const end = c.indexOf(`\n${indent}}\n`, at);
  return c.slice(at, end < 0 ? undefined : end);
}

const STORE = "src/lib/stores/filedrag.svelte.ts";
const MODEL = "src/lib/dragout.ts";
const API = "src/lib/api/window.ts";
const BACKEND = "src-tauri/src/dragout.rs";
const GHOST = "src/lib/FileDragGhost.svelte";
const DROP = "src/lib/filedrop.ts";

/** Every source file of the front end, tests aside. */
function frontend(): { rel: string; source: string }[] {
  const out: { rel: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
        out.push({ rel, source: read(rel) });
      }
    }
  };
  walk("src");
  return out;
}

// ── 1: one door ─────────────────────────────────────────────────────────────

export function doorViolations(files: { rel: string; source: string }[]): string[] {
  const out: string[] = [];
  for (const { rel, source } of files) {
    const c = code(source);
    if (/["'`]drag_out_begin["'`]/.test(c) && rel !== API) {
      out.push(`${rel} invokes the command itself`);
    }
  }
  return out;
}

// ── 2: asked once, in order ─────────────────────────────────────────────────

export function askingViolations(store: string): string[] {
  const c = code(store);
  const out: string[] = [];
  const hand = fn(c, "handOver");
  const rest = c.replace(hand, "");
  if (/\bout\(|\.out\b(?!\?:)/.test(rest.replace(/host\?\.out;/, ""))) {
    out.push("the system is asked outside `handOver`");
  }
  if (!/\|\|\s*handing\s*\|\|\s*refused\)\s*return/.test(hand)) {
    out.push("the system is asked again while a question is out, or after it said no");
  }
  const heard = hand.search(/afterTelling\(/);
  const asked = hand.search(/\bout\(files\)/);
  if (heard < 0 || asked < 0 || heard > asked) {
    out.push("the system is asked before what was being said of the files has been heard");
  }
  if (!/if \(fileDrag\.outside\) handOver\(\);\s*if \(!handing\) tellOver\(\);/.test(fn(c, "onMove"))) {
    out.push("the files are spoken of while the system is being asked to take them");
  }
  if (!/handing = null;\s*refused = false;/.test(fn(c, "beginFileDrag"))) {
    out.push("a new drag inherits the last one's answer");
  }
  return out;
}

// ── 3: the pointer waits for the answer ─────────────────────────────────────

export function waitingViolations(store: string): string[] {
  const c = code(store);
  const out: string[] = [];
  if (!/^function onUp\(\): void \{\s*if \(handing\) return afterHanding\(letGo\);/.test(fn(c, "onUp"))) {
    out.push("a release is handled before the system has answered");
  }
  if (
    !/^function onCancel\(\): void \{\s*if \(handing\) return afterHanding\(cancelFileDrag\);/.test(
      fn(c, "onCancel"),
    )
  ) {
    out.push("a pointer taken away is a cancelled drag before the system has answered");
  }
  if (!/if \(!took && candidate === drag\) next\(\);/.test(fn(c, "afterHanding"))) {
    out.push("what waited for the answer is done even when the system has the files");
  }
  return out;
}

// ── 4: taken means let go of ────────────────────────────────────────────────

export function takenViolations(store: string): string[] {
  const body = fn(code(store), "systemTook");
  const out: string[] = [];
  if (body === "") return ["there is no `systemTook`"];
  if (/\bhost\b|\bland\(|\bletGo\(|\brelease\b/.test(body)) {
    out.push("the system taking the files is treated as a drop");
  }
  if (/tellLeft\(|\bleft\b|cancelFileDrag\(/.test(body)) {
    out.push("the page takes back what it said when the system takes the files");
  }
  if (!/told = false;/.test(body) || !/stopListening\(\);/.test(body) || !/clearDrag\(\);/.test(body)) {
    out.push("the page does not let go of files the system took");
  }
  if (!/releaseSelection\(\);/.test(body)) {
    out.push("the page stays unselectable after the system took the files");
  }
  return out;
}

// ── 6: the page claims no length ────────────────────────────────────────────

export function specViolations(model: string): string[] {
  const body = fn(code(model), "dragOutSpec");
  return /entries\.map\(\(\{ path, name, isDir \}\) => \(\{ path, name, isDir \}\)\)/.test(body)
    ? []
    : ["what is handed over is not exactly a path, a name and a kind"];
}

// ── 7: the page and the backend agree ───────────────────────────────────────

export function mirrorViolations(model: string, backend: string): string[] {
  const m = code(model);
  const b = code(backend);
  const out: string[] = [];
  const offered = /return os === "macos" \|\| os === "windows";/.test(fn(m, "dragOutOffered"));
  const supported = /pub const SUPPORTED: bool = cfg!\(any\(target_os = "macos", windows\)\);/.test(b);
  if (!offered || !supported) out.push("the page and the backend differ on where files can be dragged out");
  const folders = /if \(os === "windows" && files\.entries\.some\(\(e\) => e\.isDir\)\) return "folders";/.test(
    fn(m, "dragOutBlocker"),
  );
  const promised = /pub const FOLDERS: bool = cfg!\(target_os = "macos"\);/.test(b);
  if (!folders || !promised) out.push("the page and the backend differ on where a folder can be promised");
  return out;
}

// ── 8: one picture at the pointer ───────────────────────────────────────────

export function pictureViolations(model: string, drop: string, ghost: string): string[] {
  const out: string[] = [];
  if (!/carried: describeFiles\(\{ \.\.\.files, system: true \}\)/.test(fn(code(model), "dragOutSpec"))) {
    out.push("files handed to the system are not marked as the system's to draw");
  }
  const d = code(drop);
  if (
    !/\.\.\.\(files\.system \? \{ system: true \} : \{\}\)/.test(fn(d, "describeFiles")) ||
    !/if \(raw\.system === true\) read\.system = true;/.test(fn(d, "parseFiles"))
  ) {
    out.push("the mark does not reach the window the files are held over");
  }
  const g = code(ghost);
  const drawn = /const files = \$derived\(([\s\S]*?)\n  \);/.exec(g)?.[1] ?? "";
  if (!/!fileDrag\.files\.system/.test(drawn) || !/\{#if files !== null\}/.test(g)) {
    out.push("a window draws its own label beside the system's picture");
  }
  return out;
}

// ── the tree as it is ───────────────────────────────────────────────────────

describe("files are handed to the system by one door", () => {
  it("the command has one wrapper", () => {
    expect(doorViolations(frontend())).toEqual([]);
  });

  it("catches a second caller of the command", () => {
    expect(
      doorViolations([
        { rel: "src/lib/SftpPanel.svelte", source: `invoke("drag_out_begin", { spec });` },
      ]),
    ).toHaveLength(1);
  });
});

describe("the system is asked once, after what was being said has been heard", () => {
  const store = read(STORE);

  it("holds for the store", () => {
    expect(askingViolations(store)).toEqual([]);
  });

  it("catches each way of asking wrong", () => {
    const mutate = (from: string | RegExp, to: string) => {
      const next = store.replace(from, to);
      expect(next).not.toBe(store);
      return askingViolations(next);
    };
    expect(mutate("|| handing || refused) return;", ") return;")).toContain(
      "the system is asked again while a question is out, or after it said no",
    );
    expect(
      mutate(
        "new Promise<void>((heard) => afterTelling(heard))",
        "Promise.resolve()",
      ),
    ).toContain("the system is asked before what was being said of the files has been heard");
    expect(mutate("if (!handing) tellOver();", "tellOver();")).toContain(
      "the files are spoken of while the system is being asked to take them",
    );
    expect(mutate(/handing = null;\s*refused = false;/, "")).toContain(
      "a new drag inherits the last one's answer",
    );
    expect(
      mutate("function onUp(): void {", "function onUp(): void {\n  void host?.out?.(fileDrag.files!);"),
    ).toContain("the system is asked outside `handOver`");
  });
});

describe("the pointer waits for the system's answer", () => {
  const store = read(STORE);

  it("holds for the store", () => {
    expect(waitingViolations(store)).toEqual([]);
  });

  it("catches a release, or a pointer taken away, handled before the answer", () => {
    const mutate = (from: string, to: string) => {
      const next = store.replace(from, to);
      expect(next).not.toBe(store);
      return waitingViolations(next);
    };
    expect(mutate("if (handing) return afterHanding(letGo);", "")).toContain(
      "a release is handled before the system has answered",
    );
    expect(mutate("if (handing) return afterHanding(cancelFileDrag);", "")).toContain(
      "a pointer taken away is a cancelled drag before the system has answered",
    );
    expect(mutate("if (!took && candidate === drag) next();", "next();")).toContain(
      "what waited for the answer is done even when the system has the files",
    );
  });
});

describe("files the system took are let go of — not dropped, not taken back", () => {
  const store = read(STORE);

  it("holds for the store", () => {
    expect(takenViolations(store)).toEqual([]);
  });

  it("catches a drop, and a word taken back", () => {
    const mutate = (to: string) => {
      const next = store.replace("function systemTook(): void {\n  told = false;", to);
      expect(next).not.toBe(store);
      return takenViolations(next);
    };
    expect(mutate("function systemTook(): void {\n  told = false;\n  land();")).toContain(
      "the system taking the files is treated as a drop",
    );
    expect(mutate("function systemTook(): void {\n  tellLeft();")).toEqual([
      "the page takes back what it said when the system takes the files",
      "the page does not let go of files the system took",
    ]);
    const held = store.replace("  releaseSelection();\n}", "}");
    expect(held).not.toBe(store);
    expect(takenViolations(held)).toEqual([
      "the page stays unselectable after the system took the files",
    ]);
  });
});

describe("the page claims no length for a file", () => {
  const model = read(MODEL);

  it("holds for the model", () => {
    expect(specViolations(model)).toEqual([]);
  });

  it("catches a size passed on", () => {
    const sized = model.replace(
      "({ path, name, isDir }) => ({ path, name, isDir })",
      "({ path, name, isDir, size }) => ({ path, name, isDir, size })",
    );
    expect(sized).not.toBe(model);
    expect(specViolations(sized)).toHaveLength(1);
  });
});

describe("the page and the backend agree on what can be dragged out", () => {
  const model = read(MODEL);
  const backend = read(BACKEND);

  it("holds for both", () => {
    expect(mirrorViolations(model, backend)).toEqual([]);
  });

  it("catches either side moving alone", () => {
    const linux = model.replace(
      'return os === "macos" || os === "windows";',
      'return os === "macos" || os === "windows" || os === "linux";',
    );
    expect(linux).not.toBe(model);
    expect(mirrorViolations(linux, backend)).toContain(
      "the page and the backend differ on where files can be dragged out",
    );
    const everywhere = backend.replace(
      'pub const FOLDERS: bool = cfg!(target_os = "macos");',
      "pub const FOLDERS: bool = true;",
    );
    expect(everywhere).not.toBe(backend);
    expect(mirrorViolations(model, everywhere)).toContain(
      "the page and the backend differ on where a folder can be promised",
    );
  });
});

describe("there is one picture at the pointer", () => {
  const model = read(MODEL);
  const drop = read(DROP);
  const ghost = read(GHOST);

  it("holds: the system's files are marked, the mark is read, the label is not drawn", () => {
    expect(pictureViolations(model, drop, ghost)).toEqual([]);
  });

  it("catches each way to end up with two", () => {
    const unmarked = model.replace("describeFiles({ ...files, system: true })", "describeFiles(files)");
    expect(unmarked).not.toBe(model);
    expect(pictureViolations(unmarked, drop, ghost)).toEqual([
      "files handed to the system are not marked as the system's to draw",
    ]);
    const unread = drop.replace("  if (raw.system === true) read.system = true;\n", "");
    expect(unread).not.toBe(drop);
    expect(pictureViolations(model, unread, ghost)).toEqual([
      "the mark does not reach the window the files are held over",
    ]);
    const both = ghost.replace(" && !fileDrag.files.system", "");
    expect(both).not.toBe(ghost);
    expect(pictureViolations(model, drop, both)).toEqual([
      "a window draws its own label beside the system's picture",
    ]);
  });
});
