import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake backend: a language server that answers `initialize` and nothing else.
const handlers = new Map<string, (m: string) => void>();
const closedHandlers = new Map<string, (c: { code: number | null; asked: boolean }) => void>();
const sent: { id: string; method: string }[] = [];
const stopped: string[] = [];
let installed = true;
let next = 0;

vi.mock("../api/lsp", () => ({
  lspStart: vi.fn(async () => (installed ? { id: `lsp${++next}`, found: true } : { id: null, found: false })),
  lspSend: vi.fn(async (id: string, message: string) => {
    const msg = JSON.parse(message) as { id?: number; method?: string };
    sent.push({ id, method: msg.method ?? "" });
    if (msg.method === "initialize") {
      queueMicrotask(() => handlers.get(id)?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } })));
    }
  }),
  lspStop: vi.fn(async (id: string) => {
    stopped.push(id);
  }),
  onLspMessage: vi.fn(async (id: string, h: (m: string) => void) => {
    handlers.set(id, h);
    return () => handlers.delete(id);
  }),
  onLspClosed: vi.fn(async (id: string, h: (c: { code: number | null; asked: boolean }) => void) => {
    closedHandlers.set(id, h);
    return () => closedHandlers.delete(id);
  }),
}));

import { acquireLsp, forgetLsp, forgetMissing, lspEntryKey, lspStatus, releaseLsp, stopLsp } from "./lsp.svelte";

const req = (sessionId = "s1", root = "/srv/app") => ({ sessionId, local: false, server: "pyright", root });

beforeEach(() => {
  installed = true;
  sent.length = 0;
  stopped.length = 0;
  forgetLsp("s1");
  forgetLsp("s2");
  stopped.length = 0;
});

describe("the language servers of the editors", () => {
  it("starts one server per folder, shares it, and stops it with the last editor", async () => {
    const a = await acquireLsp(req());
    const b = await acquireLsp(req());
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(lspStatus(lspEntryKey(req()))).toBe("running");
    expect(sent.filter((s) => s.method === "initialize")).toHaveLength(1);
    releaseLsp(req());
    expect(stopped).toEqual([]);
    releaseLsp(req());
    expect(stopped).toHaveLength(1);
    expect(lspStatus(lspEntryKey(req()))).toBe("stopped");
  });

  it("remembers a server that is not installed until asked to look again", async () => {
    installed = false;
    expect(await acquireLsp(req())).toBeNull();
    expect(lspStatus(lspEntryKey(req()))).toBe("missing");
    installed = true;
    // Still missing for the tab: no second start on every file.
    expect(await acquireLsp(req())).toBeNull();
    forgetMissing(req());
    expect(await acquireLsp(req())).not.toBeNull();
    releaseLsp(req());
  });

  it("says when a server ended by itself", async () => {
    await acquireLsp(req());
    const id = [...closedHandlers.keys()].pop()!;
    closedHandlers.get(id)!({ code: 1, asked: false });
    expect(lspStatus(lspEntryKey(req()))).toBe("failed");
  });

  it("stops by hand and with the tab", async () => {
    await acquireLsp(req("s1", "/a"));
    stopLsp(req("s1", "/a"));
    expect(stopped).toHaveLength(1);
    await acquireLsp(req("s2", "/b"));
    await acquireLsp(req("s2", "/c"));
    forgetLsp("s2");
    expect(stopped).toHaveLength(3);
    expect(lspStatus(lspEntryKey(req("s2", "/b")))).toBeNull();
  });
});
