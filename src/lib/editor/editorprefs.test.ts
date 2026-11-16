import { describe, expect, it } from "vitest";
import { EDITOR_DEFAULTS, MAX_OVERRIDES, langKey, sanitizeEditorSettings, withOverride } from "./editorprefs";

describe("sanitizeEditorSettings", () => {
  it("fills what an older store lacks", () => {
    expect(sanitizeEditorSettings({ diffBeforeSave: false })).toEqual({ ...EDITOR_DEFAULTS, diffBeforeSave: false });
    expect(sanitizeEditorSettings(null)).toEqual(EDITOR_DEFAULTS);
  });

  it("drops what is not a language, a formatter id or a key", () => {
    const s = sanitizeEditorSettings({
      wrap: "yes",
      langOverrides: { "sftp:/a": "python", "sftp:/b": "klingon", "sftp:/c": 3 },
      formatters: { python: "ruff", yaml: "rm -rf /", nonsense: "x" },
      lspAuto: ["h|/srv|pyright", 5, "h|/srv|pyright"],
    });
    expect(s.wrap).toBe(true);
    expect(s.langOverrides).toEqual({ "sftp:/a": "python" });
    expect(s.formatters).toEqual({ python: "ruff" });
    expect(s.lspAuto).toEqual(["h|/srv|pyright"]);
  });
});

describe("withOverride", () => {
  it("sets, moves to newest, drops, and keeps the cap", () => {
    expect(withOverride({ a: "yaml" }, "b", "python")).toEqual({ a: "yaml", b: "python" });
    expect(Object.keys(withOverride({ a: "yaml", b: "json" }, "a", "toml"))).toEqual(["b", "a"]);
    expect(withOverride({ a: "yaml" }, "a", null)).toEqual({});
    const many = Object.fromEntries(Array.from({ length: MAX_OVERRIDES }, (_, i) => [`k${i}`, "yaml" as const]));
    const next = withOverride(many, "new", "json");
    expect(Object.keys(next).length).toBe(MAX_OVERRIDES);
    expect(next.k0).toBeUndefined();
    expect(next.new).toBe("json");
  });

  it("keys by where the file lives", () => {
    expect(langKey("sftp", "/etc/x")).toBe("sftp:/etc/x");
  });
});
