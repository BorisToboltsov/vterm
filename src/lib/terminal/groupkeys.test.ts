import { describe, expect, it } from "vitest";
import { keysReceivers, mirrorable, pastedText, type Screen } from "./groupkeys";

describe("who gets the keys", () => {
  const screens: Record<string, Screen | null> = { a: "alternate", b: "alternate", c: "normal", d: null };
  const screenOf = (id: string) => screens[id] ?? null;

  it("gives them to the members on the same kind of screen and names the rest", () => {
    expect(keysReceivers("a", ["a", "b", "c", "d"], screenOf)).toEqual({ to: ["b"], skipped: ["c", "d"] });
  });

  it("from a shell, gives them to the shells", () => {
    expect(keysReceivers("c", ["a", "b", "c"], screenOf)).toEqual({ to: [], skipped: ["a", "b"] });
  });

  it("gives them to nobody when the source's own screen is unknown", () => {
    expect(keysReceivers("d", ["a", "d"], screenOf)).toEqual({ to: [], skipped: ["a"] });
  });
});

describe("what is passed on", () => {
  it("passes keys, arrows and Esc as they are", () => {
    expect(mirrorable("i\x1b:wq\r")).toBe("i\x1b:wq\r");
    expect(mirrorable("\x1b[A\x1bOB")).toBe("\x1b[A\x1bOB");
  });

  it("drops mouse and focus reports, which name places on the source's own screen", () => {
    expect(mirrorable("a\x1b[<0;12;5Mb\x1b[<0;12;5m")).toBe("ab");
    expect(mirrorable("\x1b[M !!x")).toBe("x");
    expect(mirrorable("\x1b[32;10;4Mz")).toBe("z");
    expect(mirrorable("\x1b[I\x1b[O")).toBe("");
  });

  it("finds the text of a whole bracketed paste, and only of a whole one", () => {
    expect(pastedText("\x1b[200~line 1\rline 2\x1b[201~")).toBe("line 1\rline 2");
    expect(pastedText("plain")).toBeNull();
    expect(pastedText("\x1b[200~half")).toBeNull();
    expect(pastedText("\x1b[200~a\x1b[201~\x1b[200~b\x1b[201~")).toBeNull();
  });
});
