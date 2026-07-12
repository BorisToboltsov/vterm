import { describe, it, expect } from "vitest";
import {
  SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  DEFAULT_SETTINGS_GROUP,
  sectionsMatching,
  groupSections,
  groupForSection,
  visibleSectionIds,
  groupMatchCounts,
} from "./settingsNav";

describe("settingsNav groups", () => {
  it("every section belongs to exactly one group", () => {
    const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
    const sectionIds = SETTINGS_SECTIONS.map((s) => s.id);
    // No duplicates across groups.
    expect(new Set(grouped).size).toBe(grouped.length);
    // Exact 1:1 coverage of all sections.
    expect(new Set(grouped)).toEqual(new Set(sectionIds));
  });

  it("default group is the first group and has sections", () => {
    expect(DEFAULT_SETTINGS_GROUP).toBe(SETTINGS_GROUPS[0].id);
    expect(groupSections(DEFAULT_SETTINGS_GROUP).length).toBeGreaterThan(0);
  });

  it("groupSections returns [] for an unknown group", () => {
    expect(groupSections("nope")).toEqual([]);
  });

  it("groupForSection maps a section to its owning group (deep-link)", () => {
    expect(groupForSection("statusbar")).toBe("sessions");
    expect(groupForSection("language")).toBe("general");
    expect(groupForSection("nope")).toBeNull();
  });
});

describe("visibleSectionIds", () => {
  it("shows the active group's sections when not searching", () => {
    const ids = visibleSectionIds("", "appearance");
    expect(ids).toEqual(new Set(["appearance", "cursor", "idle"]));
  });

  it("blank/whitespace query falls back to the active group", () => {
    expect(visibleSectionIds("   ", "terminal")).toEqual(new Set(["terminal", "smartlogs"]));
  });

  it("shows cross-group matches when searching (ignores active group)", () => {
    const ids = visibleSectionIds("backup", "appearance");
    expect(ids.has("backup")).toBe(true);
    expect(ids.has("appearance")).toBe(false);
  });
});

describe("sectionsMatching", () => {
  it("matches bilingual keywords", () => {
    expect(sectionsMatching("шаблоны").has("snippets")).toBe(true);
    expect(sectionsMatching("threshold").has("statusbar")).toBe(true);
  });
});

describe("groupMatchCounts", () => {
  it("is all-zero when not searching", () => {
    const counts = groupMatchCounts("");
    for (const g of SETTINGS_GROUPS) expect(counts[g.id]).toBe(0);
  });

  it("counts matching sections per group when searching", () => {
    const counts = groupMatchCounts("editor");
    // "editor" keyword appears in sftp/snippets/editor (files group) and smartlogs.
    expect(counts.files).toBeGreaterThanOrEqual(1);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(sectionsMatching("editor").size);
  });
});
