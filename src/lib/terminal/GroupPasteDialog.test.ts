import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GroupPasteDialog from "./GroupPasteDialog.svelte";

describe("GroupPasteDialog", () => {
  it("opens with the block pasted into the line and pastes what the field holds", async () => {
    const onpaste = vi.fn();
    render(GroupPasteDialog, { props: { open: true, text: "line 1\nline 2", targets: ["web-1", "web-2"], onpaste } });
    const area = screen.getByTestId("group-paste-text") as HTMLTextAreaElement;
    await Promise.resolve();
    expect(area.value).toBe("line 1\nline 2");
    expect(screen.getByTestId("group-paste-targets").textContent).toContain("web-1, web-2");
    await fireEvent.input(area, { target: { value: "edited" } });
    await fireEvent.click(screen.getByTestId("group-paste-confirm"));
    expect(onpaste).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("names production among the members and has nothing to paste from an empty field", async () => {
    render(GroupPasteDialog, { props: { open: true, text: "", targets: ["db-1"], prod: ["db-1"] } });
    expect(screen.getByTestId("group-paste-prod").textContent).toContain("db-1");
    expect(screen.getByTestId("group-paste-confirm")).toBeDisabled();
  });
});
