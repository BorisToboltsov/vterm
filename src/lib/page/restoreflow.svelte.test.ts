import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keeper = vi.hoisted(() => ({
  takeSavedTabs: vi.fn((): { main: unknown; others: unknown[] } | null => null),
  startSavingTabs: vi.fn(),
}));
vi.mock("../stores/tabrestore.svelte", () => keeper);
const api = vi.hoisted(() => ({
  connectPlan: vi.fn(async (_id: string) => ({ needsSecret: false, secretLabel: "Password" })),
}));
vi.mock("../api", () => api);
const toasts = vi.hoisted(() => ({ notifyInfo: vi.fn(), notifyError: vi.fn() }));
vi.mock("../stores/toasts.svelte", () => toasts);

import { createRestoreFlow, type RestoreFlow } from "./restoreflow.svelte";
import { settings } from "../settings.svelte";
import { addTab, emptyLayout } from "../splitlayout";
import { findTab, NOT_CONNECTED, resetTabs, tabsState, type Tab } from "../stores/tabs.svelte";
import { savedWindow } from "../tabrestore";
import type { ServerProfile } from "../types";

const tab = (sessionId: string, over: Partial<Tab> = {}): Tab => ({
  sessionId,
  kind: "ssh",
  serverId: `srv-${sessionId}`,
  alias: sessionId,
  secret: null,
  remember: false,
  status: "Connected",
  gen: 0,
  ...over,
});

const ATTACH = { kind: "container" as const, name: "nginx", argv: ["docker", "exec", "-it", "nginx", "sh"] };

/** A slot as the window wrote it, after the trip through JSON. */
const slot = (tabs: Tab[]): unknown => {
  let layout = emptyLayout();
  for (const t of tabs) layout = addTab(layout, t.sessionId);
  return JSON.parse(JSON.stringify(savedWindow(tabs, layout)));
};

const server = (id: string, over: Partial<ServerProfile> = {}): ServerProfile =>
  ({ id, alias: `alias-${id}`, prod: false, ...over }) as ServerProfile;

/** Let the keychain answers (connectPlan) arrive. */
const settled = () => new Promise((r) => setTimeout(r, 0));

function harness(servers: ServerProfile[]) {
  const askSecret = vi.fn();
  let flow!: RestoreFlow;
  const cleanup = $effect.root(() => {
    flow = createRestoreFlow({ servers: () => servers, askSecret });
  });
  flushSync();
  return { flow, askSecret, cleanup };
}

const status = (id: string) => {
  const t = findTab(id);
  return t ? { waiting: t.waiting ?? null, status: t.status, gen: t.gen } : null;
};

const modeBefore = settings.restoreTabs;
beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  keeper.takeSavedTabs.mockReturnValue(null);
});
afterEach(() => {
  settings.restoreTabs = modeBefore;
  resetTabs();
});

describe("restore flow: bringing the tabs back", () => {
  it("with nothing saved it opens nothing, and the slot starts being written", () => {
    const { flow, cleanup } = harness([]);
    flow.restore();
    expect(tabsState.list).toEqual([]);
    expect(keeper.startSavingTabs).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("'by hand' brings every tab back waiting, connects nothing, and names the servers gone", () => {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("a"), tab("gone"), tab("l", { kind: "local" })]), others: [] });
    const { flow, cleanup } = harness([server("srv-a")]);
    flow.restore();
    expect(status("a")).toEqual({ waiting: "manual", status: NOT_CONNECTED, gen: 0 });
    expect(status("l")).toEqual({ waiting: "manual", status: NOT_CONNECTED, gen: 0 });
    expect(status("gone")).toBeNull();
    expect(toasts.notifyInfo).toHaveBeenCalledTimes(1);
    expect(api.connectPlan).not.toHaveBeenCalled();
    cleanup();
  });

  it("'connect' opens only what the policy allows: a local shell and a server that asks nothing", async () => {
    settings.restoreTabs = "connect";
    keeper.takeSavedTabs.mockReturnValue({
      main: slot([
        tab("l", { kind: "local" }),
        tab("web"),
        tab("pw"),
        tab("prod"),
        tab("box", { attach: ATTACH }),
      ]),
      others: [],
    });
    api.connectPlan.mockImplementation(async (id: string) => ({ needsSecret: id === "srv-pw", secretLabel: "Password" }));
    const { flow, cleanup } = harness([
      server("srv-web"),
      server("srv-pw"),
      server("srv-prod", { prod: true }),
      server("srv-box"),
    ]);
    flow.restore();
    // A local shell connects as it mounts; a server is asked whether it wants a secret first.
    expect(status("l")).toEqual({ waiting: null, status: "connecting", gen: 0 });
    expect(status("web")?.waiting).toBe("checking");
    expect(status("prod")?.waiting).toBe("prod");
    expect(status("box")?.waiting).toBe("attach");
    await settled();
    expect(status("web")).toEqual({ waiting: null, status: "Connecting…", gen: 1 });
    expect(status("pw")?.waiting).toBe("secret");
    // A production server and a container are never asked about, let alone dialled.
    expect(api.connectPlan.mock.calls.map(([id]) => id).sort()).toEqual(["srv-pw", "srv-web"]);
    cleanup();
  });

  it("a server whose keychain could not be asked waits for its button", async () => {
    settings.restoreTabs = "connect";
    keeper.takeSavedTabs.mockReturnValue({ main: slot([tab("web")]), others: [] });
    api.connectPlan.mockRejectedValueOnce(new Error("no keychain"));
    const { flow, cleanup } = harness([server("srv-web")]);
    flow.restore();
    await settled();
    expect(status("web")?.waiting).toBe("manual");
    cleanup();
  });

  it("runs once, and starts writing the slot even when the restore throws", () => {
    keeper.takeSavedTabs.mockImplementationOnce(() => {
      throw new Error("bad storage");
    });
    const { flow, cleanup } = harness([]);
    expect(() => flow.restore()).toThrow("bad storage");
    expect(keeper.startSavingTabs).toHaveBeenCalledTimes(1);
    flow.restore();
    expect(keeper.takeSavedTabs).toHaveBeenCalledTimes(1);
    expect(keeper.startSavingTabs).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("restore flow: opening a waiting tab", () => {
  function restoredManually(tabs: Tab[], servers: ServerProfile[]) {
    settings.restoreTabs = "manual";
    keeper.takeSavedTabs.mockReturnValue({ main: slot(tabs), others: [] });
    const h = harness(servers);
    h.flow.restore();
    return h;
  }

  it("its button connects it in place, asking for the secret where its server takes one", async () => {
    api.connectPlan.mockImplementation(async (id: string) => ({ needsSecret: id === "srv-pw", secretLabel: "Passphrase" }));
    const { flow, askSecret, cleanup } = restoredManually(
      [tab("web"), tab("pw"), tab("l", { kind: "local" })],
      [server("srv-web"), server("srv-pw")],
    );
    await flow.wake("web");
    await flow.wake("pw");
    await flow.wake("l");
    expect(status("web")).toEqual({ waiting: null, status: "Connecting…", gen: 1 });
    expect(status("l")).toMatchObject({ waiting: null, gen: 1 });
    expect(status("pw")?.waiting).toBe("manual");
    expect(askSecret).toHaveBeenCalledWith(expect.objectContaining({ id: "srv-pw" }), "Passphrase", "pw");
    // A local shell needs no question about a secret.
    expect(api.connectPlan.mock.calls.map(([id]) => id)).toEqual(["srv-web", "srv-pw"]);
    cleanup();
  });

  it("a tab that is not waiting, or still being checked, is left alone; a failure is said", async () => {
    api.connectPlan.mockRejectedValueOnce(new Error("unknown server"));
    const { flow, cleanup } = restoredManually([tab("web")], [server("srv-web")]);
    await flow.wake("web");
    expect(toasts.notifyError).toHaveBeenCalledTimes(1);
    expect(status("web")?.waiting).toBe("manual");
    await flow.wake("nobody");
    expect(api.connectPlan).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("⌘K opens every tab that may open without a question, and the rest say why", async () => {
    api.connectPlan.mockImplementation(async (id: string) => ({ needsSecret: id === "srv-pw", secretLabel: "Password" }));
    const { flow, cleanup } = restoredManually(
      [tab("l", { kind: "local" }), tab("web"), tab("pw"), tab("prod"), tab("box", { attach: ATTACH })],
      [server("srv-web"), server("srv-pw"), server("srv-prod", { prod: true }), server("srv-box")],
    );
    flow.wakeAll();
    expect(status("l")).toMatchObject({ waiting: null, gen: 1 });
    expect(status("prod")?.waiting).toBe("prod");
    expect(status("box")?.waiting).toBe("attach");
    await settled();
    expect(status("web")).toEqual({ waiting: null, status: "Connecting…", gen: 1 });
    expect(status("pw")?.waiting).toBe("secret");
    cleanup();
  });
});
