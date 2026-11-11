import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Toast from "./Toast.svelte";
import {
  clearToasts,
  notifyError,
  notifyInfo,
  notifySuccess,
  toastsState,
} from "../stores/toasts.svelte";
import { journalState } from "../stores/journal.svelte";
import { MAX_TOASTS } from "../notifications/journal";

describe("Toast", () => {
  beforeEach(() => clearToasts());
  afterEach(() => clearToasts());

  it("renders queued toasts from the store", () => {
    notifyError("Something failed");
    render(Toast);
    expect(screen.getByText("Something failed")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("the dismiss button removes the toast", async () => {
    notifySuccess("Saved");
    render(Toast);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Dismiss"));
    // The store drops it immediately; the node lingers for the out-transition
    // (Phase 43) and is gone once that finishes.
    expect(toastsState.list).toHaveLength(0);
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
  });

  it("a message said again shows once, counted", () => {
    notifyError("exec channel failed", { source: "docker" });
    notifyError("exec channel failed", { source: "docker" });
    notifyError("exec channel failed", { source: "docker" });
    render(Toast);
    expect(screen.getAllByText("exec channel failed")).toHaveLength(1);
    expect(screen.getByTestId("toast-count")).toHaveTextContent("×3");
    expect(screen.getByTestId("toast-about")).toHaveTextContent("Docker");
  });

  it("no more than MAX_TOASTS stand; the rest wait under one line that opens the journal", async () => {
    for (let i = 0; i < MAX_TOASTS + 4; i++) notifyInfo(`message ${i}`);
    render(Toast);
    expect(screen.getAllByRole("status")).toHaveLength(MAX_TOASTS);
    // The newest are the ones shown.
    expect(screen.getByText(`message ${MAX_TOASTS + 3}`)).toBeInTheDocument();
    expect(screen.queryByText("message 0")).toBeNull();
    expect(screen.getByTestId("toasts-more")).toHaveTextContent("4");
    await userEvent.click(screen.getByTestId("toasts-open-journal"));
    expect(journalState.open).toBe(true);
    await userEvent.click(screen.getByTestId("toasts-hide-all"));
    expect(toastsState.list).toHaveLength(0);
  });

  it("the line is not there while every toast fits", () => {
    notifyInfo("one");
    render(Toast);
    expect(screen.queryByTestId("toasts-more")).toBeNull();
  });
});
