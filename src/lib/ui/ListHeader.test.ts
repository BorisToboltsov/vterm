import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import FilterField from "./FilterField.svelte";
import FilteredEmpty from "./FilteredEmpty.svelte";
import GroupHeader from "./GroupHeader.svelte";
import ListHeader from "./ListHeader.svelte";
import type { MenuAction, MenuSubmenu, OpenMenu } from "./ctxmenu";
import { NO_FILTER, NO_GROUPS, type ListSchema } from "./listview";

interface Box {
  name: string;
  state: string;
}

const BOXES: Box[] = [
  { name: "web", state: "running" },
  { name: "db", state: "exited" },
  { name: "api", state: "running" },
];

const SCHEMA: ListSchema<Box> = {
  text: (b) => b.name,
  sorts: [
    { id: "name", firstDir: "asc", compare: (a, b) => a.name.localeCompare(b.name) },
    { id: "state", firstDir: "asc", compare: (a, b) => a.state.localeCompare(b.state) },
  ],
  groups: [{ id: "state", of: (b) => ({ key: b.state, label: b.state }) }],
  facets: [{ id: "state", value: (b) => b.state }],
  tie: (a, b) => a.name.localeCompare(b.name),
};

const ORDER = { sort: { key: "name", dir: "asc" as const }, group: NO_GROUPS };

function header(props: Record<string, unknown> = {}) {
  const onfilter = vi.fn();
  const onorder = vi.fn();
  const onmenu = vi.fn<(m: OpenMenu) => void>();
  render(ListHeader<Box>, {
    props: {
      items: BOXES,
      schema: SCHEMA,
      filter: NO_FILTER,
      onfilter,
      order: ORDER,
      onorder,
      shown: 3,
      total: 3,
      placeholder: "Name",
      wide: false,
      onmenu,
      labels: { facet: () => "Status", sort: (id: string) => `by ${id}`, group: (id: string) => `by ${id}` },
      ...props,
    },
  });
  return { onfilter, onorder, onmenu };
}

describe("FilterField", () => {
  it("clears by the cross and by Esc, and says how many of how many", async () => {
    const oninput = vi.fn();
    render(FilterField, { props: { value: "ng", placeholder: "Name", shown: 2, total: 14, oninput, testid: "f" } });
    expect(screen.getByTestId("f-count")).toHaveTextContent("2 of 14");
    await fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(oninput).toHaveBeenLastCalledWith("");
  });

  it("the cross clears; without a figure there is none", async () => {
    const oninput = vi.fn();
    render(FilterField, { props: { value: "ng", placeholder: "Name", oninput, testid: "f" } });
    expect(screen.queryByTestId("f-count")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Clear the filter" }));
    expect(oninput).toHaveBeenLastCalledWith("");
    expect(screen.queryByRole("button", { name: "Clear the filter" })).toBeNull();
  });

  it("is a dock's row or a window's field", () => {
    render(FilterField, { props: { placeholder: "Search", size: "window" } });
    expect(screen.getByRole("textbox").closest("label")).toHaveClass("h-7", "text-sm");
  });
});

describe("ListHeader", () => {
  it("narrow: a funnel that hands its menu out, and the eye", async () => {
    const { onmenu } = header({ filter: { text: "", facets: { state: ["exited"] } }, shown: 1 });
    const funnel = screen.getByTestId("list-header-funnel");
    expect(funnel).toHaveClass("text-accent");
    expect(funnel).toHaveTextContent("1");
    await fireEvent.click(funnel);
    const menu = onmenu.mock.calls[0][0];
    expect((menu.items[0] as MenuSubmenu).label).toBe("Status: exited");
    // No facet buttons in a narrow panel.
    expect(screen.queryByTestId("list-header-facet-state")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect((onmenu.mock.calls[1][0].items[0] as MenuSubmenu).label).toBe("Groups: No groups");
  });

  it("wide: the facets are buttons that say their value, with a reset", async () => {
    const { onmenu, onfilter } = header({ wide: true, filter: { text: "a", facets: { state: ["running"] } } });
    const facet = screen.getByTestId("list-header-facet-state");
    expect(facet).toHaveTextContent("Status: running");
    expect(screen.queryByTestId("list-header-funnel")).toBeNull();
    await fireEvent.click(facet);
    const rows = onmenu.mock.calls[0][0].items as MenuAction[];
    // Counted under the field's text: of «a», only api is left, and it runs.
    expect(rows.map((r) => [r.label, r.hint])).toEqual([
      ["All", undefined],
      ["running", "1"],
    ]);
    await fireEvent.click(screen.getByTestId("list-header-reset"));
    expect(onfilter).toHaveBeenLastCalledWith({ text: "a", facets: {} });
  });

  it("the field writes the text and shows «N of M» only while the list is narrowed", async () => {
    const { onfilter } = header();
    expect(screen.queryByTestId("list-header-field-count")).toBeNull();
    await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), { target: { value: "we" } });
    expect(onfilter).toHaveBeenLastCalledWith({ text: "we", facets: {} });
  });

  it("without an order or rows of its own there is no eye; without facets no funnel", () => {
    header({ order: null, schema: { ...SCHEMA, facets: [] } });
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    expect(screen.queryByTestId("list-header-funnel")).toBeNull();
  });
});

describe("GroupHeader", () => {
  it("folds by its button, names the group and counts it", async () => {
    const ontoggle = vi.fn();
    render(GroupHeader, { props: { label: "shop", count: 3, collapsed: true, ontoggle, icon: "container" } });
    const toggle = screen.getByTestId("group-header-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("group-header-count")).toHaveTextContent("3");
    await fireEvent.click(toggle);
    expect(ontoggle).toHaveBeenCalledOnce();
  });

  it("the rest is a micro-label", () => {
    render(GroupHeader, { props: { label: "Standalone", count: 1, collapsed: false, ontoggle: () => {}, rest: true } });
    expect(screen.getByText("Standalone")).toHaveClass("text-caption", "uppercase", "tracking-wider");
  });
});

describe("FilteredEmpty", () => {
  it("says what narrows the list and drops it", async () => {
    const onreset = vi.fn();
    render(FilteredEmpty, { props: { summary: "«oom» · Type: Warning", onreset } });
    expect(screen.getByText("Nothing matches the filter")).toBeInTheDocument();
    expect(screen.getByText("«oom» · Type: Warning")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onreset).toHaveBeenCalledOnce();
  });
});
