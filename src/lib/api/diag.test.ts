import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/home/me/diag.jsonl" }));

import {
  captureDiag,
  diag,
  diagEvent,
  diagExport,
  flushDiag,
  orNull,
  pickDiagExportPath,
  setDiagThreshold,
  swallow,
  swallowed,
} from "./diag";
import { call, nullWrittenByCall, writtenByCall } from "./call";

describe("the diagnostics facade", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    setDiagThreshold("info");
  });

  it("writes what passes the threshold and nothing below it", () => {
    const c = captureDiag();
    setDiagThreshold("warn");
    diag.error("app", "boom");
    diag.warn("files", "listing failed", { path: "/etc", skipped: undefined });
    diag.info("files", "listed");
    diag.debug("files", "argv");
    expect(c.events().map((e) => [e.level, e.text, e.fields])).toEqual([
      ["error", "boom", undefined],
      ["warn", "listing failed", { path: "/etc" }],
    ]);
    c.stop();
  });

  it("names the session and its server when told", () => {
    const c = captureDiag();
    diagEvent("info", "connection", "connected", undefined, { sid: "tab-1", serverId: "srv-1", server: "prod-db" });
    expect(c.events()[0]).toMatchObject({ sid: "tab-1", serverId: "srv-1", server: "prod-db" });
    c.stop();
  });

  it("outside the app nothing is sent: there is no backend to write to", () => {
    diag.error("app", "boom");
    flushDiag();
    expect(invoke).not.toHaveBeenCalled();
  });

  describe("in the app", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    });
    afterEach(() => {
      vi.useRealTimers();
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    });

    it("sends events in one batch half a second later, and an error at once", () => {
      diag.info("files", "one");
      diag.info("files", "two");
      expect(invoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(invoke).toHaveBeenCalledTimes(1);
      const [cmd, args] = invoke.mock.calls[0] as [string, { events: { text: string }[] }];
      expect(cmd).toBe("diag_write");
      expect(args.events.map((e) => e.text)).toEqual(["one", "two"]);
      diag.error("app", "boom");
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  });

  it("asks the save dialog for the export, then hands the path over", async () => {
    expect(await pickDiagExportPath()).toBe("/home/me/diag.jsonl");
    await diagExport("/home/me/diag.jsonl");
    expect(invoke).toHaveBeenCalledWith("diag_export", { path: "/home/me/diag.jsonl" });
  });
});

describe("call(): the one door to the backend", () => {
  beforeEach(() => invoke.mockReset());

  it("passes the call on as it was made", async () => {
    invoke.mockResolvedValue(7);
    expect(await call<number>("list_servers")).toBe(7);
    expect(invoke).toHaveBeenLastCalledWith("list_servers");
    await call("add_server", { profile: { id: "x" } });
    expect(invoke).toHaveBeenLastCalledWith("add_server", { profile: { id: "x" } });
  });

  it("writes a rejection — its command and error, never its arguments — and throws it on", async () => {
    const c = captureDiag();
    invoke.mockRejectedValueOnce("connection refused");
    await expect(call("connect", { password: "hunter2" })).rejects.toBe("connection refused");
    invoke.mockRejectedValueOnce("auth-rejected: wrong password or key not accepted");
    await expect(call("connect", { password: "hunter2" })).rejects.toMatch("auth-rejected");
    const events = c.events();
    expect(events.map((e) => [e.level, e.text])).toEqual([
      ["warn", "command connect failed: connection refused"],
      ["info", "command connect failed: auth-rejected: wrong password or key not accepted"],
    ]);
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(events[0].fields).toMatchObject({ command: "connect" });
    c.stop();
  });

  it("does not write the failure of the diagnostics' own commands", async () => {
    const c = captureDiag();
    invoke.mockRejectedValueOnce("writer gone");
    await expect(call("diag_write", { events: [] })).rejects.toBe("writer gone");
    expect(c.events()).toEqual([]);
    c.stop();
  });
});

describe("nothing is dropped in silence", () => {
  it("writes a swallowed error: debug when expected, warn when the user lost something", async () => {
    const c = captureDiag();
    setDiagThreshold("debug");
    swallowed("settings", "save the settings", new Error("quota exceeded"), "warn");
    await Promise.reject(new Error("window gone")).catch(swallow("windows", "end the drag"));
    expect(await Promise.reject("refused").catch(orNull("files", "tell the window"))).toBeNull();
    expect(c.events().map((e) => [e.level, e.source, e.text])).toEqual([
      ["warn", "settings", "save the settings: quota exceeded"],
      ["debug", "windows", "end the drag: window gone"],
      ["debug", "files", "tell the window: refused"],
    ]);
    c.stop();
  });

  it("a rejection of call() needs nothing more: call() wrote it", async () => {
    const c = captureDiag();
    invoke.mockRejectedValueOnce("gone").mockRejectedValueOnce("gone again");
    await call("disconnect", { sessionId: "s" }).catch(writtenByCall);
    expect(await call("local_cwd", { sessionId: "s" }).catch(nullWrittenByCall)).toBeNull();
    expect(c.events().map((e) => e.text)).toEqual(["command disconnect failed: gone", "command local_cwd failed: gone again"]);
    c.stop();
  });
});
