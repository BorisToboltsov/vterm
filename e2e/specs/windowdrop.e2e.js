// A tab dropped on another window with the real pointer (ADR 0018) — Linux on
// X11, where the X server is asked what the pointer is over (winhit.rs).
//
// WebDriver cannot do this: its pointer lives inside one page, and the whole
// point is a pointer that leaves a window. So the X server's own pointer is
// moved, with `xdotool` — the events reach the app the way a mouse's do.
//
// Runs where there is an X server to move a pointer on and `xdotool` to move it
// (the Linux box, `pnpm e2e:linux`); skipped elsewhere, CI's runner included —
// a test that drives the pointer of a screen is not one to gate a release on
// before it has earned it.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  TEXT,
  openShell,
  strips,
  tabIds,
  tabMenu,
  windowCount,
  windowWithOnly,
} from "../support/tabs.js";

const canDrive =
  process.platform === "linux" &&
  !!process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY &&
  spawnSync("xdotool", ["version"]).status === 0;
// A window of another application to put on top of ours.
const hasClock = canDrive && spawnSync("xclock", ["-help"]).error === undefined;

const xdo = (...args) => execFileSync("xdotool", args.map(String));
const panes = async () => (await strips()).map((pane) => pane.map((tab) => tab.id));

/** A point of the current window's page, on the screen. The windows here have
 *  no frame of the system's (ADR 0011): the page starts where the window does. */
async function onScreen(pick, ...args) {
  const at = await browser.execute(pick, ...args);
  const rect = await browser.getWindowRect();
  return { x: Math.round(rect.x + at.x), y: Math.round(rect.y + at.y) };
}

const middleOfTab = (id) =>
  onScreen((tab) => {
    const box = document.querySelector(`[data-tab="${tab}"]`).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, id);

/** A point of the terminal this window shows, at shares of its width and height. */
const inTerminal = (fx, fy) =>
  onScreen(
    (sx, sy) => {
      const box = [...document.querySelectorAll(".xterm")]
        .find((term) => getComputedStyle(term).visibility === "visible")
        .getBoundingClientRect();
      return { x: box.left + box.width * sx, y: box.top + box.height * sy };
    },
    fx,
    fy,
  );

/** Press on `from`, carry to `to` in steps a hand could make, and let go. */
async function drag(from, to, steps = 24) {
  xdo("mousemove", from.x, from.y);
  await browser.pause(150);
  xdo("mousedown", 1);
  await browser.pause(150);
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    xdo("mousemove", x, y);
    await browser.pause(60);
  }
  // Held over the target for a moment: the window under the pointer is asked
  // on a move, and answers a beat later.
  await browser.pause(500);
  xdo("mouseup", 1);
}

(canDrive ? describe : describe.skip)("vterm — a tab dropped on another window (X11)", () => {
  let stays;
  let travels;
  let main;
  let second;

  before(async () => {
    // Two windows side by side, each with one local shell.
    stays = await openShell();
    travels = await openShell();
    await tabMenu(travels, TEXT.newWindow);
    await windowCount(2, "the second window did not open");
    main = await windowWithOnly(stays);
    await browser.setWindowRect(0, 0, 780, 900);
    second = await windowWithOnly(travels);
    await browser.setWindowRect(800, 0, 780, 900);
    await browser.pause(800);
  });

  (hasClock ? it : it.skip)(
    "over a window of another application lying on ours, the tab goes nowhere",
    async () => {
      // A clock over the whole side of the main window the tab comes in by: the
      // X server sees it, a rectangle would not. (Over a part of the main
      // window left bare the tab WOULD be over it, and bring it to the front.)
      const clock = spawn("xclock", ["-geometry", "500x900+280+0"], { stdio: "ignore" });
      try {
        await browser.pause(1500);
        await browser.switchToWindow(second);
        const from = await middleOfTab(travels);
        await drag(from, { x: 520, y: 450 });
        await browser.pause(1500);
        // Not in the window the clock covers — and its own window may not open
        // a new one for its only tab: it stays where it was.
        await browser.switchToWindow(main);
        expect(await tabIds()).toEqual([stays]);
        await browser.switchToWindow(second);
        expect(await tabIds()).toEqual([travels]);
      } finally {
        clock.kill();
        await browser.pause(500);
      }
    },
  );

  it("dropped at the edge of a pane of the other window, it lands there as a pane of its own", async () => {
    await browser.switchToWindow(main);
    const to = await inTerminal(0.92, 0.5);
    await browser.switchToWindow(second);
    const from = await middleOfTab(travels);
    await drag(from, to);

    // The window it left had no other tab and closes behind it…
    await windowCount(1, "the tab did not leave its window");
    // …and the main one has it in a new pane on the right: the pointer's place
    // in the window was read exactly, not just "which window".
    await browser.switchToWindow(main);
    await browser.waitUntil(async () => (await tabIds()).length === 2, {
      timeout: 15000,
      timeoutMsg: "the tab did not arrive",
    });
    expect(await panes()).toEqual([[stays], [travels]]);
  });
});
