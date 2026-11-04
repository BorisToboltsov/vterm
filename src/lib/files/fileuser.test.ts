import { describe, expect, it } from "vitest";
import { fileUserFailure, fileUserRow, type ShellUserReport } from "./fileuser";

const report = (over: Partial<ShellUserReport> = {}): ShellUserReport => ({
  files: "boris",
  login: "boris",
  shell: "boris",
  hidden: false,
  ...over,
});

describe("fileUserRow", () => {
  it("says nothing while files and terminal agree under the login user", () => {
    expect(fileUserRow(report())).toBeNull();
  });

  it("says nothing without an answer: an unknown is no reason to speak", () => {
    expect(fileUserRow(null)).toBeNull();
    expect(fileUserRow(report({ files: null, login: null, shell: null }))).toBeNull();
    expect(fileUserRow(report({ shell: null }))).toBeNull();
  });

  it("after su: names both and offers to take the terminal's user on", () => {
    expect(fileUserRow(report({ shell: "deploy" }))).toEqual({
      files: "boris",
      shell: "deploy",
      hidden: false,
      openAs: "deploy",
      back: null,
    });
  });

  it("once taken on: says whom the files are under and offers the way back", () => {
    expect(fileUserRow(report({ files: "deploy", shell: "deploy" }))).toEqual({
      files: "deploy",
      shell: null,
      hidden: false,
      openAs: null,
      back: "boris",
    });
  });

  it("after exit from su: the terminal is the login user, so the only way is back", () => {
    expect(fileUserRow(report({ files: "deploy", shell: "boris" }))).toEqual({
      files: "deploy",
      shell: "boris",
      hidden: false,
      openAs: null,
      back: "boris",
    });
  });

  it("su again to a third user: both ways stay open", () => {
    expect(fileUserRow(report({ files: "deploy", shell: "root" }))).toEqual({
      files: "deploy",
      shell: "root",
      hidden: false,
      openAs: "root",
      back: "boris",
    });
  });

  it("a hidden user is said to be there and cannot be taken on: there is no name", () => {
    expect(fileUserRow(report({ shell: null, hidden: true }))).toEqual({
      files: "boris",
      shell: null,
      hidden: true,
      openAs: null,
      back: null,
    });
  });

  it("taken on, with the terminal unknown: still says so, still offers the way back", () => {
    expect(fileUserRow(report({ files: "deploy", shell: null }))).toMatchObject({
      files: "deploy",
      shell: null,
      back: "boris",
    });
  });

  it("never offers to take on the login user: that is the way back", () => {
    const row = fileUserRow(report({ files: "deploy", shell: "boris" }));
    expect(row?.openAs).toBeNull();
  });
});

describe("fileUserFailure", () => {
  it("reads each marker of the backend", () => {
    expect(fileUserFailure("sudo-password: sudo asks for a password")).toEqual({ kind: "needPassword" });
    expect(fileUserFailure("sudo-rejected: sudo did not accept the password")).toEqual({ kind: "wrongPassword" });
    expect(fileUserFailure("sudo-refused: plain is not in the sudoers file.")).toEqual({
      kind: "refused",
      reason: "plain is not in the sudoers file.",
    });
    expect(fileUserFailure("sftp-server-missing: no sftp-server program found")).toEqual({ kind: "noServer" });
  });

  it("gives anything else as it was said", () => {
    expect(fileUserFailure("SFTP init failed: eof")).toEqual({ kind: "other", text: "SFTP init failed: eof" });
    expect(fileUserFailure(new Error("x"))).toEqual({ kind: "other", text: "Error: x" });
  });
});
