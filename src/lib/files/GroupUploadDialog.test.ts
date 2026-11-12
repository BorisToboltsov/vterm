import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GroupUploadDialog from "./GroupUploadDialog.svelte";
import type { UploadAsk } from "./groupupload";

const ask = (replace = false): UploadAsk => ({
  lead: "a",
  destDir: "/etc/nginx",
  sources: [{ path: "/home/me/app.conf", name: "app.conf", isDir: false }],
  hosts: [
    { id: "a", label: "web-1", prod: false, check: { kind: "ready", free: ["app.conf"], taken: [] }, picked: true },
    {
      id: "b",
      label: "web-2",
      prod: false,
      check: { kind: "ready", free: [], taken: [{ name: "app.conf", isDir: false, size: 2048, modified: null }] },
      picked: true,
    },
    { id: "c", label: "db-1", prod: true, check: { kind: "noFolder" }, picked: false },
  ],
  outside: ["local"],
  replace,
});

describe("GroupUploadDialog", () => {
  it("names each server's folder and counts only the servers that get something", async () => {
    const onconfirm = vi.fn();
    const onreplace = vi.fn();
    render(GroupUploadDialog, { props: { ask: ask(), onconfirm, onreplace } });
    const rows = screen.getAllByTestId("group-upload-host").map((r) => r.textContent ?? "");
    expect(rows[1]).toContain("web-2");
    expect(rows[2]).toContain("db-1");
    expect(screen.getByTestId("group-upload-confirm").textContent).toContain("1");
    await fireEvent.click(screen.getByTestId("group-upload-replace"));
    expect(onreplace).toHaveBeenCalledExactlyOnceWith(true);
    await fireEvent.click(screen.getByTestId("group-upload-confirm"));
    expect(onconfirm).toHaveBeenCalledOnce();
  });

  it("with replace ticked, counts the server whose name is taken too", () => {
    render(GroupUploadDialog, { props: { ask: ask(true) } });
    expect(screen.getByTestId("group-upload-confirm").textContent).toContain("2");
  });
});
