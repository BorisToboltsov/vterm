import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { onSessionSubmit, writeToTerminal } from "./session";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("onSessionSubmit", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("hears a line carrying Enter, with the write that carries it", async () => {
    const heard = vi.fn();
    const stop = onSessionSubmit("s1", heard);
    const written = writeToTerminal("s1", bytes("ls\r"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toBe(written);
    await written;
    expect(invoke).toHaveBeenCalledWith("write_to_terminal", { sessionId: "s1", data: [108, 115, 13] });
    stop();
  });

  it("does not hear keystrokes without Enter, or another session", async () => {
    const heard = vi.fn();
    const stop = onSessionSubmit("s1", heard);
    await writeToTerminal("s1", bytes("ls"));
    await writeToTerminal("s2", bytes("ls\r"));
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it("stops hearing once unsubscribed, and keeps the other listeners", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const stopA = onSessionSubmit("s1", a);
    const stopB = onSessionSubmit("s1", b);
    stopA();
    await writeToTerminal("s1", bytes("\r"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    stopB();
    stopB();
    await writeToTerminal("s1", bytes("\r"));
    expect(b).toHaveBeenCalledTimes(1);
  });
});
