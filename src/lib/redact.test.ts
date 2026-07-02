import { describe, it, expect } from "vitest";
import { redactSecrets, REDACTED } from "./redact";

describe("redactSecrets", () => {
  it("returns empty input unchanged", () => {
    expect(redactSecrets("")).toEqual({ text: "", count: 0 });
  });

  it("leaves text with no secrets untouched", () => {
    const t = "ls -la /var/log\ncat README.md\necho done";
    const r = redactSecrets(t);
    expect(r.text).toBe(t);
    expect(r.count).toBe(0);
  });

  it("masks sensitive KEY=value assignments, keeping the key", () => {
    const r = redactSecrets("export PGPASSWORD=hunter2");
    expect(r.text).toBe(`export PGPASSWORD=${REDACTED}`);
    expect(r.count).toBe(1);
  });

  it("masks quoted and colon-separated secrets", () => {
    const r = redactSecrets('api_key: "abc123def"\nGITHUB_TOKEN=ghp_xxx');
    expect(r.text).toBe(`api_key: "${REDACTED}"\nGITHUB_TOKEN=${REDACTED}`);
    expect(r.count).toBe(2);
  });

  it("masks --password CLI flags", () => {
    const r = redactSecrets("mysql --user=root --password=s3cr3t db");
    expect(r.text).toContain(`--password=${REDACTED}`);
    expect(r.text).toContain("--user=root");
  });

  it("masks bearer/authorization tokens but keeps the scheme", () => {
    const r = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsIn");
    expect(r.text).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(r.count).toBe(1);
  });

  it("masks passwords embedded in URLs", () => {
    const r = redactSecrets("psql postgres://admin:topsecret@db.example.com/app");
    expect(r.text).toBe(`psql postgres://admin:${REDACTED}@db.example.com/app`);
    expect(r.count).toBe(1);
  });

  it("masks AWS access key ids", () => {
    const r = redactSecrets("AWS_KEY is AKIAIOSFODNN7EXAMPLE here");
    expect(r.text).toBe(`AWS_KEY is ${REDACTED} here`);
    expect(r.count).toBe(1);
  });

  it("masks a PEM private-key body, keeping the fence", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nQyNTUxOQ==\n-----END OPENSSH PRIVATE KEY-----";
    const r = redactSecrets(pem);
    expect(r.text).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(r.text).toContain("-----END OPENSSH PRIVATE KEY-----");
    expect(r.text).toContain(REDACTED);
    expect(r.text).not.toContain("b3BlbnNzaC1rZXktdjEAAAA");
    expect(r.count).toBe(1);
  });

  it("masks an echoed inline password prompt", () => {
    const r = redactSecrets("Password: hunter2");
    expect(r.text).toBe(`Password: ${REDACTED}`);
  });

  // Phase 20.2 — self-identifying tokens that leak outside a KEY= / Bearer context.
  it("masks standalone self-identifying tokens", () => {
    const cases: [string, string][] = [
      // JWT (three base64url segments)
      [
        "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ],
      ["ghp_0123456789ABCDEFabcdef0123456789ABCD", "ghp_0123456789ABCDEFabcdef0123456789ABCD"],
      ["github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_11ABCDEFG0123456789_abcdefghij"],
      ["xoxb-123456789012-abcdefABCDEF12", "xoxb-123456789012-abcdefABCDEF12"],
      ["sk_live_abcdEFGH1234567890", "sk_live_abcdEFGH1234567890"],
      ["AIzaSyD1234567890abcdefghijklmnopqrstuv", "AIzaSyD1234567890abcdefghijklmnopqrstuv"],
      ["ya29.a0AfB_1234567890abcdefghijklmnop", "ya29.a0AfB_1234567890abcdefghijklmnop"],
    ];
    for (const [input, secret] of cases) {
      const r = redactSecrets(`found: ${input} end`);
      expect(r.text, input).not.toContain(secret);
      expect(r.text, input).toContain(REDACTED);
    }
  });

  it("does not flag ordinary base64url-ish words as tokens", () => {
    const t = "the review meeting is at noon; see notes.md and eyJson is not a token here x";
    // "eyJson" has no dotted JWT structure → left alone.
    expect(redactSecrets(t).text).toBe(t);
  });

  it("counts multiple secrets across a transcript", () => {
    const t = [
      "git clone https://user:tok@github.com/x/y",
      "export API_KEY=abc",
      "normal line",
    ].join("\n");
    const r = redactSecrets(t);
    expect(r.count).toBe(2);
    expect(r.text).toContain("normal line");
  });
});
