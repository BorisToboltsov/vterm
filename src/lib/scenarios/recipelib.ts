// The recipe library (ADR 0071): the recipes built into the app and the user's
// own, as one list the Scenarios panel draws. Built-in recipes ship with the
// build — nothing is fetched (principle 6); their names, descriptions and the
// labels of their parameters are shown in the reader's language (`t()` keys
// by id), while the file keeps its English header, so a copy into "Mine" is an
// ordinary script. Pure.
import { parseRecipe, type RecipeMeta } from "./recipe";

/** Where a recipe comes from. */
export type RecipeOrigin = "builtin" | "own" | "source";

export interface LibraryRecipe {
  /** `builtin:<file>` or the file's path. */
  id: string;
  origin: RecipeOrigin;
  /** The file name (`install-docker.sh`). */
  file: string;
  /** The folder it was read from; "" for a built-in one. */
  dir: string;
  text: string;
  /** Its header, or why it has none that reads. */
  meta: RecipeMeta | null;
  error: string | null;
}

const BUILTIN_FILES = import.meta.glob("./builtin/*.sh", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** The built-in recipes, in the order the library shows them. */
export const BUILTIN_ORDER = [
  "install-docker",
  "update-packages",
  "add-user-key",
  "firewall-open-port",
  "swap-file",
  "timezone-ntp",
  "fail2ban-ssh",
  "ssh-key-only",
  "node-exporter",
  "cleanup-disk",
] as const;

export type BuiltinId = (typeof BUILTIN_ORDER)[number];

/** A library entry for one recipe text. */
export function libraryRecipe(origin: RecipeOrigin, file: string, dir: string, id: string, text: string): LibraryRecipe {
  const parsed = parseRecipe(text);
  return {
    id,
    origin,
    file,
    dir,
    text,
    meta: parsed.ok ? parsed.meta : null,
    error: parsed.ok ? null : parsed.error,
  };
}

/** The built-in recipes. */
export function builtinRecipes(): LibraryRecipe[] {
  return BUILTIN_ORDER.map((name) => {
    const text = BUILTIN_FILES[`./builtin/${name}.sh`] ?? "";
    return libraryRecipe("builtin", `${name}.sh`, "", `builtin:${name}`, text);
  });
}

/** The built-in id of a recipe, or null for one of the user's. */
export const builtinId = (r: LibraryRecipe): BuiltinId | null =>
  r.origin === "builtin" ? (r.file.replace(/\.sh$/, "") as BuiltinId) : null;

/** The user's recipes as the scan found them: the app's folder is "own", the rest "source". */
export function userRecipes(scan: { dir: string; files: { path: string; dir: string; name: string; text: string }[] }): LibraryRecipe[] {
  return scan.files.map((f) => libraryRecipe(f.dir === scan.dir ? "own" : "source", f.name, f.dir, f.path, f.text));
}

/** Whether `r` matches the filter text: its name, description or file. */
export function recipeMatches(r: LibraryRecipe, shownName: string, shownDescription: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [shownName, shownDescription, r.file].some((s) => s.toLowerCase().includes(q));
}
