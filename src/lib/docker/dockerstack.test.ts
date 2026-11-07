import { describe, expect, it } from "vitest";
import type { DockerContainer } from "./docker";
import {
  parseServiceNames,
  parseStackPs,
  serviceActionArgs,
  serviceLogsArgs,
  serviceSummary,
  serviceUpArgs,
  serviceUpCommand,
  stackConfigArgs,
  stackOf,
  stackPsArgs,
  stackServices,
  usesOwnFiles,
  type DockerStack,
} from "./dockerstack";

const ctr = (over: Partial<DockerContainer> = {}): DockerContainer => ({
  id: "a",
  name: "life-e2e-backend-1",
  image: "img",
  state: "running",
  status: "",
  ports: "",
  project: "life-e2e",
  service: "backend",
  workdir: "/srv/deploy",
  createdAt: "",
  runningFor: "",
  networks: [],
  configFiles: ["/srv/deploy/compose.yaml", "/srv/deploy/compose.build.yaml"],
  envFile: "/srv/deploy/e2e.env",
  ...over,
});
// The real stack this was checked on: two files and an env file of its own.
const OWN: DockerStack = { project: "life-e2e", workdir: "/srv/deploy", files: ["/srv/deploy/compose.yaml", "/srv/deploy/compose.build.yaml"], envFile: "/srv/deploy/e2e.env" };
const PLAIN: DockerStack = { project: "web", workdir: "/srv/web", files: ["/srv/web/compose.yaml"], envFile: "" };

describe("a stack, from its containers' labels", () => {
  it("is told by the containers of its project", () => {
    expect(stackOf([ctr(), ctr({ id: "b", project: "other" })], "life-e2e")).toEqual(OWN);
    expect(stackOf([ctr()], "missing")).toBeNull();
    // A container that did not say its files leaves them to one that did.
    expect(stackOf([ctr({ configFiles: [], envFile: "" }), ctr({ id: "b" })], "life-e2e")?.files).toEqual(OWN.files);
  });

  it("knows when `up` from its directory would read another definition", () => {
    expect(usesOwnFiles(OWN)).toBe(true);
    expect(usesOwnFiles(PLAIN)).toBe(false);
    expect(usesOwnFiles({ ...PLAIN, files: ["/srv/web/stack.yml"] })).toBe(true);
    expect(usesOwnFiles({ ...PLAIN, files: ["/elsewhere/compose.yaml"] })).toBe(true);
    expect(usesOwnFiles({ ...PLAIN, envFile: "/srv/web/.env" })).toBe(false);
    expect(usesOwnFiles({ ...PLAIN, envFile: "/srv/web/prod.env" })).toBe(true);
  });
});

describe("what the stack's details ask", () => {
  it("reads the configuration from the stack's own files, and acts by the project alone", () => {
    expect(stackConfigArgs(OWN, true)).toEqual([
      "docker", "compose", "--project-directory", "/srv/deploy", "-p", "life-e2e",
      "-f", "/srv/deploy/compose.yaml", "-f", "/srv/deploy/compose.build.yaml", "--env-file", "/srv/deploy/e2e.env",
      "config", "--services",
    ]);
    expect(stackPsArgs("web")).toEqual(["docker", "compose", "-p", "web", "ps", "-a", "--format", "json"]);
    expect(serviceActionArgs("web", "restart", "api")).toEqual(["docker", "compose", "-p", "web", "restart", "api"]);
    expect(serviceUpArgs(PLAIN, "api")).toEqual(["docker", "compose", "--project-directory", "/srv/web", "-p", "web", "up", "-d", "api"]);
    expect(serviceLogsArgs("web", "api", 500)).toEqual(["docker", "compose", "-p", "web", "logs", "--tail", "500", "--timestamps", "--no-color", "api"]);
    expect(serviceLogsArgs("web", null).at(-1)).toBe("--no-color");
  });

  it("offers the hand-run `up` with the stack's files, quoted", () => {
    expect(serviceUpCommand({ ...OWN, workdir: "/srv/my deploy" }, "web")).toBe(
      "docker compose --project-directory '/srv/my deploy' -p life-e2e -f /srv/deploy/compose.yaml -f /srv/deploy/compose.build.yaml --env-file /srv/deploy/e2e.env up -d web",
    );
  });
});

describe("the stack's services", () => {
  // compose 2.21+ prints a line per container; older ones, an array.
  const PS = [
    '{"Service":"backend","ID":"43d5","Name":"life-e2e-backend-1","State":"running","Health":"unhealthy","ExitCode":0}',
    '{"Service":"db","ID":"ec54","Name":"life-e2e-db-1","State":"restarting","Health":"","ExitCode":0}',
    '{"Service":"migrate","ID":"m1","Name":"life-e2e-migrate-1","State":"exited","Health":"","ExitCode":0}',
    '{"Service":"old","ID":"o1","Name":"life-e2e-old-1","State":"exited","Health":"","ExitCode":1}',
  ].join("\n");

  it("reads compose ps in both shapes", () => {
    const rows = parseStackPs(PS);
    expect(rows.map((r) => [r.service, r.state, r.health, r.exitCode])).toEqual([
      ["backend", "running", "unhealthy", 0],
      ["db", "restarting", "", 0],
      ["migrate", "exited", "", 0],
      ["old", "exited", "", 1],
    ]);
    expect(parseStackPs(`[${PS.split("\n").join(",")}]`)).toEqual(rows);
    expect(parseStackPs("")).toEqual([]);
  });

  it("lists the declared services in the files' order, the never created among them, and the undeclared after", () => {
    const list = stackServices(parseServiceNames("db\nmigrate\nbackend\nweb\nwarning: junk line\n"), parseStackPs(PS));
    expect(list.map((s) => [s.name, s.containers.length, s.declared])).toEqual([
      ["db", 1, true],
      ["migrate", 1, true],
      ["backend", 1, true],
      ["web", 0, true],
      ["old", 1, false],
    ]);
    // Files not read: only what has containers can be listed.
    expect(stackServices(null, parseStackPs(PS)).every((s) => !s.declared)).toBe(true);
  });

  it("says each service in a word with a tone", () => {
    const list = stackServices(["backend", "db", "migrate", "old", "web"], parseStackPs(PS));
    expect(list.map((s) => [s.name, serviceSummary(s).word, serviceSummary(s).tone])).toEqual([
      ["backend", "unhealthy", "warn"],
      ["db", "restarting", "bad"],
      ["migrate", "exited", "idle"],
      ["old", "exit 1", "bad"],
      ["web", "", "idle"],
    ]);
    const scaled = stackServices(["api"], parseStackPs([
      '{"Service":"api","ID":"1","Name":"a1","State":"running","ExitCode":0}',
      '{"Service":"api","ID":"2","Name":"a2","State":"exited","ExitCode":0}',
    ].join("\n")));
    expect(serviceSummary(scaled[0])).toEqual({ word: "running 1/2", tone: "warn" });
  });
});
