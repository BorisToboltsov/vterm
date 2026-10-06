import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import K8sPods from "./K8sPods.svelte";
import { LIST_COLUMNS } from "./colwidths";
import { resetColumnWidths, setColumnWidth } from "./stores/colwidths.svelte";
import type { K8sPod, K8sPodMetrics, PodGroup } from "./k8s";

function pod(over: Partial<K8sPod> = {}): K8sPod {
  return {
    name: "checkout-5d9c7b-x2k4p",
    namespace: "shop",
    phase: "Running",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    node: "worker-eu-central-1a",
    age: "5d",
    containers: ["app"],
    ownerKind: "Deployment",
    ownerName: "checkout",
    cpuLimit: null,
    memLimit: null,
    qos: "",
    ...over,
  };
}

function props(pods: K8sPod[] = [pod()], metrics: [string, K8sPodMetrics][] = []) {
  const groups: PodGroup[] = [{ kind: "Deployment", name: "checkout", pods }];
  return {
    groups,
    metricsByKey: new Map<string, K8sPodMetrics>(metrics),
    run: vi.fn().mockResolvedValue(true),
    openShell: vi.fn(),
    onViewDetails: vi.fn(),
    showMenu: vi.fn(),
  };
}

const withMetrics = (p: K8sPod): [string, K8sPodMetrics][] => [
  [`${p.namespace}/${p.name}`, { namespace: p.namespace, name: p.name, cpu: "120m", mem: "210Mi" }],
];

beforeEach(() => {
  localStorage.clear();
  resetColumnWidths();
  flushSync();
});

describe("K8sPods", () => {
  it("shows namespace and node as columns only in a wide container", () => {
    // v1.1: one component for a narrow side dock and the full-width bottom dock —
    // the columns exist in the markup and the container decides (`@wide:`).
    render(K8sPods, { props: props() });
    const ns = screen.getByTestId("k8s-col-namespace");
    const node = screen.getByTestId("k8s-col-node");
    expect(ns).toHaveTextContent("shop");
    expect(node).toHaveTextContent("worker-eu-central-1a");
    for (const col of [ns, node]) {
      expect(col.className).toMatch(/(^|\s)hidden(\s|$)/);
      expect(col.className).toContain("@wide:block");
      expect(col.className).toContain("truncate");
    }
  });

  it("keeps a narrow row free of the table's placeholders", () => {
    // Cells a pod has nothing for exist only so a wide row has every column; in a
    // narrow row they must not be laid out — a gap or a stray dash would be new.
    render(K8sPods, { props: props() });
    for (const id of ["k8s-col-restarts", "k8s-col-nometrics", "k8s-col-limits"]) {
      const el = screen.getByTestId(id);
      expect(el.className, id).toMatch(/(^|\s)hidden(\s|$)/);
      expect(el.className, id).toContain("@wide:block");
    }
    // …and the CPU shape's wrapper is not a box there at all.
    expect(screen.getByTestId("k8s-col-spark").className).toMatch(/(^|\s)contents(\s|$)/);
  });

  it("shows restarts, figures and the no-limit note in a narrow row when there are any", () => {
    const p = pod({ restarts: 3 });
    render(K8sPods, { props: props([p], withMetrics(p)) });
    const restarts = screen.getByTestId("k8s-col-restarts");
    expect(restarts).toHaveTextContent("↻3");
    expect(restarts.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByText("120m")).toBeInTheDocument();
    expect(screen.getByText("210Mi")).toBeInTheDocument();
    // The bare numbers come with the note that nothing caps them.
    const note = screen.getByTestId("k8s-col-limits");
    expect(note).toHaveTextContent("no limit set");
    expect(note.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.queryByTestId("k8s-col-nometrics")).toBeNull();
  });

  it("says a pod has no ceiling even without metrics — in the table only", () => {
    // The note comes from the spec, not from `top`. A narrow row has no figures
    // for it to explain, so there it stays out of the way.
    render(K8sPods, { props: props() });
    const note = screen.getByTestId("k8s-col-limits");
    expect(note).toHaveTextContent("no limit set");
    expect(note.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(note.className).toContain("@wide:block");
  });
});

// The wide layout is a table. jsdom has no layout, so the columns are compared as
// written: the header must name the same width, in the same visual order, as the
// cells of a row — that is what keeps a title over its column.
describe("K8sPods — columns of the wide layout", () => {
  /** A row's cells as the table shows them: the figure cluster is dissolved
   *  (`@wide:contents`) and `@wide:order-N` moves the CPU shape next to its figure. */
  function rowCells(row: Element): Element[] {
    const flat: Element[] = [];
    for (const child of row.children) {
      if (/(^|\s)@wide:contents(\s|$)/.test(child.className)) flat.push(...child.children);
      else flat.push(child);
    }
    const order = (el: Element) => Number(el.className.match(/@wide:order-(\d)/)?.[1] ?? 0);
    return flat
      .map((el, i) => ({ el, i }))
      .sort((a, b) => order(a.el) - order(b.el) || a.i - b.i)
      .map((x) => x.el);
  }
  /** What a cell asks for along the row in the wide layout: a width token, or
   *  `flex-1` for the filler. A row cell says it with `@wide:` (its plain classes
   *  are the narrow layout's); a header cell is only ever wide and says it plainly. */
  const TOKEN = "(w-(?:\\[[^\\]]+\\]|\\d+)|flex-1)(?=\\s|$)";
  const size = (el: Element) =>
    (el.className.match(new RegExp(`(?:^|\\s)@wide:${TOKEN}`)) ??
      el.className.match(new RegExp(`(?:^|\\s)${TOKEN}`)))?.[1] ?? null;

  it("titles the columns, in a header that only exists when wide", () => {
    render(K8sPods, { props: props() });
    const header = screen.getByTestId("k8s-columns");
    expect(header.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(header.className).toContain("@wide:flex");
    expect(header).toHaveClass("sticky", "top-0");
    const titles = [...header.children].map((c) => c.textContent?.trim()).filter(Boolean);
    expect(titles).toEqual([
      "Name",
      "Namespace",
      "Node",
      "Ready",
      "↻",
      "CPU",
      "Memory",
      "Limits",
      "Age",
    ]);
  });

  it("lets the three text columns be resized, and only them", () => {
    render(K8sPods, { props: props() });
    for (const c of ["k8s.name", "k8s.namespace", "k8s.node"]) {
      expect(screen.getByTestId(`column-grip-${c}`)).toHaveClass("cursor-col-resize");
    }
    expect(document.querySelectorAll('[data-testid^="column-grip-"]')).toHaveLength(3);
  });

  it("gives every row the header's columns — with metrics, without, with restarts", () => {
    const a = pod({ name: "with-metrics", restarts: 2, cpuLimit: 500, memLimit: 512 });
    const b = pod({ name: "no-metrics" });
    const c = pod({ name: "unbounded" });
    render(K8sPods, { props: props([a, b, c], [...withMetrics(a), ...withMetrics(c)]) });
    const head = [...screen.getByTestId("k8s-columns").children].map(size);
    expect(head).toEqual([
      "w-[7px]", // state dot
      "w-[var(--c-name)]",
      "w-[var(--c-ns)]",
      "w-[var(--c-node)]",
      "flex-1", // takes whatever the window has left
      "w-16", // ready
      "w-12", // restarts
      "w-[3.25rem]", // CPU shape
      "w-20", // CPU figure
      "w-20", // memory
      "w-28", // limits
      "w-18", // age
      "w-14", // actions
    ]);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(rowCells(row).map(size), row.textContent ?? "").toEqual(head);
  });

  it("says there is nothing to show where a pod has no metrics", () => {
    render(K8sPods, { props: props() });
    expect(screen.getByTestId("k8s-col-nometrics")).toHaveTextContent("—");
  });

  it("feeds the widths to the list as CSS variables — the user's, or the defaults", () => {
    render(K8sPods, { props: props() });
    const list = screen.getByTestId("k8s-columns").parentElement!;
    expect(list.style.getPropertyValue("--c-name")).toBe(`${LIST_COLUMNS["k8s.name"]}px`);
    setColumnWidth("k8s.node", 240);
    flushSync();
    expect(list.style.getPropertyValue("--c-node")).toBe("240px");
    expect(list.style.getPropertyValue("--c-ns")).toBe(`${LIST_COLUMNS["k8s.namespace"]}px`);
  });

  it("rules the columns: text cells on the right, figures on the left, full row height", () => {
    render(K8sPods, { props: props() });
    const row = screen.getByRole("listitem");
    expect(row.className).toContain("@wide:items-stretch");
    expect(row.className).toContain("@wide:py-0");
    expect(screen.getByTestId("k8s-col-namespace").className).toContain("@wide:border-r");
    expect(screen.getByTestId("k8s-col-limits").className).toContain("@wide:border-l");
  });
});
