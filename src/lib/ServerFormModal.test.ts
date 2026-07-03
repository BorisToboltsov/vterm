import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import ServerFormModal from "./ServerFormModal.svelte";
import type { ServerProfile } from "./types";

// The form persists through `./api`; stub it so no real backend is touched and we
// can assert whether a save was actually attempted.
const addServer = vi.fn();
const updateServer = vi.fn();
vi.mock("./api", () => ({
  addServer: (...args: unknown[]) => addServer(...args),
  updateServer: (...args: unknown[]) => updateServer(...args),
  forgetSecrets: vi.fn(),
  pickKeyFile: vi.fn(),
}));

function renderForm() {
  const onsaved = vi.fn();
  const onforgotten = vi.fn();
  const result = render(ServerFormModal, { props: { onsaved, onforgotten } });
  // Exported functions live on the component instance in Svelte 5 runes mode.
  const comp = result.component as unknown as {
    openAdd: (g?: string) => void;
    openEdit: (s: ServerProfile) => void;
  };
  return { ...result, comp, onsaved, onforgotten };
}

describe("ServerFormModal validation", () => {
  beforeEach(() => {
    addServer.mockReset();
    updateServer.mockReset();
    addServer.mockResolvedValue({ id: "s1", alias: "Prod" });
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
});
