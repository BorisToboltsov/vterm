import { describe, expect, it } from "vitest";
import type { ServerProfile } from "../types";
import {
  choiceUser,
  defaultAfter,
  defaultChoice,
  defaultLoginId,
  draftsOf,
  draftsProblem,
  FIRST,
  loginById,
  newDraft,
  otherLogins,
  pickerItems,
  savedPasswordOf,
  serverLogins,
  tabUser,
  validLoginUser,
  withoutSavedPassword,
} from "./logins";

const server = (over: Partial<ServerProfile> = {}): ServerProfile =>
  ({
    id: "srv",
    alias: "web-01",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    authMethod: "key",
    keyPath: "/k",
    hasSavedPassword: false,
    hasSavedSudo: true,
    logins: [
      { id: "dep", username: "deploy", authMethod: "password", keyPath: null, hasSavedPassword: true, hasSavedSudo: false },
      { id: "adm", username: "admin", authMethod: "password", keyPath: null, hasSavedPassword: false, hasSavedSudo: false },
    ],
    defaultLogin: "",
    askLogin: false,
    ...over,
  }) as ServerProfile;

describe("the logins of a server", () => {
  it("the profile's own user is the first login; an older profile has only it", () => {
    expect(serverLogins(server()).map((l) => [l.id, l.username])).toEqual([
      ["", "root"],
      ["dep", "deploy"],
      ["adm", "admin"],
    ]);
    expect(serverLogins(server({ logins: undefined as never })).map((l) => l.username)).toEqual(["root"]);
    expect(loginById(server(), "")?.hasSavedSudo).toBe(true);
    expect(loginById(server(), "gone")).toBeNull();
  });

  it("the default is the one named, or the first when it is gone", () => {
    expect(defaultLoginId(server())).toBe(FIRST);
    expect(defaultLoginId(server({ defaultLogin: "dep" }))).toBe("dep");
    expect(defaultLoginId(server({ defaultLogin: "gone" }))).toBe(FIRST);
    expect(defaultChoice(server({ defaultLogin: "adm" }))).toEqual({ id: "adm" });
  });

  it("a tab names its user only when it is not the default", () => {
    expect(tabUser(server(), { id: "" })).toBeNull();
    expect(tabUser(server(), { id: "dep" })).toBe("deploy");
    expect(tabUser(server({ defaultLogin: "dep" }), { id: "dep" })).toBeNull();
    expect(tabUser(server({ defaultLogin: "dep" }), { id: "" })).toBe("root");
    expect(tabUser(server(), { once: " ops " })).toBe("ops");
    expect(tabUser(server(), { id: "gone" })).toBeNull();
    expect(tabUser(undefined, { id: "dep" })).toBeNull();
    expect(tabUser(server(), undefined)).toBeNull();
  });

  it("whom a choice logs in as, and whether its password is in the keychain", () => {
    expect(choiceUser(server(), undefined)).toBe("root");
    expect(choiceUser(server(), { id: "adm" })).toBe("admin");
    expect(choiceUser(server(), { once: "ops" })).toBe("ops");
    expect(choiceUser(server(), { id: "gone" })).toBeNull();
    expect(savedPasswordOf(server(), { id: "dep" })).toBe(true);
    expect(savedPasswordOf(server(), { id: "adm" })).toBe(false);
    expect(savedPasswordOf(server({ defaultLogin: "dep" }), undefined)).toBe(true);
    expect(savedPasswordOf(server(), { once: "deploy" })).toBe(false);
  });

  it("a user name as ssh takes it", () => {
    expect(validLoginUser("deploy")).toBe(true);
    expect(validLoginUser(" deploy ")).toBe(true);
    expect(validLoginUser("")).toBe(false);
    expect(validLoginUser("a b")).toBe(false);
    expect(validLoginUser("a\tb")).toBe(false);
    expect(validLoginUser("x".repeat(65))).toBe(false);
  });
});

describe("the form's logins", () => {
  it("start from the server, nothing typed, and send the others by id", () => {
    const drafts = draftsOf(server());
    expect(drafts.map((d) => [d.id, d.username, d.secret])).toEqual([
      ["", "root", ""],
      ["dep", "deploy", ""],
      ["adm", "admin", ""],
    ]);
    drafts[1] = { ...drafts[1], username: " deployer ", keyPath: "/stale" };
    expect(otherLogins(drafts)).toEqual([
      { id: "dep", username: "deployer", authMethod: "password", keyPath: null },
      { id: "adm", username: "admin", authMethod: "password", keyPath: null },
    ]);
    expect(draftsOf(null)).toEqual([]);
  });

  it("a new login has its id now, and cannot be saved without a user", () => {
    const d = newDraft("n1");
    expect(d).toMatchObject({ id: "n1", username: "", authMethod: "password" });
    expect(typeof newDraft().id).toBe("string");
    expect(draftsProblem([...draftsOf(server()), d])).toBe("emptyUser");
    expect(draftsProblem([...draftsOf(server()), { ...d, username: "ops" }])).toBeNull();
  });

  it("a removed default falls back to the first", () => {
    const drafts = draftsOf(server()).filter((d) => d.id !== "dep");
    expect(defaultAfter(drafts, "dep")).toBe(FIRST);
    expect(defaultAfter(drafts, "adm")).toBe("adm");
  });
});

describe("the quick picker", () => {
  it("numbers every login and marks the default", () => {
    expect(pickerItems(server({ defaultLogin: "dep" })).map((i) => [i.key, i.login.username, i.isDefault])).toEqual([
      [1, "root", false],
      [2, "deploy", true],
      [3, "admin", false],
    ]);
  });
});

describe("withoutSavedPassword", () => {
  it("forgets the refused login's password and nobody else's", () => {
    const s = server({ hasSavedPassword: true });
    expect(withoutSavedPassword(s, "").hasSavedPassword).toBe(false);
    const after = withoutSavedPassword(s, "dep");
    expect(after.hasSavedPassword).toBe(true);
    expect(after.logins.map((l) => l.hasSavedPassword)).toEqual([false, false]);
  });
});
