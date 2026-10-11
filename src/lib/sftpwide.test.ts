import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrepOutcome } from "./sync";

// The wide layout of the file panel (v1.17): what a narrow panel stacks over
// and under the listing — the content search and the transfers — stands in a
// column beside it. Rendered through the SFTP panel, which has both.

const sftpGrep = vi.fn();
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sftpList: vi.fn(async () => []),
  sftpHome: vi.fn(async () => "/etc/nginx"),
  sftpGrep: (...a: unknown[]) => sftpGrep(...a),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import SftpPanel from "./SftpPanel.svelte";
import { applyProgress, clearTransfers } from "./stores/transfers.svelte";
import { panelSplits, resetPanelShares } from "./stores/panelsplit.svelte";

const FOUND: GrepOutcome = {
  matches: [
    { path: "conf.d/api.conf", line: 12, text: "    proxy_pass http://upstream_api;" },
    { path: "upstreams.conf", line: 1, text: "upstream upstream_api {" },
    { path: "conf.d/api.conf", line: 31, text: "    proxy_next_upstream error timeout;" },
  ],
  truncated: false,
  failed: false,
};

const onOpenFile = vi.fn();

async function connected() {
  render(SftpPanel, { props: { embedded: true, sessionId: "s1", sessionReady: true, onOpenFile } });
  await userEvent.click(screen.getByText(/connect/i));
  await screen.findByTestId("sftp-row");
}

/** Give an element a width and let the observers see it (jsdom has no layout). */
function setWidth(el: HTMLElement, width: number) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  const observers = (
    globalThis.ResizeObserver as unknown as { instances: { cb: (entries: unknown[]) => void }[] }
  ).instances;
  for (const o of observers) o.cb([{ target: el }]);
}
/** The panel `panelWidth` px wide, its row `rowWidth` px wide. */
async function layout(panelWidth: number, rowWidth = panelWidth) {
  const root = document.querySelector<HTMLElement>("[data-wide]")!;
  setWidth(root, panelWidth);
  await waitFor(() => expect(root.dataset.wide).toBe(String(panelWidth >= 768)));
  setWidth(screen.getByTestId("sftp-row"), rowWidth);
}
async function search(query: string) {
  await fireEvent.input(screen.getByTestId("sftp-search-input"), { target: { value: query } });
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByTestId("grep-results");
}
const openSearch = () => userEvent.click(screen.getByRole("button", { name: "Search file contents (grep)" }));
const transfer = (id: string, name: string) =>
  applyProgress({ id, name, direction: "upload", transferred: 10, total: 100, done: false });

beforeEach(() => {
  resetPanelShares();
  sftpGrep.mockReset().mockResolvedValue(FOUND);
  onOpenFile.mockReset();
});
afterEach(() => clearTransfers());

describe("the content search", () => {
  it("narrow: the field and the results stand under the path bar, as they did", async () => {
    await connected();
    await openSearch();
    expect(screen.getByTestId("sftp-search-inline")).toBeInTheDocument();
    expect(screen.queryByTestId("sftp-side")).toBeNull();
    await search("upstream");
    expect(within(screen.getByTestId("sftp-search-inline")).getByTestId("grep-results")).toBeInTheDocument();
    // In a narrow panel the list of results is a box of bounded height.
    expect(screen.getByTestId("grep-list").className).toContain("max-h-48");
  });

  it("groups the results by file, numbers the lines and marks what was searched for", async () => {
    await connected();
    await openSearch();
    await search("upstream");
    expect(screen.getByTestId("grep-summary").textContent?.trim()).toBe("Matches: 3 · files: 2");
    const files = screen.getAllByTestId("grep-file").map((f) => f.textContent?.replace(/\s+/g, " ").trim());
    expect(files).toEqual(["conf.d/api.conf · 2", "upstreams.conf · 1"]);
    const lines = screen.getAllByTestId("grep-line");
    expect(lines.map((l) => l.firstElementChild?.textContent)).toEqual(["12", "31", "1"]);
    // The indentation is dropped; every occurrence is marked.
    expect(lines[0].lastElementChild?.textContent).toBe("proxy_pass http://upstream_api;");
    expect([...lines[2].querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["upstream", "upstream"]);
  });

  it("a line opens its file on that line; the file's row opens it on its first match", async () => {
    await connected();
    await openSearch();
    await search("upstream");
    await userEvent.click(screen.getAllByTestId("grep-line")[1]);
    expect(onOpenFile).toHaveBeenLastCalledWith("/etc/nginx/conf.d/api.conf", "api.conf", 31);
    await userEvent.click(screen.getAllByTestId("grep-file")[1]);
    expect(onOpenFile).toHaveBeenLastCalledWith("/etc/nginx/upstreams.conf", "upstreams.conf", 1);
  });

  it("says when the answer was cut at the limit", async () => {
    sftpGrep.mockResolvedValue({ ...FOUND, truncated: true });
    await connected();
    await openSearch();
    await search("upstream");
    expect(screen.getByTestId("grep-truncated").textContent).toContain("first 1000");
  });

  it("a search that did not run is an error — never 'no matches'", async () => {
    sftpGrep.mockResolvedValue({ matches: [], truncated: false, failed: true });
    await connected();
    await openSearch();
    await search("(");
    expect(screen.getByTestId("grep-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("grep-empty")).toBeNull();
  });

  it("matches with an error: the result is shown, and said to be possibly incomplete", async () => {
    sftpGrep.mockResolvedValue({ ...FOUND, failed: true });
    await connected();
    await openSearch();
    await search("upstream");
    expect(screen.getAllByTestId("grep-line")).toHaveLength(3);
    expect(screen.getByTestId("grep-partial")).toBeInTheDocument();
    expect(screen.queryByTestId("grep-failed")).toBeNull();
  });

  it("nothing found, and the search did run: 'no matches'", async () => {
    sftpGrep.mockResolvedValue({ matches: [], truncated: false, failed: false });
    await connected();
    await openSearch();
    await search("zzz");
    expect(screen.getByTestId("grep-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("grep-failed")).toBeNull();
  });

  it("a call that failed outright is a search that did not run too", async () => {
    sftpGrep.mockRejectedValue("session closed");
    await connected();
    await openSearch();
    await search("upstream");
    expect(screen.getByTestId("grep-failed")).toBeInTheDocument();
  });

  it("the marks belong to the search that ran, not to what the field says now", async () => {
    await connected();
    await openSearch();
    await search("upstream");
    await fireEvent.input(screen.getByTestId("sftp-search-input"), { target: { value: "proxy" } });
    expect([...screen.getAllByTestId("grep-line")[0].querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
      "upstream",
    ]);
  });
});

describe("a wide file panel", () => {
  it("puts the search in a pane beside the listing, which keeps its place", async () => {
    await connected();
    await layout(1200);
    expect(screen.queryByTestId("sftp-side")).toBeNull();
    await openSearch();

    const side = await screen.findByTestId("sftp-side");
    expect(screen.queryByTestId("sftp-search-inline")).toBeNull();
    const pane = within(side).getByTestId("sftp-side-search");
    expect(within(pane).getByTestId("sftp-search-input")).toBeInTheDocument();
    // The listing takes its share of the row; the border between them is dragged.
    const main = screen.getByTestId("sftp-main");
    expect(main.style.width).toBe("62%");
    const border = screen.getByTestId("panel-divider");
    expect(border).toHaveAttribute("data-split", "files");
    expect(border.previousElementSibling).toBe(main);
    expect(border.nextElementSibling).toBe(side);

    await search("upstream");
    // In the pane the results take its height instead of a bounded box.
    expect(screen.getByTestId("grep-list").className).not.toContain("max-h-48");
    expect(screen.getByTestId("grep-list").className).toContain("flex-1");
  });

  it("closing the pane closes the search and gives the listing the row back", async () => {
    await connected();
    await layout(1200);
    await openSearch();
    await userEvent.click(within(await screen.findByTestId("sftp-side")).getByTestId("side-pane-close"));
    await waitFor(() => expect(screen.queryByTestId("sftp-side")).toBeNull());
    expect(screen.getByTestId("sftp-main").style.width).toBe("");
    expect(screen.queryByTestId("sftp-search-inline")).toBeNull();
  });

  it("the results survive the panel going narrow and wide again", async () => {
    await connected();
    await layout(1200);
    await openSearch();
    await search("upstream");
    await layout(500);
    await waitFor(() => expect(screen.queryByTestId("sftp-side")).toBeNull());
    expect(within(screen.getByTestId("sftp-search-inline")).getAllByTestId("grep-line")).toHaveLength(3);
    await layout(1200);
    expect(within(await screen.findByTestId("sftp-side")).getAllByTestId("grep-line")).toHaveLength(3);
    // Moving it asked the host nothing again.
    expect(sftpGrep).toHaveBeenCalledOnce();
  });

  it("the transfers stand beside the listing too — and only while there are any", async () => {
    await connected();
    await layout(1200);
    expect(screen.queryByTestId("sftp-side")).toBeNull();
    transfer("t1", "release.tar.gz");

    const side = await screen.findByTestId("sftp-side");
    expect(within(side).getByTestId("sftp-side-footer")).toHaveTextContent("release.tar.gz");
    expect(within(side).queryByTestId("sftp-side-search")).toBeNull();
    // Not under the listing as well.
    expect(within(screen.getByTestId("sftp-main")).queryByText("release.tar.gz")).toBeNull();

    clearTransfers();
    await waitFor(() => expect(screen.queryByTestId("sftp-side")).toBeNull());
  });

  it("the search and the transfers share the column: the search above, the transfers under it", async () => {
    await connected();
    await layout(1200);
    await openSearch();
    transfer("t1", "release.tar.gz");
    const side = await screen.findByTestId("sftp-side");
    const footer = await within(side).findByTestId("sftp-side-footer");
    const pane = within(side).getByTestId("sftp-side-search");
    expect(pane.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Under the search the transfers take at most a part of the column.
    expect(footer.className).toContain("max-h-[45%]");
  });

  it("wide, but the row cannot hold both: nothing is squeezed beside the listing", async () => {
    await connected();
    await layout(1200, 479);
    await openSearch();
    transfer("t1", "release.tar.gz");
    expect(await screen.findByTestId("sftp-search-inline")).toBeInTheDocument();
    expect(screen.queryByTestId("sftp-side")).toBeNull();
    expect(within(screen.getByTestId("sftp-main")).getByText("release.tar.gz")).toBeInTheDocument();
    // Room appears: both move beside.
    setWidth(screen.getByTestId("sftp-row"), 480);
    expect(await screen.findByTestId("sftp-side")).toBeInTheDocument();
  });

  it("a narrow panel keeps both where they were, however wide its row", async () => {
    await connected();
    await layout(700);
    await openSearch();
    transfer("t1", "release.tar.gz");
    expect(await screen.findByTestId("sftp-search-inline")).toBeInTheDocument();
    expect(screen.queryByTestId("sftp-side")).toBeNull();
  });

  it("the border has a share of its own", async () => {
    await connected();
    await layout(1200, 1000);
    await openSearch();
    const border = await screen.findByTestId("panel-divider");
    border.setPointerCapture = vi.fn();
    border.releasePointerCapture = vi.fn();
    await fireEvent.pointerDown(border, { pointerId: 1, clientX: 620, clientY: 10 });
    await fireEvent.pointerMove(border, { pointerId: 1, clientX: 500, clientY: 10 });
    await fireEvent.pointerUp(border, { pointerId: 1, clientX: 500, clientY: 10 });
    expect(panelSplits.shares.files).toBeCloseTo(0.5);
    expect(screen.getByTestId("sftp-main").style.width).toBe("50%");
  });
});
