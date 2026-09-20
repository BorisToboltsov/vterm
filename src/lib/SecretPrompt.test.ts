import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import SecretPrompt from "./SecretPrompt.svelte";
import type { ServerProfile } from "./types";

// The prompt hands the typed secret straight to the tab store; stub it so we can
// assert what it was told without opening a real session.
const openTab = vi.fn();
vi.mock("./stores/tabs.svelte", () => ({
  openTab: (...args: unknown[]) => openTab(...args),
}));

const server: ServerProfile = {
  id: "s1",
  alias: "Prod",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: null,
  hasSavedPassword: false,
  group: null,
  tags: [],
  autoRecord: false,
  noAi: false,
  chatPromptId: null,
  execMode: null,
  proxy: null,
  notes: "",
  icon: "",
  iconColor: "",
};

function renderPrompt() {
  const result = render(SecretPrompt);
  const comp = result.component as unknown as {
    prompt: (s: ServerProfile, label: string, error?: string) => void;
  };
  return { ...result, comp };
}

const rememberBox = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("SecretPrompt", () => {
  beforeEach(() => openTab.mockReset());

  it("offers to save the secret by default", async () => {
    const { comp } = renderPrompt();
    comp.prompt(server, "Password");
    await tick();
    expect(rememberBox().checked).toBe(true);
  });

  it("keeps the default when re-prompting after a rejected secret", async () => {
    const { comp } = renderPrompt();
    comp.prompt(server, "Password", "Authentication rejected");
    await tick();
    expect(screen.getByText("Authentication rejected")).toBeInTheDocument();
    expect(rememberBox().checked).toBe(true);
  });

  it("passes the typed secret and the checkbox state to the tab", async () => {
    const { comp } = renderPrompt();
    comp.prompt(server, "Password");
    await tick();
    await userEvent.type(screen.getByTestId("secret-input"), "hunter2");
    await userEvent.click(screen.getByTestId("secret-connect"));
    expect(openTab).toHaveBeenCalledWith("s1", "Prod", "hunter2", true);
  });

  it("honours the box being unchecked — the default is an offer, not a decision", async () => {
    const { comp } = renderPrompt();
    comp.prompt(server, "Password");
    await tick();
    await userEvent.click(rememberBox());
    await userEvent.type(screen.getByTestId("secret-input"), "hunter2");
    await userEvent.click(screen.getByTestId("secret-connect"));
    expect(openTab).toHaveBeenCalledWith("s1", "Prod", "hunter2", false);
  });

  it("re-arms the default for the next server instead of remembering the last choice", async () => {
    const { comp } = renderPrompt();
    comp.prompt(server, "Password");
    await tick();
    await userEvent.click(rememberBox()); // opt out for this one server
    expect(rememberBox().checked).toBe(false);

    comp.prompt({ ...server, id: "s2", alias: "Staging" }, "Password");
    await tick();
    expect(rememberBox().checked).toBe(true);
  });
});
