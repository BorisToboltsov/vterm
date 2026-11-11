import { describe, expect, it } from "vitest";
import { pollFailed, singleFlight } from "./poll";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("singleFlight", () => {
  it("runs one read at a time; calls while it is out ask for one more after it, however many", async () => {
    let running = 0;
    let most = 0;
    let runs = 0;
    const gates: (() => void)[] = [];
    const read = singleFlight(async () => {
      runs++;
      running++;
      most = Math.max(most, running);
      await new Promise<void>((done) => gates.push(done));
      running--;
    });
    const first = read();
    // Five ticks while the first read hangs (a dead link): no pile.
    for (let i = 0; i < 5; i++) expect(read()).toBe(first);
    expect(runs).toBe(1);
    gates.shift()!();
    await first;
    await tick();
    // One more read for all five, not five.
    expect(runs).toBe(2);
    gates.shift()!();
    await tick();
    await tick();
    expect(runs).toBe(2);
    expect(most).toBe(1);
  });

  it("a read that throws lets the next one run", async () => {
    let n = 0;
    const read = singleFlight(async () => {
      n++;
      if (n === 1) throw new Error("boom");
    });
    await expect(read()).rejects.toThrow("boom");
    await read();
    expect(n).toBe(2);
  });
});

describe("pollFailed", () => {
  it("counts the same error on the streak and calls only the first one, or another one, news", () => {
    const a = pollFailed(null, "exec channel failed", 1000);
    expect(a).toEqual({ failure: { text: "exec channel failed", since: 1000, count: 1 }, news: true });
    const b = pollFailed(a.failure, "exec channel failed", 4000);
    expect(b).toEqual({ failure: { text: "exec channel failed", since: 1000, count: 2 }, news: false });
    // Another error is news, the streak goes on from when it began.
    const c = pollFailed(b.failure, "no active session", 7000);
    expect(c).toEqual({ failure: { text: "no active session", since: 1000, count: 3 }, news: true });
  });
});
