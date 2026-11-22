// The dock builds a session's panel before anything has stored dock state for
// that session — a tab restored at start is the usual case. What the panel is
// handed from that state is read without creating it: a state write inside
// `$derived` is refused by Svelte (`state_unsafe_mutation`), and at start that
// refusal replaced the whole app with SvelteKit's "500 Internal Error".
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  shellUser: vi.fn(async () => null),
  onSessionSubmit: vi.fn(() => () => {}),
  sftpHome: vi.fn(async () => "/home/u"),
  sftpList: vi.fn(async () => []),
  localHome: vi.fn(async () => "/home/u"),
  localList: vi.fn(async () => []),
}));

import DockPanel from "./DockPanel.svelte";
import { dockState, peekDockState, resetDockState } from "../stores/dockstate.svelte";

beforeEach(() => {
  resetDockState();
  flushSync();
});

describe("a session's file panel, built before its dock state exists", () => {
  it.each(["ssh", "local"] as const)("mounts on a %s tab", (kind) => {
    expect(peekDockState("fresh")).toBeNull();
    expect(() =>
      render(DockPanel, {
        props: { id: "files", kind, sessionId: "fresh", visible: false, connection: "connecting" },
      }),
    ).not.toThrow();
  });

  it("mounts when the k8s panel has already picked a context", () => {
    dockState("picked").k8sScope = { context: "staging", namespace: null, allNamespaces: false };
    expect(() =>
      render(DockPanel, {
        props: { id: "files", kind: "ssh", sessionId: "picked", visible: false, connection: "connecting" },
      }),
    ).not.toThrow();
  });
});
