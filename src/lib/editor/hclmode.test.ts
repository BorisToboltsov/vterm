import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";
import { hcl } from "./hclmode";

/** Each line's tokens as [text, style], the state carried across lines. */
function tokens(src: string): [string, string | null][][] {
  const state = hcl.startState!(2);
  return src.split("\n").map((line) => {
    const out: [string, string | null][] = [];
    if (!line) {
      hcl.blankLine?.(state, 2);
      return out;
    }
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      const style = hcl.token(stream, state);
      if (stream.current().trim()) out.push([stream.current(), style]);
      stream.start = stream.pos;
    }
    return out;
  });
}

describe("the HCL stream mode", () => {
  it("tells blocks, labels, attributes, references and values apart", () => {
    const [head, count, name, , open] = tokens(
      'resource "hcloud_server" "web" {\n  count = var.web_count\n  name  = "web-${count.index + 1}"\n}\nlocals {',
    );
    expect(head).toEqual([
      ["resource", "keyword"],
      ['"hcloud_server"', "typeName"],
      ['"web"', "typeName"],
      ["{", null],
    ]);
    expect(count.slice(0, 3)).toEqual([
      ["count", "propertyName"],
      ["=", "operator"],
      ["var", "variableName.special"],
    ]);
    expect(name.map(([, s]) => s)).toEqual(["propertyName", "operator", "string", "meta", "variableName.special", null, "variableName", null, "number", "meta", "string"]);
    expect(open[0]).toEqual(["locals", "keyword"]);
  });

  it("knows its three comments and a heredoc, across lines", () => {
    const lines = tokens('# one\n// two\n/* three\n still */ x = true\nuser_data = <<-EOT\n  echo "}"\n  EOT\ny = null');
    expect(lines[0]).toEqual([["# one", "comment"]]);
    expect(lines[1]).toEqual([["// two", "comment"]]);
    expect(lines[2].every(([, st]) => st === "comment")).toBe(true);
    expect(lines[3][0][1]).toBe("comment");
    expect(lines[3].at(-1)).toEqual(["true", "atom"]);
    expect(lines[4].at(-1)).toEqual(["<<-EOT", "string"]);
    expect(lines[5]).toEqual([['  echo "}"', "string"]]);
    expect(lines[6]).toEqual([["  EOT", "string"]]);
    expect(lines[7].at(-1)).toEqual(["null", "atom"]);
  });

  it("reads a function call and a for expression", () => {
    const [line] = tokens("ids = [for s in toset(var.x) : s.id if s.on]");
    const styles = Object.fromEntries(line.map(([t, s]) => [t, s]));
    expect(styles.for).toBe("keyword");
    expect(styles.in).toBe("keyword");
    expect(styles.toset).toBe("function");
    expect(styles.if).toBe("keyword");
  });
});
