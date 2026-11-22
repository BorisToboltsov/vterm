// Test-stand guard: whatever a compose file of e2e/ publishes, it publishes on
// 127.0.0.1.
//
// The stands let in anyone who knows a password, and the passwords are in this
// repository. "2222:2222" listens on every interface of the machine, so a stand
// left running (the ssh one restarts with Docker) was a shell for the whole
// network the machine is on.
//
// The files are parsed, not matched by line: a long-syntax port, a merge key, a
// random host port ("2222") and host networking publish just as well. What the
// guard cannot read (a variable, a port from another file) is a violation, not
// a pass.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const E2E = join(process.cwd(), "e2e");

/** Short syntax on loopback: `127.0.0.1:[host]:container[/protocol]`, numbers only. */
const ON_LOOPBACK = /^127\.0\.0\.1:(?:\d+(?:-\d+)?)?:\d+(?:-\d+)?(?:\/(?:tcp|udp))?$/;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The compose files among the names of a directory. */
export const composeFiles = (names: string[]): string[] =>
  names.filter((name) => /^(?:docker-)?compose.*\.ya?ml$/.test(name)).sort();

/** Why one entry of `ports` is not known to be on loopback alone, or null. */
function portProblem(port: unknown): string | null {
  const ok = isMap(port) ? port.host_ip === "127.0.0.1" : ON_LOOPBACK.test(String(port));
  return ok ? null : `port ${JSON.stringify(port)} does not name 127.0.0.1`;
}

/** Every way the text of one compose file publishes past 127.0.0.1. */
export function exposures(text: string): string[] {
  const problems: string[] = [];
  for (const doc of parseAllDocuments(text, { merge: true })) {
    if (doc.errors.length) {
      problems.push(`not readable: ${doc.errors[0].message}`);
      continue;
    }
    const file: unknown = doc.toJS();
    if (!isMap(file)) continue;
    if (file.include !== undefined) problems.push("include: brings ports from another file");
    for (const [name, service] of Object.entries(isMap(file.services) ? file.services : {})) {
      if (!isMap(service)) continue;
      const { extends: base, network_mode: network, ports } = service;
      if (isMap(base) && base.file !== undefined) problems.push(`${name}: extends brings ports from another file`);
      if (typeof network === "string" && /^host$|\$/.test(network))
        problems.push(`${name}: network_mode ${network} may listen on every interface`);
      if (ports === undefined || ports === null) continue;
      if (!Array.isArray(ports)) {
        problems.push(`${name}: ports is not a list`);
        continue;
      }
      for (const port of ports) {
        const problem = portProblem(port);
        if (problem) problems.push(`${name}: ${problem}`);
      }
    }
  }
  return problems;
}

describe("test stands are published on 127.0.0.1 alone", () => {
  const files = composeFiles(readdirSync(E2E));

  it("the stands are found", () => {
    expect(files).toEqual(
      expect.arrayContaining(["docker-compose.kbdint.yml", "docker-compose.ssh.yml", "docker-compose.sudo.yml"]),
    );
  });

  it.each(files)("e2e/%s", (file) => {
    expect(exposures(readFileSync(join(E2E, file), "utf8"))).toEqual([]);
  });
});

describe("catches its own violations", () => {
  const stand = (body: string) => `services:\n  sshd:\n${body}\n`;
  const published = (port: string) => stand(`    ports:\n      - ${port}`);

  it.each([
    ['"2222:2222"', "every interface"],
    ['"2222"', "a random port on every interface"],
    ["2222", "the same, as a number"],
    ['"0.0.0.0:2222:2222"', "every interface by name"],
    ['"[::]:2222:2222"', "every IPv6 interface"],
    ['"192.168.1.10:2222:2222"', "the LAN's address"],
    ['"127.0.0.10:2222:2222"', "an address that only begins like loopback"],
    ['"localhost:2222:2222"', "a name, not an address"],
    ['"${BIND:-127.0.0.1}:2222:2222"', "an address decided at run time"],
    ['"127.0.0.1:2222"', "no container port: not a form compose takes"],
    ["{ target: 2222, published: 2222 }", "long syntax without host_ip"],
    ['{ target: 2222, published: 2222, host_ip: "0.0.0.0" }', "long syntax on every interface"],
  ])("%s (%s)", (port) => {
    expect(exposures(published(port))).toHaveLength(1);
  });

  it.each([
    ['"127.0.0.1:2222:2222"'],
    ['"127.0.0.1::2222"'],
    ['"127.0.0.1:8000-8002:8000-8002/udp"'],
    ['{ target: 2222, published: 2222, host_ip: "127.0.0.1" }'],
  ])("%s passes", (port) => {
    expect(exposures(published(port))).toEqual([]);
  });

  it("reads every port, service and document", () => {
    const text =
      published('"127.0.0.1:1:1"\n      - "2:2"') +
      '  other:\n    ports: ["3:3"]\n' +
      '---\nservices:\n  late:\n    ports: ["4:4"]\n';
    expect(exposures(text)).toHaveLength(3);
  });

  it("follows a merge key", () => {
    const text = 'x-base: &base\n  ports: ["2222:2222"]\nservices:\n  sshd:\n    <<: *base\n';
    expect(exposures(text)).toHaveLength(1);
  });

  it("does not take a comment for an address", () => {
    expect(exposures(published('"2222:2222" # 127.0.0.1:2222:2222'))).toHaveLength(1);
  });

  it("refuses what publishes without saying it in this file", () => {
    expect(exposures(stand("    network_mode: host"))).toHaveLength(1);
    expect(exposures(stand('    network_mode: "${NET}"'))).toHaveLength(1);
    expect(exposures(stand("    extends: { file: base.yml, service: sshd }"))).toHaveLength(1);
    expect(exposures("include: [base.yml]\n")).toHaveLength(1);
    expect(exposures(stand("    ports: 2222"))).toHaveLength(1);
    expect(exposures("services: [\n")).not.toEqual([]);
  });

  it("finds a stand added later under any compose name", () => {
    const names = ["docker-compose.new.yml", "docker-compose.new.yaml", "compose.yml", "package.json", "pnpm-lock.yaml"];
    expect(composeFiles(names)).toEqual(["compose.yml", "docker-compose.new.yaml", "docker-compose.new.yml"]);
  });
});
