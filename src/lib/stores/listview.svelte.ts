// The order and the grouping of each list (v1.29, ADR 0050). Kept here, not in
// the panel: a session panel is rebuilt on every terminal-tab switch, and an
// order that reset each time would not be a choice. One for the app, per list —
// the Docker containers of every session lie the same way. Since v1.35 the
// orders are a field of the settings (`settings.listOrders`): the settings are
// what windows share (`window://settings`) and what a backup carries, so a
// list sorted in one window lies the same way in every other one at once, and
// the order comes back with the rest of the settings. What an entry may hold
// is the list's schema to say (`sanitizeOrder`, `../ui/listview.ts`), so an
// entry is kept as stored and made safe when it is read — a list that drops a
// key in a later build falls back to its default and loses nothing else.
//
// What a list is narrowed to is not here: a filter is per session (`dockstate`).
// Orders lived in localStorage under `vterm.listview` (1.29–1.34) and the file
// panels' under `vterm.filesort` before that: both move into the settings on
// the first load and are dropped.

import { settings } from "../settings/settings.svelte";
import { sanitizeOrder, sanitizeStoredOrders, type ListOrder, type ListSchema } from "../ui/listview";

/** Where the orders lived from 1.29 to 1.34 — read once, then dropped. */
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
  | "recordings"
  | "mon.processes";

/** Where the file panels kept their order before 1.29 — read once, then dropped. */
export const LEGACY_FILES_KEY = "vterm.filesort";

/**
 * The orders kept before they were settings, taken into the settings once. The
 * settings win over them: a window opened after the move finds them there and
 * only drops what is left over.
 */
function migrate(): void {
  let stored: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) stored = raw as Record<string, unknown>;
  } catch {
    /* unreadable — nothing to take over */
  }
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_FILES_KEY) ?? "null");
    if (!("files" in stored) && legacy !== null) stored = { ...stored, files: { sort: legacy, group: "none" } };
  } catch {
    /* the old entry unreadable — the default order then */
  }
  const kept = sanitizeStoredOrders(stored);
  if (Object.keys(kept).length > 0) settings.listOrders = { ...kept, ...settings.listOrders };
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_FILES_KEY);
  } catch {
    /* storage unavailable — nothing was read from it either */
  }
}

migrate();

/** How `list` is laid out (reactive); what the schema does not know is the fallback's. */
export function listOrder<T>(list: ListId, schema: ListSchema<T>, fallback: ListOrder): ListOrder {
  return sanitizeOrder(settings.listOrders[list], schema, fallback);
}

export function setListOrder(list: ListId, order: ListOrder): void {
  settings.listOrders = {
    ...settings.listOrders,
    [list]: { sort: { key: order.sort.key, dir: order.sort.dir }, group: order.group },
  };
}

/** Every list back to its default (tests). */
export function resetListOrders(): void {
  settings.listOrders = {};
}
