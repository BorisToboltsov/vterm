import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/app", () => ({
  getName: vi.fn().mockResolvedValue("vterm"),
  getVersion: vi.fn().mockResolvedValue("0.4.0"),
  getTauriVersion: vi.fn().mockResolvedValue("2.0.0"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

import HelpPanel from "./HelpPanel.svelte";

describe("HelpPanel", () => {
  it("renders nothing when closed", () => {
    render(HelpPanel, { props: { open: false } });
    expect(screen.queryByText("Hotkeys")).toBeNull();
  });

  it("shows the hotkeys table on the Help tab", () => {
    render(HelpPanel, { props: { open: true, tab: "help" } });
    expect(screen.getByText("Hotkeys")).toBeInTheDocument();
    expect(screen.getByText("Copy selection")).toBeInTheDocument();
    expect(screen.getByText("Interrupt (SIGINT)")).toBeInTheDocument();
  });

  it("shows the app version from Tauri on the About tab", async () => {
    render(HelpPanel, { props: { open: true, tab: "about" } });
    // onMount fills these asynchronously.
    expect(await screen.findByText("0.4.0")).toBeInTheDocument();
    expect(screen.getByText("2.0.0")).toBeInTheDocument();
    expect(screen.getByText(/MIT/)).toBeInTheDocument();
  });

  it("switches tabs on click", async () => {
    const user = userEvent.setup();
    render(HelpPanel, { props: { open: true, tab: "help" } });
    await user.click(screen.getByRole("button", { name: "About" }));
    expect(await screen.findByText("0.4.0")).toBeInTheDocument();
  });

  it("opens external links through the Tauri opener", async () => {
    const user = userEvent.setup();
    render(HelpPanel, { props: { open: true, tab: "about" } });
    await user.click(await screen.findByRole("button", { name: "xterm.js" }));
    expect(openUrl).toHaveBeenCalledWith("https://xtermjs.org");
  });

  it("shows the author contacts on the About tab", () => {
    render(HelpPanel, { props: { open: true, tab: "about" } });
    expect(screen.getByText("bt@vcore.su")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "@BorisToboltsov" })).toBeInTheDocument();
  });

  it("opens the Telegram contact through the opener", async () => {
    const user = userEvent.setup();
    render(HelpPanel, { props: { open: true, tab: "about" } });
    await user.click(screen.getByRole("button", { name: "@BorisToboltsov" }));
    expect(openUrl).toHaveBeenCalledWith("https://t.me/BorisToboltsov");
  });

  it("renders the bundled user guide on the Manual tab", () => {
    render(HelpPanel, { props: { open: true, tab: "manual" } });
    // The guide's (docs/GUIDE.md) top-level heading.
    expect(
      screen.getByRole("heading", { name: "Руководство пользователя vterm", level: 1 }),
    ).toBeInTheDocument();
  });
});
