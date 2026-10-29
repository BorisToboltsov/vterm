import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ check: vi.fn(), download: vi.fn(), open: vi.fn(), snapshot: vi.fn() }));
vi.mock("../api/updater", () => ({ checkUpdate: mocks.check, downloadUpdate: mocks.download, updateSnapshot: mocks.snapshot }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.open }));
import UpdatePanel from "./UpdatePanel.svelte";
const release = { current: "1.19.0", version: "1.20.0", available: true, notes: "## New features", url: "https://github.com/BorisToboltsov/vterm/releases/tag/v1.20.0", kind: "portable", trustedUpdates: true, ready: false };
beforeEach(() => { vi.clearAllMocks(); mocks.check.mockResolvedValue(release); mocks.open.mockResolvedValue(undefined); mocks.download.mockResolvedValue(undefined); mocks.snapshot.mockResolvedValue(null); });
describe("update panel", () => {
  it("restores an already downloaded update when the panel is reopened", async () => {
    mocks.snapshot.mockResolvedValue({ ...release, ready: true });
    const install = vi.fn(), user = userEvent.setup();
    render(UpdatePanel, { onInstall: install });
    await user.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(install).toHaveBeenCalledWith(release.version);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("never checks on mount and requires separate download and installation actions", async () => {
    const user = userEvent.setup(), install = vi.fn();
    render(UpdatePanel, { onInstall: install });
    expect(mocks.check).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check for updates…" }));
    expect(await screen.findByText("Version 1.20.0 is available")).toBeInTheDocument();
    mocks.download.mockImplementation(async (_version, progress) => { progress({ downloaded: 5, total: 10 }); });
    await user.click(screen.getByRole("button", { name: "Download update" }));
    await user.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(install).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Open release on GitHub" }));
    expect(mocks.open).toHaveBeenCalledWith(release.url);
  });
  it("does not report a failed check as up to date", async () => {
    mocks.check.mockRejectedValue("update-network");
    const user = userEvent.setup(); render(UpdatePanel, { onInstall: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Check for updates…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach GitHub");
    expect(screen.queryByText("No newer version is available.")).toBeNull();
  });
  it("offers manual download without a trusted key or supported format", async () => {
    mocks.check.mockResolvedValue({ ...release, trustedUpdates: false });
    const user = userEvent.setup(); render(UpdatePanel, { onInstall: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Check for updates…" }));
    await screen.findByText(/In-app installation is not configured/);
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
  });
  it("never offers install after signature failure", async () => {
    mocks.download.mockRejectedValue("update-signature");
    const user = userEvent.setup(); render(UpdatePanel, { onInstall: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Check for updates…" }));
    await user.click(await screen.findByRole("button", { name: "Download update" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be verified"));
    expect(screen.queryByRole("button", { name: "Install and restart" })).toBeNull();
  });
  it("reports up to date without download controls", async () => {
    mocks.check.mockResolvedValue({ ...release, available: false });
    const user = userEvent.setup(); render(UpdatePanel, { onInstall: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Check for updates…" }));
    expect(await screen.findByText("No newer version is available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
  });
});
