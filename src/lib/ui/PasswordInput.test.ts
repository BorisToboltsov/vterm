import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import PasswordInput from "./PasswordInput.svelte";

describe("PasswordInput", () => {
  it("starts masked and reveals on toggle", async () => {
    render(PasswordInput, { props: { testid: "pw", value: "hunter2" } });
    const input = screen.getByTestId("pw");
    const eye = screen.getByTestId("pw-reveal");
    expect(input).toHaveAttribute("type", "password");
    expect(eye).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(eye);
    expect(input).toHaveAttribute("type", "text");
    expect(eye).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(eye);
    expect(input).toHaveAttribute("type", "password");
  });

  it("labels the toggle for its next action, in both states", async () => {
    render(PasswordInput, { props: { testid: "pw" } });
    const eye = screen.getByTestId("pw-reveal");
    expect(eye).toHaveAttribute("aria-label", "Show password");
    await userEvent.click(eye);
    expect(eye).toHaveAttribute("aria-label", "Hide password");
  });

  it("keeps the typed value across a reveal round-trip", async () => {
    render(PasswordInput, { props: { testid: "pw" } });
    const input = screen.getByTestId("pw") as HTMLInputElement;
    await userEvent.type(input, "s3cret");
    await userEvent.click(screen.getByTestId("pw-reveal"));
    expect(input.value).toBe("s3cret");
  });

  it("comes back masked on a fresh mount — reopening a dialog never shows the last secret", async () => {
    const first = render(PasswordInput, { props: { testid: "pw" } });
    await userEvent.click(screen.getByTestId("pw-reveal"));
    expect(screen.getByTestId("pw")).toHaveAttribute("type", "text");
    first.unmount();

    render(PasswordInput, { props: { testid: "pw" } });
    expect(screen.getByTestId("pw")).toHaveAttribute("type", "password");
  });

  // The AI key field binds into a sparse map (`keyDrafts[endpointId]`), so the
  // bound value is `undefined` until the user types. A `$bindable("")` fallback
  // made Svelte reject that binding outright — the settings panel crashed.
  it("accepts an undefined bound value (sparse-map call sites)", async () => {
    render(PasswordInput, { props: { testid: "pw", value: undefined } });
    const input = screen.getByTestId("pw") as HTMLInputElement;
    expect(input.value).toBe("");
    await userEvent.type(input, "k");
    expect(input.value).toBe("k");
  });

  it("is a type=button toggle so it can't submit the form it sits in", () => {
    render(PasswordInput, { props: { testid: "pw" } });
    expect(screen.getByTestId("pw-reveal")).toHaveAttribute("type", "button");
  });

  it("disables both the field and the toggle", () => {
    render(PasswordInput, { props: { testid: "pw", disabled: true } });
    expect(screen.getByTestId("pw")).toBeDisabled();
    expect(screen.getByTestId("pw-reveal")).toBeDisabled();
  });

  it("focuses itself when asked (dialogs that open straight into the field)", () => {
    render(PasswordInput, { props: { testid: "pw", autofocus: true } });
    expect(screen.getByTestId("pw")).toHaveFocus();
  });

  it("does not focus itself by default", () => {
    render(PasswordInput, { props: { testid: "pw" } });
    expect(screen.getByTestId("pw")).not.toHaveFocus();
  });
});
