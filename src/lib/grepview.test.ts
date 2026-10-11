import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { groupMatches, lineSpans, matchSpans } from "./grepview";
import { GREP_LIMIT, type GrepMatch } from "./sync";

const m = (path: string, line: number, text = "x"): GrepMatch => ({ path, line, text });
const FIXED = { caseSensitive: false, regex: false };
const joined = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
const hits = (spans: { text: string; hit: boolean }[]) => spans.filter((s) => s.hit).map((s) => s.text);

describe("groupMatches", () => {
  it("groups by file, keeping grep's order of files and of lines", () => {
    const groups = groupMatches([m("b.conf", 3), m("a.conf", 9), m("b.conf", 12), m("a.conf", 1)]);
    expect(groups.map((g) => g.path)).toEqual(["b.conf", "a.conf"]);
    expect(groups[0].matches.map((x) => x.line)).toEqual([3, 12]);
    expect(groups[1].matches.map((x) => x.line)).toEqual([9, 1]);
  });

  it("is empty for no matches, and loses none", () => {
    expect(groupMatches([])).toEqual([]);
    fc.assert(
      fc.property(fc.array(fc.record({ path: fc.constantFrom("a", "b", "c/d"), line: fc.nat(99) })), (list) => {
        const matches = list.map((x) => m(x.path, x.line));
        const groups = groupMatches(matches);
        expect(groups.reduce((n, g) => n + g.matches.length, 0)).toBe(matches.length);
        expect(new Set(groups.map((g) => g.path)).size).toBe(groups.length);
        for (const g of groups) expect(g.matches.every((x) => x.path === g.path)).toBe(true);
      }),
    );
  });
});

describe("matchSpans", () => {
  it("marks every occurrence of a fixed string, whatever its case", () => {
    const spans = matchSpans("proxy_next_upstream to Upstream_api", "upstream", FIXED);
    expect(hits(spans)).toEqual(["upstream", "Upstream"]);
    expect(spans).toEqual([
      { text: "proxy_next_", hit: false },
      { text: "upstream", hit: true },
      { text: " to ", hit: false },
      { text: "Upstream", hit: true },
      { text: "_api", hit: false },
    ]);
  });

  it("respects the case when asked to", () => {
    expect(hits(matchSpans("Upstream upstream", "upstream", { caseSensitive: true, regex: false }))).toEqual(["upstream"]);
  });

  it("a fixed string is not an expression: its dots and brackets are themselves", () => {
    expect(hits(matchSpans("a.b axb [x]", "a.b", FIXED))).toEqual(["a.b"]);
    expect(hits(matchSpans("a.b axb [x]", "[x]", FIXED))).toEqual(["[x]"]);
    expect(hits(matchSpans("cost $5 (net)", "$5 (", FIXED))).toEqual(["$5 ("]);
  });

  it("marks what an expression matches", () => {
    const opts = { caseSensitive: false, regex: true };
    expect(hits(matchSpans("listen 80; listen 443;", "listen [0-9]+", opts))).toEqual(["listen 80", "listen 443"]);
  });

  it("an expression JavaScript cannot read marks nothing — the line is still shown", () => {
    const opts = { caseSensitive: false, regex: true };
    expect(matchSpans("a(b", "(", opts)).toEqual([{ text: "a(b", hit: false }]);
    expect(matchSpans("a[b", "[", opts)).toEqual([{ text: "a[b", hit: false }]);
  });

  it("an expression that matches the empty string marks nothing", () => {
    expect(matchSpans("abc", "x*", { caseSensitive: false, regex: true })).toEqual([{ text: "abc", hit: false }]);
  });

  it("no query, or no text: nothing to mark", () => {
    expect(matchSpans("abc", "", FIXED)).toEqual([{ text: "abc", hit: false }]);
    expect(matchSpans("", "a", FIXED)).toEqual([]);
  });

  it("stops marking a line of endless matches — the rest stays plain", () => {
    const spans = matchSpans("a".repeat(500), "a", FIXED);
    expect(hits(spans)).toHaveLength(40);
    expect(joined(spans)).toBe("a".repeat(500));
  });

  it("whatever the text and the query, the spans put together are the text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 6 }), fc.boolean(), fc.boolean(), (text, query, caseSensitive, regex) => {
        const spans = matchSpans(text, query, { caseSensitive, regex });
        expect(joined(spans)).toBe(text);
        expect(spans.every((s) => s.text.length > 0)).toBe(true);
      }),
    );
  });
});

describe("lineSpans", () => {
  it("drops the indentation of the line", () => {
    expect(joined(lineSpans("\t    proxy_pass http://upstream;", "upstream", FIXED))).toBe("proxy_pass http://upstream;");
  });

  it("a match near the start is shown with the whole start of the line", () => {
    const spans = lineSpans("proxy_pass http://upstream_api;", "upstream", FIXED);
    expect(spans[0]).toEqual({ text: "proxy_pass http://", hit: false });
  });

  it("a match far to the right is brought into view: the start gives way to an ellipsis", () => {
    const line = `${"x".repeat(200)} needle tail`;
    const spans = lineSpans(line, "needle", FIXED);
    expect(spans[0].text.startsWith("…")).toBe(true);
    expect(spans[0].text).toHaveLength(25);
    expect(spans[1]).toEqual({ text: "needle", hit: true });
    expect(spans[2]).toEqual({ text: " tail", hit: false });
  });

  it("a line that starts with the match, or has none marked, is left whole", () => {
    expect(lineSpans("upstream api {", "upstream", FIXED)[0]).toEqual({ text: "upstream", hit: true });
    const long = "y".repeat(300);
    expect(lineSpans(long, "(", { caseSensitive: false, regex: true })).toEqual([{ text: long, hit: false }]);
  });
});

describe("the limit of a search", () => {
  it("is one number in the backend, which cuts the answer, and here, where the cut is named", () => {
    const rs = readFileSync(join(process.cwd(), "src-tauri", "src", "sync.rs"), "utf8");
    const limit = /pub const GREP_LIMIT: usize = (\d+);/.exec(rs);
    expect(limit).not.toBeNull();
    expect(Number(limit![1])).toBe(GREP_LIMIT);
  });
});
