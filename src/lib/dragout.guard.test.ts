// Drag-out guard (v1.14, ADR 0027).
//
// Files of a server are dragged onto the desktop by a drag of the system's own:
// when they leave the window, the page hands the drag over and lets go. The
// backend half is held by a gate of its own
// (`a_file_leaves_the_app_only_as_a_checked_promise`, dragout.rs); this one
// holds the page's. Each rule is a way the handing over quietly goes wrong:
//
//  1. One door. The command is called from one wrapper, the wrapper from one
//     function of the page — and only after the pure model said these files
//     can be handed over at all. A second caller would hand over files of this
//     machine, or of a session that is down.
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
//     exactly that — and must not clear what the backend has them draw.
//  6. The page claims no length. How long a file is, is the server's to say at
//     the moment the drag begins: a listing is minutes old, and gives a link
//     the length of its own text.
//  7. The page and the backend agree on where this can be done, and on where a
//     folder can be promised.
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
const PAGE = "src/routes/+page.svelte";
const API = "src/lib/api/window.ts";
const BACKEND = "src-tauri/src/dragout.rs";

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
    if (/\bdragOutBegin\(/.test(c) && rel !== API && rel !== PAGE) {
      out.push(`${rel} hands a drag to the system`);
    }
  }
  return out;
}

export function pageDoorViolations(page: string): string[] {
  const c = code(page);
  const out: string[] = [];
  const calls = c.match(/\bdragOutBegin\(/g)?.length ?? 0;
  const hand = fn(c, "handToSystem");
  if (calls !== 1 || !/\bdragOutBegin\(/.test(hand)) {
    out.push("the page hands a drag over outside `handToSystem`");
  }
  const asked = hand.search(/dragOutBlocker\([^)]*\)\s*!==\s*null\)\s*return false/);
  if (asked < 0 || asked > hand.search(/\bdragOutBegin\(/)) {
    out.push("the system is asked before the model said these files can be handed over");
  }
  if (!/\bout:\s*handToSystem\b/.test(c)) {
    out.push("the store is not given the page's one way to hand a drag over");
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

// ── 5: a drag that names no files is not the desktop's ──────────────────────

export function desktopViolations(page: string): string[] {
  const body = fn(code(page), "hearDesktopDrag");
  const out: string[] = [];
  if (!/desktopCarried = ev\.paths\.length > 0 \? desktopFiles\(ev\.paths\) : null;/.test(body)) {
    out.push("a drag that names no files is kept as one from the desktop");
  }
  const clears = body.match(/clearGuestFiles\(\)/g)?.length ?? 0;
  const guarded = body.match(/if \(named\) clearGuestFiles\(\)/g)?.length ?? 0;
  if (clears === 0 || clears !== guarded) {
    out.push("what the system says of a drag that named no files clears what the backend draws");
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

// ── the tree as it is ───────────────────────────────────────────────────────

describe("files are handed to the system by one door", () => {
  it("the command, its wrapper and the page's one caller", () => {
    expect(doorViolations(frontend())).toEqual([]);
    expect(pageDoorViolations(read(PAGE))).toEqual([]);
  });

  it("catches a second caller, and a caller that does not ask the model", () => {
    expect(
      doorViolations([
        { rel: "src/lib/SftpPanel.svelte", source: `invoke("drag_out_begin", { spec });` },
        { rel: "src/lib/FileBrowser.svelte", source: `void dragOutBegin(spec);` },
      ]),
    ).toHaveLength(2);
    const page = read(PAGE);
    const unasked = page.replace(
      /if \(dragOutBlocker\(mine, dropTabs, hostEnv\.os\) !== null\) return false;/,
      "",
    );
    expect(unasked).not.toBe(page);
    expect(pageDoorViolations(unasked)).toContain(
      "the system is asked before the model said these files can be handed over",
    );
    const second = page.replace(
      "function tellNotCarried(",
      "function again(s: never) { return dragOutBegin(s); }\n  function tellNotCarried(",
    );
    expect(second).not.toBe(page);
    expect(pageDoorViolations(second)).toContain("the page hands a drag over outside `handToSystem`");
    const unwired = page.replace("out: handToSystem,", "");
    expect(unwired).not.toBe(page);
    expect(pageDoorViolations(unwired)).toContain(
      "the store is not given the page's one way to hand a drag over",
    );
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

describe("a drag that names no files is not one from the desktop", () => {
  const page = read(PAGE);

  it("holds for the page", () => {
    expect(desktopViolations(page)).toEqual([]);
  });

  it("catches a nameless drag kept, and one that clears what is drawn", () => {
    const kept = page.replace(
      "desktopCarried = ev.paths.length > 0 ? desktopFiles(ev.paths) : null;",
      "desktopCarried = desktopFiles(ev.paths);",
    );
    expect(kept).not.toBe(page);
    expect(desktopViolations(kept)).toContain(
      "a drag that names no files is kept as one from the desktop",
    );
    const clears = page.replace("else if (named) clearGuestFiles();", "else clearGuestFiles();");
    expect(clears).not.toBe(page);
    expect(desktopViolations(clears)).toContain(
      "what the system says of a drag that named no files clears what the backend draws",
    );
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
