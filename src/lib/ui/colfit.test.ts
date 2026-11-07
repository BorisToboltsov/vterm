import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fieldWidth, fitColumns, hideableFields, LIST_FIELDS, sanitizeHiddenFields, toggleHidden, type FieldListId, type ListField } from "./colfit";
import { LIST_COLUMNS } from "./colwidths";

const LISTS = Object.keys(LIST_FIELDS) as FieldListId[];
const fullWidth = (list: FieldListId): number =>
  LIST_FIELDS[list].fixed + LIST_FIELDS[list].fields.reduce((a, f) => a + fieldWidth(f, {}), 0);

describe("fitting a list's columns to its width", () => {
  it("keeps every column where they all fit, and before the width is known", () => {
    const all = LIST_FIELDS["docker.containers"].fields.map((f) => f.id);
    expect(fitColumns("docker.containers", {}, [], fullWidth("docker.containers")).shown).toEqual(all);
    expect(fitColumns("docker.containers", {}, [], 0)).toEqual({ shown: all, dropped: [] });
  });

  it("drops columns in the list's order and never the name", () => {
    // Half of a bottom dock with the details beside it.
    const fit = fitColumns("docker.containers", {}, [], 640);
    expect(fit.dropped).toEqual(["ports", "image"]);
    expect(fit.shown).toEqual(["name", "state", "ip", "cpu"]);
    const tight = fitColumns("docker.containers", {}, [], 100);
    expect(tight.shown).toEqual(["name", "cpu"]);
    expect(tight.dropped).toEqual(["ports", "image", "ip", "state"]);
  });

  it("follows the user's widths", () => {
    expect(fitColumns("docker.containers", {}, [], 900).dropped).toEqual(["ports"]);
    expect(fitColumns("docker.containers", { "docker.name": 600 }, [], 900).dropped).toEqual(["ports", "image", "ip", "state"]);
    expect(fitColumns("docker.containers", { "docker.ports": 60 }, [], 960).dropped).toEqual([]);
  });

  it("reports only what the width took, not what the user hid", () => {
    const fit = fitColumns("docker.containers", {}, ["ports"], 10_000);
    expect(fit.shown).not.toContain("ports");
    expect(fit.dropped).toEqual([]);
  });

  it("drops a column named first before the list's own order", () => {
    const room = fullWidth("k8s.pods") - 50;
    expect(fitColumns("k8s.pods", {}, [], room).dropped).toEqual(["limits"]);
    expect(fitColumns("k8s.pods", {}, [], room, ["namespace"]).dropped).toEqual(["namespace"]);
  });

  it("what it shows fits, whatever the width — unless only the kept columns are left", () => {
    for (const list of LISTS) {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 4000 }), (room) => {
          const fit = fitColumns(list, {}, [], room);
          const spec = LIST_FIELDS[list];
          const used = spec.fixed + spec.fields.filter((f) => fit.shown.includes(f.id)).reduce((a, f) => a + fieldWidth(f, {}), 0);
          const leftovers = fit.shown.filter((id) => (spec.drop as readonly string[]).includes(id));
          expect(used <= room || leftovers.length === 0).toBe(true);
          for (const f of spec.fields) if (!f.hideable) expect(fit.shown).toContain(f.id);
        }),
      );
    }
  });

  it("names only columns that exist", () => {
    for (const list of LISTS) {
      const ids = LIST_FIELDS[list].fields.map((f) => f.id);
      for (const id of LIST_FIELDS[list].drop) expect(ids).toContain(id);
      for (const f of LIST_FIELDS[list].fields as readonly ListField[]) if (f.col) expect(Object.keys(LIST_COLUMNS)).toContain(f.col);
    }
  });
});

describe("the columns the user hid", () => {
  it("keeps only known lists and fields that may be hidden", () => {
    expect(
      sanitizeHiddenFields({ "docker.containers": ["ports", "name", "ports", 7, "nope"], "k8s.pods": "x", other: ["a"] }),
    ).toEqual({ "docker.containers": ["ports"] });
    expect(sanitizeHiddenFields(null)).toEqual({});
    expect(sanitizeHiddenFields(["x"])).toEqual({});
    expect(sanitizeHiddenFields({ toString: ["ip"] })).toEqual({});
  });

  it("flips a field, and never the name", () => {
    expect(toggleHidden([], "docker.containers", "ip")).toEqual(["ip"]);
    expect(toggleHidden(["ip"], "docker.containers", "ip")).toEqual([]);
    expect(toggleHidden([], "docker.containers", "name")).toEqual([]);
    expect(hideableFields("docker.containers")).not.toContain("name");
    expect(hideableFields("k8s.pods")).not.toContain("actions");
  });
});
