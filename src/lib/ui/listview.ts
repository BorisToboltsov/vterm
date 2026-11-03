// The view of a list (v1.29, ADR 0050): what the filter row, the facets and the
// «View» menu ask of a list, and what the list then draws — its groups, how many
// items are shown and how many there are. Pure: a panel describes its list as a
// schema and keeps the state (the order — per list for the app,
// `stores/listview.svelte.ts`; the filter — per session, `stores/dockstate`);
// nothing here knows Docker, k8s or files.
//
// The rules every list keeps:
//  - one sort key and a direction; equal items fall back to the list's own tie
//    (usually the name), so the same items never come out two ways;
//  - a value an item does not have goes last, whichever way the order runs;
//  - an item's rank (a folder over a file) beats the order;
//  - the group without a key — the rest — is drawn last.

import type { MenuAction, MenuItem } from "./ctxmenu";

export type SortDir = "asc" | "desc";

export interface ListSort {
  key: string;
  dir: SortDir;
}

/** The grouping that is none: one flat list. */
export const NO_GROUPS = "none";

/** How a list is laid out — kept for the app, per list. */
export interface ListOrder {
  sort: ListSort;
  /** A grouping of the schema, or `NO_GROUPS`. */
  group: string;
}

/** What a list is narrowed to — kept per session. */
export interface ListFilter {
  text: string;
  /** Per facet, the values kept; absent or empty — every value. */
  facets: Readonly<Record<string, readonly string[]>>;
}

export const NO_FILTER: ListFilter = { text: "", facets: {} };

/** One order a list can be put in. */
export interface SortSpec<T> {
  id: string;
  /** Text reads A→Z; of a number, a size or a time the question is "which is the biggest". */
  firstDir: SortDir;
  /** Ascending; equal items fall through to the schema's tie. */
  compare: (a: T, b: T) => number;
  /** The item has no value here: it goes last in either direction. */
  missing?: (item: T) => boolean;
}

/** A group as its header names it. Key "" is the rest. */
export interface GroupKey {
  key: string;
  label: string;
}

/** One way to partition a list. */
export interface GroupSpec<T> {
  id: string;
  of: (item: T) => GroupKey;
  /** The order of the groups; without it they come as their first items do. */
  compare?: (a: GroupKey, b: GroupKey) => number;
}

/** A property a list can be narrowed by. */
export interface FacetSpec<T> {
  id: string;
  /** The item's value; "" — it has none, and is kept only while the facet is unset. */
  value: (item: T) => string;
  /** Several values at once (log levels) rather than one (a status). */
  multi?: boolean;
  /** The values the menu lists first, in this order; the others follow by count. */
  order?: readonly string[];
}

export interface ListSchema<T> {
  /** What the filter field matches, case-insensitively. */
  text: (item: T) => string;
  sorts: readonly SortSpec<T>[];
  groups?: readonly GroupSpec<T>[];
  facets?: readonly FacetSpec<T>[];
  /** The order of last resort, usually by name: it makes every order total. */
  tie: (a: T, b: T) => number;
  /** A lower rank stands above whatever the order (folders over files). */
  rank?: (item: T) => number;
}

export interface ListGroup<T> {
  key: string;
  label: string;
  /** The group without a key — drawn last, under a micro-label. */
  rest: boolean;
  items: T[];
}

export interface ListView<T> {
  /** One group with key "" and no header when the list is not grouped. */
  groups: ListGroup<T>[];
  grouped: boolean;
  shown: number;
  total: number;
  /** Anything narrows the list: the field reads «N of M», an empty result says why. */
  filtered: boolean;
}

/** The terms of the field: every one has to be found, in any order. */
function terms(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesText(haystack: string, text: string): boolean {
  const hay = haystack.toLowerCase();
  return terms(text).every((t) => hay.includes(t));
}

function picked(filter: ListFilter, facet: string): readonly string[] {
  return filter.facets[facet] ?? [];
}

/** The facets that narrow anything. */
export function activeFacets(filter: ListFilter): string[] {
  return Object.keys(filter.facets).filter((id) => picked(filter, id).length > 0);
}

export function isFiltered(filter: ListFilter): boolean {
  return terms(filter.text).length > 0 || activeFacets(filter).length > 0;
}

/** The items the filter keeps; `except` — a facet left out (its own menu counts without it). */
export function filterItems<T>(items: readonly T[], schema: ListSchema<T>, filter: ListFilter, except?: string): T[] {
  const facets = (schema.facets ?? []).filter((f) => f.id !== except && picked(filter, f.id).length > 0);
  const text = terms(filter.text).length > 0;
  if (!text && facets.length === 0) return [...items];
  return items.filter(
    (item) =>
      (!text || matchesText(schema.text(item), filter.text)) &&
      facets.every((f) => picked(filter, f.id).includes(f.value(item))),
  );
}

/** `items` in `sort`'s order — a new array. An unknown key keeps the tie alone. */
export function sortItems<T>(items: readonly T[], schema: ListSchema<T>, sort: ListSort): T[] {
  const spec = schema.sorts.find((s) => s.id === sort.key);
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (schema.rank) {
      const r = schema.rank(a) - schema.rank(b);
      if (r !== 0) return r;
    }
    if (spec) {
      const x = spec.missing?.(a) ?? false;
      const y = spec.missing?.(b) ?? false;
      if (x !== y) return x ? 1 : -1;
      if (!x) {
        const c = spec.compare(a, b);
        if (c !== 0) return sign * c;
      }
    }
    return schema.tie(a, b);
  });
}

/** Already sorted `items` in the groups of `group`; each group keeps their order. */
export function groupItems<T>(items: readonly T[], schema: ListSchema<T>, group: string): ListGroup<T>[] {
  const spec = schema.groups?.find((g) => g.id === group);
  if (!spec) return [{ key: "", label: "", rest: false, items: [...items] }];
  const byKey = new Map<string, ListGroup<T>>();
  for (const item of items) {
    const { key, label } = spec.of(item);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, rest: key === "", items: [] };
      byKey.set(key, g);
    }
    g.items.push(item);
  }
  const groups = [...byKey.values()];
  const named = groups.filter((g) => !g.rest);
  if (spec.compare) named.sort(spec.compare);
  return [...named, ...groups.filter((g) => g.rest)];
}

export function applyView<T>(
  items: readonly T[],
  schema: ListSchema<T>,
  filter: ListFilter,
  order: ListOrder,
): ListView<T> {
  const kept = sortItems(filterItems(items, schema, filter), schema, order.sort);
  const grouped = schema.groups?.some((g) => g.id === order.group) ?? false;
  return {
    groups: groupItems(kept, schema, order.group),
    grouped,
    shown: kept.length,
    total: items.length,
    filtered: isFiltered(filter),
  };
}

export interface FacetValue {
  value: string;
  count: number;
}

/**
 * The values a facet offers, each with the number of items it would show: the
 * field and the other facets apply, the facet itself does not — so a picked
 * value does not make the others read 0. A picked value stays listed at 0.
 */
export function facetValues<T>(
  items: readonly T[],
  schema: ListSchema<T>,
  filter: ListFilter,
  facet: string,
): FacetValue[] {
  const spec = schema.facets?.find((f) => f.id === facet);
  if (!spec) return [];
  const counts = new Map<string, number>();
  for (const v of spec.order ?? []) counts.set(v, 0);
  for (const item of filterItems(items, schema, filter, facet)) {
    const v = spec.value(item);
    if (v !== "") counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const v of picked(filter, facet)) if (!counts.has(v)) counts.set(v, 0);
  const listed = new Set(spec.order ?? []);
  const rest = [...counts.entries()]
    .filter(([v]) => !listed.has(v))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return [...(spec.order ?? []).map((v) => [v, counts.get(v) ?? 0] as const), ...rest].map(([value, count]) => ({
    value,
    count,
  }));
}

/**
 * The filter after a value of `facet` is picked: a multi facet adds or removes
 * it, a single one takes it — or lets go of it, picked again. `null` — every value.
 */
export function pickFacet<T>(filter: ListFilter, schema: ListSchema<T>, facet: string, value: string | null): ListFilter {
  const spec = schema.facets?.find((f) => f.id === facet);
  const now = picked(filter, facet);
  let next: readonly string[];
  if (value === null || !spec) next = [];
  else if (spec.multi) next = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
  else next = now.length === 1 && now[0] === value ? [] : [value];
  const facets = { ...filter.facets };
  if (next.length > 0) facets[facet] = next;
  else delete facets[facet];
  return { ...filter, facets };
}

/** The facets dropped, the text kept — or everything, `withText`. */
export function clearFacets(filter: ListFilter, withText = false): ListFilter {
  return { text: withText ? "" : filter.text, facets: {} };
}

/** What a click on a column title asks for: that key, or the same one the other way round. */
export function nextSort<T>(schema: ListSchema<T>, current: ListSort, key: string): ListSort {
  if (current.key !== key) return { key, dir: schema.sorts.find((s) => s.id === key)?.firstDir ?? "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** A stored order made safe for this schema; anything it does not know is the fallback's. */
export function sanitizeOrder<T>(raw: unknown, schema: ListSchema<T>, fallback: ListOrder): ListOrder {
  const o = typeof raw === "object" && raw !== null ? (raw as { sort?: unknown; group?: unknown }) : {};
  const s = typeof o.sort === "object" && o.sort !== null ? (o.sort as { key?: unknown; dir?: unknown }) : {};
  const spec = schema.sorts.find((x) => x.id === s.key);
  const sort: ListSort = spec
    ? { key: spec.id, dir: s.dir === "asc" || s.dir === "desc" ? s.dir : spec.firstDir }
    : { ...fallback.sort };
  const known = o.group === NO_GROUPS || (schema.groups ?? []).some((g) => g.id === o.group);
  return { sort, group: known ? (o.group as string) : fallback.group };
}

/** The words of the menus — the panel translates, this module does not. */
export interface ListMenuText {
  groups: string;
  order: string;
  asc: string;
  desc: string;
  collapseAll: string;
  expandAll: string;
  all: string;
  reset: string;
  /** A grouping's name; `NO_GROUPS` too. */
  group: (id: string) => string;
  sort: (id: string) => string;
  facet: (id: string) => string;
  value: (facet: string, value: string) => string;
}

/** A menu without a separator at either end or two in a row. */
function tidy(items: MenuItem[]): MenuItem[] {
  return items.filter(
    (item, i) =>
      item.kind !== "separator" || (i > 0 && i < items.length - 1 && items[i + 1].kind !== "separator"),
  );
}

/**
 * The «View» menu: the grouping and the key as submenus that say what they are
 * set to, the two directions, folding every group while there are groups, then
 * what the list adds of its own (tags, hidden files).
 */
export function viewMenu<T>(
  schema: ListSchema<T>,
  order: ListOrder,
  text: ListMenuText,
  on: { order: (next: ListOrder) => void; fold?: (collapsed: boolean) => void },
  extra: MenuItem[] = [],
): MenuItem[] {
  const items: MenuItem[] = [];
  const groups = schema.groups ?? [];
  if (groups.length > 0) {
    items.push({
      kind: "submenu",
      key: "group",
      icon: "layoutGrid",
      label: `${text.groups}: ${text.group(order.group)}`,
      items: [...groups.map((g) => g.id), NO_GROUPS].map((id) => ({
        label: text.group(id),
        checked: order.group === id,
        onSelect: () => on.order({ ...order, group: id }),
      })),
    });
  }
  if (schema.sorts.length > 1) {
    items.push({
      kind: "submenu",
      key: "sort",
      icon: "arrowsUpDown",
      label: `${text.order}: ${text.sort(order.sort.key)}`,
      items: schema.sorts.map((s) => ({
        label: text.sort(s.id),
        checked: order.sort.key === s.id,
        onSelect: () => on.order({ ...order, sort: order.sort.key === s.id ? order.sort : { key: s.id, dir: s.firstDir } }),
      })),
    });
  }
  if (schema.sorts.length > 0) {
    items.push(
      ...(["asc", "desc"] as const).map(
        (dir): MenuAction => ({
          label: text[dir],
          checked: order.sort.dir === dir,
          onSelect: () => on.order({ ...order, sort: { key: order.sort.key, dir } }),
        }),
      ),
    );
  }
  const fold = on.fold;
  if (fold && groups.some((g) => g.id === order.group)) {
    items.push(
      { kind: "separator" },
      { icon: "chevronUp", label: text.collapseAll, onSelect: () => fold(true) },
      { icon: "chevronDown", label: text.expandAll, onSelect: () => fold(false) },
    );
  }
  if (extra.length > 0) items.push({ kind: "separator" }, ...extra);
  return tidy(items);
}

/** The values of one facet as menu rows: every value first, each with its count. */
export function facetValueMenu<T>(
  items: readonly T[],
  schema: ListSchema<T>,
  filter: ListFilter,
  facet: string,
  text: ListMenuText,
  onpick: (next: ListFilter) => void,
): MenuAction[] {
  const now = picked(filter, facet);
  return [
    { label: text.all, checked: now.length === 0, onSelect: () => onpick(pickFacet(filter, schema, facet, null)) },
    ...facetValues(items, schema, filter, facet).map(
      ({ value, count }): MenuAction => ({
        label: text.value(facet, value),
        hint: String(count),
        checked: now.includes(value),
        onSelect: () => onpick(pickFacet(filter, schema, facet, value)),
      }),
    ),
  ];
}

/** What a facet's button says: its name, or the values it keeps. */
export function facetLabel<T>(schema: ListSchema<T>, filter: ListFilter, facet: string, text: ListMenuText): string {
  const now = picked(filter, facet);
  if (now.length === 0 || !schema.facets?.some((f) => f.id === facet)) return text.facet(facet);
  return `${text.facet(facet)}: ${now.map((v) => text.value(facet, v)).join(", ")}`;
}

/**
 * The funnel's menu of a narrow panel: each facet a submenu that says what it is
 * set to, then — while anything is picked — the reset.
 */
export function facetMenu<T>(
  items: readonly T[],
  schema: ListSchema<T>,
  filter: ListFilter,
  text: ListMenuText,
  onpick: (next: ListFilter) => void,
): MenuItem[] {
  const menu: MenuItem[] = (schema.facets ?? []).map((f) => ({
    kind: "submenu",
    key: f.id,
    label: picked(filter, f.id).length > 0 ? facetLabel(schema, filter, f.id, text) : `${text.facet(f.id)}: ${text.all}`,
    items: facetValueMenu(items, schema, filter, f.id, text, onpick),
  }));
  if (activeFacets(filter).length > 0) {
    menu.push({ kind: "separator" }, { icon: "close", label: text.reset, onSelect: () => onpick(clearFacets(filter)) });
  }
  return menu;
}
