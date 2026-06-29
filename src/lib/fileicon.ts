// Map a filename to a registry icon name by extension/type (Phase 12.6). Folders
// and symlinks keep their shared icons (design-system invariant); regular files
// get a category icon for quick scanning. Unknown extensions fall back to `file`.

import { fileExt } from "./editorlang";
import type { IconName } from "./icons";

interface EntryLike {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}

const EXT_ICON: Record<string, IconName> = {};
const set = (icon: IconName, exts: string[]) => exts.forEach((e) => (EXT_ICON[e] = icon));

// Source code → angle-bracket "code" glyph.
set("code", [
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "go", "rs", "rb",
  "php", "java", "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "swift", "kt", "kts",
  "scala", "lua", "pl", "pm", "r", "jl", "dart", "clj", "cljs", "hs", "erl", "ex",
  "html", "htm", "css", "scss", "less", "xml", "vue",
]);
// Structured config / data → braces glyph.
set("braces", [
  "yaml", "yml", "json", "jsonc", "toml", "ini", "conf", "cfg", "env",
  "properties", "tf", "tfvars", "sql",
]);
// Shell scripts → terminal glyph.
set("terminal", ["sh", "bash", "zsh", "ksh", "ps1", "psm1", "fish"]);
// Images → image glyph.
set("image", ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "avif"]);
// Archives → archive glyph.
set("archive", ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "lz", "lzma"]);
// Keys / certificates → lock glyph.
set("lock", ["pem", "key", "crt", "cert", "cer", "pub", "p12", "pfx", "gpg", "asc"]);

/** Registry icon name for a directory entry (Phase 12.6 file-type icons). */
export function fileIconName(entry: EntryLike): IconName {
  if (entry.isSymlink) return "symlink";
  if (entry.isDir) return "folder";
  return EXT_ICON[fileExt(entry.name)] ?? "file";
}
