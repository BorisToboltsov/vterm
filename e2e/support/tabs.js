// What the specs about windows share: reading a window's tabs, finding a
// window by what it shows, and driving a tab's menu.
//
// The windows are told apart by what they show, never by the order of their
// handles — WebDriver promises no order.

export const testid = (id) => $(`[data-testid="${id}"]`);

/** Session tabs of the current window, pane by pane, in strip order. */
export async function strips() {
  return browser.execute(() =>
    [...document.querySelectorAll('[role="tablist"]')]
      .map((list) =>
        [...list.querySelectorAll("[data-tab]:not([data-doc])")].map((tab) => ({
          id: tab.getAttribute("data-tab"),
          shown: tab.getAttribute("aria-selected") === "true",
        })),
      )
      .filter((pane) => pane.length > 0),
  );
}

export const tabIds = async () => (await strips()).flat().map((tab) => tab.id);

/**
 * What the terminal this window shows has on its screen. Every tab's terminal
 * is in the page and laid out, shown or not (a terminal made anew would start a
 * new session); the ones no pane shows are only invisible — so "shown" is asked
 * of the computed style, not of the layout.
 */
export async function screen() {
  return browser.execute(() =>
    [...document.querySelectorAll(".xterm")]
      .filter((term) => getComputedStyle(term).visibility === "visible")
      .map((term) => term.querySelector(".xterm-rows")?.innerText ?? "")
      .join("\n"),
  );
}

/** How many times `word` is on the screen of the terminal this window shows. */
export const seen = async (word) => (await screen()).split(word).length - 1;

/** Switch to the window for which `test` holds; resolves its handle. */
export async function windowWhere(test, what) {
  let found = null;
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if (await test().catch(() => false)) {
          found = handle;
          return true;
        }
      }
      return false;
    },
    { timeout: 30000, interval: 300, timeoutMsg: `no window ${what}` },
  );
  return found;
}

export const windowWithTab = (id) =>
  windowWhere(async () => (await tabIds()).includes(id), `has tab ${id}`);

/** The window whose tabs are exactly these — once a tab on its way has left
 *  the window giving it up (until then both windows have it). */
export const windowWithOnly = (...ids) =>
  windowWhere(
    async () => JSON.stringify(await tabIds()) === JSON.stringify(ids),
    `has exactly ${ids.join(", ")}`,
  );

export const windowWithoutTabs = () =>
  windowWhere(
    async () => (await testid("new-local-terminal").isExisting()) && (await tabIds()).length === 0,
    "is left with no tabs",
  );

/** Wait until the app has `count` windows. */
export const windowCount = (count, what) =>
  browser.waitUntil(async () => (await browser.getWindowHandles()).length === count, {
    timeout: 30000,
    timeoutMsg: what,
  });

/** Open a local shell in this window and wait for its prompt; resolves the id
 *  of its tab. Only a connected tab can be moved to another window. */
export async function openShell() {
  const before = await tabIds();
  await (await testid("new-local-terminal")).click();
  let id = null;
  await browser.waitUntil(
    async () => {
      id = (await tabIds()).find((tab) => !before.includes(tab)) ?? null;
      return id !== null && (await screen()).trim().length > 0;
    },
    { timeout: 30000, timeoutMsg: "the local shell did not start" },
  );
  return id;
}

/** Make a pane show this tab. Clicked in the page: the strip is redrawn as
 *  tabs come and go, and a handle to one of its elements goes stale. */
export async function showTab(id) {
  await browser.execute((tab) => document.querySelector(`[data-tab="${tab}"]`).click(), id);
  await browser.waitUntil(
    async () => (await strips()).flat().some((tab) => tab.id === id && tab.shown),
    { timeout: 5000, timeoutMsg: `tab ${id} is not shown` },
  );
}

/**
 * Open the menu of a tab and pick an item by its label — the last one so named
 * when a submenu repeats a label of the menu above it. Each of `path` is the
 * label in the languages the app may start in (it follows the OS). The menu is
 * opened by the event the page listens for: how a right click becomes
 * `contextmenu` is the WebView's business, and differs between the drivers.
 */
export async function tabMenu(id, ...path) {
  await browser.execute((tab) => {
    const el = document.querySelector(`[data-tab="${tab}"]`);
    const box = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 4,
        clientY: box.top + 4,
      }),
    );
  }, id);
  for (const names of path) {
    await browser.waitUntil(
      () =>
        browser.execute((labels) => {
          const items = [...document.querySelectorAll('[role="menuitem"]')].filter(
            (item) => labels.includes(item.textContent.trim()) && !item.disabled,
          );
          items.at(-1)?.click();
          return items.length > 0;
        }, names),
      { timeout: 5000, timeoutMsg: `no menu item "${names[0]}"` },
    );
  }
}

/**
 * Type `echo <word>` into the terminal this window shows and wait for its
 * output. The shell echoes the typed line and then prints the word, so the
 * command ran once the word is there one more time than the line alone gives.
 * Keys go one at a time: sent as one chord, a letter typed twice in a row is
 * a key that is already down.
 */
export async function run(word) {
  await browser.execute(() => {
    const shown = [...document.querySelectorAll(".xterm")].find(
      (term) => getComputedStyle(term).visibility === "visible",
    );
    shown?.querySelector("textarea")?.focus();
  });
  const before = await seen(word);
  for (const key of `echo ${word}`) await browser.keys(key);
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await seen(word)) >= before + 2, {
    timeout: 15000,
    timeoutMsg: `the output of "echo ${word}" did not appear`,
  });
}

/** Type a line into the terminal this window shows, a key at a time, and send it. */
export async function typeLine(line) {
  await browser.execute(() => {
    const shown = [...document.querySelectorAll(".xterm")].find(
      (term) => getComputedStyle(term).visibility === "visible",
    );
    shown?.querySelector("textarea")?.focus();
  });
  for (const key of line) await browser.keys(key);
  await browser.keys("Enter");
}

// ── A connection's own zones (v1.11): its terminal and its files ─────────────

/** The zones of the connection on screen: the views in each strip, `*` on the one shown. */
export async function viewZones() {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="view-strip"]')]
      .filter((strip) => getComputedStyle(strip).visibility === "visible")
      .map((strip) =>
        [...strip.querySelectorAll("[data-view]")].map((view) => {
          const tab = view.querySelector('[role="tab"]');
          const name = (tab?.textContent ?? "").trim().replace(/\s+/g, " ");
          return tab?.getAttribute("aria-selected") === "true" ? `${name}*` : name;
        }),
      ),
  );
}

/** What the editors on screen hold, zone by zone. */
export async function editorsOnScreen() {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="doc-body"]')]
      .filter((body) => getComputedStyle(body).visibility === "visible")
      .map((body) => body.querySelector(".cm-content")?.innerText ?? ""),
  );
}

/** The area of the connection on screen — what its views cannot be dragged out of. */
export async function connectionArea() {
  return browser.execute(() => {
    const area = [...document.querySelectorAll("[data-views-of]")].find(
      (el) => getComputedStyle(el).visibility === "visible",
    );
    const box = area.getBoundingClientRect();
    return { x: box.left, y: box.top, w: box.width, h: box.height };
  });
}

/**
 * Drag a view of the connection on screen by its tab, with the pointer: press
 * it, go through `points`, let go at the last. The pointer is WebDriver's — the
 * page gets the events a mouse gives, pointer capture and all.
 *
 * Returns what was drawn at each point while the button was still down: the
 * label that follows the pointer and the tint over the part of a zone the view
 * would take (null where nothing is offered).
 */
export async function dragView(name, points) {
  const start = await browser.execute((wanted) => {
    const view = [...document.querySelectorAll("[data-viewstrip] [data-view]")].find(
      (el) => getComputedStyle(el).visibility === "visible" && el.textContent.includes(wanted),
    );
    const box = view.querySelector('[role="tab"]').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }, name);
  // One pointer for the whole drag: the button stays down between the steps.
  const mouse = () => browser.action("pointer", { id: "view-drag", parameters: { pointerType: "mouse" } });
  await mouse()
    .move({ x: start.x, y: start.y })
    .down()
    .move({ x: start.x + 10, y: start.y + 3, duration: 60 })
    .perform(true);
  const drawn = [];
  for (const point of points) {
    await mouse()
      .move({ x: Math.round(point.x), y: Math.round(point.y), duration: 200 })
      .perform(true);
    await browser.pause(150);
    drawn.push(
      await browser.execute(() => {
        const box = (testid) => {
          const el = document.querySelector(`[data-testid="${testid}"]`);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        };
        return { label: box("view-drag-ghost"), tint: box("pane-drop-zone") };
      }),
    );
  }
  await mouse().up().perform();
  return drawn;
}

/** Open the menu of a view in a connection's strip and pick an item by its label. */
export async function viewMenu(name, labels) {
  await browser.execute((wanted) => {
    const view = [...document.querySelectorAll("[data-view]")].find(
      (el) => getComputedStyle(el).visibility === "visible" && el.textContent.includes(wanted),
    );
    const box = view.getBoundingClientRect();
    view.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 4,
        clientY: box.top + 4,
      }),
    );
  }, name);
  await browser.waitUntil(
    () =>
      browser.execute((wanted) => {
        const items = [...document.querySelectorAll('[role="menuitem"]')].filter(
          (item) => wanted.includes(item.textContent.trim()) && !item.disabled,
        );
        items.at(-1)?.click();
        return items.length > 0;
      }, labels),
    { timeout: 5000, timeoutMsg: `no menu item "${labels[0]}"` },
  );
}

/** Menu labels in the two languages the app may start in. */
export const TEXT = {
  newWindow: ["Move to a new window", "В отдельное окно"],
  toMain: ["Move to the main window", "В главное окно"],
  wholePane: ["Whole pane", "Всю область"],
  besideBelow: ["Show beside, below", "Показать рядом, снизу"],
  joinZones: ["Join the zones", "Объединить зоны"],
  terminal: ["Terminal", "Терминал"],
};
