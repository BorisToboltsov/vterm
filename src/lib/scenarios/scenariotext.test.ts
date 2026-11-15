import { describe, expect, it } from "vitest";
import { builtinRecipes, libraryRecipe } from "./recipelib";
import { cellLook, changeLook, hostLook, paramText, recipeDescription, recipeName } from "./scenariotext";

describe("how the Scenarios say things", () => {
  const [docker] = builtinRecipes();
  const mine = libraryRecipe("own", "x.sh", "/d", "/d/x.sh", "# vterm:\n#   name: Mine\n#   description: Mine does\n#   params:\n#     A: { label: Label A, hint: a hint }\n");

  it("names a built-in recipe in the reader's language and the user's as written", () => {
    expect(recipeName(docker)).toBe("Install Docker");
    expect(recipeDescription(docker)).toMatch(/Docker Engine/);
    expect(paramText(docker, docker.meta!.params[0])).toEqual({ label: "User to add to the docker group", hint: "empty — the login of the connection" });
    expect(recipeName(mine)).toBe("Mine");
    expect(recipeDescription(mine)).toBe("Mine does");
    expect(paramText(mine, mine.meta!.params[0])).toEqual({ label: "Label A", hint: "a hint" });
    const plain = libraryRecipe("source", "p.sh", "/d", "/d/p.sh", "echo\n");
    expect([recipeName(plain), recipeDescription(plain)]).toEqual(["p.sh", ""]);
  });

  it("every built-in parameter has its label in the dictionary", () => {
    for (const r of builtinRecipes()) for (const p of r.meta!.params) expect(paramText(r, p).label).not.toMatch(/^scenarios\./);
  });

  it("gives every state, cell and change a look", () => {
    for (const s of ["waiting", "connecting", "checking", "running", "same", "change", "ok", "skipped", "failed", "stopped", "bogus"]) {
      expect(hostLook(s).text).not.toBe("");
    }
    expect(cellLook("changed", true, false).text).toBe("would change");
    expect(cellLook("changed", false, false).text).toBe("changed");
    expect(cellLook("failed", false, true).text).toBe("ignored");
    for (const s of ["running", "ok", "failed", "skipped", "unreachable"] as const) expect(cellLook(s, false, false).cls).not.toBe("");
    expect(changeLook("delete").sign).toBe("−");
    for (const k of ["create", "update", "replace", "read", "noop"] as const) expect(changeLook(k).sign).toBeTruthy();
  });
});
