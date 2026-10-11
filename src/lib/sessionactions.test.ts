import { describe, expect, it } from "vitest";
import { ICONS } from "./icons";
import { en } from "./i18n/messages";
import {
  keySession,
  SESSION_ACTION_DEFS,
  sessionActionsMatching,
  sessionActionView,
  sessionKey,
  type SessionActionState,
} from "./sessionactions";
import { BUILTIN_ACTIONS, canUnpin, SESSION_ACTIONS } from "./topbaractions";
import { isUtility } from "./utilities";

const READY: SessionActionState = {
  connected: true,
  canRecord: true,
  recording: false,
  canBroadcast: true,
  broadcastActive: false,
  notesFor: "db-01",
};
const NOTHING: SessionActionState = {
  connected: false,
  canRecord: false,
  recording: false,
  canBroadcast: false,
  broadcastActive: false,
  notesFor: null,
};

describe("the session actions the Utilities window lists", () => {
  it("is every built-in button that can be taken off the top bar — none is left with no place", () => {
    const listed = SESSION_ACTION_DEFS.map((a) => a.id);
    expect([...listed].sort()).toEqual(BUILTIN_ACTIONS.filter(canUnpin).sort());
    expect(listed).toEqual([...SESSION_ACTIONS]);
  });

  it("each has a title, a description and an icon that exist", () => {
    for (const a of SESSION_ACTION_DEFS) {
      expect(en[a.titleKey], a.id).toBeTruthy();
      expect(en[a.descKey], a.id).toBeTruthy();
      expect(ICONS[a.icon], a.id).toBeTruthy();
    }
    const titles = SESSION_ACTION_DEFS.map((a) => en[a.titleKey]);
    expect(titles).toEqual(["Monitoring", "Session recording", "Recordings", "Broadcast input", "Server notes"]);
  });

  it("is selected by a key no tool has", () => {
    for (const id of SESSION_ACTIONS) {
      expect(keySession(sessionKey(id))).toBe(id);
      expect(isUtility(sessionKey(id))).toBe(false);
    }
    expect(keySession("cidr")).toBeNull();
    expect(keySession("session:nope")).toBeNull();
    expect(keySession("session:")).toBeNull();
    expect(keySession("")).toBeNull();
  });

  it("is found by what the user would type, in both languages", () => {
    const found = (q: string) => sessionActionsMatching(q).map((a) => a.id);
    expect(found("")).toEqual([...SESSION_ACTIONS]);
    expect(found("   ")).toEqual([...SESSION_ACTIONS]);
    expect(found("мониторинг")).toEqual(["monitoring"]);
    expect(found("cpu")).toEqual(["monitoring"]);
    expect(found("синхронный")).toEqual(["broadcast"]);
    expect(found("заметки")).toEqual(["notes"]);
    expect(found("notes")).toEqual(["notes"]);
    expect(found("запись")).toContain("record");
    expect(found("zzz-nothing")).toEqual([]);
  });
});

describe("sessionActionView", () => {
  it("with a session and a server in reach, every action can run", () => {
    for (const id of SESSION_ACTIONS) {
      const v = sessionActionView(id, READY);
      expect(v.disabled, id).toBe(false);
      expect(v.reasonKey, id).toBeNull();
      expect(en[v.buttonKey], id).toBeTruthy();
    }
  });

  it("with nothing open, only the recordings library runs — and each of the rest says why not", () => {
    const off = SESSION_ACTIONS.filter((id) => sessionActionView(id, NOTHING).disabled);
    expect(off).toEqual(["monitoring", "record", "broadcast", "notes"]);
    expect(sessionActionView("recordings", NOTHING)).toMatchObject({ disabled: false, reasonKey: null });
    expect(sessionActionView("monitoring", NOTHING).reasonKey).toBe("sessionact.needSession");
    expect(sessionActionView("record", NOTHING).reasonKey).toBe("sessionact.needSession");
    expect(sessionActionView("broadcast", NOTHING).reasonKey).toBe("sessionact.needTab");
    expect(sessionActionView("notes", NOTHING).reasonKey).toBe("sessionact.needServer");
  });

  it("a disabled action always has a reason, an enabled one never does", () => {
    const flags = [true, false];
    for (const connected of flags)
      for (const canRecord of flags)
        for (const recording of flags)
          for (const canBroadcast of flags)
            for (const broadcastActive of flags)
              for (const notesFor of ["db-01", null]) {
                const s = { connected, canRecord, recording, canBroadcast, broadcastActive, notesFor };
                for (const id of SESSION_ACTIONS) {
                  const v = sessionActionView(id, s);
                  expect(v.reasonKey === null, `${id} ${JSON.stringify(s)}`).toBe(!v.disabled);
                  if (v.reasonKey) expect(en[v.reasonKey]).toBeTruthy();
                  expect(v.onKey === null).toBe(!v.on);
                }
              }
  });

  it("recording is a switch: the button says what a press will do, and the state is named", () => {
    expect(sessionActionView("record", READY)).toMatchObject({ buttonKey: "recordings.start", on: false, onKey: null });
    expect(sessionActionView("record", { ...READY, recording: true })).toMatchObject({
      buttonKey: "recordings.stop",
      on: true,
      onKey: "sessionact.record.on",
    });
  });

  it("broadcast likewise", () => {
    expect(sessionActionView("broadcast", READY)).toMatchObject({ buttonKey: "broadcast.addToGroup", on: false });
    expect(sessionActionView("broadcast", { ...READY, broadcastActive: true })).toMatchObject({
      buttonKey: "broadcast.removeFromGroup",
      on: true,
      onKey: "sessionact.broadcast.on",
    });
  });

  it("what opens something over the window is told apart from a switch", () => {
    const opens = SESSION_ACTIONS.filter((id) => sessionActionView(id, READY).opens);
    expect(opens).toEqual(["monitoring", "recordings", "notes"]);
  });

  it("monitoring depends on a monitorable session, not on whether the tab can be recorded", () => {
    expect(sessionActionView("monitoring", { ...NOTHING, canRecord: true }).disabled).toBe(true);
    expect(sessionActionView("monitoring", { ...NOTHING, connected: true }).disabled).toBe(false);
  });
});
