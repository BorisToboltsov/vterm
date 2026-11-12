import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  writeToTerminal: vi.fn(async () => {}),
  annotateRecording: vi.fn(async () => {}),
}));
vi.mock("../api", () => api);
const recording = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock("../stores/recordings.svelte", () => ({ isRecording: (id: string) => recording.on.has(id) }));

import { createBroadcastFlow, type BroadcastDeps } from "./broadcastflow.svelte";
import { captureDiag } from "../api/diag";
import type { Screen } from "../terminal/groupkeys";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/** What each session was written, as text. */
const written = () =>
  (api.writeToTerminal.mock.calls as unknown as [string, Uint8Array][]).map(([id, b]) => [id, decode(b)]);

describe("the synchronous-input flow", () => {
  let targets: string[];
  let prod: Set<string>;
  let screens: Record<string, Screen>;
  let pasted: [string, string][];
  let histories: Record<string, string | Error>;
  let recorded: number;
  let focused: number;
  let activity: string[];
  let heard: ReturnType<typeof captureDiag>;

  const deps = (): BroadcastDeps => ({
    targets: () => targets,
    prodOf: (ids) => ids.filter((id) => prod.has(id)),
    label: (id) => `srv-${id}`,
    screenOf: (id) => screens[id] ?? null,
    term: (id) => ({
      pasteInto: (text) => pasted.push([id, text]),
      typedCommands: () => (id === "b" ? ["typed-on-b"] : []),
    }),
    readHistory: async (id) => {
      const h = histories[id];
      if (h instanceof Error) throw h;
      return h ?? "";
    },
    ensureGroupRecording: async () => {
      recorded++;
    },
    activity: (id) => activity.push(id),
    focusTerminal: () => focused++,
  });

  beforeEach(() => {
    targets = ["a", "b", "c"];
    prod = new Set();
    screens = { a: "normal", b: "normal", c: "normal" };
    pasted = [];
    histories = {};
    recorded = 0;
    focused = 0;
    activity = [];
    recording.on.clear();
    api.writeToTerminal.mockClear();
    api.annotateRecording.mockClear();
    heard = captureDiag();
  });
  afterEach(() => heard.stop());

  it("sends one command with Enter to every member, and remembers it", () => {
    const flow = createBroadcastFlow(deps());
    flow.send("uptime");
    expect(written()).toEqual([
      ["a", "uptime\r"],
      ["b", "uptime\r"],
      ["c", "uptime\r"],
    ]);
    expect(flow.recent).toEqual(["uptime"]);
    expect(heard.events().map((e) => [e.code, e.fields])).toEqual([["group-sent", { sessions: 3, prod: 0 }]]);
  });

  it("keeps a command with a leading space out of its history, as the shells do", () => {
    const flow = createBroadcastFlow(deps());
    flow.send(" export TOKEN=1");
    expect(written()).toHaveLength(3);
    expect(flow.recent).toEqual([]);
  });

  it("asks before a prod server gets the command, and records the group first", async () => {
    prod.add("b");
    recording.on.add("b");
    const flow = createBroadcastFlow(deps());
    flow.send("reboot");
    expect(written()).toEqual([]);
    expect(flow.pendingProd).toEqual(["srv-b"]);
    await flow.confirmSend();
    expect(recorded).toBe(1);
    expect(written()).toHaveLength(3);
    expect(api.annotateRecording).toHaveBeenCalledExactlyOnceWith("b", "broadcast: reboot");
  });

  it("passes the keys of the terminal in focus only to members on the same screen", () => {
    screens = { a: "alternate", b: "alternate", c: "normal" };
    const flow = createBroadcastFlow(deps());
    flow.keys("a", "x");
    expect(written()).toEqual([]);
    flow.switchMode("keys");
    expect(focused).toBe(1);
    flow.keys("a", "i\x1b:wq\r\x1b[<0;3;4M");
    expect(written()).toEqual([["b", "i\x1b:wq\r"]]);
    expect(flow.keysStatus("a")).toEqual({ to: ["srv-b"], skipped: ["srv-c"], held: [] });
  });

  it("gives a pasted block to each member through its own paste", () => {
    const flow = createBroadcastFlow(deps());
    flow.switchMode("keys");
    flow.keys("a", "\x1b[200~line 1\rline 2\x1b[201~");
    expect(written()).toEqual([]);
    expect(pasted).toEqual([
      ["b", "line 1\rline 2"],
      ["c", "line 1\rline 2"],
    ]);
  });

  it("asks before keys mode reaches prod, and holds back prod that joins later", async () => {
    prod.add("c");
    const flow = createBroadcastFlow(deps());
    flow.switchMode("keys");
    expect(flow.mode).toBe("line");
    expect(flow.keysAsk).toBe(true);
    await flow.confirmKeys();
    expect(flow.mode).toBe("keys");
    expect(recorded).toBe(1);
    targets = ["a", "b", "c", "d"];
    screens.d = "normal";
    prod.add("d");
    expect(flow.keysStatus("a")).toEqual({ to: ["srv-b", "srv-c"], skipped: [], held: ["srv-d"] });
    flow.keys("a", "k");
    expect(written().map(([id]) => id)).toEqual(["b", "c"]);
  });

  it("pastes a block into every member and says so to the diagnostics", async () => {
    const flow = createBroadcastFlow(deps());
    flow.openPaste("a\nb");
    expect(flow.pasteAsk).toEqual({ text: "a\nb" });
    await flow.paste("a\nb");
    expect(flow.pasteAsk).toBeNull();
    expect(pasted.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(heard.events().at(-1)).toMatchObject({ code: "group-pasted", fields: { sessions: 3, lines: 2 } });
  });

  it("reads every member's history for Ctrl+R and names those it could not read", async () => {
    histories = { a: "uptime\nnginx -t\n", b: "nginx -t\n", c: new Error("permission denied") };
    const flow = createBroadcastFlow(deps());
    flow.send("df -h");
    const open = flow.openHistory();
    expect(flow.history).toMatchObject({ open: true, loading: true, members: 3 });
    await open;
    expect(flow.history.loading).toBe(false);
    expect(flow.history.unread).toEqual(["srv-c"]);
    expect(flow.history.rows.map((r) => [r.cmd, r.on.length])).toEqual([
      ["df -h", 3],
      ["nginx -t", 2],
      ["typed-on-b", 1],
      ["uptime", 1],
    ]);
    flow.closeHistory();
    expect(flow.history.open).toBe(false);
  });

  it("forgets a closed tab and goes back to the line when the group is gone", () => {
    const flow = createBroadcastFlow(deps());
    flow.send("ls");
    flow.forget("a");
    flow.switchMode("keys");
    flow.reset();
    expect(flow.mode).toBe("line");
    expect(heard.events().map((e) => e.code)).toEqual(["group-sent", "group-keys-on", "group-keys-off"]);
  });
});
