import { describe, expect, it } from "vitest";
import { filterCommands, matchScore, type CommandItem } from "./command";

const noop = () => {};
function cmd(p: Partial<CommandItem> & { id: string; title: string }): CommandItem {
  return { icon: "server", group: "Test", run: noop, ...p };
}

const items: CommandItem[] = [
  cmd({ id: "1", title: "Add server", keywords: "new", group: "Actions" }),
  cmd({ id: "2", title: "Settings", keywords: "preferences" }),
  cmd({ id: "3", title: "web01", subtitle: "root@10.0.0.1", group: "Servers" }),
  cmd({ id: "4", title: "db01", subtitle: "admin@db.example", group: "Servers" }),
];

describe("matchScore", () => {
  it("returns 0 for an empty query (matches everything)", () => {
    expect(matchScore("", items[0])).toBe(0);
    expect(matchScore("   ", items[1])).toBe(0);
  });

  it("returns null when a term is absent", () => {
    expect(matchScore("zzz", items[0])).toBeNull();
  });

  it("matches across title, subtitle, keywords and group (case-insensitive)", () => {
    expect(matchScore("SERVER", items[0])).not.toBeNull(); // title
    expect(matchScore("preferences", items[1])).not.toBeNull(); // keywords
    expect(matchScore("10.0.0.1", items[2])).not.toBeNull(); // subtitle
    expect(matchScore("servers", items[3])).not.toBeNull(); // group
  });

  it("requires every whitespace-separated term to match", () => {
    expect(matchScore("add server", items[0])).not.toBeNull();
    expect(matchScore("add nope", items[0])).toBeNull();
  });

  it("ranks a title prefix above a mere substring (lower is better)", () => {
    const prefix = matchScore("set", items[1])!; // "Settings" starts with "set"
    const sub = matchScore(" web", items[2])!; // title "web01" includes "web" (also prefix)
    expect(prefix).toBeLessThan(0);
    expect(typeof sub).toBe("number");
  });
});

describe("filterCommands", () => {
  it("returns all items in order for an empty query", () => {
    expect(filterCommands(items, "").map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("drops non-matching items", () => {
    const r = filterCommands(items, "01");
    expect(r.map((c) => c.id).sort()).toEqual(["3", "4"]);
  });

  it("ranks better matches first", () => {
    const r = filterCommands(items, "set");
    expect(r[0].id).toBe("2"); // Settings (title prefix) wins
  });

  it("is stable on ties (keeps original order)", () => {
    const tie: CommandItem[] = [
      cmd({ id: "a", title: "alpha node" }),
      cmd({ id: "b", title: "alpha node" }),
    ];
    // Identical titles ⇒ identical score ⇒ original order preserved.
    expect(filterCommands(tie, "alpha").map((c) => c.id)).toEqual(["a", "b"]);
  });
});
