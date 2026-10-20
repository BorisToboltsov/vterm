import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

import LinkOpenDialog from "./LinkOpenDialog.svelte";
import { settings } from "./settings.svelte";
import { answerLink, clickLink, currentLinkQuestion } from "./stores/linkopen.svelte";

describe("LinkOpenDialog", () => {
  beforeEach(() => {
    openUrl.mockClear();
    answerLink("cancel");
    settings.terminalLinks = "confirm";
    flushSync();
  });

  it("shows the host apart from the address, with a trusted name in the user part outside it", async () => {
    render(LinkOpenDialog);
    clickLink("https://github.com@evil.io/login");
    flushSync();
    expect(screen.getByTestId("link-host").textContent).toBe("evil.io");
    expect(screen.getByTestId("link-address").textContent).toBe("https://github.com@evil.io/login");
    expect(screen.getByTestId("link-address").querySelector("span")?.textContent).toBe("evil.io");
    await userEvent.click(screen.getByTestId("link-open"));
    expect(openUrl).toHaveBeenCalledWith("https://github.com@evil.io/login");
    expect(screen.queryByTestId("link-host")).toBeNull();
  });

  it("“don't ask again” switches the setting when the link is opened", async () => {
    render(LinkOpenDialog);
    clickLink("https://example.com/");
    flushSync();
    await userEvent.click(screen.getByTestId("link-silence"));
    await userEvent.click(screen.getByTestId("link-open"));
    expect(settings.terminalLinks).toBe("direct");
  });

  it("a misleading link warns and offers no silence", () => {
    render(LinkOpenDialog);
    clickLink("https://evil.io/", "github.com");
    flushSync();
    expect(screen.getByTestId("link-mislead").textContent).toContain("github.com");
    expect(screen.getByTestId("link-mislead").textContent).toContain("evil.io");
    expect(screen.queryByTestId("link-silence")).toBeNull();
  });

  it("flags a non-Latin host", () => {
    render(LinkOpenDialog);
    clickLink("https://gіthub.com/");
    flushSync();
    expect(screen.getByTestId("link-host").textContent?.startsWith("xn--")).toBe(true);
    expect(screen.getByTestId("link-idn")).toBeInTheDocument();
  });

  it("an http link can be copied but not opened", () => {
    render(LinkOpenDialog);
    clickLink("http://localhost:8080/");
    flushSync();
    expect(screen.getByTestId("link-http")).toBeInTheDocument();
    expect(screen.getByText("Copy link?")).toBeInTheDocument();
    expect(screen.queryByTestId("link-open")).toBeNull();
    expect(screen.queryByTestId("link-silence")).toBeNull();
    expect(screen.getByTestId("link-copy")).toBeInTheDocument();
  });

  it("a new question starts with the box unticked", async () => {
    render(LinkOpenDialog);
    clickLink("https://example.com/");
    flushSync();
    await userEvent.click(screen.getByTestId("link-silence"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(currentLinkQuestion()).toBeNull();
    clickLink("https://example.com/");
    flushSync();
    expect((screen.getByTestId("link-silence") as HTMLInputElement).checked).toBe(false);
  });
});
