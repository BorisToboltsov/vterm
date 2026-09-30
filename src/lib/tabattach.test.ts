import { describe, expect, it } from "vitest";
import { attachIcon, attachRows, attachTitle } from "./tabattach";

describe("tabattach", () => {
  it("titles an attached tab `name · host`, a plain one by the host alone", () => {
    expect(attachTitle("Rescalc dev", { kind: "container", name: "nginx" })).toBe(
      "nginx · Rescalc dev",
    );
    expect(attachTitle("Rescalc dev", undefined)).toBe("Rescalc dev");
  });

  it("marks containers and pods with their own icons", () => {
    expect(attachIcon("container")).toBe("container");
    expect(attachIcon("pod")).toBe("kubernetes");
  });

  it("lists only the facts it knows, host last", () => {
    expect(
      attachRows({ kind: "container", name: "nginx", image: "nginx:1.27" }, "Rescalc dev"),
    ).toEqual([
      ["tab.attachImage", "nginx:1.27"],
      ["tab.attachHost", "Rescalc dev"],
    ]);
    expect(attachRows({ kind: "pod", name: "web-7f9c", container: "app" }, "Local shell")).toEqual([
      ["tab.attachContainer", "app"],
      ["tab.attachHost", "Local shell"],
    ]);
  });
});
