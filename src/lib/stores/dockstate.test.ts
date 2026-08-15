import { beforeEach, describe, expect, it } from "vitest";
import {
  dockState,
  rememberSub,
  removeDockState,
  resetDockState,
  storedSub,
} from "./dockstate.svelte";

describe("dock state store", () => {
  beforeEach(resetDockState);

  it("starts a session empty rather than undefined", () => {
    // Panels read this on mount and must not have to null-check the session itself.
    expect(dockState("s1")).toEqual({ files: null, k8sScope: null, sub: {} });
  });

  it("returns the same object for a session, so writes are seen by the next reader", () => {
    dockState("s1").files = { connected: true, cwd: "/srv/app", home: "/root" };
    expect(dockState("s1").files).toEqual({
      connected: true,
      cwd: "/srv/app",
      home: "/root",
    });
  });

  it("keeps sessions apart", () => {
    dockState("s1").files = { connected: true, cwd: "/a", home: "/a" };
    expect(dockState("s2").files).toBeNull();
  });

  it("falls back to the panel's own default until a sub-tab is remembered", () => {
    expect(storedSub("s1", "docker", "containers")).toBe("containers");
    rememberSub("s1", "docker", "images");
    expect(storedSub("s1", "docker", "containers")).toBe("images");
  });

  it("remembers sub-tabs per panel, not per session", () => {
    rememberSub("s1", "git", "graph");
    rememberSub("s1", "k8s", "workloads");
    expect(storedSub("s1", "git", "changes")).toBe("graph");
    expect(storedSub("s1", "k8s", "pods")).toBe("workloads");
    expect(storedSub("s1", "docker", "containers")).toBe("containers");
  });

  it("stores the k8s scope so a remount does not re-pick context by hand", () => {
    dockState("s1").k8sScope = { context: "prod", namespace: "web", allNamespaces: false };
    expect(dockState("s1").k8sScope?.context).toBe("prod");
  });

  it("drops everything a closed session held", () => {
    // This is the teardown contract: a session id keys this store, so closing the
    // tab has to clear it or the next tab reusing the id inherits stale state.
    dockState("s1").files = { connected: true, cwd: "/a", home: "/a" };
    rememberSub("s1", "docker", "images");
    removeDockState("s1");
    expect(dockState("s1")).toEqual({ files: null, k8sScope: null, sub: {} });
  });

  it("removing an unknown session is a no-op", () => {
    removeDockState("never-existed");
    expect(dockState("s1").files).toBeNull();
  });

  it("resets every session", () => {
    dockState("s1").files = { connected: true, cwd: "/a", home: "/a" };
    dockState("s2").k8sScope = { context: "c", namespace: null, allNamespaces: true };
    resetDockState();
    expect(dockState("s1").files).toBeNull();
    expect(dockState("s2").k8sScope).toBeNull();
  });
});
