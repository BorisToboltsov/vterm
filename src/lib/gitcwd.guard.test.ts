import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Git follows the terminal while "path sync" is off (v1.0.35).
//
// The bug: git read only the dock's shared directory, which with following off is
// written by the file panel alone — and the file panel opens home on connect. A
// `cd` into a repo in the terminal left git on "not a git repository" for the
// folder the session started in. The rule lives in `gitCwd`; this keeps the panel
// on it, the dock feeding it the terminal's cwd, and a local tab's cwd polled
// while git is on screen (not only while following), and Git's "Enable path sync"
// button wired to the one dock-wide switch. Checked on the source with
// JS comments stripped, so a comment naming a call can't satisfy it.

const LIB = join(process.cwd(), "src", "lib");
const PAGE = join(process.cwd(), "src", "routes", "+page.svelte");

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const read = (p: string) => strip(readFileSync(p, "utf8"));

describe("git follows the terminal guard", () => {
  it("the git panel picks its directory through gitCwd, terminal included", () => {
    const src = read(join(LIB, "GitPanel.svelte"));
    expect(src).toMatch(/\$derived\(\s*gitCwd\(\s*followTerminal\s*,\s*dockCwd\(sessionId\)\s*,\s*terminalCwd\s*\)\s*\)/);
    // Reading the dock directory straight into `cwd` is the old, broken rule.
    expect(src).not.toMatch(/cwd\s*=\s*\$derived\(\s*dockCwd\(/);
  });

  it("the dock hands the terminal's cwd to the git panel", () => {
    const src = read(join(LIB, "DockPanel.svelte"));
    const start = src.indexOf("<GitPanel");
    expect(start, "<GitPanel not found in DockPanel.svelte").toBeGreaterThan(-1);
    const tag = src.slice(start, src.indexOf("/>", start));
    expect(tag).toMatch(/\{terminalCwd\}|terminalCwd=\{/);
  });

  it("a local tab's cwd is polled by pollsLocalCwd, which knows about git", () => {
    const src = read(PAGE);
    expect(src).toMatch(/pollsLocalCwd\([^;]*?gitShown\)/);
  });

  // v1.0.37: Git's "Enable path sync" button is the same switch as the SFTP/Git
  // toggle. It used to set the shell up but leave following off, so an SFTP panel
  // connected afterwards neither followed nor showed the toggle on — the label
  // promised what the button didn't do. Checked on the wiring, not a name.
  it("git's path sync button turns on the same dock-wide following as the toggle", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/enableGitPathSync|pendingFollowTwoWay/);
    // Per session since v1.2 (the docks keep a panel for every session on screen).
    expect(src).toMatch(
      /\?\s*\(\)\s*=>\s*enablePathSync\(tab\.sessionId\)\s*\n\s*:\s*undefined\}/,
    );
    const start = src.indexOf("function enablePathSync(id: string)");
    expect(start, "enablePathSync() not found in +page.svelte").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body).toMatch(/followTerminal\[id\]\s*=\s*true/);
    // Confirming the shell-setup dialog always ends with following on.
    const confirm = src.indexOf("function confirmFollowSetup()");
    const cbody = src.slice(confirm, src.indexOf("\n  }", confirm));
    expect(cbody).toMatch(/^\s*followTerminal\[id\]\s*=\s*true;/m);
  });
});
