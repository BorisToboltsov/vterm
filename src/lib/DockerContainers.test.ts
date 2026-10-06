import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import DockerContainers from "./DockerContainers.svelte";
import type { ComposeGroup, DockerContainer, DockerStat } from "./docker";

function container(over: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "abc123456789",
    name: "edge-proxy-canary-2",
    image: "registry.internal.example.com/platform/edge-proxy:2026.08.1",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:80->80/tcp",
    project: "",
    service: "",
    workdir: null,
    createdAt: "2026-07-19 10:00:00",
    runningFor: "2 hours",
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  const groups: ComposeGroup[] = [{ project: "", workdir: null, containers: [container()] }];
  return {
    groups,
    statsById: new Map<string, DockerStat>(),
    run: vi.fn().mockResolvedValue(true),
    onShell: vi.fn(),
    onLogs: vi.fn(),
    onInspect: vi.fn(),
    onComposeLogs: vi.fn(),
    onViewDetails: vi.fn(),
    showMenu: vi.fn(),
    ...over,
  };
}

describe("DockerContainers", () => {
  it("stacks the image under the container name instead of beside it", () => {
    // v1.0.14. Side by side, the two shared ~240px of the dock's width and a
    // compose-generated name truncated the image down to its registry host — the
    // half that says what is actually running. Block elements (not baseline-aligned
    // spans) are what puts them on separate lines.
    render(DockerContainers, { props: props() });
    const name = screen.getByText("edge-proxy-canary-2");
    const image = screen.getByText("registry.internal.example.com/platform/edge-proxy:2026.08.1");
    expect(name.tagName).toBe("DIV");
    expect(image.tagName).toBe("DIV");
    expect(image.parentElement).toBe(name.parentElement);
    expect(image.previousElementSibling).toBe(name);
  });

  it("keeps both lines truncating rather than wrapping the row taller", () => {
    // A wrapped image name would reflow the whole list on every poll.
    render(DockerContainers, { props: props() });
    for (const text of [
      "edge-proxy-canary-2",
      "registry.internal.example.com/platform/edge-proxy:2026.08.1",
    ]) {
      expect(screen.getByText(text).className).toContain("truncate");
    }
  });

  it("lays the row out as columns in a wide container — same markup, no second component", () => {
    // v1.1. The panel can sit in a narrow side dock or in the full-width bottom
    // one; it adapts to its own container (`@wide:`), never to the dock it is in.
    render(DockerContainers, { props: props() });
    const name = screen.getByText("edge-proxy-canary-2");
    const block = name.parentElement!;
    // Stacked by default, a row of cells when wide.
    expect(block.className).toContain("@wide:flex");
    // Status and ports sat in the hover card; a wide row has room to show them.
    const status = screen.getByTestId("docker-col-status");
    const ports = screen.getByTestId("docker-col-ports");
    expect(status).toHaveTextContent("Up 2 hours");
    expect(ports).toHaveTextContent("0.0.0.0:80->80/tcp");
    for (const col of [status, ports]) {
      // Not laid out at all in a narrow dock — the two-line row stays as it was.
      expect(col.className).toMatch(/(^|\s)hidden(\s|$)/);
      expect(col.className).toContain("@wide:block");
      expect(col.className).toContain("truncate");
      expect(col.parentElement).toBe(block);
    }
  });
});

// The wide layout is a table: titled columns, rules between them, and borders
// the user drags. Width tokens are compared as written — jsdom has no layout —
// which is exactly the contract: the header and the rows must name the SAME
// width for the same column, or their borders drift apart.
describe("DockerContainers — columns of the wide layout", () => {
  /** The width a cell asks for: `w-[…]` on a header cell, `@wide:w-[…]` on a row cell. */
  const width = (el: Element) =>
    el.className.match(/(?:^|\s)(?:@wide:)?(w-\[[^\]]+\])/)?.[1] ?? null;

  it("titles the columns, in a header that only exists when wide", () => {
    render(DockerContainers, { props: props() });
    const header = screen.getByTestId("docker-columns");
    expect(header.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(header.className).toContain("@wide:flex");
    // Stays put while the list scrolls under it.
    expect(header).toHaveClass("sticky", "top-0");
    const titles = ["docker.name", "docker.image", "docker.status", "docker.ports"].map(
      (c) => screen.getByTestId(`column-${c}`).textContent?.trim(),
    );
    expect(titles).toEqual(["Name", "Image", "Status", "Ports"]);
    expect(header.lastElementChild).toHaveTextContent("CPU");
  });

  it("gives every column a border that can be dragged", () => {
    render(DockerContainers, { props: props() });
    for (const c of ["docker.name", "docker.image", "docker.status", "docker.ports"]) {
      expect(screen.getByTestId(`column-grip-${c}`)).toHaveClass("cursor-col-resize");
    }
  });

  it("sizes the header and the rows from the same variables", () => {
    render(DockerContainers, { props: props() });
    const header = screen.getByTestId("docker-columns");
    const row = screen.getByRole("listitem");
    // Outer structure: state-dot slot · cells · metrics box.
    expect([...header.children].map(width)).toEqual([...row.children].map(width));
    expect(width(header.firstElementChild!)).toBe("w-[7px]");
    expect(width(header.lastElementChild!)).toBe("w-[104px]");
    // The cells, one for one.
    const headCells = [...header.children[1].children];
    const rowCells = [...row.children[1].children];
    expect(headCells.map(width)).toEqual([
      "w-[var(--c-name)]",
      "w-[var(--c-image)]",
      "w-[var(--c-status)]",
      "w-[var(--c-ports)]",
    ]);
    expect(rowCells.map(width)).toEqual(headCells.map(width));
    // Same horizontal padding too — it takes part in how the cells shrink.
    const pad = (el: Element) =>
      el.className.match(/(?:^|\s)(?:@wide:)?(p[xr]-2)(?=\s|$)/)?.[1] ?? null;
    expect(rowCells.map(pad)).toEqual(headCells.map(pad));
    // A rule on the right of every cell, running the height of the row.
    for (const cell of rowCells) expect(cell.className).toContain("@wide:border-r");
    expect(row.className).toContain("@wide:items-stretch");
  });

  it("feeds the widths to the list as CSS variables — the user's, or the defaults", async () => {
    const { setColumnWidth, resetColumnWidths } = await import("./stores/colwidths.svelte");
    const { LIST_COLUMNS } = await import("./colwidths");
    const { flushSync } = await import("svelte");
    resetColumnWidths();
    render(DockerContainers, { props: props() });
    const list = screen.getByTestId("docker-columns").parentElement!;
    expect(list.style.getPropertyValue("--c-image")).toBe(`${LIST_COLUMNS["docker.image"]}px`);
    setColumnWidth("docker.image", 420);
    flushSync();
    // One style write on the list re-sizes the header and every row.
    expect(list.style.getPropertyValue("--c-image")).toBe("420px");
    expect(list.style.getPropertyValue("--c-name")).toBe(`${LIST_COLUMNS["docker.name"]}px`);
    resetColumnWidths();
  });

  it("drops the compose indent in the table, where every row must start at the same x", () => {
    const groups: ComposeGroup[] = [
      { project: "edge", workdir: "/srv/edge", containers: [container({ project: "edge" })] },
    ];
    render(DockerContainers, { props: props({ groups }) });
    const row = screen.getByRole("listitem");
    expect(row.className).toContain("pl-5");
    expect(row.className).toContain("@wide:pl-2.5");
  });
});
