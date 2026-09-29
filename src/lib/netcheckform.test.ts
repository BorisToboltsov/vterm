import { describe, expect, it } from "vitest";
import {
  appendRuleLine,
  builderError,
  builderFilled,
  buildRuleLine,
  isDeletableLine,
  lineAtY,
  lineRange,
  removeLine,
  splitHostPort,
  type BuilderFields,
} from "./netcheckform";
import { parseRules } from "./netcheck";

const f = (p: Partial<BuilderFields>): BuilderFields => ({
  source: "10.64.48.180",
  target: "10.70.39.10",
  ports: "22",
  proto: "tcp",
  ...p,
});

describe("buildRuleLine", () => {
  it("writes one port bare and several in brackets, always with the protocol", () => {
    expect(buildRuleLine(f({}))).toBe("10.64.48.180 -> 10.70.39.10:22/tcp");
    expect(buildRuleLine(f({ ports: "22, 443  8000-8010" }))).toBe(
      "10.64.48.180 -> 10.70.39.10:[22, 443, 8000-8010]/tcp",
    );
    expect(buildRuleLine(f({ proto: "udp", ports: "53" }))).toBe("10.64.48.180 -> 10.70.39.10:53/udp");
  });

  it("omits the arrow without a source and trims the fields", () => {
    expect(buildRuleLine(f({ source: "", target: "  db.corp " }))).toBe("db.corp:22/tcp");
  });

  it("produces lines the rules parser accepts as the same rule", () => {
    const { rules, errors } = parseRules(buildRuleLine(f({ ports: "22, 443" })));
    expect(errors).toEqual([]);
    expect(rules[0]).toMatchObject({
      source: "10.64.48.180",
      targets: ["10.70.39.10"],
      ports: [22, 443],
      proto: "tcp",
    });
  });
});

describe("builderFilled / builderError", () => {
  it("needs both a target and ports before it says anything", () => {
    expect(builderFilled(f({ target: " " }))).toBe(false);
    expect(builderFilled(f({ ports: "" }))).toBe(false);
    expect(builderError(f({ target: "", ports: "99999" }))).toBeNull();
  });

  it("reports what the rules box would reject", () => {
    expect(builderError(f({}))).toBeNull();
    expect(builderError(f({ ports: "99999" }))?.code).toBe("port");
    expect(builderError(f({ target: "10.70.39.300" }))?.code).toBe("host");
    // The grey placeholder typed for real is not a target.
    expect(builderError(f({ target: "0.0.0.0" }))?.code).toBe("unspecified");
  });
});

describe("splitHostPort", () => {
  it("spreads host:port and host:[ports] over the two fields", () => {
    expect(splitHostPort("10.70.39.10:22")).toEqual({ target: "10.70.39.10", ports: "22" });
    expect(splitHostPort(" db.corp : [22, 443] ")).toEqual({ target: "db.corp", ports: "22, 443" });
  });

  it("leaves a bare host or a half-typed colon alone", () => {
    expect(splitHostPort("10.70.39.10")).toBeNull();
    expect(splitHostPort("10.70.39.10:")).toBeNull();
    expect(splitHostPort("a -> b:22")).toBeNull();
  });
});

describe("appendRuleLine", () => {
  it("adds the rule on a line of its own", () => {
    expect(appendRuleLine("", "a:1")).toBe("a:1");
    expect(appendRuleLine("  \n", "a:1")).toBe("a:1");
    expect(appendRuleLine("x:1", "a:1")).toBe("x:1\na:1");
    expect(appendRuleLine("x:1\n", "a:1")).toBe("x:1\na:1");
  });
});

describe("line geometry and deletion", () => {
  it("maps a pointer offset to a line, counting the scroll", () => {
    expect(lineAtY(0, 0, 24)).toBe(0);
    expect(lineAtY(23.9, 0, 24)).toBe(0);
    expect(lineAtY(24, 0, 24)).toBe(1);
    expect(lineAtY(10, 48, 24)).toBe(2);
    expect(lineAtY(-3, 0, 24)).toBe(-1);
    expect(lineAtY(10, 0, 0)).toBe(-1);
  });

  it("offers deletion only for existing lines with content", () => {
    const text = "a:1\n\n  \nb:2";
    expect(isDeletableLine(text, 0)).toBe(true);
    expect(isDeletableLine(text, 1)).toBe(false);
    expect(isDeletableLine(text, 2)).toBe(false);
    expect(isDeletableLine(text, 3)).toBe(true);
    expect(isDeletableLine(text, 4)).toBe(false);
    expect(isDeletableLine(text, -1)).toBe(false);
  });

  it("removes a whole line without leaving a blank one behind", () => {
    const text = "a:1\nb:2\nc:3";
    expect(removeLine(text, 0)).toBe("b:2\nc:3");
    expect(removeLine(text, 1)).toBe("a:1\nc:3");
    expect(removeLine(text, 2)).toBe("a:1\nb:2");
    expect(removeLine("only:1", 0)).toBe("");
    expect(removeLine(text, 9)).toBe(text);
  });

  it("gives the exact range the editor deletes (for undo)", () => {
    const text = "a:1\nbb:2\nc:3";
    expect(lineRange(text, 1)).toEqual({ start: 4, end: 9 });
    expect(lineRange(text, 2)).toEqual({ start: 8, end: 12 });
    expect(lineRange(text, 5)).toBeNull();
  });
});
