import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AFTER_ENTER_MS, SHELL_USER_POLL_MS } from "./fileuser";

const api = vi.hoisted(() => {
  const submit = new Map<string, () => void>();
  return {
    submit,
    sftpList: vi.fn(async () => []),
    sftpHome: vi.fn(async () => "/home/boris"),
    shellUser: vi.fn(),
    sftpOpenAs: vi.fn(async () => {}),
    sftpOpenOwn: vi.fn(async () => {}),
    onSessionSubmit: vi.fn((id: string, cb: () => void) => {
      submit.set(id, cb);
      return () => submit.delete(id);
    }),
  };
});
vi.mock("../api", () => ({ ...api, sftpConnect: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import SftpPanel from "./SftpPanel.svelte";

const report = (shell: string | null, files = "boris") => ({ files, login: "boris", shell, hidden: false });

async function connected(props: Record<string, unknown> = {}) {
  const view = render(SftpPanel, { props: { embedded: true, sessionId: "s1", sessionReady: true, ...props } });
  await userEvent.click(screen.getByText(/connect/i));
  await waitFor(() => expect(api.sftpList).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.shellUser.mockResolvedValue(report("boris"));
});
afterEach(() => vi.useRealTimers());

describe("SftpPanel: whom the files are under", () => {
  it("says nothing while files and terminal agree", async () => {
    await connected();
    await waitFor(() => expect(api.shellUser).toHaveBeenCalledWith("s1"));
    expect(screen.queryByTestId("sftp-fileuser")).toBeNull();
  });

  it("after su: says so, and takes the user on only through the question", async () => {
    api.shellUser.mockResolvedValue(report("deploy"));
    await connected();
    await screen.findByTestId("sftp-fileuser");
    expect(screen.getByTestId("sftp-fileuser-text").textContent).toContain("deploy");
    expect(api.sftpOpenAs).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("sftp-fileuser-open"));
    expect(api.sftpOpenAs).not.toHaveBeenCalled();
    api.sftpList.mockClear();
    api.shellUser.mockResolvedValue(report("deploy", "deploy"));
    await userEvent.click(screen.getByTestId("fileuser-confirm"));
    expect(api.sftpOpenAs).toHaveBeenCalledWith("s1", "deploy", null);
    // Under the new user the listing is another one, and so is what the row says.
    await waitFor(() => expect(api.sftpList).toHaveBeenCalled());
    await screen.findByTestId("sftp-fileuser-back");
    expect(screen.queryByTestId("sftp-fileuser-open")).toBeNull();
  });

  it("going back needs no question", async () => {
    api.shellUser.mockResolvedValue(report("boris", "deploy"));
    await connected();
    api.sftpList.mockClear();
    api.shellUser.mockResolvedValue(report("boris"));
    await userEvent.click(await screen.findByTestId("sftp-fileuser-back"));
    expect(api.sftpOpenOwn).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(screen.queryByTestId("sftp-fileuser")).toBeNull());
    expect(api.sftpList).toHaveBeenCalled();
  });

  it("a failed answer says nothing: an unknown is no claim", async () => {
    api.shellUser.mockRejectedValue("exec channel failed");
    await connected();
    await waitFor(() => expect(api.shellUser).toHaveBeenCalled());
    expect(screen.queryByTestId("sftp-fileuser")).toBeNull();
  });

  it("asks after an Enter and now and then, and only while on screen", async () => {
    // From before the mount: the panel's interval has to be a fake one too.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await connected();
    await waitFor(() => expect(api.shellUser).toHaveBeenCalled());
    api.shellUser.mockClear();

    api.submit.get("s1")?.();
    api.submit.get("s1")?.();
    await vi.advanceTimersByTimeAsync(AFTER_ENTER_MS);
    // Two Enters in a row (`su`, its password) are one question.
    expect(api.shellUser).toHaveBeenCalledTimes(1);

    api.shellUser.mockClear();
    await vi.advanceTimersByTimeAsync(SHELL_USER_POLL_MS);
    expect(api.shellUser).toHaveBeenCalledTimes(1);

    api.shellUser.mockClear();
    await view.rerender({ embedded: true, sessionId: "s1", sessionReady: true, visible: false });
    await vi.advanceTimersByTimeAsync(SHELL_USER_POLL_MS * 2);
    expect(api.shellUser).not.toHaveBeenCalled();
    expect(api.submit.has("s1")).toBe(false);
  });

  it("does not ask without a session", async () => {
    render(SftpPanel, { props: { embedded: true, sessionId: "s1", sessionReady: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.shellUser).not.toHaveBeenCalled();
  });
});
