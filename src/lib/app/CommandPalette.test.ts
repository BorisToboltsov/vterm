import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette.svelte";
import type { CommandItem } from "./command";

function commands(runs: Record<string, () => void>): CommandItem[] {
  return [
    { id: "add", title: "Add server", icon: "plus", group: "Actions", run: runs.add },
    { id: "settings", title: "Settings", icon: "settings", group: "Actions", run: runs.settings },
    {
      id: "web",
      title: "web01",
      subtitle: "root@host",
      icon: "server",
      group: "Servers",
      run: runs.web,
    },
  ];
}

describe("CommandPalette", () => {
  it("lists commands and filters as you type", async () => {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    render(CommandPalette, { props: { open: true, commands: commands(runs) } });

    expect(screen.getByText("Add server")).toBeInTheDocument();
    expect(screen.getByText("web01")).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("command-input"), "web");
    expect(screen.queryByText("Add server")).toBeNull();
    expect(screen.getByText("web01")).toBeInTheDocument();
  });

  it("runs the top match on Enter and closes", async () => {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    render(CommandPalette, { props: { open: true, commands: commands(runs) } });

    await userEvent.type(screen.getByTestId("command-input"), "web");
    await userEvent.keyboard("{Enter}");

    expect(runs.web).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("command-input")).toBeNull();
  });

  it("runs a command on click", async () => {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    render(CommandPalette, { props: { open: true, commands: commands(runs) } });

    await userEvent.click(screen.getByText("Settings"));
    expect(runs.settings).toHaveBeenCalledOnce();
  });

  it("ArrowDown moves the selection before Enter", async () => {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    render(CommandPalette, { props: { open: true, commands: commands(runs) } });

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(runs.settings).toHaveBeenCalledOnce();
    expect(runs.add).not.toHaveBeenCalled();
  });

  it("Escape closes the palette", async () => {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    render(CommandPalette, { props: { open: true, commands: commands(runs) } });

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("command-input")).toBeNull();
  });

  it("shows an empty state when nothing matches", async () => {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    render(CommandPalette, { props: { open: true, commands: commands(runs) } });

    await userEvent.type(screen.getByTestId("command-input"), "zzzzz");
    expect(screen.getByText("Nothing found")).toBeInTheDocument();
  });
});

describe("CommandPalette — a command onto the top bar (v1.35)", () => {
  function setup() {
    const runs = { add: vi.fn<() => void>(), settings: vi.fn<() => void>(), web: vi.fn<() => void>() };
    const on = new Set<string>(["settings"]);
    const toggle = vi.fn((item: CommandItem) => (on.has(item.id) ? on.delete(item.id) : on.add(item.id)));
    const pin = { can: (id: string) => id !== "web", pinned: (id: string) => on.has(id), toggle };
    render(CommandPalette, { props: { open: true, commands: commands(runs), pin } });
    return { runs, toggle };
  }

  it("a row's pin puts its command on the bar instead of running it", async () => {
    const { runs, toggle } = setup();
    const pins = screen.getAllByTestId("command-pin");
    // Every command but the one that cannot stand on the bar has a pin.
    expect(pins).toHaveLength(2);
    expect(pins[1]).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(pins[0]);
    expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ id: "add" }));
    expect(runs.add).not.toHaveBeenCalled();
    expect(screen.getByTestId("command-pin-hint")).toBeInTheDocument();
  });

  it("Shift+Enter pins the row in focus; Enter still runs it", async () => {
    const { runs, toggle } = setup();
    await userEvent.type(screen.getByTestId("command-input"), "add");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(runs.add).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(runs.add).toHaveBeenCalledTimes(1);
  });

  it("a command that cannot stand on the bar runs on Shift+Enter", async () => {
    const { runs, toggle } = setup();
    await userEvent.type(screen.getByTestId("command-input"), "web");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(toggle).not.toHaveBeenCalled();
    expect(runs.web).toHaveBeenCalledTimes(1);
  });
});
