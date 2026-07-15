import { describe, it, expect } from "vitest";
import { splitHostPort, prepareHosts } from "./knownhosts";
import type { KnownHostEntry } from "./api";

describe("splitHostPort", () => {
  it("splits host:port at the last colon", () => {
    expect(splitHostPort("example.com:22")).toEqual({ host: "example.com", port: "22" });
    expect(splitHostPort("10.0.0.1:2222")).toEqual({ host: "10.0.0.1", port: "2222" });
  });

  it("keeps a bracketed IPv6 host intact", () => {
    expect(splitHostPort("[::1]:22")).toEqual({ host: "[::1]", port: "22" });
  });

  it("handles an id with no port", () => {
    expect(splitHostPort("example.com")).toEqual({ host: "example.com", port: "" });
  });
});

describe("prepareHosts", () => {
  const entries: KnownHostEntry[] = [
    { id: "beta.example:22", fingerprint: "SHA256:bbb" },
    { id: "alpha.example:2222", fingerprint: "SHA256:aaa" },
    { id: "alpha.example:22", fingerprint: "SHA256:ccc" },
  ];

  it("sorts by host then numeric port", () => {
    const out = prepareHosts(entries, "");
    expect(out.map((h) => h.id)).toEqual([
      "alpha.example:22",
      "alpha.example:2222",
      "beta.example:22",
    ]);
  });

  it("filters by id substring", () => {
    expect(prepareHosts(entries, "beta").map((h) => h.id)).toEqual(["beta.example:22"]);
  });

  it("filters by fingerprint", () => {
    expect(prepareHosts(entries, "aaa").map((h) => h.id)).toEqual(["alpha.example:2222"]);
  });

  it("returns everything for a blank query", () => {
    expect(prepareHosts(entries, "   ")).toHaveLength(3);
  });

  it("splits fields for display", () => {
    const [first] = prepareHosts(entries, "");
    expect(first.host).toBe("alpha.example");
    expect(first.port).toBe("22");
    expect(first.fingerprint).toBe("SHA256:ccc");
  });
});
