// Git panel backend (Phase 29). `git_run` runs one `git` command in a working
// directory over the session's transport (see `exec`): SSH tabs on a dedicated
// exec channel, local shell tabs by spawning `git` here. All argument building
// and output parsing lives on the frontend (`src/lib/git/git.ts`).
//
// `GIT_TERMINAL_PROMPT=0` is forced so credential prompts (HTTPS-with-password
// remotes over a non-TTY exec channel) fail fast with a readable error instead
// of hanging forever.
//
// The WebView is a trust boundary (v1.25.1): it names the argv, but only the
// subcommands and options the panel uses get through `check_args`.

/// POSIX single-quote escaping so an argument survives the remote login shell
/// intact (SSH `exec` runs the string through the user's shell). Wraps in `'…'`
/// and rewrites embedded quotes as `'\''`.
pub fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Build the shell command string run on the remote for an SSH tab:
/// `GIT_TERMINAL_PROMPT=0 git -C '<cwd>' '<arg>' …`. Every field is quoted so
/// branch names, commit messages, paths, etc. can't break out of the command.
pub fn ssh_command(cwd: &str, args: &[String]) -> String {
    let mut cmd = format!("GIT_TERMINAL_PROMPT=0 git -C {}", shell_quote(cwd));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    cmd
}

/// The local argv: `-C <cwd>` before the panel's arguments.
pub fn local_args(cwd: &str, args: &[String]) -> Vec<String> {
    let mut all = vec!["-C".to_string(), cwd.to_string()];
    all.extend_from_slice(args);
    all
}

/// Why a local `git` may hang past its timeout.
pub const TIMEOUT_HINT: &str = " — the working-tree update may be stuck on a filter (e.g. Git \
                                LFS) or a slow/unreachable remote";

/// The subcommands the Git panel runs (git.ts). Anything else would let the argv
/// pick a program: `config` (a `core.fsmonitor` or `!`-alias runs on the next
/// command), `submodule foreach`, `bisect run`, `difftool`, an alias, or an
/// external `git-<name>` found on PATH. Global options (`-c`, `--exec-path`,
/// `--git-dir`) can only come before a subcommand, so they never get through.
const SUBCOMMANDS: &[&str] = &[
    "add",
    "branch",
    "checkout",
    "cherry-pick",
    "clean",
    "commit",
    "diff",
    "fetch",
    "log",
    "merge",
    "pull",
    "push",
    "rebase",
    "remote",
    "reset",
    "restore",
    "rev-parse",
    "revert",
    "show",
    "stash",
    "status",
    "tag",
];

/// Options of allowed subcommands that run a program or write a file of the
/// caller's choosing: the transport helpers of fetch/pull/push, `--exec`, and
/// `--output` of log/diff/show (a write anywhere the user can write).
const DANGEROUS_OPTIONS: &[&str] = &[
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--output",
    "--config-env",
];

/// Whether the WebView may run `git <args…>`. git accepts any unambiguous
/// abbreviation of a long option (`--upload-p=…`), so a token is refused when it
/// abbreviates a dangerous option, not only when it spells it out. Everything
/// after `--` is a path, and the value after `-m` is a message — neither is read
/// as an option.
pub fn check_args(args: &[String]) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("git: no arguments".into());
    };
    if !SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(format!("git: `{sub}` is not a command the Git panel runs"));
    }
    if sub == "remote" && args.get(1).map(String::as_str) != Some("get-url") {
        return Err("git: only `remote get-url` is allowed".into());
    }
    let mut tokens = args[1..].iter();
    while let Some(token) = tokens.next() {
        if token == "--" {
            break;
        }
        if token == "-m" {
            tokens.next(); // the message, whatever it starts with
            continue;
        }
        // `rebase -x <cmd>` / `-i` and their bundles: the panel rebases onto a
        // branch and nothing else.
        if sub == "rebase" && token.starts_with('-') {
            return Err("git: `rebase` takes no options here".into());
        }
        if let Some(long) = token.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or(long);
            if !name.is_empty()
                && DANGEROUS_OPTIONS
                    .iter()
                    .any(|o| o.trim_start_matches('-').starts_with(name))
            {
                return Err(format!("git: option `{token}` is not allowed"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn shell_quote_wraps_plain() {
        assert_eq!(shell_quote("main"), "'main'");
    }

    #[test]
    fn shell_quote_escapes_single_quote() {
        // it's → '\''  →  'it'\''s'
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn ssh_command_quotes_cwd_and_args() {
        let cmd = ssh_command("/tmp/my repo", &["status".into(), "--porcelain".into()]);
        assert_eq!(
            cmd,
            "GIT_TERMINAL_PROMPT=0 git -C '/tmp/my repo' 'status' '--porcelain'"
        );
    }

    #[test]
    fn ssh_command_neutralizes_injection() {
        // A branch name trying to inject a second command stays a single arg.
        let cmd = ssh_command("/repo", &["checkout".into(), "x; rm -rf /".into()]);
        assert_eq!(
            cmd,
            "GIT_TERMINAL_PROMPT=0 git -C '/repo' 'checkout' 'x; rm -rf /'"
        );
    }

    #[test]
    fn local_args_put_the_directory_first() {
        assert_eq!(
            local_args("/r", &argv(&["status"])),
            argv(&["-C", "/r", "status"])
        );
    }

    /// The argv shapes git.ts builds — every one must pass.
    #[test]
    fn what_the_git_panel_runs_is_allowed() {
        for ok in [
            &["rev-parse", "--show-toplevel"][..],
            &["status", "--porcelain=v2", "--branch", "-z"],
            &[
                "log",
                "--no-color",
                "-z",
                "--pretty=format:%H%x1f%s",
                "-n",
                "200",
                "--all",
            ],
            &[
                "branch",
                "-a",
                "--no-color",
                "--format=%(HEAD)%00%(refname)",
            ],
            &["add", "--", "a.txt"],
            &["add", "-A"],
            &["reset", "-q"],
            &["restore", "--staged", "--", "a"],
            &["clean", "-f", "--", "a"],
            &["checkout", "HEAD", "--", "a"],
            &["reset", "--hard"],
            &["commit", "-m", "fix: --output is not an option here"],
            &["checkout", "-b", "feature", "main"],
            &["branch", "-D", "old"],
            &["branch", "-m", "a", "b"],
            &["merge", "feature"],
            &["rebase", "main"],
            &["branch", "--set-upstream-to=origin/x", "x"],
            &["diff", "--no-color", "a", "b"],
            &["reset", "--soft", "abc"],
            &["cherry-pick", "abc"],
            &["revert", "--no-edit", "abc"],
            &["tag", "v1", "abc"],
            &["remote", "get-url", "origin"],
            &["fetch", "--all", "--prune"],
            &["pull", "--ff-only"],
            &[
                "push",
                "--force-with-lease",
                "--set-upstream",
                "origin",
                "x",
            ],
            &["stash", "push", "-m", "--exec looks like an option"],
            &["stash", "push", "--", "a"],
            &["stash", "list", "--format=%gd%x1f%s"],
            &["stash", "apply", "stash@{0}"],
            &["stash", "show", "--name-status", "stash@{0}"],
            &["diff", "--no-color", "--cached", "-U3"],
            &["show", "--no-color", "--format=", "abc", "--", "--output"],
            &["show", "main:src/a.ts"],
            &[
                "show",
                "-z",
                "--no-color",
                "--name-status",
                "--format=%an",
                "abc",
            ],
            &["diff", "-z", "--no-color", "--name-status", "abc^1", "abc"],
        ] {
            assert_eq!(check_args(&argv(ok)), Ok(()), "{ok:?}");
        }
    }

    #[test]
    fn what_runs_a_program_or_writes_a_file_is_refused() {
        for bad in [
            &[][..],
            &["config", "core.fsmonitor", "sh -c id"],
            &["-c", "core.sshCommand=sh -c id", "fetch"],
            &["--exec-path=/tmp", "status"],
            &["submodule", "foreach", "id"],
            &["bisect", "run", "id"],
            &["difftool"],
            &["remote", "add", "x", "ext::sh -c id"],
            &["fetch", "--upload-pack=sh -c id", "origin"],
            &["fetch", "--upload-p=sh -c id", "origin"],
            &["push", "--e=x", "origin"],
            &["pull", "--upload-pack", "x"],
            &["push", "--receive-pack=x", "origin"],
            &["push", "--exec=x", "origin"],
            &["log", "--output=/home/u/.bashrc"],
            &["diff", "--outp=/x"],
            &["rebase", "-x", "id", "main"],
            &["rebase", "--exec=id", "main"],
            &["rebase", "-ix", "id"],
            &["status", "--config-env=core.pager=X"],
        ] {
            assert!(check_args(&argv(bad)).is_err(), "{bad:?}");
        }
    }
}
