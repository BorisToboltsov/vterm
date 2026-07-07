import { render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localList = vi.fn();
const localHome = vi.fn();
vi.mock("./api", () => ({
  localList: (...a: unknown[]) => localList(...a),
  localHome: (...a: unknown[]) => localHome(...a),
  localMkdir: vi.fn(),
  localCreateFile: vi.fn(),
  localDelete: vi.fn(),
}));

import LocalFilePanel from "./LocalFilePanel.svelte";

beforeEach(() => {
  localList.mockReset().mockResolvedValue([]);
  localHome.mockReset().mockResolvedValue("/home/me");
});

describe("LocalFilePanel follow-terminal", () => {
  it("navigates to a new terminalCwd while following", async () => {
    const { rerender } = render(LocalFilePanel, {
      props: { embedded: true, followTerminal: true, terminalCwd: "/var" },
    });
    await new Promise((r) => setTimeout(r, 20));
    // Initial mount with follow+cwd should load /var (not home).
    expect(localList).toHaveBeenCalledWith("/var");
    localList.mockClear();
    await rerender({ embedded: true, followTerminal: true, terminalCwd: "/etc" });
    await new Promise((r) => setTimeout(r, 20));
    expect(localList).toHaveBeenCalledWith("/etc");
  });
});
