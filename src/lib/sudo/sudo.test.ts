import { describe, expect, it } from "vitest";
import { elevateStep, fieldAfter, fieldState, savesThroughSudo, sudoAnswer, sudoBadge, triedNote } from "./sudo";

describe("sudoAnswer", () => {
  it("reads every marker the backend sends", () => {
    expect(sudoAnswer("sudo-password: nothing")).toEqual({ kind: "password", tried: "nothing" });
    expect(sudoAnswer("sudo-password: saved")).toEqual({ kind: "password", tried: "saved" });
    expect(sudoAnswer("sudo-password: login")).toEqual({ kind: "password", tried: "login" });
    expect(sudoAnswer("sudo-rejected: sudo did not accept the password")).toEqual({ kind: "wrong" });
    expect(sudoAnswer("sudo-refused: not-allowed: Sorry, user plain may not run sudo on h.")).toEqual({
      kind: "refused",
      why: "not-allowed",
      said: "Sorry, user plain may not run sudo on h.",
    });
    expect(
      sudoAnswer("sudo-refused: command-refused: Sorry, user limited is not allowed to execute '/usr/bin/cp a b' as root on h."),
    ).toMatchObject({ kind: "refused", why: "command-refused" });
  });

  it("keeps what sudo said, colons and all", () => {
    expect(sudoAnswer("sudo-refused: other: pam: code: 7")).toEqual({ kind: "refused", why: "other", said: "pam: code: 7" });
  });

  it("an unknown reason or a newer marker is 'other', with all of it said", () => {
    expect(sudoAnswer("sudo-refused: mystery: x")).toEqual({ kind: "refused", why: "other", said: "mystery: x" });
    expect(sudoAnswer("sudo-password: something-new")).toEqual({ kind: "password", tried: "nothing" });
  });

  it("anything else is not sudo's answer", () => {
    expect(sudoAnswer("permission denied")).toBeNull();
    expect(sudoAnswer(new Error("file-changed: x"))).toBeNull();
  });
});

describe("elevateStep", () => {
  it("tries at once what needs no typing, but asks first on prod", () => {
    expect(elevateStep({ kind: "ready", via: "none" }, false)).toBe("check");
    expect(elevateStep({ kind: "saved", from: "saved" }, false)).toBe("check");
    expect(elevateStep({ kind: "saved", from: "login" }, true)).toBe("confirm");
    expect(elevateStep(null, false)).toBe("check");
    expect(elevateStep(null, true)).toBe("confirm");
  });

  it("asks for a password when sudo wants one vterm has not", () => {
    expect(elevateStep({ kind: "password", tried: "nothing" }, false)).toBe("ask");
    expect(elevateStep({ kind: "password", tried: "saved" }, true)).toBe("ask");
  });

  it("does not ask again where the answer cannot change — except no answer", () => {
    expect(elevateStep({ kind: "refused", why: "not-allowed", said: "" }, false)).toBe("refused");
    expect(elevateStep({ kind: "refused", why: "no-sudo", said: "" }, true)).toBe("refused");
    expect(elevateStep({ kind: "refused", why: "no-answer", said: "" }, false)).toBe("check");
  });
});

describe("sudoBadge", () => {
  it("names what saving will take", () => {
    expect(sudoBadge(null)).toEqual({ key: "sudo.badge.checking", tone: "muted", acts: false });
    expect(sudoBadge({ kind: "ready", via: "none" }).key).toBe("sudo.badge.ready");
    expect(sudoBadge({ kind: "saved", from: "saved" }).key).toBe("sudo.badge.keychain");
    expect(sudoBadge({ kind: "saved", from: "login" }).key).toBe("sudo.badge.login");
    expect(sudoBadge({ kind: "password", tried: "nothing" })).toMatchObject({ key: "sudo.badge.password", tone: "warn", acts: true });
  });

  it("a refusal is said and leads nowhere, unless sudo only did not answer", () => {
    expect(sudoBadge({ kind: "refused", why: "not-allowed", said: "" })).toEqual({
      key: "sudo.badge.notAllowed",
      tone: "danger",
      acts: false,
    });
    expect(sudoBadge({ kind: "refused", why: "needs-tty", said: "" })).toMatchObject({ tone: "danger", acts: false });
    expect(sudoBadge({ kind: "refused", why: "no-answer", said: "" })).toMatchObject({ tone: "warn", acts: true });
  });
});

describe("triedNote and savesThroughSudo", () => {
  it("says which saved password was turned down", () => {
    expect(triedNote("saved")).toBe("sudo.triedSaved");
    expect(triedNote("login")).toBe("sudo.triedLogin");
    expect(triedNote("nothing")).toBeNull();
  });

  it("Save goes through sudo by itself only when no password has to be typed", () => {
    expect(savesThroughSudo({ kind: "ready", via: "typed" })).toBe(true);
    expect(savesThroughSudo({ kind: "saved", from: "login" })).toBe(true);
    expect(savesThroughSudo({ kind: "password", tried: "nothing" })).toBe(false);
    expect(savesThroughSudo({ kind: "refused", why: "not-allowed", said: "" })).toBe(false);
    expect(savesThroughSudo(null)).toBe(false);
  });
});

describe("fieldState and fieldAfter", () => {
  it("says whose password will go, or asks, or says no", () => {
    expect(fieldState(null)).toEqual({ kind: "checking" });
    expect(fieldState({ kind: "ready", via: "none" })).toEqual({ kind: "ready", source: "none" });
    expect(fieldState({ kind: "saved", from: "login" })).toEqual({ kind: "ready", source: "login" });
    expect(fieldState({ kind: "password", tried: "saved" })).toEqual({ kind: "type", note: "sudo.triedSaved" });
    expect(fieldState({ kind: "refused", why: "needs-tty", said: "x" })).toEqual({ kind: "refused", why: "needs-tty", said: "x" });
  });

  it("after a try: a wrong password is said inside the field, a refusal replaces it", () => {
    expect(fieldAfter({ kind: "wrong" })).toEqual({ kind: "type", note: "sudo.wrongPassword" });
    expect(fieldAfter({ kind: "password", tried: "login" })).toEqual({ kind: "type", note: "sudo.triedLogin" });
    expect(fieldAfter({ kind: "password", tried: "nothing" })).toEqual({ kind: "type", note: null });
    expect(fieldAfter({ kind: "refused", why: "not-allowed", said: "s" })).toEqual({ kind: "refused", why: "not-allowed", said: "s" });
  });
});
