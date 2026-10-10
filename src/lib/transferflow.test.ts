// The one path from "these files go there" to a job of the backend (v1.12).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferSpec } from "./api";

const sftpList = vi.fn();
const localList = vi.fn();
const transferStart = vi.fn();
vi.mock("./api", () => ({
  sftpList: (...a: unknown[]) => sftpList(...a),
  localList: (...a: unknown[]) => localList(...a),
  transferStart: (...a: unknown[]) => transferStart(...a),
}));

import {
  answerReplace,
  clearReplaceQuestions,
  currentReplaceQuestion,
} from "./stores/replaceask.svelte";
import { clearToasts, toastsState } from "./stores/toasts.svelte";
import { DISK, destPath, startTransfer, type TransferRequest } from "./transferflow";

const named = (...names: string[]) => names.map((name) => ({ name }));
const web = { session: "web", local: false, label: "web-01" };
const db = { session: "db", local: false, label: "db-01" };
const mine = { session: "l1", local: true, label: "Local shell" };
const tick = () => new Promise((r) => setTimeout(r, 0));
const asked = (): TransferSpec => transferStart.mock.calls[0][0] as TransferSpec;

beforeEach(() => {
  sftpList.mockReset().mockResolvedValue([]);
  localList.mockReset().mockResolvedValue([]);
  transferStart.mockReset().mockImplementation(async (spec: TransferSpec) => spec.id);
  clearReplaceQuestions();
  clearToasts();
});

const copy = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  src: web,
  dst: db,
  sources: [
    { path: "/etc/nginx/nginx.conf", isDir: false },
    { path: "/etc/nginx/conf.d", isDir: true },
  ],
  destDir: "/srv/backup",
  ...over,
});

describe("starting a transfer", () => {
  it("asks the destination's server which names it holds, then starts the job", async () => {
    const id = await startTransfer(copy());
    expect(sftpList).toHaveBeenCalledWith("db", "/srv/backup");
    expect(localList).not.toHaveBeenCalled();
    expect(asked()).toMatchObject({
      src: web,
      dst: db,
      destDir: "/srv/backup",
      items: [
        { from: "/etc/nginx/nginx.conf", to: "/srv/backup/nginx.conf", isDir: false, replace: false },
        { from: "/etc/nginx/conf.d", to: "/srv/backup/conf.d", isDir: true, replace: false },
      ],
    });
    expect(id).toBe(asked().id);
    expect(currentReplaceQuestion()).toBeNull();
  });

  it("lists this machine's folder when the files land on it", async () => {
    localList.mockResolvedValue(named("nginx.conf"));
    const started = startTransfer(copy({ dst: mine, destDir: "/Users/me/dl" }));
    await tick();
    expect(localList).toHaveBeenCalledWith("/Users/me/dl");
    expect(sftpList).not.toHaveBeenCalled();
    // The name is taken there: nothing starts until the user answers.
    expect(currentReplaceQuestion()).toMatchObject({
      dest: "/Users/me/dl",
      names: ["nginx.conf"],
      canSkip: true,
    });
    expect(transferStart).not.toHaveBeenCalled();
    answerReplace("replace");
    await started;
    expect(asked().items).toEqual([
      { from: "/etc/nginx/nginx.conf", to: "/Users/me/dl/nginx.conf", isDir: false, replace: true },
      { from: "/etc/nginx/conf.d", to: "/Users/me/dl/conf.d", isDir: true, replace: false },
    ]);
  });

  it("skip leaves the taken names where they are — a folder among them", async () => {
    sftpList.mockResolvedValue(named("conf.d"));
    const started = startTransfer(copy());
    await tick();
    answerReplace("skip");
    await started;
    expect(asked().items).toEqual([
      { from: "/etc/nginx/nginx.conf", to: "/srv/backup/nginx.conf", isDir: false, replace: false },
    ]);
  });

  it("cancel, or nothing left to send, starts no job", async () => {
    sftpList.mockResolvedValue(named("nginx.conf", "conf.d"));
    const cancelled = startTransfer(copy());
    await tick();
    expect(currentReplaceQuestion()?.canSkip).toBe(false);
    answerReplace("cancel");
    expect(await cancelled).toBeNull();
    expect(transferStart).not.toHaveBeenCalled();
    expect(await startTransfer(copy({ sources: [] }))).toBeNull();
    expect(sftpList).toHaveBeenCalledTimes(1);
  });

  it("a folder that cannot be read is asked about as unknown, not taken for empty", async () => {
    sftpList.mockRejectedValue(new Error("permission denied"));
    const started = startTransfer(copy());
    await tick();
    expect(currentReplaceQuestion()).toMatchObject({ names: null, canSkip: false });
    answerReplace("replace");
    await started;
    expect(asked().items.every((i) => i.replace)).toBe(true);
  });

  it("what a system dialog agreed to is neither listed nor asked about", async () => {
    await startTransfer({
      src: web,
      dst: DISK,
      sources: [{ path: "/etc/hosts", isDir: false, to: "/Users/me/hosts.txt" }],
      destDir: "/Users/me",
      agreed: true,
    });
    expect(sftpList).not.toHaveBeenCalled();
    expect(localList).not.toHaveBeenCalled();
    // The dialog named the file: it lands under that name, not under its own.
    expect(asked().items).toEqual([
      { from: "/etc/hosts", to: "/Users/me/hosts.txt", isDir: false, replace: true },
    ]);
  });

  it("two transfers started together are asked about one after the other", async () => {
    sftpList.mockResolvedValue(named("nginx.conf"));
    const first = startTransfer(copy({ destDir: "/one" }));
    const second = startTransfer(copy({ destDir: "/two" }));
    await tick();
    expect(currentReplaceQuestion()?.dest).toBe("/one");
    answerReplace("cancel");
    expect(currentReplaceQuestion()?.dest).toBe("/two");
    answerReplace("replace");
    expect(await first).toBeNull();
    expect(await second).not.toBeNull();
    expect(transferStart).toHaveBeenCalledTimes(1);
    expect(asked().destDir).toBe("/two");
  });

  it("a job the backend refuses is said so, and is no job", async () => {
    transferStart.mockRejectedValue("no active session");
    expect(await startTransfer(copy())).toBeNull();
    expect(toastsState.list.map((x) => x.message)).toEqual(["no active session"]);
  });
});

describe("a destination path", () => {
  it("is POSIX on a server, whatever this machine is", () => {
    expect(destPath("/srv/app", "a.conf", false)).toBe("/srv/app/a.conf");
    expect(destPath("/", "a", false)).toBe("/a");
    expect(destPath("/srv/app/", "a", false)).toBe("/srv/app/a");
  });

  it("uses this machine's separator on this machine", () => {
    expect(destPath("/Users/me", "a.txt", true)).toBe("/Users/me/a.txt");
    expect(destPath("C:\\Users\\me", "a.txt", true)).toBe("C:\\Users\\me\\a.txt");
  });
});
