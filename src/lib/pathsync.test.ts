import { describe, expect, it } from "vitest";
import {
  PATH_SYNC_CHOICES,
  PATH_SYNC_MODES,
  asksOnEnable,
  choiceMode,
  followsOnConnect,
  isPathSyncMode,
  pathSyncHintKey,
  pathSyncMode,
  pathSyncModeKey,
  questionShowsSetup,
  storedPathSync,
  warnsProd,
} from "./pathsync";

describe("pathsync", () => {
  it("reads only the two stored answers; anything else asks", () => {
    expect(pathSyncMode("auto")).toBe("auto");
    expect(pathSyncMode("manual")).toBe("manual");
    for (const raw of [null, undefined, "", "ask", "sometimes", "AUTO", 1, {}]) {
      expect(pathSyncMode(raw)).toBe("ask");
    }
  });

  it("stores no value for “ask” and round-trips every mode", () => {
    expect(storedPathSync("ask")).toBeNull();
    for (const mode of PATH_SYNC_MODES) {
      expect(pathSyncMode(storedPathSync(mode))).toBe(mode);
    }
  });

  it("recognises the modes", () => {
    for (const mode of PATH_SYNC_MODES) expect(isPathSyncMode(mode)).toBe(true);
    expect(isPathSyncMode("always")).toBe(false);
    expect(isPathSyncMode(null)).toBe(false);
  });

  it("an answer saves its mode, “once” saves nothing", () => {
    expect(PATH_SYNC_CHOICES.map(choiceMode)).toEqual(["auto", null, "manual"]);
  });

  it("only a server without an answer asks when sync is turned on", () => {
    expect(asksOnEnable("ask")).toBe(true);
    expect(asksOnEnable("auto")).toBe(false);
    expect(asksOnEnable("manual")).toBe(false);
  });

  it("starts following on connect only under “auto”, and never in a program's shell", () => {
    const plain = { attach: false, pendingCommand: false };
    expect(followsOnConnect("auto", plain)).toBe(true);
    expect(followsOnConnect("ask", plain)).toBe(false);
    expect(followsOnConnect("manual", plain)).toBe(false);
    expect(followsOnConnect("auto", { attach: true, pendingCommand: false })).toBe(false);
    expect(followsOnConnect("auto", { attach: false, pendingCommand: true })).toBe(false);
  });

  it("shows the setup command when it is needed now or will be typed unasked later", () => {
    expect(questionShowsSetup("ssh", true, "once")).toBe(true);
    expect(questionShowsSetup("ssh", false, "once")).toBe(false);
    expect(questionShowsSetup("ssh", false, "always")).toBe(true);
    expect(questionShowsSetup("ssh", false, "manual")).toBe(true);
    expect(questionShowsSetup(undefined, false, "always")).toBe(true);
    for (const choice of PATH_SYNC_CHOICES) {
      expect(questionShowsSetup("local", true, choice)).toBe(false);
    }
  });

  it("warns only for an SSH prod server set to sync at every connect", () => {
    expect(warnsProd("ssh", true, "auto")).toBe(true);
    expect(warnsProd("ssh", true, "manual")).toBe(false);
    expect(warnsProd("ssh", true, null)).toBe(false);
    expect(warnsProd("ssh", false, "auto")).toBe(false);
    expect(warnsProd("local", true, "auto")).toBe(false);
  });

  it("names every mode", () => {
    expect(PATH_SYNC_MODES.map(pathSyncModeKey)).toEqual([
      "pathSync.modeAsk",
      "pathSync.modeAuto",
      "pathSync.modeManual",
    ]);
    expect(PATH_SYNC_MODES.map(pathSyncHintKey)).toEqual([
      "pathSync.hintAsk",
      "pathSync.hintAuto",
      "pathSync.hintManual",
    ]);
  });
});
