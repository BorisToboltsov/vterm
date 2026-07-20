import { describe, it, expect } from "vitest";
import {
  parseCast,
  extractTranscript,
  castDuration,
  recordingDateISO,
  filterRecordings,
  sortRecordings,
  sortRecordingsBy,
  outputUpTo,
  formatTime,
  extractCommands,
  extractMarkdown,
  sessionMetaPairs,
  metadataComment,
  playbackSpeeds,
  activityBuckets,
} from "./recording";
import type { RecordingMeta } from "./types";

const ESC = "\\u001b";
const header = '{"version":2,"width":80,"height":24,"timestamp":1700000000,"title":"web"}';

describe("parseCast", () => {
  it("parses the header and o/i events, skipping junk", () => {
    const content = [
      header,
      '[0.1,"o","hello"]',
      '[0.2,"i","ls\\r"]',
      "not json",
      '[0.3,"o","world"]',
    ].join("\n");
    const { header: h, events } = parseCast(content);
    expect(h?.title).toBe("web");
    expect(events).toEqual([
      { time: 0.1, kind: "o", data: "hello" },
      { time: 0.2, kind: "i", data: "ls\r" },
      { time: 0.3, kind: "o", data: "world" },
    ]);
  });

  it("returns empty for blank content", () => {
    expect(parseCast("")).toEqual({ header: null, events: [] });
  });

  it("reads the vterm `timed` extension flag from the header", () => {
    const h = '{"version":2,"width":80,"height":24,"timestamp":1,"title":"x","timed":false}';
    expect(parseCast(h).header?.timed).toBe(false);
    // Absent on older recordings.
    expect(parseCast(header).header?.timed).toBeUndefined();
  });
});

describe("playbackSpeeds", () => {
  it("uses the normal scale (default 1×) for real-timed recordings", () => {
    expect(playbackSpeeds({ version: 2, timed: true })).toEqual({
      speeds: [0.5, 1, 2, 4],
      initial: 1,
    });
  });

  it("shifts to a slower scale (default 0.5×) for synthetic non-timed recordings", () => {
    expect(playbackSpeeds({ version: 2, timed: false })).toEqual({
      speeds: [0.25, 0.5, 1, 2],
      initial: 0.5,
    });
  });

  it("treats a missing flag (older recordings) and null as real-timed", () => {
    expect(playbackSpeeds({ version: 2 }).initial).toBe(1);
    expect(playbackSpeeds(null).initial).toBe(1);
  });
});

describe("extractTranscript", () => {
  it("joins output, strips ANSI and ignores input events", () => {
    const content = [
      header,
      `[0.1,"o","${ESC}[32m$ ls${ESC}[0m\\r\\n"]`,
      '[0.2,"i","ignored input"]',
      '[0.3,"o","file1 file2\\r\\n"]',
    ].join("\n");
    expect(extractTranscript(content)).toBe("$ ls\nfile1 file2");
  });

  it("collapses carriage-return line redraws to the final state", () => {
    const content = [header, '[0.1,"o","10%\\r50%\\r100%\\r\\n"]'].join("\n");
    expect(extractTranscript(content)).toBe("100%");
  });

  it("squeezes long blank runs and trims trailing space", () => {
    const content = [header, '[0.1,"o","a\\n\\n\\n\\nb\\n\\n"]'].join("\n");
    expect(extractTranscript(content)).toBe("a\n\nb");
  });

  it("returns empty when there is no output", () => {
    expect(extractTranscript(header)).toBe("");
    expect(extractTranscript("")).toBe("");
  });
});

describe("extractCommands", () => {
  it("lists typed command lines from input events", () => {
    const content = [
      header,
      '[0.1,"i","ls -la\\r"]',
      '[0.2,"o","file1\\r\\n"]',
      '[0.5,"i","cd /tmp\\n"]',
    ].join("\n");
    expect(extractCommands(content)).toBe("ls -la\ncd /tmp");
  });

  it("returns empty when there is no input", () => {
    expect(extractCommands([header, '[0.1,"o","x"]'].join("\n"))).toBe("");
  });

  it("lists per-line commands (commands mode: i events have no newline)", () => {
    const content = [
      header,
      '[0,"o","root@host:~# "]',
      '[0,"i","ls"]',
      '[0.1,"o","ls\\r\\nfile1\\r\\nroot@host:~# "]',
      '[0.2,"i","pwd"]',
      '[0.2,"o","pwd\\r\\n/home\\r\\n"]',
    ].join("\n");
    expect(extractCommands(content)).toBe("ls\npwd");
  });
});

describe("extractMarkdown", () => {
  it("renders a runbook: doc header + numbered code-span commands + fenced output", () => {
    const content = [
      header,
      '[0.1,"i","echo hi\\r"]',
      '[0.2,"o","hi\\r\\n"]',
      '[0.5,"i","whoami\\r"]',
      '[0.6,"o","root\\r\\n"]',
    ].join("\n");
    const md = extractMarkdown(content);
    expect(md.startsWith("# web — session recording\n")).toBe(true);
    expect(md).toContain("## 1. `echo hi`");
    expect(md).toContain("```text\nhi\n```");
    expect(md).toContain("## 2. `whoami`");
    expect(md).toContain("```text\nroot\n```");
  });

  it("emits a bare heading for a command with no output", () => {
    const md = extractMarkdown([header, '[0.1,"i","clear\\r"]'].join("\n"));
    expect(md).toContain("## 1. `clear`");
    expect(md).not.toContain("```");
  });

  it("returns empty without commands", () => {
    expect(extractMarkdown([header, '[0.1,"o","x"]'].join("\n"))).toBe("");
  });

  it("builds a runbook from commands-mode recordings (i events have no newline)", () => {
    // Real "commands + output" cast: each command is one newline-free `i` event,
    // its output begins with the echoed command and ends with the next prompt.
    const content = [
      header,
      '[0,"o","root@host:~# "]', // seed prompt (before any command)
      '[0,"i","ls"]',
      '[0,"o","ls\\r\\n"]', // echoed command — stripped
      '[0.1,"o","file1\\r\\nfile2\\r\\n"]', // result
      '[0.2,"o","root@host:~# "]', // next prompt — stripped (non-last block)
      '[0.3,"i","pwd"]',
      '[0.3,"o","pwd\\r\\n"]',
      '[0.4,"o","/home\\r\\n"]',
    ].join("\n");
    const md = extractMarkdown(content);
    expect(md).toContain("## 1. `ls`");
    expect(md).toContain("```text\nfile1\nfile2\n```");
    expect(md).toContain("## 2. `pwd`");
    expect(md).toContain("```text\n/home\n```");
    expect(md).not.toContain("root@host"); // echoed command + prompt stripped
  });

  it("widens the fence when output contains a backtick run", () => {
    const content = [
      header,
      '[0.1,"i","cat x\\r"]',
      '[0.2,"o","```js\\r\\ncode\\r\\n```\\r\\n"]',
    ].join("\n");
    expect(extractMarkdown(content)).toContain("````text\n```js\ncode\n```\n````");
  });
});

describe("sessionMetaPairs / metadataComment", () => {
  const richHeader = JSON.stringify({
    version: 2,
    width: 80,
    height: 24,
    timestamp: 1_700_000_000,
    title: "my notes",
    server: "web-prod",
    vterm: {
      recordMode: "commands",
      startedAt: 1_700_000_000,
      endedAt: 1_700_000_123,
      hostname: "web-1",
      ip: "10.0.0.5",
      connectedHost: "web.example.com",
      port: 22,
      username: "root",
      os: "Ubuntu 22.04",
      kernel: "5.15.0",
      appVersion: "0.11.0",
    },
  });
  const content = [richHeader, '[0,"o","x"]'].join("\n");

  it("lists present metadata in order (title omitted, duration computed)", () => {
    expect(sessionMetaPairs(content)).toEqual([
      ["Server", "web-prod"],
      ["Host", "web-1"],
      ["Address", "web.example.com:22"],
      ["IP", "10.0.0.5"],
      ["User", "root"],
      ["OS", "Ubuntu 22.04"],
      ["Kernel", "5.15.0"],
      ["Started", "2023-11-14 22:13:20 UTC"],
      ["Ended", "2023-11-14 22:15:23 UTC"],
      ["Duration", "2:03"],
      ["Mode", "commands"],
      ["App", "vterm 0.11.0"],
    ]);
  });

  it("formats as #-comment lines for text exports, with a trailing blank line", () => {
    expect(metadataComment(content)).toBe(
      "# Server: web-prod\n# Host: web-1\n# Address: web.example.com:22\n# IP: 10.0.0.5\n" +
        "# User: root\n# OS: Ubuntu 22.04\n# Kernel: 5.15.0\n# Started: 2023-11-14 22:13:20 UTC\n" +
        "# Ended: 2023-11-14 22:15:23 UTC\n# Duration: 2:03\n# Mode: commands\n# App: vterm 0.11.0\n\n",
    );
  });

  it("is empty when there's no header/metadata", () => {
    expect(sessionMetaPairs("")).toEqual([]);
    expect(metadataComment("")).toBe("");
  });
});

describe("castDuration", () => {
  it("is the last event's timestamp", () => {
    const content = [header, '[0.1,"o","a"]', '[2.5,"o","b"]'].join("\n");
    expect(castDuration(content)).toBe(2.5);
  });

  it("is zero with no events", () => {
    expect(castDuration(header)).toBe(0);
  });
});

const rec = (over: Partial<RecordingMeta>): RecordingMeta => ({
  path: "/r/web-1.cast",
  title: "web",
  description: "",
  server: "web",
  width: 80,
  height: 24,
  timestamp: 1_700_000_000,
  size: 100,
  ...over,
});

describe("recordingDateISO", () => {
  it("formats the UTC date, empty for 0", () => {
    expect(recordingDateISO(1_700_000_000)).toBe("2023-11-14");
    expect(recordingDateISO(0)).toBe("");
  });
});

describe("filterRecordings", () => {
  const items = [
    rec({ title: "web-prod", path: "/r/web-prod-1.cast", timestamp: 1_700_000_000, server: "web-prod" }),
    rec({ title: "db-eu", path: "/r/db-eu-2.cast", timestamp: 1_705_000_000, server: "db-eu" }),
  ];

  it("returns all on empty query", () => {
    expect(filterRecordings(items, "  ")).toHaveLength(2);
  });

  it("matches server name, filename and ISO date", () => {
    expect(filterRecordings(items, "WEB").map((r) => r.title)).toEqual(["web-prod"]);
    expect(filterRecordings(items, "db-eu-2").map((r) => r.title)).toEqual(["db-eu"]);
    expect(filterRecordings(items, "2023-11").map((r) => r.title)).toEqual(["web-prod"]);
  });

  it("matches the description and the server (even after a title rename)", () => {
    const recs = [
      rec({ title: "my notes", path: "/r/a.cast", description: "nginx restart", server: "db-eu" }),
      rec({ title: "b", path: "/r/b.cast", description: "", server: "web-us" }),
    ];
    expect(filterRecordings(recs, "nginx").map((r) => r.title)).toEqual(["my notes"]);
    expect(filterRecordings(recs, "db-eu").map((r) => r.title)).toEqual(["my notes"]);
    expect(filterRecordings(recs, "web-us").map((r) => r.title)).toEqual(["b"]);
  });
});

describe("sortRecordings", () => {
  const items = [
    rec({ title: "beta", timestamp: 200, size: 50 }),
    rec({ title: "alpha", timestamp: 100, size: 90 }),
  ];

  it("sorts by date", () => {
    expect(sortRecordings(items, "date", "asc").map((r) => r.timestamp)).toEqual([100, 200]);
    expect(sortRecordings(items, "date", "desc").map((r) => r.timestamp)).toEqual([200, 100]);
  });

  it("sorts by name and size", () => {
    expect(sortRecordings(items, "name", "asc").map((r) => r.title)).toEqual(["alpha", "beta"]);
    expect(sortRecordings(items, "size", "desc").map((r) => r.size)).toEqual([90, 50]);
  });

  it("does not mutate the input", () => {
    const before = items.map((r) => r.title);
    sortRecordings(items, "name", "asc");
    expect(items.map((r) => r.title)).toEqual(before);
  });
});

describe("sortRecordingsBy (multi-key)", () => {
  const items = [
    rec({ title: "web", timestamp: 200, size: 10 }),
    rec({ title: "web", timestamp: 100, size: 30 }),
    rec({ title: "db", timestamp: 150, size: 20 }),
  ];

  it("applies criteria in priority order (server then date)", () => {
    const out = sortRecordingsBy(items, [
      { key: "name", dir: "asc" },
      { key: "date", dir: "asc" },
    ]);
    expect(out.map((r) => [r.title, r.timestamp])).toEqual([
      ["db", 150],
      ["web", 100],
      ["web", 200],
    ]);
  });

  it("empty criteria keeps original order (copy)", () => {
    expect(sortRecordingsBy(items, [])).toEqual(items);
    expect(sortRecordingsBy(items, [])).not.toBe(items);
  });
});

describe("outputUpTo", () => {
  const events = parseCast(
    [header, '[0.1,"o","a"]', '[0.2,"i","x"]', '[0.5,"o","b"]', '[1.0,"o","c"]'].join("\n"),
  ).events;

  it("concatenates output up to the given time, ignoring input", () => {
    expect(outputUpTo(events, 0)).toBe("");
    expect(outputUpTo(events, 0.4)).toBe("a");
    expect(outputUpTo(events, 0.5)).toBe("ab");
    expect(outputUpTo(events, 99)).toBe("abc");
  });
});

describe("formatTime", () => {
  it("formats M:SS and H:MM:SS", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(83)).toBe("1:23");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(-5)).toBe("0:00");
  });
});

describe("activityBuckets", () => {
  /** Output event helper. */
  const o = (time: number, size: number) => ({ time, kind: "o" as const, data: "x".repeat(size) });

  it("returns the requested number of buckets", () => {
    expect(activityBuckets([o(0, 10), o(5, 10)], 8, 10)).toHaveLength(8);
    expect(activityBuckets([], 12, 10)).toHaveLength(12);
  });

  it("is all-zero for a recording with no output", () => {
    expect(activityBuckets([], 4, 10).every((b) => b.level === 0 && !b.burst)).toBe(true);
    expect(activityBuckets([{ time: 1, kind: "i", data: "ls\r" }], 4, 10)[0].level).toBe(0);
  });

  it("is all-zero when the recording has no duration (nothing to scrub)", () => {
    expect(activityBuckets([o(0, 100)], 4, 0).every((b) => b.level === 0)).toBe(true);
  });

  it("places output in the bucket matching its timestamp", () => {
    const b = activityBuckets([o(0.5, 100), o(9.5, 100)], 10, 10);
    expect(b[0].level).toBeGreaterThan(0);
    expect(b[9].level).toBeGreaterThan(0);
    expect(b.slice(1, 9).every((x) => x.level === 0)).toBe(true);
  });

  it("puts an event at exactly the end time in the last bucket, not out of range", () => {
    const b = activityBuckets([o(10, 100)], 5, 10);
    expect(b).toHaveLength(5);
    expect(b[4].level).toBeGreaterThan(0);
  });

  it("ignores input events — a typed command must not outweigh a scrolling build", () => {
    const b = activityBuckets(
      [{ time: 1, kind: "i", data: "make\r" }, o(6, 5000)],
      2,
      10,
    );
    expect(b[0].level).toBe(0);
    expect(b[1].level).toBe(1);
  });

  it("falls back to the last event's time when no duration is given", () => {
    const b = activityBuckets([o(0, 50), o(8, 50)], 4);
    expect(b[0].level).toBeGreaterThan(0);
    expect(b[3].level).toBeGreaterThan(0);
  });

  it("keeps ordinary chatter visible next to one huge dump (the log-scale reason)", () => {
    // One 5 MB `cat` against 2 KB of shell output. On a linear scale the small
    // bucket would round to 0.0004 — an invisible column, i.e. the flat bar again.
    const b = activityBuckets([o(1, 5_000_000), o(6, 2000)], 2, 10);
    expect(b[0].level).toBe(1);
    expect(b[1].level).toBeGreaterThan(0.4);
  });

  it("marks a stand-out slice as a burst and leaves steady output unmarked", () => {
    const steady = activityBuckets([o(1, 100), o(3, 100), o(5, 100), o(7, 100)], 4, 8);
    expect(steady.some((x) => x.burst)).toBe(false);
    const spiky = activityBuckets([o(1, 100), o(3, 100), o(5, 100), o(7, 90_000)], 4, 8);
    expect(spiky[3].burst).toBe(true);
    expect(spiky.slice(0, 3).some((x) => x.burst)).toBe(false);
  });

  it("does not let long idle stretches turn every busy slice into a burst", () => {
    const events = [o(1, 100), o(2, 120), o(3, 90)];
    const b = activityBuckets(events, 20, 60);
    expect(b.filter((x) => x.burst)).toHaveLength(0);
  });

  it("clamps a nonsensical bucket count instead of returning nothing", () => {
    expect(activityBuckets([o(1, 10)], 0, 5)).toHaveLength(1);
    expect(activityBuckets([o(1, 10)], -3, 5)).toHaveLength(1);
  });
});
