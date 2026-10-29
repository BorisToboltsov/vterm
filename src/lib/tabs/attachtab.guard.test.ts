import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A container/pod tab ("Open shell" in Docker/k8s) is labelled `nginx · host`,
// so its shell must END with the container session — otherwise `exit` leaves a
// plain host shell under a container's name (principle 5). Three things keep
// that true, all in the page's `onstatus` handler:
//   * the attach argv is typed via `renderSessionCommand` (exec / `; exit`),
//     never the plain `renderArgv` that leaves the host shell running;
//   * the tab's `closed` is its session ending, not a drop — so no automatic
//     reconnect (it would put the user straight back inside after `exit`) and
//     no NO SIGNAL takeover.
// Checked on the source with comments stripped.

function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    out += text[i++];
  }
  return out;
}

const page = stripHtmlComments(
  readFileSync(join(process.cwd(), "src", "routes", "+page.svelte"), "utf8"),
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The `onstatus={(st, d) => { … }}` handler of the terminal view. */
function onstatus(): string {
  const at = page.indexOf("onstatus={(st");
  expect(at, "the page handles terminal status").toBeGreaterThan(-1);
  const end = page.indexOf("{/key}", at);
  return page.slice(at, end);
}

describe("container tab guard", () => {
  it("types the attach argv so that the tab's shell ends with it", () => {
    const h = onstatus();
    expect(h).toMatch(/attach\s*\?\s*renderSessionCommand\(argv,\s*shell\)\s*:\s*renderArgv\(/);
  });

  it("never auto-reconnects a container tab or shows NO SIGNAL for it", () => {
    const h = onstatus();
    const auto = h.slice(h.indexOf("settings.autoReconnect && tab.kind"));
    expect(auto, "auto-reconnect skips container tabs").toMatch(/^[^{]*!attach/);
    const noSignal = h.slice(h.lastIndexOf("if (", h.indexOf("showNoSignal(")));
    expect(noSignal.slice(0, noSignal.indexOf("showNoSignal(")), "NO SIGNAL skips them").toMatch(
      /!attach/,
    );
  });
});
