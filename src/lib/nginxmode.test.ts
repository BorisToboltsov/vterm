import { describe, it, expect } from "vitest";
import { StringStream } from "@codemirror/language";
import { nginx } from "./nginxmode";

interface Tok {
  text: string;
  style: string | null;
}

/** Tokenize one line, mutating the carried-over state like CodeMirror does. */
function tokenizeLine(line: string, state: unknown): Tok[] {
  const stream = new StringStream(line, 2, 2);
  const toks: Tok[] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style = nginx.token(stream, state as any);
    if (stream.pos === stream.start) stream.pos++; // safety: never loop forever
    toks.push({ text: stream.string.slice(stream.start, stream.pos), style });
  }
  return toks;
}

function tokenizeDoc(lines: string[]): Tok[][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (nginx.startState as any)(2);
  return lines.map((l) => tokenizeLine(l, state));
}

describe("nginx mode (vendored, comment-bug fixed)", () => {
  it("does not treat `/*` in an include glob as a C comment (whole-file grey bug)", () => {
    const doc = tokenizeDoc([
      "include /etc/nginx/modules-enabled/*.conf;",
      "events {",
      "    worker_connections 768;",
    ]);

    // The include line must not open a never-closing comment.
    expect(doc[0].some((t) => t.style === "comment")).toBe(false);

    // …so the following lines highlight normally instead of greying out.
    const events = doc[1].find((t) => t.text === "events");
    expect(events?.style).toBe("controlKeyword");
    expect(doc[1].every((t) => t.style !== "comment")).toBe(true);

    const wc = doc[2].find((t) => t.text === "worker_connections");
    expect(wc?.style).toBe("keyword");
  });

  it("still highlights `#` line comments and common directives", () => {
    const doc = tokenizeDoc(["# a real comment", "sendfile on;", "worker_processes auto;"]);
    expect(doc[0][0].style).toBe("comment");
    expect(doc[1].find((t) => t.text === "sendfile")?.style).toBe("keyword");
    expect(doc[2].find((t) => t.text === "worker_processes")?.style).toBe("keyword");
  });

  it("highlights quoted strings and nested block keywords", () => {
    const doc = tokenizeDoc([
      "http {",
      "  server {",
      '    server_name "example.com";',
      "    listen 80;",
      "  }",
      "}",
    ]);
    expect(doc[0].find((t) => t.text === "http")?.style).toBe("controlKeyword");
    expect(doc[1].find((t) => t.text === "server")?.style).toBe("controlKeyword");
    // Quoted value is a single string token (exercises the string tokenizer + block stack).
    const str = doc[2].find((t) => t.style === "string");
    expect(str?.text).toContain("example.com");
    expect(doc[3].find((t) => t.text === "listen")?.style).toBe("controlKeyword");
  });
});
