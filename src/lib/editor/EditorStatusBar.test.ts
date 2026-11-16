import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EditorStatusBar from "./EditorStatusBar.svelte";

function setup(over: Record<string, unknown> = {}) {
  const onlang = vi.fn();
  const onindent = vi.fn();
  const onwrap = vi.fn();
  const onminimap = vi.fn();
  render(EditorStatusBar, {
    line: 12,
    col: 5,
    selections: 3,
    indent: { tabs: false, width: 4 },
    indentSource: "editorconfig",
    encoding: "windows-1251",
    eol: "crlf",
    lang: { kind: "yaml", label: "YAML" },
    detected: { kind: "yaml", label: "YAML" },
    overridden: false,
    wrap: true,
    minimap: false,
    onlang,
    onindent,
    onwrap,
    onminimap,
    ...over,
  });
  return { onlang, onindent, onwrap, onminimap };
}

describe("EditorStatusBar", () => {
  it("says where the cursor is and how the file is kept", () => {
    setup();
    const bar = screen.getByTestId("editor-status").textContent ?? "";
    expect(screen.getByTestId("editor-status-pos").textContent).toContain("12");
    expect(bar).toContain("WINDOWS-1251");
    expect(bar).toContain("CRLF");
    expect(screen.getByTestId("editor-status-indent").textContent).toContain("4");
  });

  it("picks a language and goes back to the detected one", async () => {
    const { onlang } = setup({ lang: { kind: "ansible", label: "Ansible" }, overridden: true });
    await userEvent.click(screen.getByTestId("editor-status-lang"));
    const picker = screen.getByTestId("editor-lang-picker");
    await userEvent.keyboard("pyth");
    await userEvent.keyboard("{Enter}");
    expect(onlang).toHaveBeenCalledWith("python");
    await userEvent.click(screen.getByTestId("editor-status-lang"));
    await userEvent.click(screen.getByText(/YAML/, { selector: "button" }));
    expect(onlang).toHaveBeenLastCalledWith(null);
    expect(picker).toBeTruthy();
  });

  it("switches wrapping and the minimap", async () => {
    const { onwrap, onminimap } = setup();
    await userEvent.click(screen.getByTestId("editor-status-minimap"));
    expect(onminimap).toHaveBeenCalled();
    expect(onwrap).not.toHaveBeenCalled();
  });
});
