import { describe, it, expect } from "vitest";
import { classifyClose, showNoSignal } from "./connlost";

describe("classifyClose", () => {
  it("is manual whenever the user initiated it", () => {
    expect(classifyClose({ userInitiated: true, wasConnected: true })).toBe("manual");
    expect(classifyClose({ userInitiated: true, wasConnected: false })).toBe("manual");
  });
  it("is dropped only for an unexpected loss of a connected session", () => {
    expect(classifyClose({ userInitiated: false, wasConnected: true })).toBe("dropped");
  });
  it("is failed when it never connected and the user didn't close it", () => {
    expect(classifyClose({ userInitiated: false, wasConnected: false })).toBe("failed");
  });
});

describe("showNoSignal", () => {
  it("shows only for a real drop", () => {
    expect(showNoSignal({ userInitiated: false, wasConnected: true })).toBe(true);
    expect(showNoSignal({ userInitiated: true, wasConnected: true })).toBe(false);
    expect(showNoSignal({ userInitiated: false, wasConnected: false })).toBe(false);
  });
});
