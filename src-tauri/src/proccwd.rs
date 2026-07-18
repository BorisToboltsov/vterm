//! The working directory of a local shell, read from the OS (Phase 39.3).
//!
//! ## Why this exists
//!
//! "Follow the terminal" was built entirely on **OSC 7** — an escape sequence the
//! shell emits to announce its cwd. That works only when the shell chooses to
//! emit it, and on a default install most do not:
//!
//!   * **macOS/zsh** ships the emitter in `/etc/zshrc_Apple_Terminal`, which
//!     `/etc/zshrc` sources *only* when `$TERM_PROGRAM == "Apple_Terminal"`. We
//!     set `TERM` and nothing else, so the hook never loads and zsh stays silent.
//!     Measured on a stock machine: 0 sequences without that variable, 2 with it.
//!   * **Windows** PowerShell and `cmd.exe` emit nothing at all by default; the
//!     Windows convention is even a different sequence (OSC 9;9), which we now
//!     also parse — but only users who set up shell integration ever send it.
//!   * **Linux** often works, because many distros ship `/etc/profile.d/vte.sh`.
//!     That is why the feature appeared to work at all.
//!
//! Setting `TERM_PROGRAM=Apple_Terminal` to trick zsh was rejected: it is a lie,
//! and that file also switches on Apple's shell-session save/restore machinery
//! (writing `~/.zsh_sessions`, rewriting history) which the user never asked for.
//!
//! ## What we do instead
//!
//! We own the pty, so we know the shell's pid, and every desktop OS can report a
//! process's cwd. `sysinfo` — already a dependency for local metrics (Phase 38) —
//! implements exactly that on all three platforms, so this is a thin wrapper
//! rather than hand-rolled FFI:
//!
//!   * Linux: `/proc/<pid>/cwd`;
//!   * macOS: `proc_pidinfo` with `PROC_PIDVNODEPATHINFO`;
//!   * Windows: the process's PEB (`RTL_USER_PROCESS_PARAMETERS.CurrentDirectory`).
//!
//! This needs **no shell cooperation at all** and is strictly better than OSC 7 in
//! one more way: it also catches `cd` performed inside a script or a subshell,
//! which never emits a prompt and therefore never fires a precmd hook.
//!
//! Failure is normal, not exceptional — the Windows path reads another process's
//! memory and can legitimately fail (bitness mismatch, AV interference, a process
//! that exited between poll and read). Every failure yields `None`, and the panel
//! simply doesn't move. OSC 7/9;9 remain wired up in parallel, so a shell that
//! *does* announce its cwd still gets the faster, event-driven path.
//!
//! Local tabs only: over SSH the shell is on another host and there is no pid to
//! inspect, so remote follow still depends on the server emitting OSC 7.

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// The current working directory of process `pid`, or `None` when the OS won't
/// say (see the module docs — this is an expected outcome, not an error).
pub fn process_cwd(pid: u32) -> Option<String> {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    // Refresh exactly one process and only its cwd: a full refresh would walk
    // every process on the machine, and this runs on a poll.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );
    let cwd = sys.process(pid)?.cwd()?.to_string_lossy().into_owned();
    // An empty answer is as useless as no answer; don't hand the panel a path
    // that would send it to the filesystem root.
    (!cwd.is_empty()).then_some(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The one process whose cwd we can assert against without mocking the OS:
    // ourselves. Exercises the real platform path on whichever OS runs the suite.
    #[test]
    fn reads_our_own_working_directory() {
        let expected = std::env::current_dir().unwrap();
        let got = process_cwd(std::process::id()).expect("own cwd should be readable");
        // Compare canonicalised, since macOS reports `/private/var/...` for
        // `/var/...` and the test runner's cwd may be a symlinked path.
        let got_c = std::fs::canonicalize(&got).unwrap_or_else(|_| got.clone().into());
        let exp_c = std::fs::canonicalize(&expected).unwrap_or(expected);
        assert_eq!(got_c, exp_c);
    }

    #[test]
    fn missing_process_yields_none_rather_than_erroring() {
        // A pid that cannot exist: the kernel caps pids well below this.
        assert!(process_cwd(u32::MAX - 1).is_none());
    }
}
