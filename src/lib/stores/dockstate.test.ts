import { beforeEach, describe, expect, it } from "vitest";
import {
  dirRevision,
  touchDir,
  dockState,
  rememberSub,
  removeDockState,
  resetDockState,
  storedSub,
  dockCwd,
  setDockCwd,
  pendingFilesDir,
  requestFilesDir,
  takeFilesDir,
  listFilter,
  setListFilter,
  collapsedGroups,
  setGroupsCollapsed,
  keepAside,
  keptAside,
  logView,
  fileSearch,
  adoptDockState,
} from "./dockstate.svelte";
import { NO_FILTER } from "../ui/listview";

describe("dock state store", () => {
  beforeEach(resetDockState);

  it("starts a session empty rather than undefined", () => {
    // Panels read this on mount and must not have to null-check the session itself.
    expect(dockState("s1")).toEqual({ files: null, cwd: null, k8sScope: null, sub: {}, dirRev: {}, lists: {}, aside: {}, logs: {}, search: null });
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
    setDockCwd("s1", "/repo");
    removeDockState("s1");
    expect(dockState("s1")).toEqual({ files: null, cwd: null, k8sScope: null, sub: {}, dirRev: {}, lists: {}, aside: {}, logs: {}, search: null });
  });

  it("bumps a folder's revision once for each transfer that ended in it", () => {
    expect(dirRevision("s1", "/srv")).toBe(0);
    touchDir("s1", "/srv");
    expect(dirRevision("s1", "/srv")).toBe(1);
    // Another folder, and another session, keep counts of their own.
    touchDir("s1", "/tmp");
    touchDir("s1", "/srv");
    expect(dirRevision("s1", "/srv")).toBe(2);
    expect(dirRevision("s1", "/tmp")).toBe(1);
    expect(dirRevision("nobody", "/srv")).toBe(0);
  });

  it("reads the shared directory without creating the session", () => {
    // dockCwd runs inside $derived — creating the entry there is a state write.
    expect(dockCwd("fresh")).toBeNull();
    setDockCwd("fresh", "/srv");
    expect(dockCwd("fresh")).toBe("/srv");
    removeDockState("fresh");
  });

  it("holds a folder asked for until that session's panel takes it", () => {
    expect(pendingFilesDir("s1")).toBeNull();
    expect(pendingFilesDir(null)).toBeNull();
    requestFilesDir("s1", "/srv/app");
    expect(pendingFilesDir("s1")).toBe("/srv/app");
    expect(pendingFilesDir("s2")).toBeNull();
    expect(takeFilesDir("s1")).toBe("/srv/app");
    expect(pendingFilesDir("s1")).toBeNull();
    expect(takeFilesDir("s1")).toBeNull();
  });

  it("drops a folder asked for with the session, and on reset", () => {
    requestFilesDir("s1", "/a");
    requestFilesDir("s2", "/b");
    removeDockState("s1");
    expect(pendingFilesDir("s1")).toBeNull();
    resetDockState();
    expect(pendingFilesDir("s2")).toBeNull();
  });

  it("keeps a list's filter per session, and reads it without creating the session", () => {
    expect(listFilter("s1", "docker.containers")).toBe(NO_FILTER);
    setListFilter("s1", "docker.containers", { text: "nginx", facets: { state: ["running"] } });
    expect(listFilter("s1", "docker.containers")).toEqual({ text: "nginx", facets: { state: ["running"] } });
    expect(listFilter("s2", "docker.containers")).toBe(NO_FILTER);
    expect(listFilter("s1", "k8s.pods")).toBe(NO_FILTER);
    removeDockState("s1");
    expect(listFilter("s1", "docker.containers")).toBe(NO_FILTER);
  });

  it("folds and unfolds groups of a list, one or several at once", () => {
    expect(collapsedGroups("s1", "recordings")).toEqual([]);
    setGroupsCollapsed("s1", "recordings", ["today"], true);
    setGroupsCollapsed("s1", "recordings", ["today", "week"], true);
    expect(collapsedGroups("s1", "recordings")).toEqual(["today", "week"]);
    setGroupsCollapsed("s1", "recordings", ["today"], false);
    expect(collapsedGroups("s1", "recordings")).toEqual(["week"]);
    // The filter of the same list is not touched by folding.
    expect(listFilter("s1", "recordings")).toEqual(NO_FILTER);
  });

  it("keeps what stood beside a panel's list per session, and forgets it when told nothing is open", () => {
    expect(keptAside("s1", "docker")).toBeNull();
    keepAside("s1", "docker", { kind: "container", id: "abc", tab: "logs" });
    keepAside("s1", "k8s", { kind: "pod", namespace: "shop", name: "web-1", tab: "overview", container: "app" });
    expect(keptAside("s1", "docker")).toEqual({ kind: "container", id: "abc", tab: "logs" });
    expect(keptAside("s2", "docker")).toBeNull();
    // The same thing again changes nothing; a different one replaces it.
    const before = dockState("s1").aside.docker;
    keepAside("s1", "docker", { kind: "container", id: "abc", tab: "logs" });
    expect(dockState("s1").aside.docker).toBe(before);
    keepAside("s1", "docker", { kind: "item", item: { kind: "network", name: "shop_default" } });
    expect(keptAside("s1", "docker")).toEqual({ kind: "item", item: { kind: "network", name: "shop_default" } });
    keepAside("s1", "docker", null);
    expect(keptAside("s1", "docker")).toBeNull();
    expect(keptAside("s1", "k8s")?.kind).toBe("pod");
  });

  it("hands out one log view per panel and session, written in place", () => {
    const view = logView("s1", "docker");
    expect(view).toEqual({ live: true, tail: 200, query: "", level: "all", stamps: true, wrap: true, top: null });
    view.query = "timeout";
    view.top = 340;
    expect(logView("s1", "docker")).toMatchObject({ query: "timeout", top: 340 });
    expect(logView("s1", "k8s").query).toBe("");
    expect(logView("s2", "docker").top).toBeNull();
  });

  it("keeps the content search of a session, closed until asked", () => {
    const search = fileSearch("s1");
    expect(search).toMatchObject({ open: false, query: "", outcome: null });
    search.open = true;
    search.query = "listen 443";
    search.outcome = { matches: [{ path: "a.conf", line: 3, text: "listen 443 ssl;" }], truncated: false, failed: false };
    expect(fileSearch("s1").outcome?.matches).toHaveLength(1);
    expect(fileSearch("s2").outcome).toBeNull();
  });

  it("closing the tab drops what stood beside its lists, its logs' reading and its search", () => {
    keepAside("s1", "docker", { kind: "container", id: "abc", tab: "inspect" });
    logView("s1", "k8s").query = "error";
    fileSearch("s1").query = "x";
    removeDockState("s1");
    expect(keptAside("s1", "docker")).toBeNull();
    expect(logView("s1", "k8s").query).toBe("");
    expect(fileSearch("s1").query).toBe("");
  });

  it("a tab moved from another window brings them along", () => {
    keepAside("s1", "docker", { kind: "container", id: "abc", tab: "resources" });
    logView("s1", "docker").tail = 1000;
    const moved = JSON.parse(JSON.stringify(dockState("s1")));
    resetDockState();
    adoptDockState("s9", moved);
    expect(keptAside("s9", "docker")).toEqual({ kind: "container", id: "abc", tab: "resources" });
    expect(logView("s9", "docker").tail).toBe(1000);
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
