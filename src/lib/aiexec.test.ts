import { describe, it, expect } from "vitest";
import {
  parseChatSegments,
  isRunnableLang,
  isProdServer,
  toTerminalInput,
  auditLabel,
} from "./aiexec";

describe("isRunnableLang", () => {
  it("accepts shell languages, rejects others and bare fences", () => {
    for (const l of ["sh", "bash", "shell", "zsh", "console", "BASH"]) {
      expect(isRunnableLang(l)).toBe(true);
    }
    for (const l of ["", "json", "yaml", "python", "text"]) {
      expect(isRunnableLang(l)).toBe(false);
    }
  });
});

describe("parseChatSegments", () => {
  it("returns a single text segment when there is no code", () => {
    const segs = parseChatSegments("just some prose\nover two lines");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("text");
  });

  it("splits text and a runnable bash block in order", () => {
    const md = "Run this:\n```bash\nls -la\n```\nThat lists files.";
    const segs = parseChatSegments(md);
    expect(segs.map((s) => s.kind)).toEqual(["text", "code", "text"]);
    expect(segs[1]).toMatchObject({ content: "ls -la", lang: "bash", runnable: true, closed: true });
    expect(segs[0].content).toContain("Run this:");
    expect(segs[2].content).toContain("lists files");
  });

  it("marks non-shell code blocks as not runnable", () => {
    const segs = parseChatSegments('```json\n{"a":1}\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ kind: "code", runnable: false });
  });

  it("marks an unterminated (streaming) fence as not closed", () => {
    const segs = parseChatSegments("```bash\nsudo apt update");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ kind: "code", closed: false, runnable: true });
  });

  it("preserves multi-line command blocks", () => {
    const md = "```sh\ncd /tmp\nrm -rf build\n```";
    const segs = parseChatSegments(md);
    expect(segs[0].content).toBe("cd /tmp\nrm -rf build");
  });

  it("drops whitespace-only text between blocks", () => {
    const md = "```bash\na\n```\n\n```bash\nb\n```";
    const segs = parseChatSegments(md);
    expect(segs.map((s) => s.kind)).toEqual(["code", "code"]);
  });
});

describe("isProdServer", () => {
  it("detects prod/production tags case-insensitively", () => {
    expect(isProdServer(["prod"])).toBe(true);
    expect(isProdServer(["Production"])).toBe(true);
    expect(isProdServer([" PROD "])).toBe(true);
  });

  it("is false for other tags or missing tags", () => {
    expect(isProdServer(["staging", "web"])).toBe(false);
    expect(isProdServer([])).toBe(false);
    expect(isProdServer(null)).toBe(false);
    expect(isProdServer(undefined)).toBe(false);
  });
});

describe("toTerminalInput", () => {
  it("appends exactly one trailing newline", () => {
    expect(toTerminalInput("ls")).toBe("ls\n");
    expect(toTerminalInput("ls\n")).toBe("ls\n");
    expect(toTerminalInput("ls\n\n\n")).toBe("ls\n");
  });

  it("keeps internal newlines for multi-line blocks", () => {
    expect(toTerminalInput("a\nb")).toBe("a\nb\n");
  });
});

describe("auditLabel", () => {
  it("uses the single line as-is", () => {
    expect(auditLabel("systemctl restart nginx")).toBe("systemctl restart nginx");
  });

  it("summarises multi-line blocks with a count", () => {
    expect(auditLabel("cd /tmp\nls\npwd")).toBe("cd /tmp … (+2)");
  });

  it("is empty for blank blocks", () => {
    expect(auditLabel("\n  \n")).toBe("");
  });
});
