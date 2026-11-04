// The order and the grouping of each list (v1.29, ADR 0050). Kept here, not in
// the panel: a session panel is rebuilt on every terminal-tab switch, and an
// order that reset each time would not be a choice. One for the app, per list —
// the Docker containers of every session lie the same way. Persisted to
// localStorage under `vterm.listview`; what an entry may hold is the list's
// schema to say (`sanitizeOrder`, `../ui/listview.ts`), so an entry is kept as
// stored and made safe when it is read — a list that drops a key in a later
// build falls back to its default and loses nothing else.
//
// What a list is narrowed to is not here: a filter is per session (`dockstate`).
// The file panels' order lived under `vterm.filesort` until 1.29 and moves here
// on the first load.

import { sanitizeOrder, type ListOrder, type ListSchema } from "../ui/listview";

export const STORAGE_KEY = "vterm.listview";

/** The lists that keep an order — one name per list, so a typo is a type error. */
export type ListId =
  | "docker.containers"
  | "docker.images"
  | "docker.networks"
  | "k8s.pods"
  | "k8s.workloads"
  | "k8s.events"
  | "files"
  | "git.changes"
  | "recordings";

/** Where the file panels kept their order before 1.29 — read once, then dropped. */
export const LEGACY_FILES_KEY = "vterm.filesort";

function load(): Record<string, unknown> {
  let stored: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) stored = raw as Record<string, unknown>;
  } catch {
    /* unreadable — every list starts at its default */
  }
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_FILES_KEY) ?? "null");
    if (!("files" in stored) && legacy !== null) stored = { ...stored, files: { sort: legacy, group: "none" } };
    localStorage.removeItem(LEGACY_FILES_KEY);
  } catch {
    /* storage unavailable or the old entry unreadable — the default order then */
  }
  return stored;
}

export const listOrders = $state<{ stored: Record<string, unknown> }>({ stored: load() });

/** How `list` is laid out (reactive); what the schema does not know is the fallback's. */
export function listOrder<T>(list: ListId, schema: ListSchema<T>, fallback: ListOrder): ListOrder {
  return sanitizeOrder(listOrders.stored[list], schema, fallback);
}

export function setListOrder(list: ListId, order: ListOrder): void {
  listOrders.stored[list] = { sort: { key: order.sort.key, dir: order.sort.dir }, group: order.group };
}

/** Every list back to its default (tests). */
export function resetListOrders(): void {
  listOrders.stored = {};
}

$effect.root(() => {
  $effect(() => {
    const data = JSON.stringify(listOrders.stored);
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      /* storage unavailable — non-fatal */
    }
  });
});
