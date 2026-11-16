import { describe, expect, it } from "vitest";
import { LISTING_STATUS_ARGS, PREFIX_ARGS, markTone, parseListingStatus } from "./gitlisting";

const rec = (...r: string[]) => r.join("\0") + "\0";

describe("parseListingStatus", () => {
  it("reads the branch, the distance and each entry's letter", () => {
    const out = rec(
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 a b pyproject.toml",
      "1 A. N... 000000 100644 100644 a b new file.py",
      "1 .D N... 100644 100644 000000 a b gone.txt",
      "2 R. N... 100644 100644 100644 a b R100 renamed.py",
      "old.py",
      "u UU N... 1 2 3 4 a b c conflict.txt",
      "? scratch.py",
      "1 .M N... 100644 100644 100644 a b src/pkg/mod.py",
      "! .venv/",
      "! src/__pycache__/",
    );
    const g = parseListingStatus(out, "");
    expect(g.branch).toBe("main");
    expect([g.ahead, g.behind]).toEqual([2, 1]);
    expect(Object.fromEntries(g.marks)).toEqual({
      "pyproject.toml": "M",
      "new file.py": "A",
      "gone.txt": "D",
      "renamed.py": "R",
      "conflict.txt": "C",
      "scratch.py": "U",
      src: "•",
    });
    expect([...g.ignored]).toEqual([".venv"]);
    expect(g.changed).toBe(7);
  });

  it("keeps to the folder shown inside the repository", () => {
    const out = rec("# branch.head (detached)", "1 .M N... 1 1 1 a b app/main.go", "1 .M N... 1 1 1 a b other/x.go", "! app/bin/");
    const g = parseListingStatus(out, "app/");
    expect(g.branch).toBeNull();
    expect(Object.fromEntries(g.marks)).toEqual({ "main.go": "M" });
    expect([...g.ignored]).toEqual(["bin"]);
    expect(g.changed).toBe(1);
  });

  it("asks git only what its policy lets through", () => {
    expect(LISTING_STATUS_ARGS[0]).toBe("status");
    expect(PREFIX_ARGS).toEqual(["rev-parse", "--show-prefix"]);
    expect(markTone("U")).toBe("ok");
    expect(markTone("D")).toBe("bad");
    expect(markTone("•")).toBe("warn");
  });
});
