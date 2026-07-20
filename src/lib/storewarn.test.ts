import { describe, it, expect } from "vitest";
import { storeWarningMessage } from "./storewarn";

describe("storeWarningMessage", () => {
  it("names the rescue path when the original was moved aside", () => {
    const m = storeWarningMessage({
      file: "/home/u/.config/vterm/servers.json",
      quarantined: "/home/u/.config/vterm/servers.json.corrupt-17ab",
    });
    expect(m.key).toBe("store.corruptSaved");
    // The file is named by basename — the message is a toast, not a path dump.
    expect(m.params.file).toBe("servers.json");
    // The rescue path stays full: it is the one thing the user must act on.
    expect(m.params.saved).toBe("/home/u/.config/vterm/servers.json.corrupt-17ab");
  });

  it("uses a different message when the file could not be rescued", () => {
    // The two cases are not variations in tone: one says "your data is safe at
    // X", the other says "your data is still at risk". Reporting the second as
    // the first is the failure this whole change exists to prevent.
    const m = storeWarningMessage({
      file: "/home/u/.config/vterm/servers.json",
      quarantined: null,
    });
    expect(m.key).toBe("store.corruptStuck");
    // Full path here — the user has to go find it themselves.
    expect(m.params.file).toBe("/home/u/.config/vterm/servers.json");
  });

  it("takes the basename off Windows paths too", () => {
    const m = storeWarningMessage({
      file: "C:\\Users\\u\\AppData\\Roaming\\su.vcore.vterm\\config\\folders.json",
      quarantined: "C:\\Users\\u\\AppData\\Roaming\\su.vcore.vterm\\config\\folders.json.corrupt-1",
    });
    expect(m.params.file).toBe("folders.json");
  });

  it("leaves a bare filename alone", () => {
    const m = storeWarningMessage({ file: "servers.json", quarantined: null });
    expect(m.params.file).toBe("servers.json");
  });
});
