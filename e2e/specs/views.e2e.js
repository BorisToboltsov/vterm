// Files inside their connection (ADR 0024): a file opens under its server's
// tab, is dragged beside the terminal — and cannot be dragged out of its
// connection, — a second one stands beside the first, and the connection
// takes its zones along to another window. On the real app: a real shell,
// real files, the editor reading them through the backend, a pointer that
// presses and moves.
//
// It needs no server: the connection is a local shell, the files are made by it.

import {
  TEXT,
  connectionArea,
  dragView,
  editorsOnScreen,
  openShell,
  run,
  tabIds,
  tabMenu,
  typeLine,
  viewMenu,
  viewZones,
  windowCount,
  windowWithOnly,
  windowWithoutTabs,
} from "../support/tabs.js";

/** A view's name with the terminal's label in either language made one. */
const plain = (zones) =>
  zones.map((zone) =>
    zone.map((view) => (TEXT.terminal.includes(view.replace(/\*/g, "")) ? view.replace(/^[^*]+/, "T") : view)),
  );

const zonesAre = (want, what) =>
  browser.waitUntil(async () => JSON.stringify(plain(await viewZones())) === JSON.stringify(want), {
    timeout: 15000,
    timeoutMsg: what,
  });

/** Bring the file panel on screen: its dock starts folded, and a folded dock's
 *  tabs are there but out of reach. */
async function showFilePanel() {
  await browser.execute(() => {
    const list = document.querySelector('[data-testid="localfiles-list"]');
    if (!list || list.getBoundingClientRect().width < 50) {
      document.querySelector('[data-testid="dock-toggle-right"]')?.click();
    }
  });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        document.querySelector('[data-testid="dock-tab-files"]')?.click();
        const list = document.querySelector('[data-testid="localfiles-list"]');
        return !!list && list.getBoundingClientRect().width >= 50;
      }),
    { timeout: 15000, interval: 500, timeoutMsg: "the file panel did not open" },
  );
}

/** Open a file of the local file panel by its name. */
async function openFile(name) {
  const row = await $(`//*[@data-testid="localfiles-list"]//*[@role="treeitem"][contains(., "${name}")]`);
  await row.waitForExist({ timeout: 15000, timeoutMsg: `${name} is not in the file panel` });
  await row.doubleClick();
}

describe("vterm — files inside their connection", () => {
  let tab;

  before(async () => {
    // Room for two zones side by side next to the docks.
    await browser.setWindowRect(0, 0, 1500, 950);
  });

  it("a file opens under its connection's tab, in place of the terminal", async () => {
    tab = await openShell();
    // The files, made by the shell the connection is.
    await typeLine("echo one > vt1.txt");
    await typeLine("echo two > vt2.txt");
    await run("made");
    // No file open: no strip of views, the terminal has the whole area.
    expect(await viewZones()).toEqual([]);

    await showFilePanel();
    await openFile("vt1.txt");
    await zonesAre([["T", "vt1.txt*"]], "the file did not open as a view of its connection");
    await browser.waitUntil(async () => (await editorsOnScreen()).join().includes("one"), {
      timeout: 15000,
      timeoutMsg: "the editor did not read the file",
    });
    // The strip above still holds connections only.
    expect(await tabIds()).toEqual([tab]);
  });

  it("a file cannot be dragged out of its connection: nothing is offered there, and letting go changes nothing", async () => {
    const area = await connectionArea();
    // Over the file panel, right of the connection.
    const outside = { x: area.x + area.w + 120, y: area.y + area.h / 2 };
    const [out] = await dragView("vt1.txt", [outside]);
    expect(out.tint).toBeNull();
    // The label stopped at the connection's edge instead of following the pointer.
    expect(out.label).not.toBeNull();
    expect(out.label.x + out.label.w).toBeLessThanOrEqual(area.x + area.w);
    expect(out.label.x).toBeGreaterThanOrEqual(area.x);
    await browser.pause(300);
    expect(plain(await viewZones())).toEqual([["T", "vt1.txt*"]]);
  });

  it("dragged to the edge of its connection, a file stands beside the terminal — and the shell still answers", async () => {
    const area = await connectionArea();
    const edge = { x: area.x + area.w - 40, y: area.y + area.h / 2 };
    const [at] = await dragView("vt1.txt", [edge]);
    // While it was in the air: the half it would take was shown, nothing moved yet.
    expect(at.label).not.toBeNull();
    expect(at.tint).not.toBeNull();
    expect(at.tint.x).toBeGreaterThan(area.x + area.w / 2 - 8);
    expect(at.tint.x + at.tint.w).toBeLessThanOrEqual(area.x + area.w + 1);
    await zonesAre([["T*"], ["vt1.txt*"]], "the file did not go beside the terminal");
    // The preview is gone with the drag.
    expect(
      await browser.execute(
        () => !!document.querySelector('[data-testid="view-drag-ghost"], [data-testid="pane-drop-zone"]'),
      ),
    ).toBe(false);
    await run("beside");
    expect((await editorsOnScreen()).join()).toContain("one");
  });

  it("a second file joins the files — not the terminal one types in — and stands beside the first", async () => {
    // `run` left the terminal's zone in focus.
    await openFile("vt2.txt");
    await zonesAre([["T*"], ["vt1.txt", "vt2.txt*"]], "the second file covered the terminal");
    await viewMenu("vt2.txt", TEXT.besideBelow);
    await zonesAre([["T*"], ["vt1.txt*"], ["vt2.txt*"]], "the files did not stand beside each other");
    const shown = await editorsOnScreen();
    expect(shown).toHaveLength(2);
    expect(shown.join("|")).toContain("one");
    expect(shown.join("|")).toContain("two");
    await run("three");
  });

  it("the connection moves to another window with its zones and its files", async () => {
    await tabMenu(tab, TEXT.newWindow);
    await windowCount(2, "the second window did not open");
    await windowWithoutTabs();
    await windowWithOnly(tab);
    await zonesAre([["T*"], ["vt1.txt*"], ["vt2.txt*"]], "the zones did not come along");
    const shown = await editorsOnScreen();
    expect(shown.join("|")).toContain("one");
    expect(shown.join("|")).toContain("two");
    // The shell came too, and the zones join back into one — showing the view
    // that was in focus, the terminal just typed into.
    await run("moved");
    await viewMenu("vt2.txt", TEXT.joinZones);
    await zonesAre([["T*", "vt1.txt", "vt2.txt"]], "the zones did not join");
  });
});
