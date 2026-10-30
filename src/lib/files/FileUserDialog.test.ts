import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sftpOpenAs = vi.fn();
vi.mock("../api", () => ({ sftpOpenAs: (...a: unknown[]) => sftpOpenAs(...a) }));

import FileUserDialog, { type FileUserAsk } from "./FileUserDialog.svelte";

const ask = (over: Partial<FileUserAsk> = {}): FileUserAsk => ({
  sessionId: "s1",
  user: "deploy",
  login: "boris",
  prod: false,
  ...over,
});

function open(question: FileUserAsk | null = ask()) {
  const onclose = vi.fn();
  const ondone = vi.fn();
  render(FileUserDialog, { props: { ask: question, onclose, ondone } });
  return { onclose, ondone };
}

const confirm = () => userEvent.click(screen.getByTestId("fileuser-confirm"));

beforeEach(() => {
  sftpOpenAs.mockReset();
});

describe("FileUserDialog", () => {
  it("draws nothing without a question", () => {
    open(null);
    expect(screen.queryByTestId("fileuser-confirm")).toBeNull();
  });

  it("offers no password field until sudo asks for one, and needs none where it does not", async () => {
    sftpOpenAs.mockResolvedValue(undefined);
    const { ondone } = open();
    expect(screen.queryByTestId("fileuser-password")).toBeNull();
    await confirm();
    expect(sftpOpenAs).toHaveBeenCalledWith("s1", "deploy", null);
    expect(ondone).toHaveBeenCalledTimes(1);
  });

  it("asks for the password when sudo wants it, and sends it only then", async () => {
    sftpOpenAs.mockRejectedValueOnce("sudo-password: sudo asks for a password");
    sftpOpenAs.mockResolvedValueOnce(undefined);
    const { ondone } = open();
    await confirm();
    expect(ondone).not.toHaveBeenCalled();
    expect(screen.getByTestId("fileuser-password-hint").textContent).toContain("boris");
    expect(screen.getByTestId("fileuser-confirm")).toBeDisabled();
    await userEvent.type(screen.getByTestId("fileuser-password"), "s3cret");
    await confirm();
    expect(sftpOpenAs).toHaveBeenLastCalledWith("s1", "deploy", "s3cret");
    expect(ondone).toHaveBeenCalledTimes(1);
  });

  it("a wrong password says so, clears the field and stays", async () => {
    sftpOpenAs.mockRejectedValueOnce("sudo-password: sudo asks for a password");
    sftpOpenAs.mockRejectedValueOnce("sudo-rejected: sudo did not accept the password");
    const { ondone } = open();
    await confirm();
    await userEvent.type(screen.getByTestId("fileuser-password"), "wrong");
    await confirm();
    expect(screen.getByTestId("fileuser-failure").textContent).toContain("did not accept");
    expect((screen.getByTestId("fileuser-password") as HTMLInputElement).value).toBe("");
    expect(ondone).not.toHaveBeenCalled();
  });

  it("a refusal carries what sudo said, and the way that needs no sudo", async () => {
    sftpOpenAs.mockRejectedValue("sudo-refused: plain is not in the sudoers file.");
    open();
    await confirm();
    const text = screen.getByTestId("fileuser-failure").textContent;
    expect(text).toContain("plain is not in the sudoers file.");
    expect(text).toContain("separate connection");
  });

  it("names a server with no sftp-server, and passes anything else on as it is", async () => {
    sftpOpenAs.mockRejectedValueOnce("sftp-server-missing: none");
    open();
    await confirm();
    expect(screen.getByTestId("fileuser-failure").textContent).toContain("sftp-server");
    sftpOpenAs.mockRejectedValueOnce("SFTP init failed: eof");
    await confirm();
    expect(screen.getByTestId("fileuser-failure").textContent).toBe("SFTP init failed: eof");
  });

  it("warns in red on production", () => {
    open(ask({ prod: true }));
    expect(screen.getByTestId("fileuser-prod").textContent).toContain("deploy");
  });

  it("no warning elsewhere, and cancelling opens nothing", async () => {
    const { onclose } = open();
    expect(screen.queryByTestId("fileuser-prod")).toBeNull();
    await userEvent.click(screen.getByText("Cancel"));
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(sftpOpenAs).not.toHaveBeenCalled();
  });
});
