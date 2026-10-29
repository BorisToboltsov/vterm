import { describe, expect, it } from "vitest";
import { changeEntries, downloadPercent, updateError } from "./updates";
describe("release presentation", () => {
  it("splits release sections without mistaking nested headings for versions", () => {
    expect(changeEntries("# History\n## v1.2.0 — date\n- new\n### Detail\nx\n## v1.1.0\n- old")).toEqual([
      { version: "1.2.0", title: "v1.2.0 — date", markdown: "- new\n### Detail\nx" },
      { version: "1.1.0", title: "v1.1.0", markdown: "- old" },
    ]);
    expect(changeEntries("empty")).toEqual([]);
  });
  it("shows unknown progress honestly and clamps known progress", () => {
    expect(downloadPercent(3, 0)).toBeNull();
    expect(downloadPercent(3, 10)).toBe(30);
    expect(downloadPercent(11, 10)).toBe(100);
    expect(downloadPercent(-1, 10)).toBe(0);
  });
  it("maps failures to translated UI messages, never raw backend text", () => {
    for (const code of ["key", "unpublished", "network", "signature", "manifest", "format", "unsaved", "busy", "window-timeout", "rolled-back", "recovery-required", "start-timeout"])
      expect(updateError(`update-${code}: private/path`)).toMatch(/^updates\./);
    expect(updateError("arbitrary error")).toBe("updates.errorInstall");
    expect(updateError("update-signature")).toBe("updates.errorSignature");
  });
});
