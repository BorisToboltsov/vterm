import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

// "New Ansible project" (ADR 0071): a folder name, servers of the catalog, the
// project written through the connection and opened.

const env = vi.hoisted(() => ({ writes: [] as { path: string; text: string }[], dirs: [] as string[], fail: false }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  sftpMkdir: vi.fn(async (_s: string, p: string) => {
    if (env.fail) throw new Error("dest-exists: a file or folder with that name already exists");
    env.dirs.push(p);
  }),
  sftpWriteText: vi.fn(async (_s: string, path: string, text: string) => void env.writes.push({ path, text })),
}));

import type { ServerProfile } from "../types";
import NewProjectDialog from "./NewProjectDialog.svelte";

const web: ServerProfile = {
  id: "w",
  alias: "web 1",
  host: "10.0.0.1",
  port: 2222,
  username: "deploy",
  authMethod: "password",
  keyPath: null,
  hasSavedPassword: true,
  group: "web",
  tags: [],
  prod: false,
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
};

function show() {
  const oncreate = vi.fn();
  render(NewProjectDialog, {
    props: { open: true, sessionId: "s1", local: false, parent: "/home/u", where: "web-1:/home/u", servers: [web], connected: new Set<string>(), onclose: vi.fn(), oncreate },
  });
  return oncreate;
}

describe("a new Ansible project", () => {
  it("is written with an inventory of the servers picked, and opened", async () => {
    const oncreate = show();
    const dialog = screen.getByTestId("new-project-dialog");
    await fireEvent.input(within(dialog).getByLabelText("Folder"), { target: { value: "" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a folder name");
    await fireEvent.input(within(dialog).getByLabelText("Folder"), { target: { value: "infra" } });
    // The folder of the catalog toggles its servers at once.
    await fireEvent.click(within(dialog).getByRole("button", { name: /web/ }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(oncreate).toHaveBeenCalledWith("/home/u/infra"));
    const inv = env.writes.find((w) => w.path === "/home/u/infra/inventory/vterm.yml")!;
    expect(inv.text).toContain('ansible_host: "10.0.0.1"');
    expect(inv.text).toContain("ansible_port: 2222");
    expect(inv.text).not.toMatch(/password/i);
  });

  it("says why it was not made", async () => {
    env.fail = true;
    const oncreate = show();
    await fireEvent.click(within(screen.getByTestId("new-project-dialog")).getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The project was not made: Error: dest-exists");
    expect(oncreate).not.toHaveBeenCalled();
    env.fail = false;
  });
});
