import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { parseOsc7 } from "./osc";
import { applyHighlight, compileRules } from "./highlight";
import { defaultHighlightRules } from "./settings.svelte";

// Integration guard for the "follow terminal" feature: a real xterm must invoke our
// OSC 7 handler for the shell-integration cwd sequence — both for raw output and
// after it passes through the log-highlight pipeline (which wraps/keeps escapes).
describe("OSC 7 reaches the terminal handler", () => {
  async function capture(data: string): Promise<string | null> {
    const term = new Terminal({ allowProposedApi: true });
    let got: string | null = null;
    term.parser.registerOscHandler(7, (d) => {
      got = parseOsc7(d);
      return true;
    });
    await new Promise<void>((r) => term.write(data, () => r()));
    return got;
  }

  it("fires for a raw OSC 7 (BEL-terminated) sequence", async () => {
    expect(await capture("\x1b]7;file://ubuntu/var/log\x07")).toBe("/var/log");
  });

  it("still fires after applyHighlight with the default rules", async () => {
    const rules = compileRules(defaultHighlightRules());
    const processed = applyHighlight("\x1b]7;file://ubuntu/var/log\x07", rules);
    expect(await capture(processed)).toBe("/var/log");
  });
});
