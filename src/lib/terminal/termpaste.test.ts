import { describe, expect, it } from "vitest";
import {
  hasPasteStructureRisk,
  isMultilinePaste,
  normalisePasteText,
  transformTerminalPaste,
} from "./termpaste";

describe("terminal multi-line paste", () => {
  it("recognises LF, CRLF and old-style CR line endings", () => {
    expect(isMultilinePaste("one line")).toBe(false);
    expect(isMultilinePaste("one\ntwo")).toBe(true);
    expect(isMultilinePaste("one\r\ntwo")).toBe(true);
    expect(normalisePasteText("one\rtwo\r\nthree")).toBe("one\ntwo\nthree");
  });

  it("preserves a script and its comments in exact mode", () => {
    const script = "# inspect the pod\r\nkubectl get pods\r\n# done";
    expect(transformTerminalPaste(script, "exact")).toBe(
      "# inspect the pod\nkubectl get pods\n# done",
    );
    expect(hasPasteStructureRisk(script)).toBe(true);
  });

  it("joins physical lines into one line for the explicit single-line choice", () => {
    expect(transformTerminalPaste("kubectl get pods\n  -n prod\n  -o wide", "single")).toBe(
      "kubectl get pods -n prod -o wide",
    );
    expect(transformTerminalPaste("kubectl get pods \\\n  -n prod", "single")).toBe(
      "kubectl get pods -n prod",
    );
  });

  it("adds POSIX continuations without doubling existing or trailing ones", () => {
    expect(
      transformTerminalPaste("kubectl get pods\n  -n prod \\\n  -o wide\n", "continued"),
    ).toBe("kubectl get pods \\\n  -n prod \\\n  -o wide");
  });

  it("warns for comments and heredocs but not an ordinary multi-line command", () => {
    expect(hasPasteStructureRisk("echo value # explanation\necho done")).toBe(true);
    expect(hasPasteStructureRisk("cat <<'EOF'\n# data\nEOF")).toBe(true);
    expect(hasPasteStructureRisk("kubectl get pods\n  -n prod")).toBe(false);
  });
});
