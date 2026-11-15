import { describe, expect, it } from "vitest";
import { folderName, isPinned, MAX_SOURCES, sanitizeBookmarks, sanitizeScenarioTab, sanitizeSeeded, sanitizeSources, togglePin } from "./bookmarks";

describe("what the Scenarios panel remembers", () => {
  it("keeps absolute recipe folders, each once, and no more than its limit", () => {
    expect(sanitizeSources(["/a", " /a ", "rel", "C:\\scripts", "\\\\host\\share", 7, ""])).toEqual(["/a", "C:\\scripts", "\\\\host\\share"]);
    expect(sanitizeSources("nope")).toEqual([]);
    expect(sanitizeSources(Array.from({ length: 40 }, (_, i) => `/s${i}`))).toHaveLength(MAX_SOURCES);
  });

  it("keeps pinned projects of a known kind and an absolute folder, each once", () => {
    expect(
      sanitizeBookmarks([
        { kind: "ansible", root: "/p", serverId: "s1" },
        { kind: "ansible", root: "/p", serverId: "s1" },
        { kind: "terraform", root: "/p", serverId: "" },
        { kind: "chef", root: "/p" },
        { kind: "ansible", root: "p" },
        null,
      ]),
    ).toEqual([
      { kind: "ansible", root: "/p", serverId: "s1" },
      { kind: "terraform", root: "/p", serverId: null },
    ]);
    expect(sanitizeBookmarks({})).toEqual([]);
    expect(sanitizeScenarioTab("runs")).toBe("runs");
    expect(sanitizeScenarioTab("x")).toBe("library");
  });

  it("pins and unpins, by folder and place", () => {
    const b = { kind: "ansible" as const, root: "/p", serverId: null };
    const pinned = togglePin([], b);
    expect(isPinned(pinned, b)).toBe(true);
    expect(isPinned(pinned, { ...b, serverId: "s" })).toBe(false);
    expect(togglePin(pinned, b)).toEqual([]);
    expect(folderName("/srv/infra/ansible/")).toBe("ansible");
    expect(folderName("C:\\work\\tf")).toBe("tf");
  });

  it("the shipped files written into «Mine»: library file names, a fingerprint and a language each", () => {
    expect(sanitizeSeeded({ "a.sh": { hash: "0f", lang: "ru" }, "b.yml": { hash: "", lang: "en" } })).toEqual({
      "a.sh": { hash: "0f", lang: "ru" },
      "b.yml": { hash: "", lang: "en" },
    });
    for (const bad of [null, [], "x", { "../x.sh": { hash: "1", lang: "en" } }, { "x.txt": { hash: "1", lang: "en" } }, { "x.sh": { hash: 1, lang: "en" } }, { "x.sh": null }]) {
      expect(sanitizeSeeded(bad)).toEqual({});
    }
  });
});
