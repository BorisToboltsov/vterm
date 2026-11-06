import { describe, expect, it } from "vitest";
import {
  imageHistoryArgs,
  imageUsersArgs,
  networkInspectArgs,
  networkSubnetsArgs,
  parseHistory,
  parseNetworkDetail,
  parseNetworkSubnets,
  parseUsers,
  parseVolumeDetail,
  sameItem,
  volumeInspectArgs,
  volumeUsersArgs,
} from "./dockeritems";

const US = "\x1f";

// Cut from real Docker 29 answers, values replaced.
const NETWORK = JSON.stringify([
  {
    Name: "life-e2e_default",
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    IPAM: { Driver: "default", Config: [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }] },
    Containers: {
      "152f19fdeeb3": { Name: "life-e2e-storage-1", IPv4Address: "172.20.0.2/16", IPv6Address: "" },
      "0a1b2c3d4e5f": { Name: "life-e2e-backend-1", IPv4Address: "172.20.0.3/16", IPv6Address: "fd00::3/64" },
    },
    Labels: { "com.docker.compose.project": "life-e2e" },
  },
]);
const VOLUME = JSON.stringify([
  {
    CreatedAt: "2026-10-11T20:00:52Z",
    Driver: "local",
    Labels: { "com.docker.volume.anonymous": "" },
    Mountpoint: "/var/lib/docker/volumes/0b71/_data",
    Name: "0b71abdf84e5",
    Options: null,
    Scope: "local",
  },
]);

describe("who uses an image or a volume", () => {
  it("asks docker by filter — by id, not by name", () => {
    expect(imageUsersArgs("abc").slice(0, 5)).toEqual(["docker", "ps", "-a", "--filter", "ancestor=abc"]);
    expect(volumeUsersArgs("data").slice(0, 5)).toEqual(["docker", "ps", "-a", "--filter", "volume=data"]);
    expect(parseUsers([["b1", "web", "Running"].join(US), ["a1", "api", "exited"].join(US), ""].join("\n"))).toEqual([
      { id: "a1", name: "api", state: "exited" },
      { id: "b1", name: "web", state: "running" },
    ]);
  });
});

describe("an image's layers", () => {
  it("drops the shell prefix every step has, and tells a step that adds bytes", () => {
    expect(imageHistoryArgs("abc")).toEqual(["docker", "history", "--no-trunc", "--format", expect.any(String), "abc"]);
    const raw = [
      [`/bin/sh -c #(nop)  CMD ["postgres"]`, "0B", "9 days ago"].join(US),
      [`/bin/sh -c apt-get update && apt-get install -y x`, "85.2MB", "9 days ago"].join(US),
      [`ENTRYPOINT ["docker-entrypoint.sh"]`, "0B", "9 days ago"].join(US),
      [`RUN /bin/sh -c ln -sT a b # buildkit`, "23B", "9 days ago"].join(US),
    ].join("\n");
    expect(parseHistory(raw)).toEqual([
      { step: 'CMD ["postgres"]', size: "0B", adds: false },
      { step: "RUN apt-get update && apt-get install -y x", size: "85.2MB", adds: true },
      { step: 'ENTRYPOINT ["docker-entrypoint.sh"]', size: "0B", adds: false },
      { step: "RUN ln -sT a b", size: "23B", adds: true },
    ]);
  });
});

describe("a network", () => {
  it("reads its ranges, whether it reaches out, and every member's address", () => {
    expect(networkInspectArgs("n")).toEqual(["docker", "network", "inspect", "n"]);
    const d = parseNetworkDetail(NETWORK)!;
    expect(d).toMatchObject({ name: "life-e2e_default", driver: "bridge", internal: false });
    expect(d.subnets).toEqual([{ subnet: "172.20.0.0/16", gateway: "172.20.0.1" }]);
    expect(d.members).toEqual([
      { id: "0a1b2c3d4e5f", name: "life-e2e-backend-1", ipv4: "172.20.0.3", ipv6: "fd00::3" },
      { id: "152f19fdeeb3", name: "life-e2e-storage-1", ipv4: "172.20.0.2", ipv6: "" },
    ]);
    expect(parseNetworkDetail(VOLUME)).toBeNull();
    expect(parseNetworkDetail("Error: No such network")).toBeNull();
  });

  it("reads every network's subnets in one answer", () => {
    expect(networkSubnetsArgs(["a", "b"]).slice(-2)).toEqual(["a", "b"]);
    const m = parseNetworkSubnets([["a", "172.20.0.0/16 fd00::/64 ", "false"].join(US), ["b", "", "true"].join(US)].join("\n"));
    expect(m.get("a")).toEqual({ subnets: ["172.20.0.0/16", "fd00::/64"], internal: false });
    expect(m.get("b")).toEqual({ subnets: [], internal: true });
  });
});

describe("a volume", () => {
  it("reads where its data lives and whether docker made it for one container", () => {
    expect(volumeInspectArgs("v")).toEqual(["docker", "volume", "inspect", "v"]);
    const v = parseVolumeDetail(VOLUME)!;
    expect(v).toMatchObject({ name: "0b71abdf84e5", driver: "local", mountpoint: "/var/lib/docker/volumes/0b71/_data", anonymous: true });
    expect(v.created).toBe(Date.parse("2026-10-11T20:00:52Z"));
    expect(parseVolumeDetail(NETWORK)).toBeNull();
  });
});

describe("the item beside the list", () => {
  it("is the same when it names the same thing", () => {
    expect(sameItem({ kind: "image", id: "a", label: "x" }, { kind: "image", id: "a", label: "y" })).toBe(true);
    expect(sameItem({ kind: "network", name: "n" }, { kind: "volume", name: "n" })).toBe(false);
    expect(sameItem({ kind: "volume", name: "n" }, { kind: "volume", name: "n" })).toBe(true);
    expect(sameItem(null, { kind: "volume", name: "n" })).toBe(false);
  });
});
