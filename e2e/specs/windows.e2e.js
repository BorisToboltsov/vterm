// Two real windows (ADR 0017, 0018, 0023): a tab moves into a window of its
// own and back, and a pane moves whole — each a real session handed from one
// WebView to another through the backend.
//
// This is the part no unit test reaches: two WebViews with separate memory, the
// backend holding a session's output while its tab is on the way, and a
// terminal in the other window restoring the screen before it takes the
// session over. It needs no server: the tabs are local shells.

import {
  TEXT,
  openShell,
  run,
  seen,
  showTab,
  strips,
  tabMenu,
  windowCount,
  windowWithOnly,
  windowWithTab,
  windowWithoutTabs,
} from "../support/tabs.js";

describe("vterm — a tab between two windows", () => {
  let first;

  it("a local shell runs a command in the main window", async () => {
    first = await openShell();
    await run("alpha");
    expect(await seen("alpha")).toBe(2);
  });

  it("the tab moves to a window of its own, with its screen and its session", async () => {
    await tabMenu(first, TEXT.newWindow);
    await windowCount(2, "the second window did not open");
    // The main window gave the tab up…
    await windowWithoutTabs();
    // …and the new one has it, showing what the terminal showed before the move.
    await windowWithTab(first);
    await browser.waitUntil(async () => (await seen("alpha")) === 2, {
      timeout: 15000,
      timeoutMsg: "the terminal's screen did not come along",
    });
    // The session came too: the same shell answers in the new window.
    await run("beta");
  });

  it("the tab moves back, and the window opened for it closes behind it", async () => {
    await tabMenu(first, TEXT.toMain);
    await windowCount(1, "the emptied window did not close");
    await windowWithTab(first);
    // Everything printed in either window is on the screen, once.
    expect(await seen("alpha")).toBe(2);
    expect(await seen("beta")).toBe(2);
    await run("omega");
  });

  it("a pane moves whole: every tab, in its order, showing the tab it showed", async () => {
    const second = await openShell();
    await run("midway");
    const third = await openShell();
    await run("third");
    // The middle tab is the one the pane shows when it goes.
    await showTab(second);
    await tabMenu(second, TEXT.wholePane, TEXT.newWindow);

    await windowCount(2, "no window opened for the pane");
    // The pane has gone once the window it left has nothing: it goes a tab at
    // a time, and until the last one both windows have some of it.
    await windowWithoutTabs();
    await windowWithOnly(first, second, third);
    expect(await strips()).toEqual([
      [
        { id: first, shown: false },
        { id: second, shown: true },
        { id: third, shown: false },
      ],
    ]);
    expect(await seen("midway")).toBe(2);
    // A tab that arrived unseen restored its own screen, and its shell answers.
    await showTab(third);
    await browser.waitUntil(async () => (await seen("third")) === 2, {
      timeout: 15000,
      timeoutMsg: "a tab that arrived unseen lost its screen",
    });
    await run("delta");
  });
});
