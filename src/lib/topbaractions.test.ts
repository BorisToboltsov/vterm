import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  actionUtility,
  allTopbarIds,
  ANCHORS,
  BUILTIN_ACTIONS,
  canUnpin,
  DEFAULT_TOPBAR,
  fitTopbar,
  isTopbarId,
  KEEP_SLOT,
  moveChanges,
  moveTopbar,
  mustShow,
  previewTopbar,
  sameSlot,
  sanitizeTopbar,
  SESSION_ACTIONS,
  shownTopbar,
  TOPBAR_SIZES,
  topbarRoom,
  topbarSlot,
  utilAction,
  withPinned,
  withUnpinned,
  type SlotBox,
  type TopbarId,
  type TopbarState,
} from "./topbaractions";
import { UTILITIES } from "./utilities";

const QUIET: TopbarState = { recording: false, broadcastActive: false, showNotes: true };
const ids = (shown: { id: TopbarId }[]) => shown.map((a) => a.id);
const anyId = fc.constantFrom(...allTopbarIds());
const anyList = fc.uniqueArray(anyId, { maxLength: 18 }).map(sanitizeTopbar);

describe("the buttons there are", () => {
  it("the default bar is the bar as it was before it could be edited", () => {
    expect([...DEFAULT_TOPBAR]).toEqual([
      "broadcast",
      "notes",
      "monitoring",
      "record",
      "recordings",
      "utilities",
      "settings",
    ]);
  });

  it("every tool of the Utilities panel can be a button", () => {
    const all = allTopbarIds();
    expect(all.slice(0, BUILTIN_ACTIONS.length)).toEqual([...BUILTIN_ACTIONS]);
    for (const u of UTILITIES) {
      expect(all).toContain(utilAction(u.id));
      expect(actionUtility(utilAction(u.id))).toBe(u.id);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it("knows a button from what is not one", () => {
    expect(isTopbarId("settings")).toBe(true);
    expect(isTopbarId("util:cidr")).toBe(true);
    // A tool this build does not have (a newer build's, or a typo).
    expect(isTopbarId("util:nope")).toBe(false);
    expect(isTopbarId("util:")).toBe(false);
    expect(isTopbarId("Settings")).toBe(false);
    expect(isTopbarId("")).toBe(false);
    expect(isTopbarId(7)).toBe(false);
    expect(isTopbarId(null)).toBe(false);
    expect(actionUtility("settings")).toBeNull();
  });

  it("only the two anchors cannot be taken off: Utilities and Settings", () => {
    expect(allTopbarIds().filter((id) => !canUnpin(id))).toEqual(["utilities", "settings"]);
    expect([...ANCHORS]).toEqual(["utilities", "settings"]);
  });

  it("every built-in button is either an anchor or a session action — nothing in between", () => {
    // What can be taken off the bar is what the Utilities window still lists.
    expect([...SESSION_ACTIONS].sort()).toEqual(BUILTIN_ACTIONS.filter(canUnpin).sort());
    expect(new Set(SESSION_ACTIONS).size).toBe(SESSION_ACTIONS.length);
  });
});

describe("sanitizeTopbar", () => {
  it("is the default bar for what is not a list", () => {
    for (const raw of [undefined, null, "settings", 3, {}, { 0: "settings" }]) {
      expect(sanitizeTopbar(raw)).toEqual([...DEFAULT_TOPBAR]);
    }
  });

  it("an empty list is the user's own bar: the two anchors alone", () => {
    expect(sanitizeTopbar([])).toEqual(["utilities", "settings"]);
  });

  it("keeps the order, drops what it does not know and what is repeated", () => {
    expect(sanitizeTopbar(["util:cidr", "nope", "record", "util:cidr", 4, null, "settings", "util:gone"])).toEqual([
      "util:cidr",
      "record",
      "settings",
      "utilities",
    ]);
  });

  it("puts an anchor back when it is missing — at the end, Utilities before Settings", () => {
    expect(sanitizeTopbar(["record", "util:jwt"])).toEqual(["record", "util:jwt", "utilities", "settings"]);
    expect(sanitizeTopbar(["record", "utilities"])).toEqual(["record", "utilities", "settings"]);
  });

  it("leaves the anchors where the user put them", () => {
    expect(sanitizeTopbar(["settings", "record", "utilities"])).toEqual(["settings", "record", "utilities"]);
  });

  it("whatever it is given, the result is a list of known buttons, each once, with both anchors", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const out = sanitizeTopbar(raw);
        expect(out).toContain("settings");
        expect(out).toContain("utilities");
        expect(out.every(isTopbarId)).toBe(true);
        expect(new Set(out).size).toBe(out.length);
        // Clean once, clean for good.
        expect(sanitizeTopbar(out)).toEqual(out);
      }),
    );
  });
});

describe("pinning and unpinning", () => {
  it("a new button stands just before Settings when Settings closes the bar", () => {
    expect(withPinned(["record", "settings"], "util:cidr")).toEqual(["record", "util:cidr", "settings"]);
    expect(withPinned(["settings"], "record")).toEqual(["record", "settings"]);
  });

  it("…and at the end when the user moved Settings elsewhere", () => {
    expect(withPinned(["settings", "record"], "util:cidr")).toEqual(["settings", "record", "util:cidr"]);
  });

  it("pinning what is on the bar, or is not a button, changes nothing", () => {
    const list: TopbarId[] = ["record", "settings"];
    expect(withPinned(list, "record")).toEqual(list);
    expect(withPinned(list, "util:nope")).toEqual(list);
  });

  it("unpinning takes the button off and keeps the order of the rest", () => {
    expect(withUnpinned(["broadcast", "record", "settings"], "record")).toEqual(["broadcast", "settings"]);
    expect(withUnpinned(["record", "settings"], "util:cidr")).toEqual(["record", "settings"]);
  });

  it("an anchor does not go", () => {
    const bar: TopbarId[] = ["record", "utilities", "settings"];
    expect(withUnpinned(bar, "settings")).toEqual(bar);
    expect(withUnpinned(bar, "utilities")).toEqual(bar);
  });

  it("no sequence of pins, unpins and moves loses an anchor, repeats a button or invents one", () => {
    const step = fc.oneof(
      fc.record({ op: fc.constant("pin" as const), id: anyId }),
      fc.record({ op: fc.constant("unpin" as const), id: anyId }),
      fc.record({ op: fc.constant("move" as const), id: anyId, index: fc.integer({ min: -3, max: 25 }) }),
    );
    fc.assert(
      fc.property(anyList, fc.array(step, { maxLength: 40 }), (start, steps) => {
        let list = start;
        for (const s of steps) {
          list =
            s.op === "pin" ? withPinned(list, s.id) : s.op === "unpin" ? withUnpinned(list, s.id) : moveTopbar(list, s.id, s.index);
          expect(list).toContain("settings");
          expect(list).toContain("utilities");
          expect(new Set(list).size).toBe(list.length);
          expect(sanitizeTopbar(list)).toEqual(list);
        }
      }),
    );
  });
});

describe("moveTopbar", () => {
  const list: TopbarId[] = ["broadcast", "monitoring", "record", "settings"];

  it("moves a button to stand before the one at the index", () => {
    expect(moveTopbar(list, "record", 0)).toEqual(["record", "broadcast", "monitoring", "settings"]);
    expect(moveTopbar(list, "broadcast", 3)).toEqual(["monitoring", "record", "broadcast", "settings"]);
    expect(moveTopbar(list, "broadcast", 4)).toEqual(["monitoring", "record", "settings", "broadcast"]);
  });

  it("before itself and before its right neighbour are the place it already has", () => {
    expect(moveTopbar(list, "monitoring", 1)).toEqual(list);
    expect(moveTopbar(list, "monitoring", 2)).toEqual(list);
    expect(moveChanges(list, "monitoring", 1)).toBe(false);
    expect(moveChanges(list, "monitoring", 2)).toBe(false);
    expect(moveChanges(list, "monitoring", 0)).toBe(true);
    expect(moveChanges(list, "monitoring", 3)).toBe(true);
  });

  it("an index outside the list goes to the nearest end; junk moves nothing", () => {
    expect(moveTopbar(list, "record", -9)[0]).toBe("record");
    expect(moveTopbar(list, "broadcast", 99).at(-1)).toBe("broadcast");
    expect(moveTopbar(list, "record", NaN)).toEqual(list);
    expect(moveTopbar(list, "util:cidr", 0)).toEqual(list);
  });

  it("a move is a permutation: nothing is added or lost", () => {
    fc.assert(
      fc.property(anyList, fc.integer({ min: -3, max: 25 }), fc.nat(), (l, index, pick) => {
        const id = l[pick % l.length];
        const moved = moveTopbar(l, id, index);
        expect([...moved].sort()).toEqual([...l].sort());
        // The others keep their order among themselves.
        expect(moved.filter((x) => x !== id)).toEqual(l.filter((x) => x !== id));
      }),
    );
  });

  it("the preview is the list itself until there is a button in the air and a slot for it", () => {
    expect(previewTopbar(list, null, 0)).toEqual(list);
    expect(previewTopbar(list, "record", null)).toEqual(list);
    expect(previewTopbar(list, "record", 0)).toEqual(moveTopbar(list, "record", 0));
  });
});

describe("what the bar shows", () => {
  it("the user's list, as it is", () => {
    expect(shownTopbar(DEFAULT_TOPBAR, QUIET)).toEqual(DEFAULT_TOPBAR.map((id) => ({ id, pinned: true })));
  });

  it("the notes button only while a server is selected", () => {
    expect(ids(shownTopbar(DEFAULT_TOPBAR, { ...QUIET, showNotes: false }))).not.toContain("notes");
    expect(ids(shownTopbar(DEFAULT_TOPBAR, QUIET))).toContain("notes");
  });

  it("REC taken off the bar comes back while a recording is running — and goes when it stops", () => {
    const bar: TopbarId[] = ["monitoring", "settings"];
    expect(ids(shownTopbar(bar, QUIET))).toEqual(["monitoring", "settings"]);
    expect(shownTopbar(bar, { ...QUIET, recording: true })).toEqual([
      { id: "record", pinned: false },
      { id: "monitoring", pinned: true },
      { id: "settings", pinned: true },
    ]);
  });

  it("the broadcast button likewise, while the tab is in the group", () => {
    const bar: TopbarId[] = ["settings"];
    expect(shownTopbar(bar, { ...QUIET, broadcastActive: true })).toEqual([
      { id: "broadcast", pinned: false },
      { id: "settings", pinned: true },
    ]);
    // Both at once: broadcast, then REC — the order they have on the default bar.
    expect(ids(shownTopbar(bar, { recording: true, broadcastActive: true, showNotes: false }))).toEqual([
      "broadcast",
      "record",
      "settings",
    ]);
  });

  it("an indicator that is on the bar anyway is shown once, in its own place", () => {
    const shown = shownTopbar(DEFAULT_TOPBAR, { recording: true, broadcastActive: true, showNotes: true });
    expect(ids(shown)).toEqual([...DEFAULT_TOPBAR]);
    expect(shown.every((a) => a.pinned)).toBe(true);
  });

  it("whatever the list and the state: Settings is shown, and so is a running recording or broadcast", () => {
    fc.assert(
      fc.property(anyList, fc.boolean(), fc.boolean(), fc.boolean(), (list, recording, broadcastActive, showNotes) => {
        const state = { recording, broadcastActive, showNotes };
        const shown = ids(shownTopbar(list, state));
        expect(shown).toContain("settings");
        if (recording) expect(shown).toContain("record");
        if (broadcastActive) expect(shown).toContain("broadcast");
        expect(new Set(shown).size).toBe(shown.length);
        // Nothing appears that is neither on the list nor required by the state.
        for (const id of shown) expect(list.includes(id) || mustShow(id, state)).toBe(true);
      }),
    );
  });
});

describe("fitTopbar", () => {
  const S = TOPBAR_SIZES;
  const bar: TopbarId[] = ["broadcast", "monitoring", "record", "recordings", "util:cidr", "utilities", "settings"];
  // 6 icons + REC + 6 gaps.
  const full = 6 * S.icon + S.record + 6 * S.gap;
  const settingsStays = (id: TopbarId) => id === "settings";

  it("shows everything that fits, and everything while the bar is not measured", () => {
    expect(fitTopbar(bar, full, settingsStays)).toEqual({ shown: bar, overflow: [] });
    expect(fitTopbar(bar, 0, settingsStays)).toEqual({ shown: bar, overflow: [] });
    expect(fitTopbar(bar, NaN, settingsStays)).toEqual({ shown: bar, overflow: [] });
  });

  it("one pixel short: the last buttons go under the menu, Settings stays", () => {
    const { shown, overflow } = fitTopbar(bar, full - 1, settingsStays);
    expect(shown.at(-1)).toBe("settings");
    expect(overflow.length).toBeGreaterThan(0);
    expect([...shown.filter((id) => id !== "settings"), ...overflow]).toEqual(bar.filter((id) => id !== "settings"));
  });

  it("what is shown is a prefix of the order — a wide button is not skipped for a narrow one after it", () => {
    // Room for the menu, Settings, two icons — and not for REC, which comes third.
    const room = S.icon + (S.icon + S.gap) + 2 * (S.icon + S.gap) + 10;
    expect(fitTopbar(bar, room, settingsStays)).toEqual({
      shown: ["broadcast", "monitoring", "settings"],
      overflow: ["record", "recordings", "util:cidr", "utilities"],
    });
  });

  it("a recording that is running is shown however little room there is", () => {
    const { shown, overflow } = fitTopbar(bar, 1, (id) => id === "settings" || id === "record");
    expect(shown).toEqual(["record", "settings"]);
    expect(overflow).toEqual(["broadcast", "monitoring", "recordings", "util:cidr", "utilities"]);
  });

  it("never loses or repeats a button, keeps the order, and keeps what must be seen", () => {
    fc.assert(
      fc.property(anyList, fc.integer({ min: -50, max: 900 }), fc.boolean(), (list, room, recording) => {
        const kept = (id: TopbarId) => id === "settings" || (recording && id === "record");
        const { shown, overflow } = fitTopbar(list, room, kept);
        expect([...shown, ...overflow].sort()).toEqual([...list].sort());
        expect(shown).toEqual(list.filter((id) => shown.includes(id)));
        expect(overflow).toEqual(list.filter((id) => overflow.includes(id)));
        for (const id of list) if (kept(id)) expect(shown).toContain(id);
        // With a menu, the buttons shown and the menu's own button fit the room
        // — unless what must be seen is already more than the room.
        if (overflow.length > 0 && shown.some((id) => !kept(id))) {
          const width = shown.reduce<number>((w, id) => w + (id === "record" ? S.record : S.icon) + S.gap, S.icon);
          expect(width).toBeLessThanOrEqual(room);
        }
      }),
    );
  });

  it("the breadcrumb keeps its room", () => {
    expect(topbarRoom(1100)).toBe(1100 - S.crumb - S.chrome);
    expect(topbarRoom(S.crumb)).toBe(0);
    expect(topbarRoom(0)).toBe(0);
    expect(topbarRoom(NaN)).toBe(0);
  });
});

describe("topbarSlot", () => {
  // Three icon buttons at list indices 0, 1, 2 — 27 px each, 4 px apart.
  const row: SlotBox[] = [
    { index: 0, left: 100, width: 27 },
    { index: 1, left: 131, width: 27 },
    { index: 2, left: 162, width: 27 },
  ];

  it("over a button: before it left of its middle, after it past the middle", () => {
    expect(topbarSlot(140, row)).toBe(1);
    expect(topbarSlot(150, row)).toBe(2);
  });

  it("past either end: that end", () => {
    expect(topbarSlot(10, row)).toBe(0);
    expect(topbarSlot(900, row)).toBe(3);
  });

  it("in the gap between two buttons: before the one on the right", () => {
    expect(topbarSlot(129, row)).toBe(1);
  });

  it("over the slot the dragged button holds, and the gap before it: keep the target", () => {
    const held: SlotBox[] = [row[0], { ...row[1], own: true }, row[2]];
    expect(topbarSlot(140, held)).toBe(KEEP_SLOT);
    expect(topbarSlot(129, held)).toBe(KEEP_SLOT);
    expect(topbarSlot(110, held)).toBe(0);
    // At either end of the bar, too.
    expect(topbarSlot(10, [{ ...row[0], own: true }, row[1]])).toBe(KEEP_SLOT);
    expect(topbarSlot(900, [row[0], { ...row[1], own: true }])).toBe(KEEP_SLOT);
  });

  it("no buttons, or no position: no slot", () => {
    expect(topbarSlot(100, [])).toBeNull();
    expect(topbarSlot(NaN, row)).toBeNull();
  });

  it("a swap with a wider neighbour holds: the way back is across the neighbour's new middle", () => {
    // List [a, REC, c]: a is dragged right over the wide REC.
    const before: SlotBox[] = [
      { index: 0, left: 0, width: 27, own: true },
      { index: 1, left: 31, width: 54 },
      { index: 2, left: 89, width: 27 },
    ];
    // Past REC's middle (58): a goes after it.
    expect(topbarSlot(59, before)).toBe(2);
    // The bar now draws [REC, a, c]; the indices are still the list's.
    const after: SlotBox[] = [
      { index: 1, left: 0, width: 54 },
      { index: 0, left: 58, width: 27, own: true },
      { index: 2, left: 89, width: 27 },
    ];
    // The pointer has not moved: it is over a's own slot now — nothing swaps back.
    expect(topbarSlot(59, after)).toBe(KEEP_SLOT);
    // Still over REC's right half: the same target as before.
    expect(topbarSlot(40, after)).toBe(2);
    // Only left of REC's new middle (27) does a go back in front of it.
    expect(topbarSlot(20, after)).toBe(1);
  });

  it("sameSlot compares slots, null included", () => {
    expect(sameSlot(null, null)).toBe(true);
    expect(sameSlot(2, 2)).toBe(true);
    expect(sameSlot(2, null)).toBe(false);
    expect(sameSlot(0, 1)).toBe(false);
  });
});
