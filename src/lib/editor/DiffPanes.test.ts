import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import DiffPanes from "./DiffPanes.svelte";
import { setLocale } from "../i18n";

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

const server = ["services:", "  backend:", "    image: app:0.1", "    restart: unless-stopped", "    entrypoint: /app/run.sh", "  nginx:", "    ports:", "      - 443:443", "      - 80:80", "    restart: always", ""].join("\n");
const mine = ["services:", "  backend:", "    image: app:0.2", "    restart: unless-stopped", "    deploy:", "      replicas: 2", "    entrypoint: /app/run.sh", "  nginx:", "    ports:", "      - 443:443", "    restart: always", ""].join("\n");

function mount(original = server, modified = mine) {
  render(DiffPanes, { original, modified, originalLabel: "server", modifiedLabel: "yours" });
  flushSync();
}

const pane = (side: "a" | "b") => screen.getByTestId(`diff-${side}`);
const lines = (side: "a" | "b", cls: string) => pane(side).querySelectorAll(`.cm-line${cls}`);
const counter = () => screen.getByTestId("diff-counter").textContent;

describe("DiffPanes", () => {
  beforeEach(() => {
    setLocale("ru");
    flushSync();
  });

  it("shows the two texts in two panes under their labels", () => {
    mount();
    expect(pane("a").querySelector(".cm-content")?.textContent).toContain("app:0.1");
    expect(pane("b").querySelector(".cm-content")?.textContent).toContain("replicas: 2");
    expect(screen.getByText("server")).toBeTruthy();
    expect(screen.getByText("yours")).toBeTruthy();
  });

  it("tints changed lines on both sides and marks the changed characters", () => {
    mount();
    expect(lines("a", ".cm-sd-line.cm-sd-mod")).toHaveLength(1);
    expect(lines("b", ".cm-sd-line.cm-sd-mod")).toHaveLength(1);
    expect([...pane("a").querySelectorAll(".cm-sd-word")].map((e) => e.textContent)).toEqual(["1"]);
    expect([...pane("b").querySelectorAll(".cm-sd-word")].map((e) => e.textContent)).toEqual(["2"]);
  });

  it("draws added lines on the right and only a line where they go on the left — no blank padding", () => {
    mount();
    expect([...lines("b", ".cm-sd-line.cm-sd-add")].map((e) => e.textContent)).toEqual([
      "    deploy:",
      "      replicas: 2",
    ]);
    const gaps = lines("a", ".cm-sd-gap.cm-sd-add");
    expect([...gaps].map((e) => e.textContent)).toEqual(["    entrypoint: /app/run.sh"]);
    expect(gaps[0].classList.contains("cm-sd-gap-above")).toBe(true);
    expect(pane("a").querySelectorAll(".cm-mergeSpacer")).toHaveLength(0);
  });

  it("draws removed lines on the left and a line where they were on the right", () => {
    mount();
    expect([...lines("a", ".cm-sd-line.cm-sd-del")].map((e) => e.textContent)).toEqual(["      - 80:80"]);
    expect([...lines("b", ".cm-sd-gap.cm-sd-del")].map((e) => e.textContent)).toEqual(["    restart: always"]);
  });

  it("marks lines added at the end of a file on the empty line after its last newline", () => {
    mount("a\nb\n", "a\nb\nc\n");
    const gap = lines("a", ".cm-sd-gap");
    expect(gap).toHaveLength(1);
    expect(gap[0].classList.contains("cm-sd-gap-above")).toBe(true);
    expect([...lines("b", ".cm-sd-line.cm-sd-add")].map((e) => e.textContent)).toEqual(["c"]);
  });

  it("opens on the first difference and steps through them with the buttons and F7, round the ends", async () => {
    mount();
    await frame();
    await frame();
    flushSync();
    expect(counter()).toBe("Различие 1 из 3");
    await fireEvent.click(screen.getByTestId("diff-next"));
    expect(counter()).toBe("Различие 2 из 3");
    await fireEvent.keyDown(pane("b"), { key: "F7" });
    expect(counter()).toBe("Различие 3 из 3");
    await fireEvent.keyDown(pane("b"), { key: "F7" });
    expect(counter()).toBe("Различие 1 из 3");
    await fireEvent.keyDown(pane("a"), { key: "F7", shiftKey: true });
    expect(counter()).toBe("Различие 3 из 3");
    await fireEvent.click(screen.getByTestId("diff-prev"));
    expect(counter()).toBe("Различие 2 из 3");
  });

  it("says there are no differences, with nothing to step through", async () => {
    mount(server, server);
    await frame();
    flushSync();
    expect(counter()).toBe("Различий нет");
    expect((screen.getByTestId("diff-next") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryAllByTestId("diff-mark")).toHaveLength(0);
  });
});
