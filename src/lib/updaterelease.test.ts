// @vitest-environment node
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactKind, buildManifest } from "../../scripts/update-release.mjs";
const version = "1.20.0";
const names = ["vterm_1.20.0_universal_update.zip", "vterm-portable-1.20.0-x86_64.exe", "vterm-portable-1.20.0-x86_64-webview2.exe", "vterm_1.20.0_x64-setup.exe", "vterm_1.20.0_x64_en-US.msi", "vterm_1.20.0_amd64.deb", "vterm-1.20.0-1.x86_64.rpm", "vterm_1.20.0_amd64.AppImage"];
describe("release update manifest", () => {
  it("maps all eight exact versioned assets, ignoring unrelated or old files", () => {
    expect(new Set(names.map(n => artifactKind(n, version)?.[0])).size).toBe(8);
    expect(artifactKind(names[0], "1.21.0")).toBeNull();
    expect(artifactKind("vterm.exe", version)).toBeNull();
  });
  it("signs the exact payload and refuses incomplete releases and foreign keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "vterm-sign-test-"));
    try {
      const key = generateKeyPairSync("ed25519");
      const pem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const publicRaw = key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
      expect(() => buildManifest(dir, version, pem, publicRaw)).toThrow(/eight/);
      for (const name of names) writeFileSync(join(dir, name), "abc");
      const envelope = buildManifest(dir, version, pem, publicRaw);
      expect(verify(null, Buffer.from(envelope.payload, "base64"), key.publicKey, Buffer.from(envelope.signature, "base64"))).toBe(true);
      const manifest = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
      expect(manifest.version).toBe(version);
      expect(manifest.assets[0].sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      expect(() => buildManifest(dir, version, pem, "wrong-key")).toThrow(/does not match/);
      expect(() => buildManifest(dir, "latest", pem, publicRaw)).toThrow(/version/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
