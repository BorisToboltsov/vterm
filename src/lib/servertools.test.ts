import { describe, expect, it } from "vitest";
import { commandNeedsSudo } from "./servertools";

describe("commandNeedsSudo", () => {
  it("is true for system-manager commands, false for pip/brew", () => {
    expect(commandNeedsSudo("sudo apt-get install -y shellcheck")).toBe(true);
    expect(commandNeedsSudo("  sudo dnf install -y x")).toBe(true);
    expect(commandNeedsSudo("pip install --user ruff")).toBe(false);
    expect(commandNeedsSudo("brew install hadolint")).toBe(false);
  });
});
