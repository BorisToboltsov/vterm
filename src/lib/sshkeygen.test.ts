import { describe, it, expect } from "vitest";
import {
  KEY_ALGORITHMS,
  SSH_DIR,
  isValidAlgorithm,
  defaultKeyName,
  validateKeyName,
  validateKeyPath,
  buildKeyPath,
  resolvedPath,
  buildGenerateRequest,
  isFormValid,
  type KeygenForm,
} from "./sshkeygen";

const base: KeygenForm = {
  algorithm: "ed25519",
  dir: SSH_DIR,
  name: "id_ed25519",
  useCustomPath: false,
  customPath: "",
  passphrase: "",
  comment: "",
};

describe("algorithm registry", () => {
  it("every id is unique and non-empty", () => {
    const ids = KEY_ALGORITHMS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("isValidAlgorithm accepts known ids, rejects others", () => {
    expect(isValidAlgorithm("ed25519")).toBe(true);
    expect(isValidAlgorithm("rsa-4096")).toBe(true);
    expect(isValidAlgorithm("dsa")).toBe(false);
    expect(isValidAlgorithm("")).toBe(false);
  });

  it("defaultKeyName matches ssh-keygen conventions", () => {
    expect(defaultKeyName("ed25519")).toBe("id_ed25519");
    expect(defaultKeyName("rsa-2048")).toBe("id_rsa");
    expect(defaultKeyName("rsa-4096")).toBe("id_rsa");
    expect(defaultKeyName("ecdsa-p256")).toBe("id_ecdsa");
    expect(defaultKeyName("nope")).toBe("id_key");
  });
});

describe("validateKeyName", () => {
  it("accepts a plain name", () => {
    expect(validateKeyName("id_ed25519")).toBeNull();
    expect(validateKeyName("  work_key  ")).toBeNull();
  });
  it("rejects empty", () => {
    expect(validateKeyName("")).toBe("empty");
    expect(validateKeyName("   ")).toBe("empty");
  });
  it("rejects path separators", () => {
    expect(validateKeyName("sub/id")).toBe("separator");
    expect(validateKeyName("a\\b")).toBe("separator");
  });
  it("rejects traversal components", () => {
    expect(validateKeyName(".")).toBe("dots");
    expect(validateKeyName("..")).toBe("dots");
  });
});

describe("validateKeyPath", () => {
  it("accepts rooted paths", () => {
    expect(validateKeyPath("/home/u/.ssh/id_ed25519")).toBeNull();
    expect(validateKeyPath("~/.ssh/id_ed25519")).toBeNull();
    expect(validateKeyPath("C:\\keys\\id")).toBeNull();
  });
  it("rejects empty and relative", () => {
    expect(validateKeyPath("")).toBe("empty");
    expect(validateKeyPath("relative/id")).toBe("notAbsolute");
  });
});

describe("buildKeyPath / resolvedPath", () => {
  it("joins dir and name with one slash", () => {
    expect(buildKeyPath("~/.ssh", "id_ed25519")).toBe("~/.ssh/id_ed25519");
    expect(buildKeyPath("~/.ssh/", "id_ed25519")).toBe("~/.ssh/id_ed25519");
    expect(buildKeyPath("", "id_ed25519")).toBe("id_ed25519");
  });
  it("resolvedPath uses custom path when enabled", () => {
    expect(resolvedPath(base)).toBe("~/.ssh/id_ed25519");
    expect(
      resolvedPath({ ...base, useCustomPath: true, customPath: "  /tmp/k  " }),
    ).toBe("/tmp/k");
  });
});

describe("buildGenerateRequest", () => {
  it("passes through path and overwrite; empties become undefined", () => {
    const req = buildGenerateRequest(base, false);
    expect(req).toEqual({
      algorithm: "ed25519",
      path: "~/.ssh/id_ed25519",
      passphrase: undefined,
      comment: undefined,
      overwrite: false,
    });
  });
  it("keeps passphrase and trims comment", () => {
    const req = buildGenerateRequest(
      { ...base, passphrase: "s3cret", comment: "  me@host  " },
      true,
    );
    expect(req.passphrase).toBe("s3cret");
    expect(req.comment).toBe("me@host");
    expect(req.overwrite).toBe(true);
  });
});

describe("isFormValid", () => {
  it("valid default form", () => {
    expect(isFormValid(base)).toBe(true);
  });
  it("invalid on bad name / algorithm / custom path", () => {
    expect(isFormValid({ ...base, name: "a/b" })).toBe(false);
    expect(isFormValid({ ...base, algorithm: "dsa" })).toBe(false);
    expect(isFormValid({ ...base, useCustomPath: true, customPath: "rel" })).toBe(false);
    expect(isFormValid({ ...base, useCustomPath: true, customPath: "/ok/id" })).toBe(true);
  });
});
