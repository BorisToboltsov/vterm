import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { resetSettings, settings } from "../settings/settings.svelte";
import { sectionsMatching } from "../settings/settingsNav";
import DbSettings from "./DbSettings.svelte";

beforeEach(() => resetSettings());

async function put(id: string, value: string): Promise<HTMLInputElement> {
  const el = screen.getByTestId(id) as HTMLInputElement;
  await fireEvent.change(el, { target: { value } });
  return el;
}

describe("Settings → Databases", () => {
  it("takes values within their bounds and shows what it took", async () => {
    render(DbSettings);
    expect((await put("settings-db-rows", "99999")).value).toBe("10000");
    expect(settings.dbMaxRows).toBe(10_000);
    expect((await put("settings-db-activity", "1")).value).toBe("2");
    expect(settings.dbActivitySec).toBe(2);
    expect((await put("settings-db-lockWaitSec", "0")).value).toBe("1");
    expect(settings.dbThresholds.lockWaitSec).toBe(1);
  });

  it("is found in both languages", () => {
    for (const q of ["postgres", "блокировки", "реплика"]) expect(sectionsMatching(q).has("databases"), q).toBe(true);
  });
});
