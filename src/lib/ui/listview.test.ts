import { describe, expect, it, vi } from "vitest";
import {
  activeFacets,
  applyView,
  clearFacets,
  facetLabel,
  facetMenu,
  facetValueMenu,
  facetValues,
  filterItems,
  filterSummary,
  groupItems,
  isFiltered,
  keeps,
  matchesText,
  NO_FILTER,
  NO_GROUPS,
  nextSort,
  pickFacet,
  sanitizeOrder,
  sortItems,
  viewMenu,
  type ListFilter,
  type ListMenuText,
  type ListOrder,
  type ListSchema,
} from "./listview";
import type { MenuAction, MenuItem, MenuSubmenu } from "./ctxmenu";

interface Box {
  name: string;
  image: string;
  state: string;
  stack: string;
  cpu: number | null;
}

const box = (name: string, stack: string, state: string, cpu: number | null, image = `${name}:1`): Box => ({
  name,
  image,
  state,
  stack,
  cpu,
});

const BOXES: Box[] = [
  box("web", "shop", "running", 3, "nginx:1.27"),
  box("api", "shop", "running", 41),
  box("db", "shop", "exited", null, "postgres:16"),
  box("grafana", "mon", "running", 2),
  box("redis", "", "running", 7),
];

const SCHEMA: ListSchema<Box> = {
  text: (b) => `${b.name} ${b.image}`,
  sorts: [
    { id: "name", firstDir: "asc", compare: (a, b) => a.name.localeCompare(b.name) },
    { id: "cpu", firstDir: "desc", compare: (a, b) => (a.cpu ?? 0) - (b.cpu ?? 0), missing: (b) => b.cpu === null },
  ],
  groups: [
    {
      id: "stack",
      of: (b) => ({ key: b.stack, label: b.stack }),
      compare: (a, b) => a.label.localeCompare(b.label),
    },
    { id: "state", of: (b) => ({ key: b.state, label: b.state }) },
  ],
  facets: [
    { id: "state", value: (b) => b.state, order: ["running", "exited", "paused"] },
    { id: "stack", value: (b) => b.stack, multi: true },
  ],
  tie: (a, b) => a.name.localeCompare(b.name),
};

const ORDER: ListOrder = { sort: { key: "name", dir: "asc" }, group: NO_GROUPS };
const names = (items: Box[]) => items.map((b) => b.name);
const filter = (text = "", facets: ListFilter["facets"] = {}): ListFilter => ({ text, facets });

const TEXT: ListMenuText = {
  groups: "Groups",
  order: "Order",
  asc: "Ascending",
  desc: "Descending",
  collapseAll: "Collapse all",
  expandAll: "Expand all",
  all: "All",
  reset: "Reset filters",
  group: (id) => `g:${id}`,
  sort: (id) => `s:${id}`,
  facet: (id) => `f:${id}`,
  value: (f, v) => `${f}=${v}`,
};

const labels = (items: MenuItem[]) =>
  items.map((i) => (i.kind === "separator" ? "—" : i.label));
const submenu = (items: MenuItem[], key: string) =>
  items.find((i): i is MenuSubmenu => i.kind === "submenu" && i.key === key)!;
const action = (items: MenuItem[], label: string) =>
  items.find((i): i is MenuAction => i.kind !== "separator" && i.kind !== "submenu" && i.label === label)!;

describe("the filter field", () => {
  it("finds every term, in any order and case", () => {
    expect(matchesText("web nginx:1.27", "NGINX web")).toBe(true);
    expect(matchesText("web nginx:1.27", "nginx api")).toBe(false);
    expect(matchesText("anything", "   ")).toBe(true);
  });

  it("narrows by the text the schema gives", () => {
    expect(names(filterItems(BOXES, SCHEMA, filter("nginx")))).toEqual(["web"]);
    expect(names(filterItems(BOXES, SCHEMA, filter("postgres 16")))).toEqual(["db"]);
  });
});

describe("facets", () => {
  it("a single facet keeps one value, a multi one several", () => {
    expect(names(filterItems(BOXES, SCHEMA, filter("", { state: ["exited"] })))).toEqual(["db"]);
    expect(names(filterItems(BOXES, SCHEMA, filter("", { stack: ["mon", ""] })))).toEqual(["grafana", "redis"]);
  });

  it("tells of one item whether the filter keeps it", () => {
    expect(keeps(BOXES[0], SCHEMA, filter("nginx", { state: ["running"] }))).toBe(true);
    expect(keeps(BOXES[0], SCHEMA, filter("nginx", { state: ["exited"] }))).toBe(false);
    expect(keeps(BOXES[0], SCHEMA, filter("nginx", { state: ["exited"] }), "state")).toBe(true);
  });

  it("field and facets narrow together", () => {
    expect(names(filterItems(BOXES, SCHEMA, filter("a", { state: ["running"] })))).toEqual(["api", "grafana"]);
  });

  it("counts each value without the facet itself, with the field and the other facets", () => {
    const f = filter("", { state: ["exited"], stack: ["shop"] });
    expect(facetValues(BOXES, SCHEMA, f, "state")).toEqual([
      { value: "running", count: 2 },
      { value: "exited", count: 1 },
      { value: "paused", count: 0 },
    ]);
    // The rest of the values come by count, then by name; an item without a value is not one.
    expect(facetValues(BOXES, SCHEMA, NO_FILTER, "stack")).toEqual([
      { value: "shop", count: 3 },
      { value: "mon", count: 1 },
    ]);
  });

  it("keeps a picked value listed when nothing has it any more", () => {
    expect(facetValues(BOXES, SCHEMA, filter("", { stack: ["gone"] }), "stack")).toContainEqual({ value: "gone", count: 0 });
    expect(facetValues(BOXES, SCHEMA, NO_FILTER, "nope")).toEqual([]);
  });

  it("picking: a single facet takes the value or lets it go, a multi one toggles it", () => {
    const one = pickFacet(NO_FILTER, SCHEMA, "state", "running");
    expect(one.facets).toEqual({ state: ["running"] });
    expect(pickFacet(one, SCHEMA, "state", "exited").facets).toEqual({ state: ["exited"] });
    expect(pickFacet(one, SCHEMA, "state", "running").facets).toEqual({});
    const two = pickFacet(pickFacet(NO_FILTER, SCHEMA, "stack", "shop"), SCHEMA, "stack", "mon");
    expect(two.facets).toEqual({ stack: ["shop", "mon"] });
    expect(pickFacet(two, SCHEMA, "stack", "shop").facets).toEqual({ stack: ["mon"] });
    expect(pickFacet(two, SCHEMA, "stack", null).facets).toEqual({});
    // The text stays as it is.
    expect(pickFacet(filter("x"), SCHEMA, "state", "running").text).toBe("x");
  });

  it("knows what narrows the list and drops it", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered(filter("  "))).toBe(false);
    expect(isFiltered(filter("a"))).toBe(true);
    expect(isFiltered(filter("", { state: [] }))).toBe(false);
    const f = filter("a", { state: ["running"], stack: [] });
    expect(activeFacets(f)).toEqual(["state"]);
    expect(clearFacets(f)).toEqual(filter("a"));
    expect(clearFacets(f, true)).toEqual(NO_FILTER);
  });
});

describe("order", () => {
  it("sorts by the key, either way, equal items by the tie", () => {
    expect(names(sortItems(BOXES, SCHEMA, { key: "name", dir: "asc" }))).toEqual(["api", "db", "grafana", "redis", "web"]);
    expect(names(sortItems(BOXES, SCHEMA, { key: "name", dir: "desc" }))).toEqual(["web", "redis", "grafana", "db", "api"]);
    const twins = [box("b", "", "running", 5), box("a", "", "running", 5)];
    expect(names(sortItems(twins, SCHEMA, { key: "cpu", dir: "desc" }))).toEqual(["a", "b"]);
  });

  it("puts a missing value last whichever way the order runs", () => {
    expect(names(sortItems(BOXES, SCHEMA, { key: "cpu", dir: "desc" }))).toEqual(["api", "redis", "web", "grafana", "db"]);
    expect(names(sortItems(BOXES, SCHEMA, { key: "cpu", dir: "asc" })).at(-1)).toBe("db");
  });

  it("ranks above the order, and an unknown key keeps the tie alone", () => {
    const ranked: ListSchema<Box> = { ...SCHEMA, rank: (b) => (b.state === "exited" ? 0 : 1) };
    expect(names(sortItems(BOXES, ranked, { key: "name", dir: "desc" }))[0]).toBe("db");
    expect(names(sortItems(BOXES, SCHEMA, { key: "gone", dir: "desc" }))).toEqual(["api", "db", "grafana", "redis", "web"]);
    // A new array: the input stays as it was.
    const input = [...BOXES];
    sortItems(input, SCHEMA, { key: "name", dir: "asc" });
    expect(input).toEqual(BOXES);
  });

  it("a column click: another key starts its own way, the same one turns round", () => {
    expect(nextSort(SCHEMA, { key: "name", dir: "asc" }, "cpu")).toEqual({ key: "cpu", dir: "desc" });
    expect(nextSort(SCHEMA, { key: "cpu", dir: "desc" }, "cpu")).toEqual({ key: "cpu", dir: "asc" });
    expect(nextSort(SCHEMA, { key: "cpu", dir: "asc" }, "gone")).toEqual({ key: "gone", dir: "asc" });
  });

  it("makes a stored order safe for the schema", () => {
    expect(sanitizeOrder({ sort: { key: "cpu", dir: "asc" }, group: "stack" }, SCHEMA, ORDER)).toEqual({
      sort: { key: "cpu", dir: "asc" },
      group: "stack",
    });
    expect(sanitizeOrder({ sort: { key: "cpu" }, group: NO_GROUPS }, SCHEMA, ORDER)).toEqual({
      sort: { key: "cpu", dir: "desc" },
      group: NO_GROUPS,
    });
    expect(sanitizeOrder({ sort: { key: "gone", dir: "asc" }, group: "gone" }, SCHEMA, ORDER)).toEqual(ORDER);
    expect(sanitizeOrder("junk", SCHEMA, ORDER)).toEqual(ORDER);
    expect(sanitizeOrder(null, SCHEMA, ORDER)).toEqual(ORDER);
  });
});

describe("groups", () => {
  it("partitions by the grouping, the rest last, each group in the list's order", () => {
    const groups = groupItems(sortItems(BOXES, SCHEMA, { key: "cpu", dir: "desc" }), SCHEMA, "stack");
    expect(groups.map((g) => [g.key, g.rest, names(g.items)])).toEqual([
      ["mon", false, ["grafana"]],
      ["shop", false, ["api", "web", "db"]],
      ["", true, ["redis"]],
    ]);
  });

  it("without an order of their own, groups come as their first items do", () => {
    const groups = groupItems(sortItems(BOXES, SCHEMA, { key: "name", dir: "asc" }), SCHEMA, "state");
    expect(groups.map((g) => g.key)).toEqual(["running", "exited"]);
  });

  it("no grouping is one group without a header", () => {
    expect(groupItems(BOXES, SCHEMA, NO_GROUPS)).toEqual([{ key: "", label: "", rest: false, items: BOXES }]);
  });
});

describe("applyView", () => {
  it("filters, sorts and groups, and says how many of how many", () => {
    const view = applyView(BOXES, SCHEMA, filter("", { state: ["running"] }), {
      sort: { key: "cpu", dir: "desc" },
      group: "stack",
    });
    expect(view.groups.map((g) => [g.key, names(g.items)])).toEqual([
      ["mon", ["grafana"]],
      ["shop", ["api", "web"]],
      ["", ["redis"]],
    ]);
    expect(view).toMatchObject({ grouped: true, shown: 4, total: 5, filtered: true });
  });

  it("an empty result is still a filtered one; no grouping is not grouped", () => {
    const view = applyView(BOXES, SCHEMA, filter("nothing-like-it"), ORDER);
    expect(view).toMatchObject({ grouped: false, shown: 0, total: 5, filtered: true });
    expect(applyView(BOXES, SCHEMA, NO_FILTER, ORDER).filtered).toBe(false);
  });
});

describe("the «View» menu", () => {
  it("says what the grouping and the key are set to, then the directions", () => {
    const menu = viewMenu(SCHEMA, { sort: { key: "cpu", dir: "desc" }, group: "stack" }, TEXT, { order: vi.fn() });
    expect(labels(menu)).toEqual(["Groups: g:stack", "Order: s:cpu", "Ascending", "Descending"]);
    expect(submenu(menu, "group").items.map((i) => [i.label, i.checked])).toEqual([
      ["g:stack", true],
      ["g:state", false],
      ["g:none", false],
    ]);
    expect(submenu(menu, "sort").items.map((i) => [i.label, i.checked])).toEqual([
      ["s:name", false],
      ["s:cpu", true],
    ]);
    expect(action(menu, "Descending").checked).toBe(true);
  });

  it("picks: a grouping, another key in its own direction, the same key unchanged, a direction", () => {
    const order = vi.fn();
    const current: ListOrder = { sort: { key: "name", dir: "desc" }, group: NO_GROUPS };
    const menu = viewMenu(SCHEMA, current, TEXT, { order });
    submenu(menu, "group").items[0].onSelect();
    expect(order).toHaveBeenLastCalledWith({ ...current, group: "stack" });
    submenu(menu, "sort").items[1].onSelect();
    expect(order).toHaveBeenLastCalledWith({ ...current, sort: { key: "cpu", dir: "desc" } });
    submenu(menu, "sort").items[0].onSelect();
    expect(order).toHaveBeenLastCalledWith(current);
    action(menu, "Ascending").onSelect();
    expect(order).toHaveBeenLastCalledWith({ ...current, sort: { key: "name", dir: "asc" } });
  });

  it("folds every group only while there are groups, and ends with the list's own rows", () => {
    const fold = vi.fn();
    const extra: MenuItem[] = [{ label: "Hidden files", checked: true, onSelect: vi.fn() }];
    const flat = viewMenu(SCHEMA, ORDER, TEXT, { order: vi.fn(), fold }, extra);
    expect(labels(flat)).toEqual(["Groups: g:none", "Order: s:name", "Ascending", "Descending", "—", "Hidden files"]);
    const grouped = viewMenu(SCHEMA, { ...ORDER, group: "state" }, TEXT, { order: vi.fn(), fold });
    expect(labels(grouped).slice(-3)).toEqual(["—", "Collapse all", "Expand all"]);
    action(grouped, "Collapse all").onSelect();
    expect(fold).toHaveBeenLastCalledWith(true);
    action(grouped, "Expand all").onSelect();
    expect(fold).toHaveBeenLastCalledWith(false);
  });

  it("a list with one key and no groups has only the directions; without a key — only its rows", () => {
    const one: ListSchema<Box> = { ...SCHEMA, groups: [], sorts: SCHEMA.sorts.slice(0, 1) };
    expect(labels(viewMenu(one, ORDER, TEXT, { order: vi.fn() }))).toEqual(["Ascending", "Descending"]);
    const none: ListSchema<Box> = { ...one, sorts: [] };
    const extra: MenuItem[] = [{ label: "Columns", onSelect: vi.fn() }];
    // No leading separator before the list's own rows.
    expect(labels(viewMenu(none, ORDER, TEXT, { order: vi.fn() }, extra))).toEqual(["Columns"]);
  });
});

describe("the facet menus", () => {
  it("a facet's values: every value first, each with its count and tick", () => {
    const onpick = vi.fn();
    const f = filter("", { state: ["running"] });
    const rows = facetValueMenu(BOXES, SCHEMA, f, "state", TEXT, onpick);
    expect(rows.map((r) => [r.label, r.hint, r.checked])).toEqual([
      ["All", undefined, false],
      ["state=running", "4", true],
      ["state=exited", "1", false],
      ["state=paused", "0", false],
    ]);
    rows[0].onSelect();
    expect(onpick).toHaveBeenLastCalledWith(filter());
    rows[2].onSelect();
    expect(onpick).toHaveBeenLastCalledWith(filter("", { state: ["exited"] }));
  });

  it("a facet's button says its name or what it keeps", () => {
    expect(facetLabel(SCHEMA, NO_FILTER, "stack", TEXT)).toBe("f:stack");
    expect(facetLabel(SCHEMA, filter("", { stack: ["shop", "mon"] }), "stack", TEXT)).toBe("f:stack: stack=shop, stack=mon");
    expect(facetLabel(SCHEMA, filter("", { gone: ["x"] }), "gone", TEXT)).toBe("f:gone");
  });

  it("sums up what narrows the list, for the empty result", () => {
    expect(filterSummary(SCHEMA, filter(" oom ", { state: ["exited"], gone: ["x"] }), TEXT)).toBe(
      "«oom» · f:state: state=exited",
    );
    expect(filterSummary(SCHEMA, NO_FILTER, TEXT)).toBe("");
  });

  it("the funnel: a submenu per facet that says its value, the reset while anything is picked", () => {
    const onpick = vi.fn();
    const clean = facetMenu(BOXES, SCHEMA, filter("a"), TEXT, onpick);
    expect(labels(clean)).toEqual(["f:state: All", "f:stack: All"]);
    const picked = facetMenu(BOXES, SCHEMA, filter("a", { state: ["exited"] }), TEXT, onpick);
    expect(labels(picked)).toEqual(["f:state: state=exited", "f:stack: All", "—", "Reset filters"]);
    action(picked, "Reset filters").onSelect();
    // The reset drops the facets and keeps the text.
    expect(onpick).toHaveBeenLastCalledWith(filter("a"));
  });
});
