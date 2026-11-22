import { describe, expect, it } from "vitest";
import { splitSql, statementAt, tokens } from "./sqlsplit";

const texts = (src: string, d: "postgres" | "mysql" = "postgres") => splitSql(src, d).map((p) => p.text);

describe("splitSql", () => {
  it("ends a statement at a semicolon of plain code only", () => {
    expect(texts("select 1; select ';' ; select \"a;b\" from t;")).toEqual(["select 1", "select ';'", 'select "a;b" from t']);
    expect(texts("select 'it''s; fine'; select 2")).toEqual(["select 'it''s; fine'", "select 2"]);
  });

  it("reads PostgreSQL dollar quotes, nested comments and E-strings", () => {
    const body = "create function f() returns int as $fn$ begin return 1; end $fn$ language plpgsql";
    expect(texts(`${body}; select $1;`)).toEqual([body, "select $1"]);
    expect(texts("select 1 /* a; /* b; */ c; */; select 2")).toEqual(["select 1 /* a; /* b; */ c; */", "select 2"]);
    expect(texts("select E'a\\';b'; select 3")).toEqual(["select E'a\\';b'", "select 3"]);
    expect(texts("select $$a;b$$; select 4")).toEqual(["select $$a;b$$", "select 4"]);
  });

  it("reads MySQL backticks, # comments and backslash escapes", () => {
    expect(texts("select `a;b` from t; # x; y\nselect 'a\\';b'", "mysql")).toEqual(["select `a;b` from t", "# x; y\nselect 'a\\';b'"]);
    // `--` without a space is not a comment in MySQL.
    expect(texts("select 1--2; select 3", "mysql")).toEqual(["select 1--2", "select 3"]);
  });

  it("drops what holds only blanks and comments, and keeps where each statement stands", () => {
    const src = "  -- only a comment\n;\n\nselect 1 ;  \n/* x */ select 2";
    const pieces = splitSql(src, "postgres");
    expect(pieces.map((p) => p.text)).toEqual(["select 1", "/* x */ select 2"]);
    for (const p of pieces) expect(src.slice(p.from, p.to)).toBe(p.text);
  });
});

describe("statementAt", () => {
  const src = "select 1;\nselect 2;\n\nselect 3";
  const pieces = splitSql(src, "postgres");
  it("is the statement around the caret, or the one it just left", () => {
    expect(statementAt(pieces, 3)?.text).toBe("select 1");
    expect(statementAt(pieces, src.indexOf("2") + 2)?.text).toBe("select 2");
    expect(statementAt(pieces, src.indexOf("select 3") - 1)?.text).toBe("select 2");
    expect(statementAt(pieces, src.length)?.text).toBe("select 3");
    expect(statementAt([], 0)).toBeNull();
  });
});

describe("tokens", () => {
  it("keeps qualified and quoted names whole and counts parentheses", () => {
    const ts = tokens('select x from public."Order" o join "Sales".items i on (i.id = o.id)', "postgres");
    expect(ts.map((t) => t.text)).toContain('public."Order"');
    expect(ts.map((t) => t.text)).toContain('"Sales".items');
    expect(ts.find((t) => t.text === "i.id")?.depth).toBe(1);
    expect(tokens("select 'a b' -- c", "postgres").map((t) => t.kind)).toEqual(["word", "string"]);
  });
});
