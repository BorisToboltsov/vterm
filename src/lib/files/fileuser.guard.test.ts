import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The file panel under the terminal's user (v1.26, ADR 0047).
//
// `sudo` opens the panel's SFTP as another user. What a wrong turn here costs: a
// search or a sync that sees the login user's files beside a panel that sees
// another's — a sync would plan from a tree it could not read; a panel that says
// it works as someone it does not. So:
//  - what the panel does as a command rather than over SFTP (the search, the hash
//    tree, the write check) runs as the panel's user, and plain `run_command` in
//    those commands would silently run as the login user;
//  - a refusal leaves the session as it was: nothing is written down before `sudo`
//    has agreed and `sftp-server` has answered;
//  - the password goes over stdin only: no command string is built from it;
//  - the panel asks only while on screen, and never takes a user on by itself
//    (only the dialog imports `sftpOpenAs` — the lint rule `vterm/owned-imports`).
// Each check is a function over source text, run against a planted violation too.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const BRIDGE = "src-tauri/src/commands/sftp.rs";
const SSH = "src-tauri/src/ssh.rs";
const FILEUSER = "src-tauri/src/fileuser.rs";
const PANEL = "src/lib/files/SftpPanel.svelte";

const strip = (src: string) => src.replace(/\r\n/g, "\n").replace(/^\s*\/\/.*$/gm, "");

/** The text from `head` to the brace that closes the block it opens. */
function block(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

/** The bridge's commands that run as commands, each with the call it must make. */
const FILE_COMMANDS: [string, string][] = [
  ["pub async fn sftp_write_access(", ".exec_file_captured("],
  ["pub async fn sftp_hash_tree(", ".run_file_command_streaming("],
  ["pub async fn sftp_grep(", ".run_file_command("],
];

export function bridgeViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  for (const [head, call] of FILE_COMMANDS) {
    const body = block(src, head);
    if (!body.includes(call) || /\.(run_command|run_command_streaming|exec_captured)\(/.test(body)) {
      out.push(`${head.slice(13, -1)} runs as the login user while the panel works as another`);
    }
  }
  return out;
}

export function sessionViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const open = block(src, "pub async fn sftp_as(");
  const agreed = open.indexOf("fileuser::open_as(");
  const noted = open.indexOf("self.file_user.locked()");
  const swapped = open.indexOf("*guard = Some(");
  if (agreed < 0 || noted < agreed || swapped < agreed || !/open_as\([^;]*\.await\?;/.test(open)) {
    out.push("a refusal changes whom the panel says it works as");
  }
  const back = block(src, "pub async fn sftp_as_login_user(");
  if (!/\*self\.file_user\.locked\(\) = None;/.test(back) || !/\*guard = None;/.test(back)) {
    out.push("going back keeps the other user's session or name");
  }
  return out;
}

export function moduleViolations(raw: string): string[] {
  const src = strip(raw);
  const out: string[] = [];
  const asUser = block(src, "pub fn as_user(");
  if (/password/.test(asUser.replace(/with_password/g, ""))) {
    out.push("a command is built from the password");
  }
  if (!/let auth = if with_password \{ "-k -S -p ''" \} else \{ "-n" \};/.test(asUser)) {
    out.push("sudo may read a cached ticket and leave the password on sftp-server's stdin");
  }
  const server = block(src, "pub(crate) async fn open_as<");
  if (!/if !valid_user\(user\)/.test(server)) {
    out.push("a name reaches sudo without being checked");
  }
  return out;
}

export function panelViolations(raw: string): string[] {
  const src = raw.replace(/\r\n/g, "\n");
  const out: string[] = [];
  if (!/\$effect\(\(\) => \{\s*if \(!visible \|\| !sessionReady\) return;[^]*?setInterval\(/.test(src)) {
    out.push("the panel asks the server while nobody is looking");
  }
  if (/\bsftpOpenAs\b/.test(src)) {
    out.push("the panel takes a user on past the question");
  }
  return out;
}

describe("file user guard", () => {
  it("a file command runs as the panel's user", () => {
    expect(bridgeViolations(read(BRIDGE))).toEqual([]);
  });
  it("a refusal changes nothing, and going back forgets all of it", () => {
    expect(sessionViolations(read(SSH))).toEqual([]);
  });
  it("the password goes over stdin, the name is checked", () => {
    expect(moduleViolations(read(FILEUSER))).toEqual([]);
  });
  it("the panel asks while on screen and takes nobody on by itself", () => {
    expect(panelViolations(read(PANEL))).toEqual([]);
  });
});

describe("file user guard — catches what it exists for", () => {
  const swap = (src: string, from: string, to: string) => {
    expect(src.includes(from), `the source no longer contains: ${from}`).toBe(true);
    return src.replace(from, to);
  };

  it("a search that runs as the login user", () => {
    const src = swap(read(BRIDGE), ".run_file_command(&sync::grep_command", ".run_command(&sync::grep_command");
    expect(bridgeViolations(src)).toContain("sftp_grep runs as the login user while the panel works as another");
  });

  it("a hash tree or a write check that runs as the login user", () => {
    const hash = swap(read(BRIDGE), "session.run_file_command_streaming(&cmd", "session.run_command_streaming(&cmd");
    expect(bridgeViolations(hash)).toContain("sftp_hash_tree runs as the login user while the panel works as another");
    const write = swap(read(BRIDGE), ".exec_file_captured(&sftp::write_access_command", ".exec_captured(&sftp::write_access_command");
    expect(bridgeViolations(write)).toContain(
      "sftp_write_access runs as the login user while the panel works as another",
    );
  });

  it("a name written down before sudo has agreed", () => {
    const body = block(read(SSH), "pub async fn sftp_as(");
    const noted = body.slice(body.indexOf("*self.file_user.locked()"), body.indexOf("*guard = Some("));
    const moved = swap(body, noted, "").replace("let mut guard = self.sftp.lock().await;", `let mut guard = self.sftp.lock().await;\n${noted}`);
    expect(sessionViolations(moved)).toContain("a refusal changes whom the panel says it works as");
  });

  it("going back that keeps the name", () => {
    const src = swap(read(SSH), "*self.file_user.locked() = None;", "");
    expect(sessionViolations(src)).toContain("going back keeps the other user's session or name");
  });

  it("a command built from the password", () => {
    const src = swap(read(FILEUSER), 'let auth = if with_password { "-k -S -p \'\'" } else { "-n" };', 'let auth = format!("-S {password}");');
    expect(moduleViolations(src)).toContain("a command is built from the password");
  });

  it("sudo that may trust its cache with a password waiting on stdin", () => {
    const src = swap(read(FILEUSER), "\"-k -S -p ''\"", "\"-S -p ''\"");
    expect(moduleViolations(src)).toContain(
      "sudo may read a cached ticket and leave the password on sftp-server's stdin",
    );
  });

  it("a name that reaches sudo unchecked", () => {
    const src = swap(read(FILEUSER), "if !valid_user(user) {", "if user.is_empty() {");
    expect(moduleViolations(src)).toContain("a name reaches sudo without being checked");
  });

  it("a panel that asks while hidden, or takes a user on by itself", () => {
    const hidden = swap(read(PANEL), "if (!visible || !sessionReady) return;\n    const id = sessionId;", "const id = sessionId;");
    expect(panelViolations(hidden)).toContain("the panel asks the server while nobody is looking");
    const past = swap(read(PANEL), "sftpOpenOwn,\n", "sftpOpenOwn,\n    sftpOpenAs,\n");
    expect(panelViolations(past)).toContain("the panel takes a user on past the question");
  });
});
