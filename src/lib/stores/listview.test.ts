import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_GROUPS, type ListOrder, type ListSchema } from "../ui/listview";
import { applyImportedSettings, settings } from "../settings/settings.svelte";
import { LEGACY_FILES_KEY, listOrder, resetListOrders, setListOrder, STORAGE_KEY } from "./listview.svelte";

interface Row {
  name: string;
  size: number;
}

const SCHEMA: ListSchema<Row> = {
  text: (r) => r.name,
  sorts: [
    { id: "name", firstDir: "asc", compare: (a, b) => a.name.localeCompare(b.name) },
    { id: "size", firstDir: "desc", compare: (a, b) => a.size - b.size },
  ],
  groups: [{ id: "letter", of: (r) => ({ key: r.name[0], label: r.name[0] }) }],
  tie: (a, b) => a.name.localeCompare(b.name),
};
const FALLBACK: ListOrder = { sort: { key: "name", dir: "asc" }, group: NO_GROUPS };

/** The orders as the settings persist them. */
const stored = () => JSON.parse(localStorage.getItem("vterm.settings") ?? "null")?.listOrders;

beforeEach(() => {
  localStorage.clear();
  resetListOrders();
  flushSync();
});

describe("list order store", () => {
  it("a list nobody set lies its default way", () => {
    expect(listOrder("docker.images", SCHEMA, FALLBACK)).toEqual(FALLBACK);
  });

  it("remembers each list on its own and persists it", () => {
    setListOrder("docker.images", { sort: { key: "size", dir: "desc" }, group: "letter" });
    flushSync();
    expect(listOrder("docker.images", SCHEMA, FALLBACK)).toEqual({ sort: { key: "size", dir: "desc" }, group: "letter" });
    expect(listOrder("k8s.pods", SCHEMA, FALLBACK)).toEqual(FALLBACK);
    expect(stored()).toEqual({ "docker.images": { sort: { key: "size", dir: "desc" }, group: "letter" } });
  });

  it("reads an entry through the schema and keeps it as stored", () => {
    settings.listOrders = { files: { sort: { key: "gone", dir: "asc" }, group: "letter" } };
    flushSync();
    expect(listOrder("files", SCHEMA, FALLBACK)).toEqual({ sort: FALLBACK.sort, group: "letter" });
    // What this build does not know is not thrown away: a later one may know it.
    expect(stored()).toEqual({ files: { sort: { key: "gone", dir: "asc" }, group: "letter" } });
  });

  it("an order set in another window applies here at once", () => {
    // The page applies another window's settings snapshot this way (`window://settings`).
    applyImportedSettings({ listOrders: { "docker.images": { sort: { key: "size", dir: "desc" }, group: "none" } } });
    flushSync();
    expect(listOrder("docker.images", SCHEMA, FALLBACK)).toEqual({ sort: { key: "size", dir: "desc" }, group: "none" });
  });

  it("an order comes back with a backup's settings, and junk in it is dropped", () => {
    applyImportedSettings({
      listOrders: { files: { sort: { key: "size", dir: "asc" }, group: "none" }, bad: { sort: 1, group: "x" }, worse: 7 },
    });
    flushSync();
    expect(settings.listOrders).toEqual({ files: { sort: { key: "size", dir: "asc" }, group: "none" } });
  });

  it("takes the orders from where they lived before 1.35 into the settings, once", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "k8s.pods": { sort: { key: "age", dir: "asc" }, group: "none" } }));
    vi.resetModules();
    const fresh = await import("./listview.svelte");
    const { settings: freshSettings } = await import("../settings/settings.svelte");
    expect(freshSettings.listOrders["k8s.pods"]).toEqual({ sort: { key: "age", dir: "asc" }, group: "none" });
    expect(fresh.STORAGE_KEY).toBe(STORAGE_KEY);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("takes the file panels' order from where it lived before 1.29, once", async () => {
    localStorage.setItem(LEGACY_FILES_KEY, JSON.stringify({ key: "modified", dir: "desc" }));
    vi.resetModules();
    await import("./listview.svelte");
    const { settings: freshSettings } = await import("../settings/settings.svelte");
    expect(freshSettings.listOrders.files).toEqual({ sort: { key: "modified", dir: "desc" }, group: "none" });
    expect(localStorage.getItem(LEGACY_FILES_KEY)).toBeNull();
  });

  it("an order already in the settings wins over an old one", async () => {
    localStorage.setItem(
      "vterm.settings",
      JSON.stringify({ listOrders: { files: { sort: { key: "size", dir: "asc" }, group: "none" } } }),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ files: { sort: { key: "name", dir: "desc" }, group: "none" } }));
    localStorage.setItem(LEGACY_FILES_KEY, JSON.stringify({ key: "modified", dir: "desc" }));
    vi.resetModules();
    await import("./listview.svelte");
    const { settings: freshSettings } = await import("../settings/settings.svelte");
    expect(freshSettings.listOrders.files).toEqual({ sort: { key: "size", dir: "asc" }, group: "none" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
