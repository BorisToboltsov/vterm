import { describe, expect, it } from "vitest";
import { concatBytes, createOrderedWriter } from "./termwrite";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A fake transport whose calls stay pending until released by the test. */
function manualSend() {
  const calls: { id: string; text: string; ok: () => void; fail: (e: unknown) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const send = (id: string, data: Uint8Array) =>
    new Promise<void>((ok, fail) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = (f: () => void) => () => {
        inFlight--;
        f();
      };
      calls.push({
        id,
        text: dec.decode(data),
        ok: done(ok),
        fail: (e) => done(() => fail(e))(),
      });
    });
  return { send, calls, maxInFlight: () => maxInFlight };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("concatBytes", () => {
  it("joins chunks in order", () => {
    expect(dec.decode(concatBytes([enc.encode("ab"), enc.encode(""), enc.encode("c")]))).toBe("abc");
  });
});

describe("createOrderedWriter", () => {
  it("never has two writes of one session in flight", async () => {
    const t = manualSend();
    const write = createOrderedWriter(t.send);
    const ps = [..."vterm"].map((ch) => write("s", enc.encode(ch)));
    expect(t.calls.map((c) => c.text)).toEqual(["v"]);
    t.calls[0].ok();
    await tick();
    // Everything typed while "v" was in flight goes out as ONE write, in order.
    expect(t.calls.map((c) => c.text)).toEqual(["v", "term"]);
    t.calls[1].ok();
    await Promise.all(ps);
    expect(t.maxInFlight()).toBe(1);
  });

  it("delivers bytes in call order even when the transport would reorder", async () => {
    // Real-world failure: a transport that runs each call as its own task, where
    // a later call may land first. Serialising makes that impossible.
    const landed: string[] = [];
    const write = createOrderedWriter(
      (_id, data) =>
        new Promise<void>((ok) =>
          setTimeout(() => {
            landed.push(dec.decode(data));
            ok();
          }, Math.random() * 5),
        ),
    );
    const typed = "echo vterm\r";
    await Promise.all([...typed].map((ch) => write("s", enc.encode(ch))));
    expect(landed.join("")).toBe(typed);
  });

  it("rejects only the failed batch and keeps the lane going", async () => {
    const t = manualSend();
    const write = createOrderedWriter(t.send);
    const first = write("s", enc.encode("a"));
    const second = write("s", enc.encode("b"));
    t.calls[0].fail(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await tick();
    expect(t.calls[1].text).toBe("b");
    t.calls[1].ok();
    await expect(second).resolves.toBeUndefined();
  });

  it("treats a synchronously throwing transport as a failed write", async () => {
    let n = 0;
    const write = createOrderedWriter(async () => {
      if (n++ === 0) throw new Error("sync");
    });
    await expect(write("s", enc.encode("a"))).rejects.toThrow("sync");
    await expect(write("s", enc.encode("b"))).resolves.toBeUndefined();
  });

  it("keeps sessions independent", async () => {
    const t = manualSend();
    const write = createOrderedWriter(t.send);
    void write("a", enc.encode("1"));
    void write("b", enc.encode("2"));
    // A slow session must not hold up another one.
    expect(t.calls.map((c) => `${c.id}:${c.text}`)).toEqual(["a:1", "b:2"]);
  });

  it("starts a fresh write immediately once a lane has drained", async () => {
    const t = manualSend();
    const write = createOrderedWriter(t.send);
    const p = write("s", enc.encode("x"));
    t.calls[0].ok();
    await p;
    await tick();
    void write("s", enc.encode("y"));
    expect(t.calls.map((c) => c.text)).toEqual(["x", "y"]);
  });
});
