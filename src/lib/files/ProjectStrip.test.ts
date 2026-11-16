import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ProjectStrip from "./ProjectStrip.svelte";
import { projectActions } from "./projectactions";
import type { ProjectInfo } from "./projectmap";

const info: ProjectInfo = { kind: "compose", markers: ["compose.yaml"], manifest: "compose.yaml", tasksFile: "Makefile" };

function setup(over: Partial<Parameters<typeof render<typeof ProjectStrip>>[1] & object> = {}) {
  const onrun = vi.fn();
  const ontask = vi.fn();
  const onmenu = vi.fn();
  render(ProjectStrip, {
    info,
    facts: { name: "stack", version: null, facts: ["compose.yaml", "api, db"] },
    git: { branch: "main", ahead: 2, behind: 0, changed: 3, marks: new Map<string, "M">(), ignored: new Set<string>() },
    actions: projectActions("compose"),
    tasks: [{ name: "deploy", argv: ["make", "deploy"] }],
    tasksFile: "Makefile",
    prod: true,
    last: null,
    testid: "p",
    onrun,
    ontask,
    onmenu,
    ...over,
  });
  return { onrun, ontask, onmenu };
}

describe("ProjectStrip", () => {
  it("names the project, its branch and facts", () => {
    setup();
    expect(screen.getByTestId("p").textContent).toContain("Compose · stack");
    expect(screen.getByTestId("p-branch").textContent).toBe("main");
    expect(screen.getByTestId("p").textContent).toContain("↑2");
    expect(screen.getByTestId("p").textContent).toContain("api, db");
  });

  it("runs a strip action and opens the rest as a menu the panel draws", async () => {
    const { onrun, onmenu } = setup();
    await userEvent.click(screen.getByTestId("p-act-up"));
    expect(onrun).toHaveBeenCalledWith(expect.objectContaining({ id: "up" }));
    await userEvent.click(screen.getByTestId("p-more"));
    const items = onmenu.mock.calls[0][2] as { label: string; danger?: boolean; hint?: string }[];
    expect(items.some((i) => i.danger)).toBe(true);
    await userEvent.click(screen.getByTestId("p-tasks"));
    const tasks = onmenu.mock.calls[1][2] as { label: string; hint?: string; onSelect: () => void }[];
    expect(tasks.map((t) => t.label)).toEqual(["deploy"]);
    // On a prod server a task says it will ask.
    expect(tasks[0].hint).toBeTruthy();
  });

  it("repeats the last action", async () => {
    const { ontask } = setup({ last: { name: "deploy", argv: ["make", "deploy"] } });
    await userEvent.click(screen.getByTestId("p-repeat"));
    expect(ontask).toHaveBeenCalledWith({ name: "deploy", argv: ["make", "deploy"] });
  });
});
