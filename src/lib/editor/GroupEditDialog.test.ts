import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GroupEditDialog from "./GroupEditDialog.svelte";
import { patchHost, type EditAsk } from "./groupedit";
import { hunksOf } from "./linepatch";
import type { TextFile } from "../types";

const file = (content: string): TextFile => ({
  content,
  eol: "lf",
  size: content.length,
  mode: null,
  mtime: null,
  sha256: "s",
  readOnly: false,
  encoding: "utf-8",
});
const hunks = hunksOf("a\nb\nc\nd\ne\n", "a\nb\nC\nd\ne\n")!;
const ask = (over: Partial<EditAsk> = {}): EditAsk => ({
  lead: "l",
  leadLabel: "web-1",
  docId: "d",
  path: "/etc/app.conf",
  name: "app.conf",
  hunks,
  hosts: [
    { id: "w2", label: "web-2", prod: false, edit: patchHost(file("a\nb\nc\nd\ne\n"), hunks, false), picked: true },
    { id: "w3", label: "web-3", prod: false, edit: patchHost(file("x\n"), hunks, false), picked: false },
    { id: "db", label: "db-1", prod: true, edit: { kind: "denied" }, picked: false },
  ],
  writing: false,
  done: false,
  leadFailed: false,
  ...over,
});

describe("GroupEditDialog", () => {
  it("shows how the edit lands on each copy and previews it before anything is written", async () => {
    const onapply = vi.fn();
    render(GroupEditDialog, { props: { ask: ask(), onapply } });
    const rows = screen.getAllByTestId("group-edit-host");
    expect((screen.getByLabelText("web-3") as HTMLInputElement).disabled).toBe(true);
    expect(rows).toHaveLength(3);
    await fireEvent.click(rows[0].querySelector("button")!);
    const preview = screen.getByTestId("group-edit-preview").textContent ?? "";
    expect(preview).toContain("- c");
    expect(preview).toContain("+ C");
    expect(screen.getByTestId("group-edit-apply").textContent).toContain("1");
    await fireEvent.click(screen.getByTestId("group-edit-apply"));
    expect(onapply).toHaveBeenCalledOnce();
  });

  it("asks for sudo where a copy could not be read", async () => {
    const onsudo = vi.fn();
    render(GroupEditDialog, { props: { ask: ask(), onsudo } });
    const field = document.querySelector("input[type=password]") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "pw" } });
    await fireEvent.click(screen.getByText(/sudo/i, { selector: "button" }));
    expect(onsudo).toHaveBeenCalledExactlyOnceWith("pw");
  });

  it("offers nothing to apply when the edit is too large or the source was not saved", () => {
    const { unmount } = render(GroupEditDialog, { props: { ask: ask({ hunks: null }) } });
    expect(screen.getByTestId("group-edit-too-large")).toBeTruthy();
    expect(screen.getByTestId("group-edit-apply")).toBeDisabled();
    unmount();
    render(GroupEditDialog, { props: { ask: ask({ leadFailed: true }) } });
    expect(screen.getByTestId("group-edit-apply")).toBeDisabled();
  });
});
