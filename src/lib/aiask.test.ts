import { describe, expect, it } from "vitest";
import { askBlocker, chatBusy, ASK_BLOCK_MESSAGE, ASK_PRESETS } from "./aiask";
import { messages } from "./i18n/messages";

const idle = { streaming: false, pending: null, dialogRunning: false };

describe("chatBusy", () => {
  it("is idle only when nothing is in flight", () => {
    expect(chatBusy(idle)).toBe(false);
  });

  it("counts streaming, a pending dialog step and a running loop as busy", () => {
    expect(chatBusy({ ...idle, streaming: true })).toBe(true);
    expect(chatBusy({ ...idle, pending: { command: "ls" } })).toBe(true);
    // Between replies: a dialog command executes and will be fed back.
    expect(chatBusy({ ...idle, dialogRunning: true })).toBe(true);
  });
});

describe("askBlocker", () => {
  it("lets a question through on a usable chat", () => {
    expect(askBlocker({ ready: true, noAi: false })).toBeNull();
  });

  it("reports an unconfigured assistant first, then a barred server", () => {
    expect(askBlocker({ ready: false, noAi: true })).toBe("notReady");
    expect(askBlocker({ ready: true, noAi: true })).toBe("noAi");
  });

  it("has a translated message for every reason", () => {
    for (const key of Object.values(ASK_BLOCK_MESSAGE)) {
      expect(messages.en[key]).toBeTruthy();
      expect(messages.ru[key]).toBeTruthy();
    }
  });
});

describe("ASK_PRESETS", () => {
  it("gives every source an English header, a label and a preset question", () => {
    for (const p of Object.values(ASK_PRESETS)) {
      expect(p.header).toMatch(/^[A-Z][A-Za-z ]+$/);
      for (const key of [p.label, p.question]) {
        expect(messages.en[key]).toBeTruthy();
        expect(messages.ru[key]).toBeTruthy();
      }
    }
  });
});
