import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Where a container's details, logs and inspect open (v1.7): beside the list
// when the panel is wide, as a dialog when it is not.

const US = "\x1f";
const PS = [
  ["abc123456789", "edge-proxy", "nginx:1.27", "running", "Up 2 hours", "0.0.0.0:80->80/tcp", "", "", "", "2026-10-07 10:00:00 +0000 UTC", "2 hours ago", "bridge"],
].map((row) => row.join(US));

const calls: string[] = [];
// Whether the events snapshot reports a crash loop (stage 3) — off but in its own test.
const crashing = vi.hoisted(() => ({ on: false }));
// Whether `ps` reports a compose stack (stage 5) — off but in its own test.
const stacked = vi.hoisted(() => ({ on: false }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  containerRun: vi.fn(async (_session: string, args: string[]) => {
    calls.push(args.join(" "));
    await new Promise((r) => setTimeout(r, 5));
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[1] === "version") return ok("29.0.1\n");
    if (args[1] === "ps" && args.includes("--filter")) return ok(["abc123456789", "edge-proxy", "running"].join(US));
    if (args[1] === "compose" && args.includes("ps")) return ok('{"Service":"api","ID":"abc123456789","Name":"shop-api-1","State":"running","Health":"","ExitCode":0}');
    if (args[1] === "compose" && args.includes("--services")) return ok("api\nworker\n");
    if (args[1] === "ps" && stacked.on)
      return ok(["abc123456789", "shop-api-1", "api:1", "running", "Up 2 hours", "", "shop", "api", "/srv/shop", "2026-10-07 10:00:00 +0000 UTC", "2 hours ago", "shop_default", "/srv/shop/compose.yaml", ""].join(US));
    if (args[1] === "ps") return ok(PS.join("\n"));
    if (args[1] === "images") return ok(["img111111111", "nginx", "1.27", "187MB", "2026-10-07 10:00:00 +0000 UTC"].join(US));
    if (args[1] === "history") return ok([`/bin/sh -c #(nop)  CMD ["nginx"]`, "0B", "9 days ago"].join(US) + "\n" + ["/bin/sh -c apt-get install nginx", "60MB", "9 days ago"].join(US));
    if (args[1] === "network" && args[2] === "ls") return ok(["n1", "web_default", "bridge", "local"].join(US));
    if (args[1] === "inspect") return ok('[{"Id":"abc123456789"}]');
    if (args[1] === "logs") return ok("GET /healthz 200");
    if (args[1] === "events") {
      if (!crashing.on) return ok("");
      const now = BigInt(Date.now()) * 1_000_000n;
      const die = (agoMs: number) => [String(now - BigInt(agoMs) * 1_000_000n), "die", "abc123456789ffff", "edge-proxy", "1", ""].join(US);
      return ok([die(30_000), die(90_000)].join("\n"));
    }
    if (args[1] === "system" && args.includes("-v")) return ok(JSON.stringify({ Images: [], Volumes: [], Containers: [], BuildCache: [] }));
    if (args[1] === "system") return ok('{"Active":"0","Reclaimable":"33.34GB (98%)","Size":"33.96GB","TotalCount":"143","Type":"Local Volumes"}');
    return ok("");
  }),
}));

import { flushSync } from "svelte";
import DockerPanel from "./DockerPanel.svelte";
import { resetDockState } from "../stores/dockstate.svelte";
import { resetListOrders } from "../stores/listview.svelte";
import { settings } from "../settings/settings.svelte";
import { hiddenFields, toggleField } from "../stores/colwidths.svelte";
import { panelSplits, resetPanelShares, setPanelShare } from "../stores/panelsplit.svelte";

/** Give the row the two parts share a width, as the browser's observer would
 *  report it (jsdom has no layout; Svelte binds the width through one). */
function sizeRow(part: HTMLElement, width: number) {
  const row = part.parentElement!;
  Object.defineProperty(row, "clientWidth", { configurable: true, value: width });
  const observers = (
    globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
  ).instances;
  for (const o of observers) o.cb([{ target: row }]);
}

/** Give the panel a width and let its observer see it (jsdom has no layout). */
function resize(width: number) {
  const root = document.querySelector<HTMLElement>("[data-wide]")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, value: width });
  const observers = (
    globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
  ).instances;
  for (const o of observers) o.cb([]);
}

async function mount(id: string) {
  render(DockerPanel, { props: { sessionId: id, visible: true, sessionReady: true } });
  await screen.findByText("edge-proxy");
}

beforeEach(() => {
  calls.length = 0;
  resetDockState();
  resetListOrders();
  resetPanelShares();
});

describe("DockerPanel — shared context controls", () => {
  it("keeps row actions and changes the header's grouping through nested View", async () => {
    await mount("d-menu-row");
    await fireEvent.contextMenu(screen.getByText("edge-proxy"));
    expect(screen.getByRole("menuitem", { name: "Inspect" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /^Groups:/ }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Status" }));
    expect(settings.listOrders["docker.containers"].group).toBe("state");
    expect(screen.queryByRole("menu")).toBeNull();
    await fireEvent.click(screen.getByTestId("docker-list-header-view"));
    expect(screen.getByRole("menuitem", { name: "Groups: Status" })).toBeInTheDocument();
  });

  it("offers search and reset on empty filtered space, without object actions", async () => {
    await mount("d-menu-filter");
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Status: All" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^running/ }));
    expect(screen.getByTestId("docker-list-header-funnel")).toHaveTextContent("1");
    const field = within(screen.getByTestId("docker-list-header")).getByRole("textbox");
    await fireEvent.input(field, { target: { value: "missing" } });
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    expect(screen.queryByRole("menuitem", { name: "Inspect" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Find in this list" }));
    expect(field).toHaveFocus();
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Filters" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Reset search and filters" }));
    expect(field).toHaveValue("");
    expect(screen.getByTestId("docker-list-header-funnel")).not.toHaveClass("text-accent");
    expect(screen.getByText("edge-proxy")).toBeInTheDocument();
  });

  it("offers columns only in the wide list and changes the same visibility setting", async () => {
    await mount("d-menu-columns");
    const list = screen.getByTestId("docker-list-part");
    await fireEvent.contextMenu(list);
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    expect(screen.queryByRole("menuitem", { name: "Columns" })).toBeNull();
    await fireEvent.keyDown(window, { key: "Escape" });
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 1200 });
    resize(1200);
    await fireEvent.contextMenu(list);
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
    const before = hiddenFields("docker.containers").includes("image");
    try {
      await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Image" }));
      expect(hiddenFields("docker.containers").includes("image")).toBe(!before);
    } finally {
      if (hiddenFields("docker.containers").includes("image") !== before) toggleField("docker.containers", "image");
    }
  });

  it("uses image controls after switching tabs and refreshes disk usage as the toolbar does", async () => {
    await mount("d-menu-images");
    await fireEvent.click(screen.getByRole("button", { name: "Images" }));
    await screen.findByTestId("docker-images-header");
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /^Groups:/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Repository" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Status" })).toBeNull();
    await fireEvent.keyDown(window, { key: "Escape" });
    const before = calls.filter((c) => c.startsWith("docker system df")).length;
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith("docker system df")).length).toBeGreaterThan(before));
  });

  it("switches the network graph through View and hides filters that do not apply to it", async () => {
    await mount("d-menu-net");
    await fireEvent.click(screen.getByTestId("docker-subtab-networks"));
    await screen.findByTestId("docker-net-header");
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    expect(screen.getByRole("menuitem", { name: "Filters" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Graph" }));
    expect(screen.queryByTestId("docker-net-header")).toBeNull();
    await fireEvent.contextMenu(screen.getByTestId("docker-list-part"));
    expect(screen.queryByRole("menuitem", { name: "Filters" })).toBeNull();
    await fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Graph" })).toHaveAttribute("aria-checked", "true");
    await fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "List" }));
    expect(screen.getByTestId("docker-net-header")).toBeInTheDocument();
  });
});

describe("DockerPanel — where a container's details open", () => {
  it("a narrow dock opens them as a dialog", async () => {
    await mount("d-narrow");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    // On the log (v1.33): it is what a container is opened for.
    expect(screen.getByRole("dialog")).toContainElement(screen.getByTestId("docker-log-tools"));
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });

  it("a wide panel opens them beside the list, which stays on screen", async () => {
    await mount("d-wide");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const side = screen.getByTestId("docker-side");
    expect(side).toContainElement(screen.getByTestId("docker-log-tools"));
    expect(screen.getByTestId("docker-list-part")).toContainElement(
      screen.getByRole("button", { name: "View details" }),
    );
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });

  it("the border between the list and the pane is there only while there are two parts", async () => {
    await mount("d-border");
    resize(1200);
    const list = screen.getByTestId("docker-list-part");
    // The list alone takes the whole row.
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(list.style.width).toBe("");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    // list | border | pane, in that order, and the list takes its share.
    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("data-split", "docker");
    expect(divider.previousElementSibling).toBe(list);
    expect(divider.nextElementSibling).toBe(screen.getByTestId("docker-side"));
    expect(list.style.width).toBe("50%");
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.queryByTestId("panel-divider")).toBeNull();
    expect(list.style.width).toBe("");
  });

  it("dragging the border gives the list or the pane more room, and it stays where it was left", async () => {
    await mount("d-drag");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const list = screen.getByTestId("docker-list-part");
    sizeRow(list, 1200);
    const divider = screen.getByTestId("panel-divider");
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600, clientY: 10 });
    await fireEvent.pointerMove(divider, { pointerId: 1, clientX: 420, clientY: 10 });
    await fireEvent.pointerUp(divider, { pointerId: 1, clientX: 420, clientY: 10 });
    expect(panelSplits.shares.docker).toBeCloseTo(0.35);
    expect(list.style.width).toBe("35%");
    // Closed and opened again — another container, another session: the same border.
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByTestId("docker-list-part").style.width).toBe("35%");
  });

  it("a share the row has no room for is drawn at the limit, not past it", async () => {
    setPanelShare("docker", 0.2);
    flushSync();
    await mount("d-limit");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const list = screen.getByTestId("docker-list-part");
    sizeRow(list, 800);
    // 240px of 800: the list keeps its minimum; what the user set is kept for a wider dock.
    await waitFor(() => expect(list.style.width).toBe("30%"));
    expect(panelSplits.shares.docker).toBe(0.2);
  });

  it("logs read in the pane are fetched like the dialog's, and fill it", async () => {
    await mount("d-logs");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await waitFor(() => expect(screen.getByTestId("docker-text")).toHaveTextContent("GET /healthz 200"));
    expect(calls.filter((c) => c.startsWith("docker logs"))).toHaveLength(1);
    expect(screen.getByTestId("docker-text")).toHaveClass("min-h-0", "flex-1");
  });

  it("inspect asked from the row's menu is the details' own view, not a second pane (v1.33)", async () => {
    await mount("d-text");
    resize(1200);
    await fireEvent.contextMenu(screen.getByRole("listitem"));
    const menu = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".fixed.z-50");
      expect(el).not.toBeNull();
      return el!;
    });
    await fireEvent.click(within(menu).getByText("Inspect"));
    const side = await screen.findByTestId("docker-side-detail");
    expect(within(side).getByTestId("docker-detail-tab-inspect").className).toContain("text-accent");
    await waitFor(() => expect(side).toHaveTextContent('"Id":"abc123456789"'));
    expect(screen.queryByTestId("docker-side-text")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a click on the row opens its details, and the row says it is the one open", async () => {
    await mount("d-row");
    resize(1200);
    await fireEvent.click(screen.getByText("edge-proxy"));
    expect(await screen.findByTestId("docker-side-detail")).toBeInTheDocument();
    expect(screen.getByTestId("docker-row")).toHaveAttribute("aria-current", "true");
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    expect(screen.getByTestId("docker-row")).not.toHaveAttribute("aria-current");
  });

  it("the list is laid out by its own width, not the panel's", async () => {
    await mount("d-own");
    resize(1200);
    const list = screen.getByTestId("docker-list-part");
    // A query container of its own: the rows' `@wide:` reads the list.
    expect(list).toHaveClass("@container");
    await waitFor(() => expect(document.querySelector("[data-wide]")).toHaveAttribute("data-wide", "true"));
    // jsdom gives the list no width: as narrow as the details beside it can make it.
    expect(list).toHaveAttribute("data-list-wide", "false");
    Object.defineProperty(list, "clientWidth", { configurable: true, value: 1200 });
    resize(1200);
    await waitFor(() => expect(list).toHaveAttribute("data-list-wide", "true"));
  });

  it("details that are open follow the panel across the threshold", async () => {
    await mount("d-cross");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    resize(1200);
    await waitFor(() => expect(screen.getByTestId("docker-side")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull();
    resize(400);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });

  it("…and keep the view they were on: Logs stays Logs, not Overview again (v1.17)", async () => {
    await mount("d-keep");
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.click(screen.getByTestId("docker-detail-tab-logs"));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("GET /healthz 200"));
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();

    // Narrow → wide: the dialog gives way to the pane, on the same view.
    resize(1200);
    const side = await screen.findByTestId("docker-side");
    expect(within(side).queryByTestId("docker-detail-overview")).toBeNull();
    await waitFor(() => expect(side).toHaveTextContent("GET /healthz 200"));
    expect(within(side).getByTestId("docker-detail-tab-logs").className).toContain("text-accent");

    // Wide → narrow: back in the dialog, still the logs.
    await fireEvent.click(within(side).getByTestId("docker-detail-tab-inspect"));
    resize(400);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByTestId("docker-detail-overview")).toBeNull();
    await waitFor(() => expect(dialog).toHaveTextContent('"Id":"abc123456789"'));
  });

  it("…and the log reads on as it was: its filter and its lines survive the threshold (v1.34)", async () => {
    await mount("d-log-cross");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const side = await screen.findByTestId("docker-side");
    await fireEvent.input(within(side).getByRole("textbox", { name: "Filter lines" }), { target: { value: "healthz" } });
    await fireEvent.change(within(side).getByTestId("docker-log-tail"), { target: { value: "1000" } });
    resize(400);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Filter lines" }).value).toBe("healthz");
    expect(within(dialog).getByTestId<HTMLSelectElement>("docker-log-tail").value).toBe("1000");
    await waitFor(() => expect(calls).toContain("docker logs --tail 1000 --timestamps abc123456789"));
  });

  it("a terminal-tab switch rebuilds the panel: the details come back open, on their view, with the log as it was read (v1.34)", async () => {
    const first = render(DockerPanel, { props: { sessionId: "d-back", visible: true, sessionReady: true } });
    await screen.findByText("edge-proxy");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    const side = await screen.findByTestId("docker-side");
    await fireEvent.click(within(side).getByTestId("docker-log-live"));
    await fireEvent.click(within(side).getByTestId("docker-detail-tab-inspect"));
    first.unmount();

    render(DockerPanel, { props: { sessionId: "d-back", visible: true, sessionReady: true } });
    // The row, and — once the first poll finds it — the pane's title.
    await screen.findAllByText("edge-proxy");
    resize(1200);
    const again = await screen.findByTestId("docker-side");
    await waitFor(() => expect(again).toHaveTextContent('"Id":"abc123456789"'));
    expect(within(again).getByTestId("docker-detail-tab-inspect").className).toContain("text-accent");
    await fireEvent.click(within(again).getByTestId("docker-detail-tab-logs"));
    // Held still before the switch, held still after it.
    expect(within(again).getByTestId("docker-log-live")).toHaveAttribute("aria-pressed", "false");
  });

  it("…and another session's panel opens nothing of it", async () => {
    const first = render(DockerPanel, { props: { sessionId: "d-mine", visible: true, sessionReady: true } });
    await screen.findByText("edge-proxy");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await screen.findByTestId("docker-side");
    first.unmount();
    render(DockerPanel, { props: { sessionId: "d-other", visible: true, sessionReady: true } });
    await screen.findByText("edge-proxy");
    resize(1200);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("docker-side")).toBeNull();
  });

  it("details opened anew start from the log", async () => {
    await mount("d-anew");
    resize(1200);
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    await fireEvent.click(screen.getByTestId("docker-detail-tab-overview"));
    expect(screen.getByTestId("docker-detail-overview")).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId("side-pane-close"));
    await fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.queryByTestId("docker-detail-overview")).toBeNull();
    expect(screen.getByTestId("docker-log-tools")).toBeInTheDocument();
  });
});

describe("DockerPanel — the list's filter row (v1.29)", () => {
  it("the field narrows the containers, and an empty result says why and drops the filter", async () => {
    await mount("d-filter");
    const field = screen.getByRole("textbox", { name: "Name, image, port" });
    await fireEvent.input(field, { target: { value: "nothing-like-it" } });
    expect(await screen.findByText("Nothing matches the filter")).toBeInTheDocument();
    expect(screen.getByText("«nothing-like-it»")).toBeInTheDocument();
    expect(screen.queryByText("edge-proxy")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(await screen.findByText("edge-proxy")).toBeInTheDocument();
  });

  it("the filter is the session's: another session's panel starts unfiltered", async () => {
    await mount("d-one");
    await fireEvent.input(screen.getByRole("textbox", { name: "Name, image, port" }), { target: { value: "zzz" } });
    expect(await screen.findByText("Nothing matches the filter")).toBeInTheDocument();
    document.body.innerHTML = "";
    await mount("d-two");
    expect(screen.getByRole("textbox", { name: "Name, image, port" })).toHaveValue("");
  });

  it("a group folds by its header", async () => {
    await mount("d-fold");
    const toggle = within(screen.getByTestId("docker-group")).getByTestId("docker-group-toggle");
    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("edge-proxy")).toBeNull();
    await fireEvent.click(toggle);
    expect(await screen.findByText("edge-proxy")).toBeInTheDocument();
  });
});

describe("DockerPanel — several containers and the disk (stage 2)", () => {
  it("picked containers get one action, and its confirmation names them", async () => {
    await mount("d-bulk");
    await fireEvent.click(screen.getByTestId("docker-row-pick"));
    const bar = screen.getByTestId("docker-picked-bar");
    expect(bar).toHaveTextContent("Picked: 1");
    // Running: it can be stopped, not started.
    expect(screen.getByTestId("docker-picked-start")).toBeDisabled();
    await fireEvent.click(screen.getByTestId("docker-picked-stop"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("docker stop edge-proxy");
    await fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(calls).toContain("docker stop abc123456789"));
    await fireEvent.click(screen.getByTestId("docker-picked-clear"));
    expect(screen.queryByTestId("docker-picked-bar")).toBeNull();
  });

  it("the images view says what the disk holds — asked when it opens, not on every poll", async () => {
    await mount("d-disk");
    expect(calls.some((c) => c.startsWith("docker system df"))).toBe(false);
    await fireEvent.click(screen.getByTestId("docker-subtab-images"));
    await waitFor(() => expect(screen.getByTestId("docker-disk-volumes")).toHaveTextContent("33.96GB"));
    expect(screen.getByTestId("docker-disk-volumes")).toHaveTextContent("33.34GB (98%) can be freed");
    expect(calls.filter((c) => c === "docker system df --format {{json .}}")).toHaveLength(1);
  });
});

describe("DockerPanel — what happened lately (stage 3)", () => {
  it("a container its restart policy keeps bringing back is named, though every poll sees it running", async () => {
    crashing.on = true;
    render(DockerPanel, { props: { sessionId: "d-loop", visible: true, sessionReady: true } });
    const strip = await screen.findByTestId("docker-attention");
    expect(strip).toHaveTextContent("Crashing and restarting");
    expect(strip).toHaveTextContent("2× · exit 1");
    // A snapshot that ends, asked with the containers' poll.
    expect(calls.some((c) => c.startsWith("docker events --since 10m --until 0s"))).toBe(true);
    crashing.on = false;
  });
});

describe("DockerPanel — the column of names (stage 4)", () => {
  it("goes on with images, networks and volumes while details stand beside it, and opens an image's", async () => {
    await mount("d-tree");
    expect(screen.queryByTestId("docker-tree-sections")).toBeNull();
    resize(1200);
    await fireEvent.click(screen.getByText("edge-proxy"));
    const sections = await screen.findByTestId("docker-tree-sections");
    await fireEvent.click(within(screen.getByTestId("docker-tree-images")).getByTestId("docker-tree-images-toggle"));
    await fireEvent.click(await within(sections).findByTestId("docker-tree-image"));
    const side = await screen.findByTestId("docker-side-item");
    await waitFor(() => expect(within(side).getByTestId("docker-image-layers")).toHaveTextContent("apt-get install nginx"));
    expect(within(side).getByTestId("docker-image-users")).toHaveTextContent("edge-proxy");
    // A user of the image opens that container's details in its place.
    await fireEvent.click(within(within(side).getByTestId("docker-image-users")).getByText("edge-proxy"));
    expect(await screen.findByTestId("docker-side-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("docker-side-item")).toBeNull();
  });

  it("an image's details open beside the list come back after a terminal-tab switch (v1.34)", async () => {
    const first = render(DockerPanel, { props: { sessionId: "d-tree-back", visible: true, sessionReady: true } });
    await screen.findByText("edge-proxy");
    resize(1200);
    await fireEvent.click(screen.getByText("edge-proxy"));
    const sections = await screen.findByTestId("docker-tree-sections");
    await fireEvent.click(within(screen.getByTestId("docker-tree-images")).getByTestId("docker-tree-images-toggle"));
    await fireEvent.click(await within(sections).findByTestId("docker-tree-image"));
    await screen.findByTestId("docker-side-item");
    first.unmount();

    render(DockerPanel, { props: { sessionId: "d-tree-back", visible: true, sessionReady: true } });
    await screen.findByText("edge-proxy");
    resize(1200);
    const side = await screen.findByTestId("docker-side-item");
    await waitFor(() => expect(within(side).getByTestId("docker-image-layers")).toHaveTextContent("apt-get install nginx"));
  });
});

describe("DockerPanel — a compose stack's details (stage 5)", () => {
  it("open from the stack's header — as a dialog where there is no room beside the list", async () => {
    stacked.on = true;
    render(DockerPanel, { props: { sessionId: "d-stack", visible: true, sessionReady: true } });
    await screen.findByText("shop-api-1");
    await fireEvent.click(screen.getByTestId("docker-stack-open"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("docker-stack-detail")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getAllByTestId("docker-stack-service")).toHaveLength(2));
    expect(within(dialog).getAllByTestId("docker-stack-service")[1]).toHaveTextContent("not created");
    stacked.on = false;
  });
});
