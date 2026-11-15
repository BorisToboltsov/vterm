import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import LoginPicker, { type LoginAsk } from "./LoginPicker.svelte";
import type { ServerProfile } from "../types";

const server = {
  id: "srv",
  alias: "web-01",
  host: "10.0.4.21",
  port: 22,
  username: "root",
  authMethod: "key",
  keyPath: "/k",
  hasSavedPassword: false,
  hasSavedSudo: false,
  logins: [
    { id: "dep", username: "deploy", authMethod: "password", keyPath: null, hasSavedPassword: true, hasSavedSudo: false },
    { id: "adm", username: "admin", authMethod: "password", keyPath: null, hasSavedPassword: false, hasSavedSudo: false },
  ],
  defaultLogin: "dep",
  askLogin: false,
} as unknown as ServerProfile;

function open(ask: LoginAsk | null = { server }) {
  const onpick = vi.fn();
  const oncancel = vi.fn();
  render(LoginPicker, { props: { ask, onpick, oncancel } });
  return { onpick, oncancel };
}

describe("LoginPicker", () => {
  it("draws nothing without a question", () => {
    open(null);
    expect(screen.queryByTestId("login-picker")).toBeNull();
  });

  it("lists every login numbered, the default marked and in focus; Enter connects with it", async () => {
    const { onpick } = open();
    const rows = screen.getAllByTestId("login-pick");
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "1 root key",
      "2 deploy password · keychain",
      "3 admin password",
    ]);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "Enter" });
    expect(onpick).toHaveBeenCalledWith({ id: "dep" }, false);
  });

  it("a digit picks its login at once; arrows move", async () => {
    const { onpick } = open();
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "3" });
    expect(onpick).toHaveBeenLastCalledWith({ id: "adm" }, false);
    // From the default (2) one up is the first login.
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "ArrowUp" });
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "Enter" });
    expect(onpick).toHaveBeenLastCalledWith({ id: "" }, false);
    // Up again wraps round to «Other»: with nothing typed, Enter connects nobody.
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "ArrowUp" });
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "Enter" });
    expect(onpick).toHaveBeenCalledTimes(2);
  });

  it("«Other» is a user for this connection — kept in the profile only when asked", async () => {
    const { onpick } = open({ server, other: true });
    const other = screen.getByTestId("login-other");
    expect(screen.getByTestId("login-pick-connect")).toBeDisabled();
    await userEvent.type(other, "ops");
    // Digits typed into the name are the name, not a pick.
    await userEvent.type(other, "2");
    await userEvent.click(screen.getByTestId("login-other-add"));
    await userEvent.click(screen.getByTestId("login-pick-connect"));
    expect(onpick).toHaveBeenCalledExactlyOnceWith({ once: "ops2" }, true);
  });

  it("a name ssh would not take is not connected with", async () => {
    const { onpick } = open({ server, other: true });
    await userEvent.type(screen.getByTestId("login-other"), "a b");
    expect(screen.getByTestId("login-pick-connect")).toBeDisabled();
    await fireEvent.keyDown(screen.getByTestId("login-picker"), { key: "Enter" });
    expect(onpick).not.toHaveBeenCalled();
  });
});
