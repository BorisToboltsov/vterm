import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import DockerContainers from "./DockerContainers.svelte";
import type { DockerContainer, DockerFacts, DockerStat } from "./docker";
import { resetColumnWidths, toggleField } from "../stores/colwidths.svelte";
import type { ListGroup } from "../ui/listview";

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
    networks: [],
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  const groups: ListGroup<DockerContainer>[] = [{ key: "", label: "", rest: true, items: [container()] }];
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
    // The name's line is a block of its own (the name and, in trouble, its state).
    const nameLine = name.parentElement!;
    expect(nameLine.tagName).toBe("DIV");
    expect(image.tagName).toBe("DIV");
    expect(image.parentElement).toBe(nameLine.parentElement);
    expect(image.previousElementSibling).toBe(nameLine);
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
    const block = name.parentElement!.parentElement!;
    // Stacked by default, a row of cells when wide.
    expect(block.className).toContain("@wide:flex");
    // Status and ports sat in the hover card; a wide row has room to show them —
    // the state as one word (v1.33), the ports as the host ports they answer on.
    const status = screen.getByTestId("docker-col-status");
    const ports = screen.getByTestId("docker-col-ports");
    expect(status).toHaveTextContent("running");
    expect(ports).toHaveTextContent(":80");
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
    const titles = ["docker.name", "docker.image", "docker.status", "docker.ports", "docker.ip"].map(
      (c) => screen.getByTestId(`column-${c}`).textContent?.trim(),
    );
    expect(titles).toEqual(["Name", "Image", "State", "Ports", "Address"]);
    expect(header.lastElementChild).toHaveTextContent("CPU");
  });

  it("gives every column a border that can be dragged", () => {
    render(DockerContainers, { props: props() });
    for (const c of ["docker.name", "docker.image", "docker.status", "docker.ports", "docker.ip"]) {
      expect(screen.getByTestId(`column-grip-${c}`)).toHaveClass("cursor-col-resize");
    }
  });

  it("sizes the header and the rows from the same variables", () => {
    render(DockerContainers, { props: props() });
    const header = screen.getByTestId("docker-columns");
    const row = screen.getByRole("listitem");
    // Outer structure: state-dot slot · cells · metrics box.
    expect([...header.children].map(width)).toEqual([...row.children].map(width));
    expect(width(header.firstElementChild!)).toBe("w-[0.4375rem]");
    expect(width(header.lastElementChild!)).toBe("w-[6.5rem]");
    // The cells, one for one.
    const headCells = [...header.children[1].children];
    const rowCells = [...row.children[1].children];
    expect(headCells.map(width)).toEqual([
      "w-[var(--c-name)]",
      "w-[var(--c-image)]",
      "w-[var(--c-status)]",
      "w-[var(--c-ports)]",
      "w-[var(--c-ip)]",
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
    const { setColumnWidth, resetColumnWidths } = await import("../stores/colwidths.svelte");
    const { LIST_COLUMNS } = await import("../ui/colwidths");
    const { flushSync } = await import("svelte");
    resetColumnWidths();
    render(DockerContainers, { props: props() });
    const list = screen.getByTestId("docker-columns").parentElement!;
    expect(list.style.getPropertyValue("--c-image")).toBe(`${LIST_COLUMNS["docker.image"] / 16}rem`);
    setColumnWidth("docker.image", 420);
    flushSync();
    // One style write on the list re-sizes the header and every row.
    expect(list.style.getPropertyValue("--c-image")).toBe("26.25rem");
    expect(list.style.getPropertyValue("--c-name")).toBe(`${LIST_COLUMNS["docker.name"] / 16}rem`);
    resetColumnWidths();
  });

  it("drops the compose indent in the table, where every row must start at the same x", () => {
    const groups: ListGroup<DockerContainer>[] = [
      { key: "edge", label: "edge", rest: false, items: [container({ project: "edge", workdir: "/srv/edge" })] },
    ];
    render(DockerContainers, { props: props({ groups }) });
    const row = screen.getByRole("listitem");
    expect(row.className).toContain("pl-5");
    expect(row.className).toContain("@wide:pl-2.5");
  });
});

// v1.33: the table is fitted to the list, the row opens its details, and the
// container's state, restarts and address are columns.
describe("DockerContainers — the list beside the details", () => {
  const facts = (over: Partial<DockerFacts> = {}): DockerFacts => ({
    cpuCores: null,
    memBytes: null,
    restarts: 0,
    networkMode: "shop_default",
    addresses: [{ network: "shop_default", ipv4: "172.20.0.5", ipv6: "" }],
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    oomKilled: false,
    ...over,
  });

  it("opens the details on a click on the row, and not twice from its buttons", async () => {
    const onViewDetails = vi.fn();
    render(DockerContainers, { props: props({ onViewDetails }) });
    await fireEvent.click(screen.getByText("edge-proxy-canary-2"));
    expect(onViewDetails).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(onViewDetails).toHaveBeenCalledTimes(2);
  });

  it("marks the row whose details are open", () => {
    render(DockerContainers, { props: props({ selectedId: "abc123456789" }) });
    const row = screen.getByTestId("docker-row");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row.className).toContain("bg-accent/10");
  });

  it("says the address, the restarts and a failing health check", () => {
    const c = container({ status: "Up 2 hours (unhealthy)" });
    const groups: ListGroup<DockerContainer>[] = [{ key: "", label: "", rest: true, items: [c] }];
    render(DockerContainers, {
      props: props({ groups, factsById: new Map([[c.id, facts({ restarts: 3 })]]) }),
    });
    expect(screen.getByTestId("docker-col-ip")).toHaveTextContent("172.20.0.5");
    const state = screen.getByTestId("docker-col-status");
    expect(state).toHaveTextContent("unhealthy");
    expect(state).toHaveTextContent("↻3");
  });

  it("names a container without an address of its own instead of leaving it blank", () => {
    const c = container();
    const groups: ListGroup<DockerContainer>[] = [{ key: "", label: "", rest: true, items: [c] }];
    render(DockerContainers, {
      props: props({ groups, factsById: new Map([[c.id, facts({ networkMode: "host", addresses: [] })]]) }),
    });
    expect(screen.getByTestId("docker-col-ip")).toHaveTextContent("host");
  });

  it("takes a column the user hid off the table — header and rows alike", () => {
    resetColumnWidths();
    render(DockerContainers, { props: props() });
    expect(screen.getByTestId("docker-col-ports")).toBeInTheDocument();
    toggleField("docker.containers", "ports");
    flushSync();
    expect(screen.queryByTestId("docker-col-ports")).toBeNull();
    expect(screen.queryByTestId("column-docker.ports")).toBeNull();
    // Nothing was taken by the width, so nothing is reported as such.
    expect(screen.queryByTestId("docker-columns-dropped")).toBeNull();
    resetColumnWidths();
  });
});

// Stage 2: picking several rows for an action on all of them.
describe("DockerContainers — picking several rows", () => {
  const three = () => {
    const items = ["a", "b", "c"].map((n) => container({ id: `${n}00000000000`, name: `ctr-${n}` }));
    return [{ key: "", label: "", rest: true, items }] as ListGroup<DockerContainer>[];
  };

  it("a plain click opens the details; ⌘/Ctrl-click and the checkbox pick instead", async () => {
    const onViewDetails = vi.fn();
    const onpick = vi.fn();
    render(DockerContainers, { props: props({ groups: three(), onViewDetails, onpick }) });
    await fireEvent.click(screen.getByText("ctr-a"), { metaKey: true });
    expect(onpick).toHaveBeenLastCalledWith(new Set(["a00000000000"]));
    expect(onViewDetails).not.toHaveBeenCalled();
    await fireEvent.click(screen.getAllByTestId("docker-row-pick")[1]);
    expect(onpick).toHaveBeenLastCalledWith(new Set(["b00000000000"]));
    expect(onViewDetails).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByText("ctr-c"));
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });

  it("Shift-click takes the run from the last picked row", async () => {
    const onpick = vi.fn();
    const { rerender } = render(DockerContainers, { props: props({ groups: three(), onpick }) });
    await fireEvent.click(screen.getByText("ctr-a"), { ctrlKey: true });
    await rerender({ picked: new Set(["a00000000000"]) });
    await fireEvent.click(screen.getByText("ctr-c"), { shiftKey: true });
    expect(onpick).toHaveBeenLastCalledWith(new Set(["a00000000000", "b00000000000", "c00000000000"]));
  });

  it("shows every row's checkbox while some are picked, and marks the picked", () => {
    render(DockerContainers, { props: props({ groups: three(), onpick: vi.fn(), picked: new Set(["b00000000000"]) }) });
    const boxes = screen.getAllByTestId("docker-row-pick") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    for (const b of boxes) expect(b.className).toContain("opacity-100");
    expect(screen.getAllByTestId("docker-row")[1].className).toContain("bg-accent/15");
  });

  it("offers no picking where the panel does not act on several", () => {
    render(DockerContainers, { props: props({ groups: three() }) });
    expect(screen.queryByTestId("docker-row-pick")).toBeNull();
  });
});

describe("DockerContainers — a stack's own files (stage 5)", () => {
  const group = (files: string[], envFile = "") =>
    [{ key: "shop", label: "shop", rest: false, items: [container({ project: "shop", workdir: "/srv/shop", configFiles: files, envFile })] }] as ListGroup<DockerContainer>[];

  it("does not offer `up` from the directory to a stack that came up from its own files", () => {
    const { unmount } = render(DockerContainers, { props: props({ groups: group(["/srv/shop/compose.yaml", "/srv/shop/compose.prod.yaml"], "/srv/shop/prod.env") }) });
    expect(screen.getByTestId("docker-stack-up-all")).toBeDisabled();
    unmount();
    render(DockerContainers, { props: props({ groups: group(["/srv/shop/compose.yaml"]) }) });
    expect(screen.getByTestId("docker-stack-up-all")).not.toBeDisabled();
  });

  it("opens the stack's details from its header", async () => {
    const onStackOpen = vi.fn();
    render(DockerContainers, { props: props({ groups: group(["/srv/shop/compose.yaml"]), onStackOpen }) });
    await fireEvent.click(screen.getByTestId("docker-stack-open"));
    expect(onStackOpen).toHaveBeenCalledWith("shop");
  });
});
