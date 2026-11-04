import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_GROUPS, type ListOrder, type ListSchema } from "../ui/listview";
import { LEGACY_FILES_KEY, listOrder, listOrders, resetListOrders, setListOrder, STORAGE_KEY } from "./listview.svelte";

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

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

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
    listOrders.stored = { files: { sort: { key: "gone", dir: "asc" }, group: "letter" }, other: 1 };
    flushSync();
    expect(listOrder("files", SCHEMA, FALLBACK)).toEqual({ sort: FALLBACK.sort, group: "letter" });
    // What this build does not know is not thrown away: a later one may know it.
    expect(stored()).toEqual({ files: { sort: { key: "gone", dir: "asc" }, group: "letter" }, other: 1 });
  });

  it("takes the file panels' order from where it lived before 1.29, once", async () => {
    localStorage.setItem(LEGACY_FILES_KEY, JSON.stringify({ key: "modified", dir: "desc" }));
    vi.resetModules();
    const fresh = await import("./listview.svelte");
    expect(fresh.listOrders.stored.files).toEqual({ sort: { key: "modified", dir: "desc" }, group: "none" });
    expect(localStorage.getItem(LEGACY_FILES_KEY)).toBeNull();
  });

  it("an order already stored here wins over the old one", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ files: { sort: { key: "size", dir: "asc" }, group: "none" } }));
    localStorage.setItem(LEGACY_FILES_KEY, JSON.stringify({ key: "modified", dir: "desc" }));
    vi.resetModules();
    const fresh = await import("./listview.svelte");
    expect(fresh.listOrders.stored.files).toEqual({ sort: { key: "size", dir: "asc" }, group: "none" });
  });
});
