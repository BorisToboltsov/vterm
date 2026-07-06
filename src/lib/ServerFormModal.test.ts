import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import ServerFormModal from "./ServerFormModal.svelte";
import type { ServerProfile } from "./types";

// The form persists through `./api`; stub it so no real backend is touched and we
// can assert whether a save was actually attempted.
const addServer = vi.fn();
const updateServer = vi.fn();
const saveProxySecret = vi.fn();
vi.mock("./api", () => ({
  addServer: (...args: unknown[]) => addServer(...args),
  updateServer: (...args: unknown[]) => updateServer(...args),
  forgetSecrets: vi.fn(),
  pickKeyFile: vi.fn(),
  saveProxySecret: (...args: unknown[]) => saveProxySecret(...args),
}));

function renderForm() {
  const onsaved = vi.fn();
  const onforgotten = vi.fn();
  const result = render(ServerFormModal, { props: { onsaved, onforgotten } });
  // Exported functions live on the component instance in Svelte 5 runes mode.
  const comp = result.component as unknown as {
    openAdd: (g?: string) => void;
    openEdit: (s: ServerProfile) => void;
    openDuplicate: (s: ServerProfile) => void;
  };
  return { ...result, comp, onsaved, onforgotten };
}

function server(p: Partial<ServerProfile> & { id: string; alias: string }): ServerProfile {
  return {
    host: "10.0.0.1",
    port: 2222,
    username: "root",
    authMethod: "password",
    keyPath: null,
    hasSavedPassword: true,
    group: "Prod",
    tags: ["web", "eu"],
    autoRecord: true,
    noAi: true,
    chatPromptId: null,
    execMode: null,
    proxy: null,
    ...p,
  };
}

describe("ServerFormModal validation", () => {
  beforeEach(() => {
    addServer.mockReset();
    updateServer.mockReset();
    saveProxySecret.mockReset();
    addServer.mockResolvedValue({ id: "s1", alias: "Prod" });
    saveProxySecret.mockResolvedValue(undefined);
  });

  it("highlights empty required fields on submit instead of silently doing nothing", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    // Nothing invalid is shown before the first submit attempt.
    expect(screen.queryByText("This field is required")).toBeNull();

    await userEvent.click(screen.getByTestId("save-server"));

    // All three required fields (alias/host/username) light up, plus a summary.
    expect(screen.getAllByText("This field is required")).toHaveLength(3);
    expect(screen.getByText("Fill in the required fields")).toBeInTheDocument();
    expect(screen.getByTestId("field-alias")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("field-host")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("field-username")).toHaveAttribute("aria-invalid", "true");
    // No save was attempted.
    expect(addServer).not.toHaveBeenCalled();
  });

  it("clears a field's error as soon as it is filled", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.click(screen.getByTestId("save-server"));
    expect(screen.getAllByText("This field is required")).toHaveLength(3);

    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    // Alias error clears; host + username still flagged.
    expect(screen.getAllByText("This field is required")).toHaveLength(2);
    expect(screen.getByTestId("field-alias")).toHaveAttribute("aria-invalid", "false");
  });

  it("whitespace-only values do not satisfy a required field", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.type(screen.getByTestId("field-alias"), "   ");
    await userEvent.type(screen.getByTestId("field-host"), "10.0.0.1");
    await userEvent.type(screen.getByTestId("field-username"), "root");
    await userEvent.click(screen.getByTestId("save-server"));

    expect(screen.getByTestId("field-alias")).toHaveAttribute("aria-invalid", "true");
    expect(addServer).not.toHaveBeenCalled();
  });

  it("rejects a malformed host/IP with a distinct message", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    await userEvent.type(screen.getByTestId("field-host"), "256.300.1.1");
    await userEvent.type(screen.getByTestId("field-username"), "root");
    await userEvent.click(screen.getByTestId("save-server"));

    expect(screen.getByText("Enter a valid host name or IP address")).toBeInTheDocument();
    expect(screen.getByTestId("field-host")).toHaveAttribute("aria-invalid", "true");
    expect(addServer).not.toHaveBeenCalled();

    // Fixing it to a valid host clears the error and lets the save through.
    await userEvent.clear(screen.getByTestId("field-host"));
    await userEvent.type(screen.getByTestId("field-host"), "example.com");
    expect(screen.queryByText("Enter a valid host name or IP address")).toBeNull();
    await userEvent.click(screen.getByTestId("save-server"));
    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({ host: "example.com" }));
  });

  it("shows the required message (not the invalid one) when host is left empty", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    await userEvent.type(screen.getByTestId("field-username"), "root");
    await userEvent.click(screen.getByTestId("save-server"));

    expect(screen.getByTestId("field-host")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Enter a valid host name or IP address")).toBeNull();
    // Alias/host/username all empty-required → 2 remain empty (alias & username
    // are filled here, so only host); assert host shows the required copy.
    expect(screen.getAllByText("This field is required").length).toBeGreaterThanOrEqual(1);
  });

  it("blocks save when the port is cleared (would send null to a u16 backend)", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    await userEvent.type(screen.getByTestId("field-host"), "10.0.0.1");
    await userEvent.type(screen.getByTestId("field-username"), "root");
    await userEvent.clear(screen.getByTestId("field-port"));
    await userEvent.click(screen.getByTestId("save-server"));

    expect(screen.getByText("Port must be between 1 and 65535")).toBeInTheDocument();
    expect(screen.getByTestId("field-port")).toHaveAttribute("aria-invalid", "true");
    expect(addServer).not.toHaveBeenCalled();

    // Re-typing a valid port clears the error and lets the save through.
    await userEvent.type(screen.getByTestId("field-port"), "2222");
    expect(screen.queryByText("Port must be between 1 and 65535")).toBeNull();
    await userEvent.click(screen.getByTestId("save-server"));
    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({ port: 2222 }));
  });

  it("rejects an out-of-range port", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    await userEvent.type(screen.getByTestId("field-host"), "10.0.0.1");
    await userEvent.type(screen.getByTestId("field-username"), "root");
    await userEvent.clear(screen.getByTestId("field-port"));
    await userEvent.type(screen.getByTestId("field-port"), "99999");
    await userEvent.click(screen.getByTestId("save-server"));

    expect(screen.getByTestId("field-port")).toHaveAttribute("aria-invalid", "true");
    expect(addServer).not.toHaveBeenCalled();
  });

  it("submits and saves once all required fields are valid", async () => {
    const { comp, onsaved } = renderForm();
    comp.openAdd();
    await tick();

    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    await userEvent.type(screen.getByTestId("field-host"), "10.0.0.1");
    await userEvent.type(screen.getByTestId("field-username"), "root");
    await userEvent.click(screen.getByTestId("save-server"));

    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(addServer).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "Prod", host: "10.0.0.1", username: "root" }),
    );
    expect(onsaved).toHaveBeenCalledWith(expect.anything(), "add");
    expect(screen.queryByText("This field is required")).toBeNull();
  });

  it("re-opening the form starts without stale validation errors", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();
    await userEvent.click(screen.getByTestId("save-server"));
    expect(screen.getAllByText("This field is required")).toHaveLength(3);

    comp.openAdd();
    await tick();
    expect(screen.queryByText("This field is required")).toBeNull();
  });

  it("lays out two columns and folds hints into info tooltips (Phase 20.17)", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();

    // Both group headings are present (Connection | Recording & AI).
    expect(screen.getByText("Connection")).toBeInTheDocument();
    expect(screen.getByText("Recording & AI")).toBeInTheDocument();

    // The auto-record hint is no longer a paragraph — it's a focusable info button
    // whose accessible name carries the text, with a live tooltip on hover/focus.
    const hint = "Start recording automatically when connecting (e.g. production servers).";
    expect(screen.queryByText(hint)).toBeNull();
    const trigger = screen.getByRole("button", { name: hint });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent(hint);
    await fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("ServerFormModal proxy", () => {
  beforeEach(() => {
    addServer.mockReset();
    updateServer.mockReset();
    saveProxySecret.mockReset();
    addServer.mockResolvedValue({ id: "s1", alias: "Prod" });
    saveProxySecret.mockResolvedValue(undefined);
  });

  async function fillRequired() {
    await userEvent.type(screen.getByTestId("field-alias"), "Prod");
    await userEvent.type(screen.getByTestId("field-host"), "10.0.0.1");
    await userEvent.type(screen.getByTestId("field-username"), "root");
  }

  it("is a direct connection by default — no proxy fields, no proxy in payload", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();
    expect(screen.queryByTestId("proxy-host")).toBeNull();
    await fillRequired();
    await userEvent.click(screen.getByTestId("save-server"));
    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({ proxy: null }));
  });

  it("sends the jump-host proxy and stores its secret in the keychain", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();
    await fillRequired();
    await userEvent.click(screen.getByTestId("server-use-proxy"));
    await userEvent.type(screen.getByTestId("proxy-host"), "bastion.corp");
    await userEvent.type(screen.getByTestId("proxy-username"), "jump");
    await userEvent.type(screen.getByTestId("proxy-secret"), "s3cret");
    await userEvent.click(screen.getByTestId("save-server"));

    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: expect.objectContaining({
          kind: "jump",
          host: "bastion.corp",
          username: "jump",
          authMethod: "password",
          hasSavedPassword: true,
        }),
      }),
    );
    // The typed secret is persisted separately to the keychain (never on the profile).
    expect(saveProxySecret).toHaveBeenCalledWith("s1", "s3cret");
  });

  it("sends a SOCKS5 proxy with optional basic auth and no SSH-only fields", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();
    await fillRequired();
    await userEvent.click(screen.getByTestId("server-use-proxy"));
    await userEvent.selectOptions(screen.getByTestId("proxy-kind"), "socks5");
    // SOCKS5 shows optional basic auth (hint), not the SSH auth-method radios.
    expect(
      screen.getByRole("button", {
        name: "Optional — only if the proxy requires authentication.",
      }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("proxy-host"), "socks.corp");
    await userEvent.clear(screen.getByTestId("proxy-port"));
    await userEvent.type(screen.getByTestId("proxy-port"), "1080");
    await userEvent.type(screen.getByTestId("proxy-username"), "u");
    await userEvent.type(screen.getByTestId("proxy-secret"), "p");
    await userEvent.click(screen.getByTestId("save-server"));

    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: expect.objectContaining({
          kind: "socks5",
          host: "socks.corp",
          port: 1080,
          username: "u",
          hasSavedPassword: true,
        }),
      }),
    );
    expect(saveProxySecret).toHaveBeenCalledWith("s1", "p");
  });

  it("blocks save when the proxy is enabled but its host is invalid", async () => {
    const { comp } = renderForm();
    comp.openAdd();
    await tick();
    await fillRequired();
    await userEvent.click(screen.getByTestId("server-use-proxy"));
    // Leave proxy host empty and username empty → validation blocks the save.
    await userEvent.click(screen.getByTestId("save-server"));
    expect(screen.getByTestId("proxy-host")).toHaveAttribute("aria-invalid", "true");
    expect(addServer).not.toHaveBeenCalled();
  });
});

describe("ServerFormModal duplicate", () => {
  beforeEach(() => {
    addServer.mockReset();
    updateServer.mockReset();
    addServer.mockResolvedValue({ id: "s2", alias: "Web (copy)" });
  });

  it("opens pre-filled from the source with a '(copy)' alias and adds a new server", async () => {
    const { comp, onsaved } = renderForm();
    comp.openDuplicate(server({ id: "orig", alias: "Web" }));
    await tick();

    // Fields carried over from the source; alias gets the copy suffix.
    expect(screen.getByTestId("field-alias")).toHaveValue("Web (copy)");
    expect(screen.getByTestId("field-host")).toHaveValue("10.0.0.1");
    expect(screen.getByTestId("field-username")).toHaveValue("root");
    expect(screen.getByTestId("field-port")).toHaveValue(2222);

    await userEvent.click(screen.getByTestId("save-server"));

    // It's an add (new id), not an update — and the copied secret is NOT sent.
    await waitFor(() => expect(addServer).toHaveBeenCalledOnce());
    expect(updateServer).not.toHaveBeenCalled();
    const payload = addServer.mock.calls[0][0];
    expect(payload).toMatchObject({
      alias: "Web (copy)",
      host: "10.0.0.1",
      port: 2222,
      username: "root",
      group: "Prod",
      tags: ["web", "eu"],
      autoRecord: true,
      noAi: true,
    });
    expect(payload).not.toHaveProperty("hasSavedPassword");
    expect(onsaved).toHaveBeenCalledWith(expect.anything(), "add");
  });
});
