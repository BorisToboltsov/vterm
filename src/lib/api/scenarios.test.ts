import { beforeEach, describe, expect, it, vi } from "vitest";

// The scenario wrappers (ADR 0071) pass their command and arguments as the
// backend names them; the pickers ask the system dialog.
const invoke = vi.fn();
const open = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => open(...a) }));

import * as api from "./scenarios";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  open.mockReset();
});

describe("scenario wrappers", () => {
  it("name each command and its arguments", async () => {
    await api.recipesScan(["/repo"]);
    expect(invoke).toHaveBeenLastCalledWith("recipes_scan", { sources: ["/repo"] });
    await api.recipeSave("a.sh", "x", true);
    expect(invoke).toHaveBeenLastCalledWith("recipe_save", { name: "a.sh", text: "x", replace: true });
    await api.recipeDelete("/d/a.sh");
    expect(invoke).toHaveBeenLastCalledWith("recipe_delete", { path: "/d/a.sh" });
    const run = { name: "A", mode: "check" as const, script: "x", elevation: "sudoPassword" as const, password: "p", timeoutSecs: 5, cancelId: "c" };
    await api.recipeRun("s1", run);
    expect(invoke).toHaveBeenLastCalledWith("recipe_run", { sessionId: "s1", ...run });
    await api.iacRun("s1", ["terraform", "version", "-json"], null);
    expect(invoke).toHaveBeenLastCalledWith("iac_run", { sessionId: "s1", args: ["terraform", "version", "-json"], config: null, timeoutSecs: 30 });
    await api.iacTemp("s1", [{ name: "a", text: "b" }]);
    expect(invoke).toHaveBeenLastCalledWith("iac_temp", { sessionId: "s1", files: [{ name: "a", text: "b" }] });
    await api.iacRead("s1", "/tmp/vterm-iac.a/e", 7);
    expect(invoke).toHaveBeenLastCalledWith("iac_read", { sessionId: "s1", path: "/tmp/vterm-iac.a/e", offset: 7 });
    await api.iacCleanup("s1", "/tmp/vterm-iac.a");
    expect(invoke).toHaveBeenLastCalledWith("iac_cleanup", { sessionId: "s1", dir: "/tmp/vterm-iac.a" });
  });

  it("pick a folder and shell scripts or playbooks, or nothing", async () => {
    open.mockResolvedValueOnce("/repo").mockResolvedValueOnce(null);
    expect(await api.pickRecipeFolder("t")).toBe("/repo");
    expect(await api.pickRecipeFolder("t")).toBeNull();
    open.mockResolvedValueOnce(["/a.sh", "/b.sh"]).mockResolvedValueOnce("/c.sh").mockResolvedValueOnce(null);
    expect(await api.pickRecipeFiles("t")).toEqual(["/a.sh", "/b.sh"]);
    expect(await api.pickRecipeFiles("t")).toEqual(["/c.sh"]);
    expect(await api.pickRecipeFiles("t")).toEqual([]);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ multiple: true, filters: [{ name: "Shell, YAML", extensions: ["sh", "yml", "yaml"] }] }));
  });
});
