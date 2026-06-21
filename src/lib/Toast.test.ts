import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Toast from "./Toast.svelte";
import {
  clearToasts,
  notifyError,
  notifySuccess,
  toastsState,
} from "./stores/toasts.svelte";

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
    expect(screen.queryByText("Saved")).toBeNull();
    expect(toastsState.list).toHaveLength(0);
  });
});
