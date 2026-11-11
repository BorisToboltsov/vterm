//! Who the terminal is now, and the file panel working as them (ADR 0047).
//!
//! `su` changes the user inside a shell. SFTP is a channel of its own, logged in
//! as whoever the connection logged in as, and the server never ties the two
//! together — so a transfer made after `su - deploy` still runs as the login user.
//!
//! **Who the terminal is** is read from the server's process tree over a separate
//! exec channel: nothing is typed into the shell, and any way of changing user
//! shows the same (`su`, `sudo -i`, `runuser`, a script). The channel and the shell
//! share one connection, so the shell is the sibling with a terminal. From there it
//! follows the foreground, not the terminal: `sudo` ≥ 1.9.14 runs its command on a
//! pty of its own (`use_pty`), so the user's shell may be on another tty than ours.
//! The answer is the innermost *shell* on that path, not the foreground program: a
//! one-off `sudo ls` is no change of user. The probe only reads; `who` decides.
//!
//! **Working as them** starts the `sftp-server` program through `sudo` instead of
//! asking for the `sftp` subsystem. It speaks the same protocol over the same kind
//! of channel, so the panel, the transfers, the editor and sync all go on as they
//! were. Only what runs as a command rather than over SFTP (search, the hash tree,
//! the write check) has to be wrapped: `FileUser::command`.

use crate::error::{AppError, AppResult};
use crate::git::shell_quote;
use crate::ssh::{answered, exec_on, ExecOutcome};
use russh::client::{self, Handle};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use zeroize::Zeroizing;

/// Reads the tree and nothing else. `sh -c`, because the login shell may not be
/// POSIX; `user:32` where `ps` knows it (procps cuts a name at 8 characters without
/// it). A `ps` without these columns (busybox) prints nothing: `Unknown`.
pub const TREE_PROBE: &str = "sh -c 'echo self=$$; echo login=$(id -un 2>/dev/null); \
LC_ALL=C ps -A -o pid=,ppid=,pgid=,tpgid=,user:32=,tty=,comm= 2>/dev/null \
|| LC_ALL=C ps -A -o pid=,ppid=,pgid=,tpgid=,user=,tty=,comm= 2>/dev/null'";

/// Where a chain of parents is given up on: no real tree is this deep.
const MAX_DEPTH: usize = 64;

/// How long `sudo` may take to answer whether it agrees.
const SUDO_CHECK_SECS: u64 = 20;

/// One row of `ps`.
#[derive(Debug, Clone)]
struct Proc {
    pid: i64,
    ppid: i64,
    pgid: i64,
    tpgid: i64,
    user: String,
    tty: String,
    comm: String,
}

fn parse_proc(line: &str) -> Option<Proc> {
    let mut it = line.split_whitespace();
    let pid = it.next()?.parse().ok()?;
    let ppid = it.next()?.parse().ok()?;
    let pgid = it.next()?.parse().ok()?;
    let tpgid = it.next()?.parse().ok()?;
    let user = it.next()?.to_string();
    let tty = it.next()?.to_string();
    let comm = it.collect::<Vec<_>>().join(" ");
    if comm.is_empty() {
        return None;
    }
    Some(Proc {
        pid,
        ppid,
        pgid,
        tpgid,
        user,
        tty,
        comm,
    })
}

/// A program's bare name: macOS `ps` gives a path, a login shell a leading `-`.
fn program(comm: &str) -> &str {
    let name = comm.rsplit('/').next().unwrap_or(comm);
    name.strip_prefix('-').unwrap_or(name)
}

fn is_shell(comm: &str) -> bool {
    matches!(
        program(comm),
        "sh" | "bash"
            | "dash"
            | "ash"
            | "zsh"
            | "ksh"
            | "ksh93"
            | "mksh"
            | "pdksh"
            | "yash"
            | "fish"
            | "csh"
            | "tcsh"
            | "nu"
            | "pwsh"
            | "elvish"
            | "xonsh"
    )
}

/// The process a session's channels hang off. `sshd-session` from OpenSSH 9.8.
fn is_ssh_daemon(comm: &str) -> bool {
    let name = program(comm);
    name == "sshd" || name.starts_with("sshd-") || name == "dropbear"
}

const fn no_tty(tty: &str) -> bool {
    tty.is_empty() || matches!(tty.as_bytes(), b"?" | b"??" | b"-")
}

/// What the tree says about the terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellWho {
    /// The tree could not be read or placed: no answer, and none is implied.
    Unknown,
    /// The terminal is not in the login shell, and what holds it is hidden from
    /// this user (`hidepid`): someone else, nobody knows who.
    Hidden,
    /// The user of the innermost shell in the foreground.
    Known(String),
}

/// Reads [`TREE_PROBE`]'s output. Principle 5: a tree it can't place is `Unknown`.
pub fn who(raw: &str) -> ShellWho {
    let mut me = None;
    let mut procs = Vec::new();
    for line in raw.lines() {
        if let Some(v) = line.strip_prefix("self=") {
            me = v.trim().parse::<i64>().ok();
        } else if !line.starts_with("login=") {
            procs.extend(parse_proc(line));
        }
    }
    let by_pid: HashMap<i64, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let Some(mut conn) = me else {
        return ShellWho::Unknown;
    };
    // Up from this probe to the connection's process (the login shell's `-c` may
    // stand between). With `hidepid` that process is not listed — its /proc entry is
    // root's: the pid its children name is all there is, and it is enough.
    for depth in 0.. {
        if depth == MAX_DEPTH {
            return ShellWho::Unknown;
        }
        match by_pid.get(&conn) {
            Some(p) if !is_ssh_daemon(&p.comm) => conn = p.ppid,
            _ => break,
        }
    }
    // Its one child with a terminal: the session's shell, whose sibling this is.
    let mut shells = procs.iter().filter(|p| p.ppid == conn && !no_tty(&p.tty));
    let (Some(login), None) = (shells.next(), shells.next()) else {
        return ShellWho::Unknown;
    };
    if login.tpgid <= 0 {
        return ShellWho::Unknown;
    }
    // The deepest process in the foreground of its terminal under that shell.
    // `sudo` with `use_pty` puts a pty of its own in the chain, so each is asked
    // about its own terminal rather than the shell's.
    let path_up = |from: &Proc| -> Option<Vec<i64>> {
        let mut path = vec![from.pid];
        let mut at = from;
        while at.pid != login.pid {
            at = by_pid.get(&at.ppid)?;
            path.push(at.pid);
            if path.len() > MAX_DEPTH {
                return None;
            }
        }
        Some(path)
    };
    let deepest = procs
        .iter()
        .filter(|p| !no_tty(&p.tty) && p.pgid == p.tpgid)
        .filter_map(path_up)
        .max_by_key(Vec::len);
    let Some(path) = deepest else {
        return ShellWho::Hidden;
    };
    // The innermost shell on that path; a one-off `sudo ls` leaves it unchanged.
    let shell = path
        .iter()
        .filter_map(|pid| by_pid.get(pid))
        .find(|p| is_shell(&p.comm))
        .unwrap_or(&login);
    ShellWho::Known(shell.user.clone())
}

/// The login user [`TREE_PROBE`] reported: the probe's own channel is logged in so.
pub fn login_of(raw: &str) -> Option<String> {
    let name = raw.lines().find_map(|l| l.strip_prefix("login="))?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What the file panel is told about who is who.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellUser {
    /// Whom the file panel works as.
    pub files: Option<String>,
    /// Whom the connection logged in as.
    pub login: Option<String>,
    /// Who the terminal is; null when unknown or hidden.
    pub shell: Option<String>,
    /// The terminal is someone else, and the server hides who.
    pub hidden: bool,
}

/// The report for a probe's output, with whom the panel works as if not the login user.
pub fn report(raw: &str, file_user: Option<String>) -> ShellUser {
    let login = login_of(raw);
    let tree = who(raw);
    ShellUser {
        files: file_user.or_else(|| login.clone()),
        login,
        hidden: tree == ShellWho::Hidden,
        shell: match tree {
            ShellWho::Known(user) => Some(user),
            _ => None,
        },
    }
}

/// A name `sudo -u` may be given: what a passwd entry holds, and never an option.
pub fn valid_user(name: &str) -> bool {
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    let body = name.strip_suffix('$').unwrap_or(name);
    first_ok
        && name.len() <= 64
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// `inner` run as `user`. With a password, sudo takes it from stdin and is told to
/// ignore what it has cached: a cached ticket would leave the password unread on
/// stdin — for `sftp-server`, garbage in the protocol. `-H`: the target's `$HOME`.
pub fn as_user(user: &str, with_password: bool, inner: &str) -> String {
    let auth = if with_password { "-k -S -p ''" } else { "-n" };
    format!(
        "env LC_ALL=C sudo {auth} -H -u {} -- {inner}",
        shell_quote(user)
    )
}

/// Prints where `sftp-server` is: what sshd is configured with, then where the
/// distributions put it. `internal-sftp` is no program and is passed over.
pub fn server_probe() -> String {
    let script = "conf=$(sed -n 's/^[[:space:]]*[Ss]ubsystem[[:space:]][[:space:]]*sftp[[:space:]][[:space:]]*\\([^[:space:]]*\\).*/\\1/p' /etc/ssh/sshd_config 2>/dev/null | head -n 1); \
for p in \"$conf\" /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/misc/sftp-server /usr/lib64/misc/sftp-server /usr/sbin/sftp-server \"$(command -v sftp-server 2>/dev/null)\"; do \
case \"$p\" in /*) [ -x \"$p\" ] && { echo \"$p\"; exit 0; };; esac; done; exit 1";
    format!("sh -c {}", shell_quote(script))
}

/// The panel's program as `user`: in the target's home, so that `.` — where the
/// panel starts — is theirs and not the login user's, closed to them.
fn server_command(user: &str, with_password: bool, server: &str) -> String {
    let start = format!("cd 2>/dev/null; exec {}", shell_quote(server));
    as_user(
        user,
        with_password,
        &format!("sh -c {}", shell_quote(&start)),
    )
}

/// Why `sudo` said no. The messages are `LC_ALL=C`, and they only choose between
/// outcomes: whatever is not recognised is reported as it was said.
pub fn sudo_refusal(outcome: &ExecOutcome, with_password: bool) -> AppError {
    if outcome.timed_out {
        return AppError::SudoRefused("sudo did not answer".into());
    }
    let said = outcome.stderr.to_lowercase();
    if said.contains("a password is required") {
        return AppError::SudoPasswordRequired;
    }
    if with_password
        && (said.contains("incorrect password")
            || said.contains("try again")
            || said.contains("no password was provided"))
    {
        return AppError::SudoPasswordRejected;
    }
    let reason = outcome
        .stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map_or_else(|| format!("exit {}", outcome.exit_code), str::to_string);
    AppError::SudoRefused(reason)
}

/// An SFTP session as `user`, or why not. The password, when there is one, goes
/// over stdin and nowhere else.
pub(crate) async fn open_as<H: client::Handler>(
    handle: &Handle<H>,
    user: &str,
    password: Option<&str>,
) -> AppResult<SftpSession> {
    if !valid_user(user) {
        return Err(AppError::SudoRefused(format!("not a user name: {user}")));
    }
    let with_password = password.is_some();
    let stdin = password.map(|p| crate::sync::sudo_stdin(Some(p)));
    let stdin: &[u8] = stdin.as_deref().map_or(&[], Vec::as_slice);
    // Asked apart: once `sftp-server` is meant to be running, a refusal is only a
    // closed channel — stderr does not reach the SFTP stream.
    let check = exec_on(
        handle,
        &as_user(user, with_password, "true"),
        stdin,
        SUDO_CHECK_SECS,
        None,
    )
    .await?;
    if check.timed_out || check.exit_code != 0 {
        return Err(sudo_refusal(&check, with_password));
    }
    let found = exec_on(handle, &server_probe(), &[], 10, None).await?;
    let server = found.stdout.trim();
    if !server.starts_with('/') {
        return Err(AppError::SftpServerMissing);
    }
    let channel = answered(handle.channel_open_session(), "could not open SFTP channel").await?;
    answered(
        channel.exec(true, server_command(user, with_password, server).as_bytes()),
        "could not start sftp-server",
    )
    .await?;
    if !stdin.is_empty() {
        channel
            .data(stdin)
            .await
            .map_err(|e| format!("could not start sftp-server: {e}"))?;
    }
    answered(SftpSession::new(channel.into_stream()), "SFTP init failed").await
}

/// Whom a session's file panel works as, when it is not the login user.
pub struct FileUser {
    pub user: String,
    /// `sudo`'s password, when it wants one: only in memory, wiped with the session.
    pub password: Option<Zeroizing<String>>,
}

impl FileUser {
    /// A file command — one that runs as a command rather than over SFTP — as this
    /// user. Its stdin is [`stdin`](Self::stdin).
    pub fn command(&self, inner: &str) -> String {
        as_user(
            &self.user,
            self.password.is_some(),
            &format!("sh -c {}", shell_quote(inner)),
        )
    }

    pub fn stdin(&self) -> Zeroizing<Vec<u8>> {
        match &self.password {
            Some(p) => crate::sync::sudo_stdin(Some(p)),
            None => Zeroizing::new(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree as a Linux server prints it (this one is OpenSSH 9.6, Ubuntu 24.04).
    fn tree(rows: &[&str]) -> String {
        format!(
            "self=91\nlogin=tester\n\
             1 0 1 -1 root ? sshd\n\
             74 1 74 -1 root ? sshd\n\
             85 74 74 -1 tester ? sshd\n\
             91 85 91 -1 tester ? sh\n\
             92 91 91 -1 tester ? ps\n{}\n",
            rows.join("\n")
        )
    }

    #[test]
    fn the_login_shell_at_its_prompt_is_the_login_user() {
        let raw = tree(&["86 85 86 86 tester pts/0 bash"]);
        assert_eq!(who(&raw), ShellWho::Known("tester".into()));
        assert_eq!(login_of(&raw).as_deref(), Some("tester"));
    }

    #[test]
    fn su_is_seen_through_the_root_su_in_the_middle() {
        let raw = tree(&[
            "86 85 86 94 tester pts/0 bash",
            "93 86 93 94 root pts/0 su",
            "94 93 94 94 deploy pts/0 bash",
        ]);
        assert_eq!(who(&raw), ShellWho::Known("deploy".into()));
    }

    #[test]
    fn sudo_i_is_followed_onto_the_pty_of_its_own() {
        // Real output: sudo ≥ 1.9.14, `use_pty`. The shell is on pts/1, ours on pts/0.
        let raw = tree(&[
            "86 85 86 109 tester pts/0 bash",
            "109 86 109 109 root pts/0 sudo",
            "110 109 110 111 root pts/1 sudo",
            "111 110 111 111 root pts/1 bash",
        ]);
        assert_eq!(who(&raw), ShellWho::Known("root".into()));
    }

    #[test]
    fn a_one_off_under_sudo_is_no_change_of_user() {
        let raw = tree(&[
            "86 85 86 109 tester pts/0 bash",
            "109 86 109 109 root pts/0 sudo",
            "110 109 110 111 root pts/1 sudo",
            "111 110 111 111 root pts/1 apt",
        ]);
        assert_eq!(who(&raw), ShellWho::Known("tester".into()));
    }

    #[test]
    fn a_program_in_the_foreground_leaves_the_shell_that_ran_it() {
        // The same for `ssh other`: the shell over there is not in this tree.
        let raw = tree(&[
            "86 85 86 95 tester pts/0 bash",
            "95 86 95 95 tester pts/0 vim",
        ]);
        assert_eq!(who(&raw), ShellWho::Known("tester".into()));
    }

    #[test]
    fn a_shell_in_the_background_is_not_the_terminal() {
        let raw = tree(&[
            "86 85 86 86 tester pts/0 bash",
            "95 86 95 86 tester pts/0 sudo",
            "96 95 96 86 root pts/0 bash",
        ]);
        assert_eq!(who(&raw), ShellWho::Known("tester".into()));
    }

    #[test]
    fn with_hidepid_the_terminal_is_someone_nobody_can_name() {
        // su and deploy's shell are not listed; the login shell is not in front.
        let raw = tree(&["86 85 86 94 tester pts/0 bash"]);
        assert_eq!(who(&raw), ShellWho::Hidden);
    }

    #[test]
    fn with_hidepid_even_the_connections_process_is_not_listed() {
        // Real output of a server with `hidepid=2`: 41 is sshd, 50 is su's shell.
        let at_prompt = "self=47\nlogin=tester\n\
                         42 41 42 42 tester pts/0 bash\n\
                         47 41 47 -1 tester ? sh\n\
                         48 47 47 -1 tester ? ps\n";
        assert_eq!(who(at_prompt), ShellWho::Known("tester".into()));
        let after_su = "self=54\nlogin=tester\n\
                        42 41 42 50 tester pts/0 bash\n\
                        54 41 54 -1 tester ? sh\n\
                        55 54 54 -1 tester ? ps\n";
        assert_eq!(who(after_su), ShellWho::Hidden);
    }

    #[test]
    fn it_works_on_the_newer_session_process_and_on_macos_names() {
        let raw = "self=20\nlogin=me\n\
                   10 1 10 0 root ?? sshd-session\n\
                   11 10 10 0 me ?? sshd-session\n\
                   12 11 12 30 me ttys001 -zsh\n\
                   29 12 29 30 root ttys001 su\n\
                   30 29 30 30 other ttys001 /bin/zsh\n\
                   20 11 20 0 me ?? sh\n";
        assert_eq!(who(raw), ShellWho::Known("other".into()));
    }

    #[test]
    fn a_login_shell_of_the_exec_channel_may_stand_in_the_way() {
        let raw = "self=91\nlogin=tester\n\
                   85 1 85 -1 tester ? sshd\n\
                   90 85 90 -1 tester ? fish\n\
                   91 90 90 -1 tester ? sh\n\
                   86 85 86 86 tester pts/0 fish\n";
        assert_eq!(who(raw), ShellWho::Known("tester".into()));
    }

    #[test]
    fn what_cannot_be_placed_is_unknown_and_implies_nothing() {
        // No `ps` output (busybox), a daemon it does not know, two terminals.
        assert_eq!(who("self=91\nlogin=tester\n"), ShellWho::Unknown);
        assert_eq!(
            who("self=9\nlogin=a\n9 8 9 -1 a ? sh\n8 1 8 -1 a ? tinysshd\n"),
            ShellWho::Unknown
        );
        let two = tree(&[
            "86 85 86 86 tester pts/0 bash",
            "87 85 87 87 tester pts/1 bash",
        ]);
        assert_eq!(who(&two), ShellWho::Unknown);
        assert_eq!(who(&tree(&[])), ShellWho::Unknown);
        assert_eq!(who("garbage"), ShellWho::Unknown);
    }

    #[test]
    fn a_loop_of_parents_ends() {
        let raw = "self=1\nlogin=a\n1 2 1 -1 a ? sh\n2 1 2 -1 a ? sh\n";
        assert_eq!(who(raw), ShellWho::Unknown);
    }

    #[test]
    fn the_report_says_who_files_are_and_keeps_unknown_apart_from_hidden() {
        let same = tree(&["86 85 86 86 tester pts/0 bash"]);
        assert_eq!(
            report(&same, None),
            ShellUser {
                files: Some("tester".into()),
                login: Some("tester".into()),
                shell: Some("tester".into()),
                hidden: false,
            }
        );
        let hidden = tree(&["86 85 86 94 tester pts/0 bash"]);
        let r = report(&hidden, Some("deploy".into()));
        assert_eq!(r.files.as_deref(), Some("deploy"));
        assert!(r.hidden);
        assert_eq!(r.shell, None);
        let unknown = report("self=1\n", None);
        assert_eq!((unknown.files, unknown.hidden), (None, false));
    }

    #[test]
    fn a_user_name_is_never_an_option_or_a_command() {
        for ok in ["deploy", "root", "a.b-c_d", "_svc", "machine$", "1000"] {
            assert!(valid_user(ok), "{ok}");
        }
        for bad in [
            "",
            "-u",
            "--help",
            "a b",
            "a;rm",
            "$(x)",
            "a/b",
            "a$b",
            "a\nb",
            &"x".repeat(65),
        ] {
            assert!(!valid_user(bad), "{bad}");
        }
    }

    #[test]
    fn with_a_password_sudo_reads_it_and_ignores_what_it_has_cached() {
        assert_eq!(
            as_user("deploy", true, "true"),
            "env LC_ALL=C sudo -k -S -p '' -H -u 'deploy' -- true"
        );
        assert_eq!(
            as_user("deploy", false, "true"),
            "env LC_ALL=C sudo -n -H -u 'deploy' -- true"
        );
    }

    #[test]
    fn the_server_starts_in_the_targets_home_and_paths_are_quoted() {
        assert_eq!(
            server_command("deploy", false, "/usr/lib/open ssh/sftp-server"),
            "env LC_ALL=C sudo -n -H -u 'deploy' -- sh -c 'cd 2>/dev/null; exec '\\''/usr/lib/open ssh/sftp-server'\\'''"
        );
    }

    #[test]
    fn a_file_command_runs_whole_under_the_user_and_the_password_stays_off_it() {
        let user = FileUser {
            user: "deploy".into(),
            password: Some(Zeroizing::new("s3cret".into())),
        };
        let cmd = user.command("grep -r 'x' /srv");
        assert_eq!(
            cmd,
            "env LC_ALL=C sudo -k -S -p '' -H -u 'deploy' -- sh -c 'grep -r '\\''x'\\'' /srv'"
        );
        assert!(!cmd.contains("s3cret"));
        assert_eq!(&user.stdin()[..], b"s3cret\n");
        let free = FileUser {
            user: "deploy".into(),
            password: None,
        };
        assert!(free.stdin().is_empty());
    }

    fn said(stderr: &str, exit_code: i32) -> ExecOutcome {
        ExecOutcome {
            stdout: String::new(),
            stderr: stderr.into(),
            exit_code,
            timed_out: false,
        }
    }

    #[test]
    fn a_refusal_tells_what_is_needed_from_what_is_not_allowed() {
        assert!(matches!(
            sudo_refusal(&said("sudo: a password is required\n", 1), false),
            AppError::SudoPasswordRequired
        ));
        for words in [
            "Sorry, try again.\nsudo: 1 incorrect password attempt\n",
            "sudo: no password was provided\n",
        ] {
            assert!(matches!(
                sudo_refusal(&said(words, 1), true),
                AppError::SudoPasswordRejected
            ));
        }
        let denied = sudo_refusal(&said("plain is not in the sudoers file.\n", 1), true);
        assert_eq!(
            denied.to_string(),
            "sudo-refused: plain is not in the sudoers file."
        );
        assert_eq!(
            sudo_refusal(&said("", 127), false).to_string(),
            "sudo-refused: exit 127"
        );
        let mut slow = said("", -1);
        slow.timed_out = true;
        assert!(matches!(
            sudo_refusal(&slow, false),
            AppError::SudoRefused(_)
        ));
    }
}

/// Against a real sshd with real `su` and `sudo`: what `ps` shows for them, and
/// whether `sftp-server` under `sudo` really speaks the protocol — sudo's own pty
/// (`use_pty`) and a password on the same stdin are what could break it. Ignored:
///
///   docker compose -f e2e/docker-compose.sudo.yml up -d --build --wait
///   cargo test --manifest-path src-tauri/Cargo.toml --lib live_fileuser -- --ignored
///   docker compose -f e2e/docker-compose.sudo.yml down
#[cfg(test)]
mod live_fileuser {
    use super::*;
    use russh::client::Msg;
    use russh::{Channel, ChannelMsg};
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct AcceptAnyKey;

    impl client::Handler for AcceptAnyKey {
        type Error = russh::Error;
        // Throwaway local container; its host key is regenerated on every build.
        async fn check_server_key(
            &mut self,
            _key: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn connect(user: &str, pass: &str) -> Handle<AcceptAnyKey> {
        let port = std::env::var("VTERM_TEST_SUDO_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2224);
        connect_at(port, user, pass).await
    }

    async fn connect_at(port: u16, user: &str, pass: &str) -> Handle<AcceptAnyKey> {
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            ("127.0.0.1", port),
            AcceptAnyKey,
        )
        .await
        .expect(
            "no test server — docker compose -f e2e/docker-compose.sudo.yml up -d --build --wait",
        );
        assert!(handle
            .authenticate_password(user, pass)
            .await
            .unwrap()
            .success());
        handle
    }

    /// The session's shell, as the app opens it: on the same connection as the probe.
    async fn shell(handle: &Handle<AcceptAnyKey>) -> Channel<Msg> {
        let channel = handle.channel_open_session().await.unwrap();
        channel
            .request_pty(true, "xterm-256color", 120, 40, 0, 0, &[])
            .await
            .unwrap();
        channel.request_shell(true).await.unwrap();
        channel
    }

    /// Read the shell until `needle` shows.
    async fn until(channel: &mut Channel<Msg>, needle: &str) {
        let end = Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        while !seen.contains(needle) {
            let left = end.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => {
                    seen.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("no {needle:?} in the terminal: {seen:?}"),
            }
        }
    }

    async fn type_line(channel: &Channel<Msg>, line: &str) {
        channel.data(format!("{line}\n").as_bytes()).await.unwrap();
    }

    /// The tree's answer, once it stops being `from`: a change takes the shell a moment.
    async fn who_becomes(handle: &Handle<AcceptAnyKey>, want: &ShellWho) -> ShellWho {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let raw = exec_on(handle, TREE_PROBE, &[], 10, None).await.unwrap();
            let got = who(&raw.stdout);
            if &got == want || Instant::now() > end {
                return got;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn known(name: &str) -> ShellWho {
        ShellWho::Known(name.into())
    }

    #[tokio::test]
    #[ignore]
    async fn su_is_seen_and_so_is_its_exit() {
        let handle = connect("tester", "testpass").await;
        let mut term = shell(&handle).await;
        until(&mut term, "$ ").await;
        assert_eq!(
            who_becomes(&handle, &known("tester")).await,
            known("tester")
        );
        type_line(&term, "su - deploy").await;
        until(&mut term, "assword").await;
        type_line(&term, "deploypass").await;
        assert_eq!(
            who_becomes(&handle, &known("deploy")).await,
            known("deploy")
        );
        type_line(&term, "exit").await;
        assert_eq!(
            who_becomes(&handle, &known("tester")).await,
            known("tester")
        );
    }

    #[tokio::test]
    #[ignore]
    async fn sudo_i_is_seen_on_the_pty_of_its_own() {
        let handle = connect("tester", "testpass").await;
        let mut term = shell(&handle).await;
        until(&mut term, "$ ").await;
        type_line(&term, "sudo -i").await;
        until(&mut term, "assword").await;
        type_line(&term, "testpass").await;
        assert_eq!(who_becomes(&handle, &known("root")).await, known("root"));
    }

    /// Needs a server with `hidepid=2`, which takes a privileged container, so it is
    /// not in the compose file: run the image with `--privileged`, remount /proc, and
    /// name its port in `VTERM_TEST_SUDO_HIDEPID_PORT`. Without it there is nothing to do.
    #[tokio::test]
    #[ignore]
    async fn where_the_server_hides_processes_it_says_so_and_names_nobody() {
        let Some(port) = std::env::var("VTERM_TEST_SUDO_HIDEPID_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
        else {
            return;
        };
        let handle = connect_at(port, "tester", "testpass").await;
        let mut term = shell(&handle).await;
        until(&mut term, "$ ").await;
        assert_eq!(
            who_becomes(&handle, &known("tester")).await,
            known("tester")
        );
        type_line(&term, "su - deploy").await;
        until(&mut term, "assword").await;
        type_line(&term, "deploypass").await;
        assert_eq!(
            who_becomes(&handle, &ShellWho::Hidden).await,
            ShellWho::Hidden
        );
    }

    #[tokio::test]
    #[ignore]
    async fn a_one_off_under_sudo_changes_nobody() {
        let handle = connect("nopass", "nopass").await;
        let mut term = shell(&handle).await;
        until(&mut term, "$ ").await;
        type_line(&term, "sudo sleep 3").await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        let raw = exec_on(&handle, TREE_PROBE, &[], 10, None).await.unwrap();
        assert!(
            raw.stdout.contains("sleep"),
            "the one-off must be running: {}",
            raw.stdout
        );
        assert_eq!(who(&raw.stdout), known("nopass"));
    }

    /// Writes `bytes` to a new file and reads them back: nothing on the way may
    /// bend them — no pty, no echo, no line ending.
    async fn round_trip(sftp: &SftpSession, path: &str, bytes: &[u8]) {
        let mut file = sftp.create(path).await.unwrap();
        file.write_all(bytes).await.unwrap();
        file.shutdown().await.unwrap();
        let mut back = Vec::new();
        sftp.open(path)
            .await
            .unwrap()
            .read_to_end(&mut back)
            .await
            .unwrap();
        assert_eq!(Sha256::digest(&back), Sha256::digest(bytes));
    }

    /// Every byte value, many times over: a tty would eat 0x03, 0x04, 0x11, 0x13…
    fn every_byte() -> Vec<u8> {
        (0..4 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect()
    }

    #[tokio::test]
    #[ignore]
    async fn with_a_password_the_panel_works_as_that_user() {
        let handle = connect("tester", "testpass").await;
        // As itself it cannot look.
        let own = {
            let channel = handle.channel_open_session().await.unwrap();
            channel.request_subsystem(true, "sftp").await.unwrap();
            SftpSession::new(channel.into_stream()).await.unwrap()
        };
        assert!(own.read_dir("/home/deploy").await.is_err());

        let sftp = open_as(&handle, "deploy", Some("testpass")).await.unwrap();
        assert_eq!(sftp.canonicalize(".").await.unwrap(), "/home/deploy");
        let names: Vec<String> = sftp
            .read_dir("/home/deploy")
            .await
            .unwrap()
            .map(|e| e.file_name())
            .collect();
        assert!(names.iter().any(|n| n == "only-deploy.txt"), "{names:?}");

        let path = format!("/home/deploy/made-{}.bin", std::process::id());
        round_trip(&sftp, &path, &every_byte()).await;
        // Made by that user, not by the login user.
        let uid = exec_on(&handle, "id -u deploy", &[], 5, None)
            .await
            .unwrap();
        let attrs = sftp.metadata(&path).await.unwrap();
        assert_eq!(attrs.uid.unwrap().to_string(), uid.stdout.trim());
        sftp.remove_file(&path).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn without_a_password_where_sudo_asks_for_none() {
        let handle = connect("nopass", "nopass").await;
        let sftp = open_as(&handle, "deploy", None).await.unwrap();
        let path = format!("/home/deploy/free-{}.bin", std::process::id());
        round_trip(&sftp, &path, &every_byte()).await;
        sftp.remove_file(&path).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn each_refusal_says_what_it_is() {
        let tester = connect("tester", "testpass").await;
        assert!(matches!(
            open_as(&tester, "deploy", None).await.err(),
            Some(AppError::SudoPasswordRequired)
        ));
        assert!(matches!(
            open_as(&tester, "deploy", Some("wrong")).await.err(),
            Some(AppError::SudoPasswordRejected)
        ));
        let plain = connect("plain", "plain").await;
        let refused = open_as(&plain, "deploy", Some("plain"))
            .await
            .err()
            .unwrap();
        assert!(
            matches!(&refused, AppError::SudoRefused(why) if why.contains("sudoers")),
            "{refused}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn a_file_command_runs_as_that_user_with_the_password_on_stdin() {
        let handle = connect("tester", "testpass").await;
        let user = FileUser {
            user: "deploy".into(),
            password: Some(Zeroizing::new("testpass".into())),
        };
        let out = exec_on(
            &handle,
            &user.command("id -un; cat /home/deploy/only-deploy.txt"),
            &user.stdin(),
            20,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out.stdout, "deploy\nsecret\n", "{}", out.stderr);
    }
}
