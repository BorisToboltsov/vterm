import { describe, expect, it } from "vitest";
import {
  facetRows,
  forgetSession,
  groupRows,
  keptOutOfHistory,
  NO_RECALL,
  recall,
  rememberSent,
  unreadHosts,
  type HostHistory,
  type Recall,
} from "./grouphistory";

describe("the line's own history", () => {
  it("keeps each command once, newest first, with every session it went to", () => {
    let list = rememberSent([], "uptime", ["a", "b"]);
    list = rememberSent(list, "df -h", ["a"]);
    list = rememberSent(list, "uptime", ["c"]);
    expect(list).toEqual([
      { cmd: "uptime", to: ["a", "b", "c"] },
      { cmd: "df -h", to: ["a"] },
    ]);
  });

  it("keeps out what the shells keep out: a leading space, or nothing at all", () => {
    expect(keptOutOfHistory(" mysql -p secret")).toBe(true);
    expect(keptOutOfHistory("   ")).toBe(true);
    expect(keptOutOfHistory("ls")).toBe(false);
    expect(rememberSent([], " export TOKEN=1", ["a"])).toEqual([]);
  });

  it("holds no more than its cap, dropping the oldest", () => {
    let list = rememberSent([], "one", ["a"], 2);
    list = rememberSent(list, "two", ["a"], 2);
    list = rememberSent(list, "three", ["a"], 2);
    expect(list.map((s) => s.cmd)).toEqual(["three", "two"]);
  });

  it("forgets a closed session from where each command went", () => {
    expect(forgetSession([{ cmd: "ls", to: ["a", "b"] }], "a")).toEqual([{ cmd: "ls", to: ["b"] }]);
  });
});

describe("↑ and ↓ in the line", () => {
  const cmds = ["systemctl reload nginx", "df -h", "systemctl status nginx", "uptime"];
  const walk = (keys: ("older" | "newer")[], typed = "") => {
    let state: Recall = NO_RECALL;
    let text = typed;
    const seen: string[] = [];
    for (const k of keys) {
      const step = recall(cmds, state, text, k);
      if (step) {
        state = step.state;
        text = step.text;
      }
      seen.push(text);
    }
    return seen;
  };

  it("steps back through what was sent and forward to the draft", () => {
    expect(walk(["older", "older", "newer", "newer"])).toEqual([
      "systemctl reload nginx",
      "df -h",
      "systemctl reload nginx",
      "",
    ]);
  });

  it("with text typed first, steps only through the commands that start with it", () => {
    expect(walk(["older", "older", "older", "newer", "newer"], "systemctl")).toEqual([
      "systemctl reload nginx",
      "systemctl status nginx",
      "systemctl status nginx",
      "systemctl reload nginx",
      "systemctl",
    ]);
  });

  it("goes nowhere when there is nothing older, or nothing newer than the draft", () => {
    expect(recall([], NO_RECALL, "x", "older")).toBeNull();
    expect(recall(cmds, NO_RECALL, "x", "newer")).toBeNull();
    expect(recall(cmds, NO_RECALL, "nope", "older")).toBeNull();
  });
});

describe("the group's history for Ctrl+R", () => {
  const hosts: HostHistory[] = [
    { id: "a", label: "web-1", commands: ["nginx -t", "vim /etc/hosts", "uptime"] },
    { id: "b", label: "web-2", commands: ["uptime", "nginx -t"] },
    { id: "c", label: "db-1", commands: null },
  ];

  it("puts what the line sent first, then the shells' by recency, shared ones first", () => {
    const rows = groupRows([{ cmd: "df -h", to: ["a", "b", "c"] }], hosts);
    expect(rows.map((r) => [r.cmd, r.sent, r.on.join(","), r.of])).toEqual([
      ["df -h", true, "web-1,web-2,db-1", 3],
      ["nginx -t", false, "web-1,web-2", 3],
      ["uptime", false, "web-1,web-2", 3],
      ["vim /etc/hosts", false, "web-1", 3],
    ]);
  });

  it("counts a member that ran a sent command though its history file does not have it yet", () => {
    const rows = groupRows([{ cmd: "uptime", to: ["c"] }], hosts);
    expect(rows[0]).toEqual({ cmd: "uptime", sent: true, on: ["web-1", "web-2", "db-1"], of: 3 });
    expect(rows.filter((r) => r.cmd === "uptime")).toHaveLength(1);
  });

  it("filters to the commands every member has, or to what the line sent", () => {
    const rows = groupRows([{ cmd: "df -h", to: ["a", "b", "c"] }], hosts);
    expect(facetRows(rows, "everywhere").map((r) => r.cmd)).toEqual(["df -h"]);
    expect(facetRows(rows, "sent").map((r) => r.cmd)).toEqual(["df -h"]);
    expect(facetRows(rows, "all")).toHaveLength(4);
  });

  it("names the members whose history could not be read", () => {
    expect(unreadHosts(hosts)).toEqual(["db-1"]);
  });
});
