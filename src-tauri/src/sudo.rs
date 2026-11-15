//! What vterm asks of `sudo`, what it makes of the answer, and which password it
//! gives it (ADR 0073).
//!
//! **One reading of the answer.** sudo says why it will not in words; [`answer`]
//! reads them — under `LC_ALL=C`, so a server in another language says the same —
//! and turns them into the typed errors the window tells apart: a password is
//! wanted (`sudo-password`), the one given was wrong (`sudo-rejected`), or sudo will
//! not whatever the password (`sudo-refused: <why>`): no rights, the command not
//! allowed, no sudo, a terminal required, the account locked or its password
//! expired, no answer. What it does not recognise is reported as it was said.
//!
//! **The window never holds a sudo password.** A typed one reaches the backend
//! once, through the check (`sudo_check`); from then on the session remembers what
//! sudo took ([`SudoMemo`]) and every sudo step of that session uses it. With
//! nothing typed, the order is: what sudo took before; no password (NOPASSWD); the
//! sudo password saved in the keychain; the login password from the keychain —
//! each saved one tried at most once a session, since every wrong try is a line in
//! the server's auth log and a step towards `pam_faillock` locking the account. The
//! login password is no new exposure: the server took the very same one at login.
//!
//! The check is `sudo -v` — it authenticates and runs nothing — with `-k`, so a
//! ticket sudo still holds cannot make a wrong password look right.

use crate::error::{AppError, AppResult};
use crate::ssh::{exec_on, ExecOutcome};
use russh::client::{self, Handle};
use serde::Serialize;
use zeroize::Zeroizing;

/// How long a check of sudo may take before it counts as no answer.
pub const CHECK_SECS: u64 = 20;

/// Why sudo will not, whatever the password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    /// The user may not run sudo on this host (`not in the sudoers file`).
    NotAllowed,
    /// sudo agrees to the user, but not to this command.
    CommandRefused,
    /// There is no `sudo` on the server.
    NoSudo,
    /// `requiretty`: sudo will only take a password from a terminal.
    NeedsTty,
    /// The account is locked or has expired (PAM account checks, faillock).
    AccountLocked,
    /// The password has expired and has to be changed first.
    PasswordExpired,
    /// sudo did not answer in time.
    NoAnswer,
    /// Something else — what sudo said comes along.
    Other,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAllowed => "not-allowed",
            Self::CommandRefused => "command-refused",
            Self::NoSudo => "no-sudo",
            Self::NeedsTty => "needs-tty",
            Self::AccountLocked => "account-locked",
            Self::PasswordExpired => "password-expired",
            Self::NoAnswer => "no-answer",
            Self::Other => "other",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which saved password sudo already turned down this session, when it asks for
/// one: the window says so instead of a bare "password".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tried {
    Nothing,
    Saved,
    Login,
}

impl std::fmt::Display for Tried {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Nothing => "nothing",
            Self::Saved => "saved",
            Self::Login => "login",
        })
    }
}

/// Where the password sudo took came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Via {
    /// sudo wants none (NOPASSWD).
    None,
    /// Typed into the prompt.
    Typed,
    /// The sudo password saved in the keychain.
    Saved,
    /// The login password saved in the keychain.
    Login,
}

/// The command that asks sudo to authenticate and run nothing.
pub fn check_command(with_password: bool) -> &'static str {
    if with_password {
        "env LC_ALL=C sudo -k -S -p '' -v"
    } else {
        "env LC_ALL=C sudo -n -v"
    }
}

/// The first line sudo said that tells something: not its retry prompt, not the
/// host-name warning every command on a misnamed host prints.
fn first_said(outcome: &ExecOutcome) -> String {
    outcome
        .stderr
        .lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                && !l.eq_ignore_ascii_case("sorry, try again.")
                && !l.to_lowercase().contains("unable to resolve host")
        })
        .map_or_else(|| format!("exit {}", outcome.exit_code), str::to_string)
}

/// Why sudo said no, as the error the window tells apart. `with_password`: a
/// password was given — only then can a "try again" mean it was wrong.
pub fn answer(outcome: &ExecOutcome, with_password: bool) -> AppError {
    let refused = |why| AppError::SudoRefused {
        why,
        said: first_said(outcome),
    };
    if outcome.timed_out {
        return AppError::SudoRefused {
            why: Refusal::NoAnswer,
            said: "sudo did not answer".into(),
        };
    }
    let said = outcome.stderr.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| said.contains(w));
    // `env: 'sudo': No such file or directory` — the shell's own words vary, 127 not.
    if outcome.exit_code == 127
        || has(&[
            "'sudo': no such file",
            "sudo: not found",
            "sudo: command not found",
        ])
    {
        return refused(Refusal::NoSudo);
    }
    if has(&["must have a tty", "terminal is required", "no tty present"]) {
        return refused(Refusal::NeedsTty);
    }
    if has(&["is not allowed to execute"]) {
        return refused(Refusal::CommandRefused);
    }
    if has(&["not in the sudoers", "may not run sudo"]) {
        return refused(Refusal::NotAllowed);
    }
    if has(&[
        "account has expired",
        "account validation failure",
        "account is locked",
        "account locked",
        "failed logins",
        "consecutive login failures",
    ]) {
        return refused(Refusal::AccountLocked);
    }
    if has(&[
        "password has expired",
        "password is expired",
        "change your password",
    ]) {
        return refused(Refusal::PasswordExpired);
    }
    if has(&["a password is required"]) {
        return AppError::SudoPasswordRequired(Tried::Nothing);
    }
    if with_password
        && has(&[
            "incorrect password",
            "try again",
            "no password was provided",
            "authentication failure",
        ])
    {
        return AppError::SudoPasswordRejected;
    }
    refused(Refusal::Other)
}

/// Ask sudo to authenticate: `Ok` when it agrees, its answer otherwise. The
/// password, when there is one, goes over stdin and nowhere else.
pub async fn check<H: client::Handler>(
    handle: &Handle<H>,
    password: Option<&str>,
) -> AppResult<()> {
    let stdin = password.map(|p| crate::sync::sudo_stdin(Some(p)));
    let stdin: &[u8] = stdin.as_deref().map_or(&[], Vec::as_slice);
    let outcome = exec_on(
        handle,
        check_command(password.is_some()),
        stdin,
        CHECK_SECS,
        None,
    )
    .await?;
    if !outcome.timed_out && outcome.exit_code == 0 {
        return Ok(());
    }
    Err(answer(&outcome, password.is_some()))
}

/// What one session remembers of sudo: the credential it took (none, for
/// NOPASSWD) and which saved passwords it turned down. Dies with the session.
#[derive(Default)]
pub struct SudoMemo {
    taken: Option<(Option<Zeroizing<String>>, Via)>,
    saved_refused: bool,
    login_refused: bool,
}

impl SudoMemo {
    /// The credential sudo took this session, if any.
    pub fn taken(&self) -> Option<(Option<Zeroizing<String>>, Via)> {
        self.taken.clone()
    }

    /// sudo turned the remembered credential down (the password was changed
    /// meanwhile): forget it, and do not offer its saved source again.
    pub fn drop_taken(&mut self) {
        match self.taken.take().map(|(_, via)| via) {
            Some(Via::Saved) => self.saved_refused = true,
            Some(Via::Login) => self.login_refused = true,
            _ => {}
        }
    }

    /// Which saved password sudo already turned down — the more telling one.
    fn tried(&self) -> Tried {
        if self.saved_refused {
            Tried::Saved
        } else if self.login_refused {
            Tried::Login
        } else {
            Tried::Nothing
        }
    }
}

/// The saved passwords sudo may be offered, read only when they are needed.
#[derive(Default)]
pub struct Saved {
    pub sudo: Option<Zeroizing<String>>,
    pub login: Option<Zeroizing<String>>,
}

/// What is known of sudo on a session before any password is tried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Route {
    /// sudo took a credential this session, or wants none.
    Ready { via: Via },
    /// A saved password will be tried: sudo's own (`saved`) or the login's (`login`).
    Saved { from: Via },
    /// sudo wants a password vterm does not have.
    Password { tried: Tried },
    /// sudo will not, whatever the password.
    Refused { why: Refusal, said: String },
}

/// Which saved password goes next, given what sudo turned down. Pure: the order
/// is the contract — sudo's own password first, then the login's, each once.
pub fn next_saved(memo: &SudoMemo, has_saved: bool, has_login: bool) -> Option<Via> {
    if has_saved && !memo.saved_refused {
        Some(Via::Saved)
    } else if has_login && !memo.login_refused {
        Some(Via::Login)
    } else {
        None
    }
}

/// What is known of sudo on this connection, trying no password: what it took
/// before, or `sudo -n -v` — which already says "no rights" on its own.
pub async fn route<H: client::Handler>(
    handle: &Handle<H>,
    memo: &tokio::sync::Mutex<SudoMemo>,
    saved: impl FnOnce() -> (bool, bool),
) -> AppResult<Route> {
    let mut memo = memo.lock().await;
    if let Some((_, via)) = &memo.taken {
        return Ok(Route::Ready { via: *via });
    }
    match check(handle, None).await {
        Ok(()) => {
            memo.taken = Some((None, Via::None));
            Ok(Route::Ready { via: Via::None })
        }
        Err(AppError::SudoPasswordRequired(_)) => {
            let (has_saved, has_login) = saved();
            Ok(match next_saved(&memo, has_saved, has_login) {
                Some(from) => Route::Saved { from },
                None => Route::Password {
                    tried: memo.tried(),
                },
            })
        }
        Err(AppError::SudoRefused { why, said }) => Ok(Route::Refused { why, said }),
        Err(e) => Err(e),
    }
}

/// The password sudo takes on this connection, or why there is none. `typed`
/// is checked first and replaces what was remembered; with nothing typed, the
/// order of the module's doc. Resolves are one at a time per session: two at once
/// would each try a saved password, and each wrong try counts.
pub async fn resolve<H: client::Handler>(
    handle: &Handle<H>,
    memo: &tokio::sync::Mutex<SudoMemo>,
    saved: impl FnOnce() -> Saved,
    typed: Option<Zeroizing<String>>,
) -> AppResult<(Option<Zeroizing<String>>, Via)> {
    let mut memo = memo.lock().await;
    if let Some(pw) = typed.filter(|p| !p.is_empty()) {
        check(handle, Some(&pw)).await?;
        memo.taken = Some((Some(pw.clone()), Via::Typed));
        return Ok((Some(pw), Via::Typed));
    }
    if let Some(taken) = memo.taken.clone() {
        return Ok(taken);
    }
    match check(handle, None).await {
        Ok(()) => {
            memo.taken = Some((None, Via::None));
            return Ok((None, Via::None));
        }
        Err(AppError::SudoPasswordRequired(_)) => {}
        Err(e) => return Err(e),
    }
    let saved = saved();
    while let Some(from) = next_saved(&memo, saved.sudo.is_some(), saved.login.is_some()) {
        let pw = match from {
            Via::Saved => saved.sudo.clone(),
            _ => saved.login.clone(),
        };
        let Some(pw) = pw else { break };
        match check(handle, Some(&pw)).await {
            Ok(()) => {
                memo.taken = Some((Some(pw.clone()), from));
                return Ok((Some(pw), from));
            }
            Err(AppError::SudoPasswordRejected) => {
                if from == Via::Saved {
                    memo.saved_refused = true;
                } else {
                    memo.login_refused = true;
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(AppError::SudoPasswordRequired(memo.tried()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(stderr: &str, exit_code: i32) -> ExecOutcome {
        ExecOutcome {
            stdout: String::new(),
            stderr: stderr.into(),
            exit_code,
            timed_out: false,
        }
    }

    fn why(e: AppError) -> Option<Refusal> {
        match e {
            AppError::SudoRefused { why, .. } => Some(why),
            _ => None,
        }
    }

    /// The words are what sudo 1.9.15 (Ubuntu 24.04, `e2e/sudo`) said under
    /// `LC_ALL=C` to each of the fixture's accounts — `live_sudo` asks them again.
    #[test]
    fn every_answer_of_sudo_is_told_apart() {
        assert!(matches!(
            answer(&said("sudo: a password is required\n", 1), false),
            AppError::SudoPasswordRequired(Tried::Nothing)
        ));
        assert!(matches!(
            answer(
                &said("Sorry, try again.\n\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n", 1),
                true
            ),
            AppError::SudoPasswordRejected
        ));
        assert_eq!(
            why(answer(
                &said("Sorry, user plain may not run sudo on a9d00a8d6f87.\n", 1),
                false
            )),
            Some(Refusal::NotAllowed)
        );
        assert_eq!(
            why(answer(
                &said(
                    "plain is not in the sudoers file.  This incident will be reported.\n",
                    1
                ),
                true
            )),
            Some(Refusal::NotAllowed)
        );
        assert_eq!(
            why(answer(
                &said("Sorry, user limited is not allowed to execute '/usr/bin/cp /a /b' as root on h.\n", 1),
                true
            )),
            Some(Refusal::CommandRefused)
        );
        assert_eq!(
            why(answer(
                &said("sudo: sorry, you must have a tty to run sudo\n", 1),
                true
            )),
            Some(Refusal::NeedsTty)
        );
        assert_eq!(
            why(answer(
                &said("env: 'sudo': No such file or directory\n", 127),
                false
            )),
            Some(Refusal::NoSudo)
        );
        assert_eq!(
            why(answer(
                &said(
                    "sudo: account validation failure, is your account locked?\n",
                    1
                ),
                true
            )),
            Some(Refusal::AccountLocked)
        );
        assert_eq!(
            why(answer(
                &said("You are required to change your password immediately (administrator enforced)\nsudo: Account or password is expired, reset your password and try again\n", 1),
                true
            )),
            Some(Refusal::PasswordExpired)
        );
        let mut slow = said("", -1);
        slow.timed_out = true;
        assert_eq!(why(answer(&slow, true)), Some(Refusal::NoAnswer));
    }

    #[test]
    fn a_try_again_is_a_wrong_password_only_when_one_was_given() {
        assert_eq!(
            why(answer(&said("Sorry, try again.\n", 1), false)),
            Some(Refusal::Other)
        );
    }

    #[test]
    fn what_is_not_recognised_is_reported_as_it_was_said() {
        let e = answer(
            &said("sudo: unable to resolve host box: Name or service not known\nVerification code:\nsudo: pam_google: bad code\n", 1),
            false,
        );
        assert_eq!(e.to_string(), "sudo-refused: other: Verification code:");
        assert_eq!(
            answer(&said("", 3), false).to_string(),
            "sudo-refused: other: exit 3"
        );
    }

    #[test]
    fn the_check_authenticates_ignores_a_ticket_and_runs_nothing() {
        assert_eq!(check_command(true), "env LC_ALL=C sudo -k -S -p '' -v");
        assert_eq!(check_command(false), "env LC_ALL=C sudo -n -v");
    }

    #[test]
    fn saved_passwords_go_sudos_own_first_then_the_logins_each_once() {
        let mut memo = SudoMemo::default();
        assert_eq!(next_saved(&memo, true, true), Some(Via::Saved));
        assert_eq!(next_saved(&memo, false, true), Some(Via::Login));
        assert_eq!(next_saved(&memo, false, false), None);
        memo.saved_refused = true;
        assert_eq!(next_saved(&memo, true, true), Some(Via::Login));
        assert_eq!(memo.tried(), Tried::Saved);
        memo.login_refused = true;
        assert_eq!(next_saved(&memo, true, true), None);
        assert_eq!(
            memo.tried(),
            Tried::Saved,
            "the saved password is the more telling"
        );
    }

    #[test]
    fn a_remembered_password_sudo_turns_down_is_not_offered_again() {
        let mut memo = SudoMemo {
            taken: Some((Some(Zeroizing::new("pw".into())), Via::Login)),
            ..Default::default()
        };
        memo.drop_taken();
        assert!(memo.taken().is_none());
        assert_eq!(next_saved(&memo, false, true), None);
        let mut typed = SudoMemo {
            taken: Some((Some(Zeroizing::new("pw".into())), Via::Typed)),
            ..Default::default()
        };
        typed.drop_taken();
        assert_eq!(next_saved(&typed, true, true), Some(Via::Saved));
    }
}

/// Against a real sshd with real `sudo` (`e2e/sudo`): every account of the fixture
/// answers as `answer` expects, and `resolve` takes the right password in the
/// right order. Ignored:
///
///   docker compose -f e2e/docker-compose.sudo.yml up -d --build --wait
///   cargo test --manifest-path src-tauri/Cargo.toml --lib live_sudo -- --ignored
///   docker compose -f e2e/docker-compose.sudo.yml down
#[cfg(test)]
mod live_sudo {
    use super::*;
    use std::sync::Arc;

    struct AcceptAnyKey;

    impl client::Handler for AcceptAnyKey {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _key: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn connect(user: &str, pass: &str) -> Handle<AcceptAnyKey> {
        let port = std::env::var("VTERM_SUDO_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2224);
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            ("127.0.0.1", port),
            AcceptAnyKey,
        )
        .await
        .expect("the sudo fixture is up (docker compose -f e2e/docker-compose.sudo.yml up)");
        let ok = handle
            .authenticate_password(user, pass)
            .await
            .expect("password auth");
        assert!(ok.success(), "{user} logs in");
        handle
    }

    fn saved(sudo: Option<&str>, login: Option<&str>) -> Saved {
        Saved {
            sudo: sudo.map(|s| Zeroizing::new(s.into())),
            login: login.map(|s| Zeroizing::new(s.into())),
        }
    }

    #[tokio::test]
    #[ignore = "needs the sudo fixture: docker compose -f e2e/docker-compose.sudo.yml up"]
    async fn each_account_answers_as_it_is_read() {
        let memo = tokio::sync::Mutex::new(SudoMemo::default());
        let tester = connect("tester", "testpass").await;
        assert_eq!(
            route(&tester, &memo, || (false, true)).await.unwrap(),
            Route::Saved { from: Via::Login }
        );
        assert!(matches!(
            check(&tester, Some("wrong")).await,
            Err(AppError::SudoPasswordRejected)
        ));
        let nopass = connect("nopass", "nopass").await;
        assert_eq!(
            route(
                &nopass,
                &tokio::sync::Mutex::new(SudoMemo::default()),
                || (false, false)
            )
            .await
            .unwrap(),
            Route::Ready { via: Via::None }
        );
        let plain = connect("plain", "plain").await;
        assert!(matches!(
            route(
                &plain,
                &tokio::sync::Mutex::new(SudoMemo::default()),
                || (true, true)
            )
            .await
            .unwrap(),
            Route::Refused {
                why: Refusal::NotAllowed,
                ..
            }
        ));
        let limited = connect("limited", "limited").await;
        check(&limited, Some("limited"))
            .await
            .expect("a right password, whatever the command");
        let ttyonly = connect("ttyonly", "ttyonly").await;
        assert!(matches!(
            check(&ttyonly, Some("ttyonly")).await,
            Err(AppError::SudoRefused {
                why: Refusal::NeedsTty,
                ..
            })
        ));
    }

    /// The steps of a save as root, in the forms `sync.rs` runs them.
    #[tokio::test]
    #[ignore = "needs the sudo fixture: docker compose -f e2e/docker-compose.sudo.yml up"]
    async fn the_steps_of_a_save_as_root_say_what_stopped_them() {
        use crate::sync::{read_refusal, step_failure, sudo_backup_step, sudo_input, sudo_prefix};
        let run = |pw: Option<&'static str>, inner: String| async move {
            let h = connect(
                if pw == Some("limited") {
                    "limited"
                } else {
                    "nopass"
                },
                pw.unwrap_or("nopass"),
            )
            .await;
            exec_on(
                &h,
                &format!("{} {inner}", sudo_prefix(pw)),
                &sudo_input(pw),
                20,
                None,
            )
            .await
            .unwrap()
        };
        // A right password, a command sudoers does not allow.
        let cp = run(Some("limited"), "cp -- /etc/hostname /tmp/x".into()).await;
        assert!(matches!(
            step_failure(&cp, true),
            AppError::SudoRefused {
                why: Refusal::CommandRefused,
                ..
            }
        ));
        let cat = run(Some("limited"), "cat -- /etc/hostname | head -c 100".into()).await;
        assert!(matches!(
            read_refusal(&cat, true),
            Some(AppError::SudoRefused {
                why: Refusal::CommandRefused,
                ..
            })
        ));
        // The backup step really runs (it is shell syntax: through `sh -c`).
        let path = format!("/tmp/bak-{}", std::process::id());
        let made = run(None, format!("sh -c 'echo x > {path}'")).await;
        assert_eq!(made.exit_code, 0, "{}", made.stderr);
        let backed = run(None, sudo_backup_step(&path)).await;
        assert_eq!(backed.exit_code, 0, "{}", backed.stderr);
        let there = run(None, format!("test -f {path}.bak")).await;
        assert_eq!(there.exit_code, 0, "the .bak copy exists");
        // A new file: nothing to back up, and that is no failure.
        let none = run(None, sudo_backup_step("/tmp/never-there")).await;
        assert_eq!(none.exit_code, 0, "{}", none.stderr);
    }

    #[tokio::test]
    #[ignore = "needs the sudo fixture: docker compose -f e2e/docker-compose.sudo.yml up"]
    async fn resolve_tries_each_saved_password_once_and_remembers_what_worked() {
        let tester = connect("tester", "testpass").await;
        let memo = tokio::sync::Mutex::new(SudoMemo::default());
        // A stale saved sudo password, then the login's — which sudo takes.
        let (pw, via) = resolve(
            &tester,
            &memo,
            || saved(Some("stale"), Some("testpass")),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            (pw.as_deref().map(String::as_str), via),
            (Some("testpass"), Via::Login)
        );
        // Remembered: nothing is read or tried again.
        let (_, again) = resolve(&tester, &memo, || panic!("not read again"), None)
            .await
            .unwrap();
        assert_eq!(again, Via::Login);

        // Both wrong: each tried once, then a password is asked for.
        let fresh = tokio::sync::Mutex::new(SudoMemo::default());
        let e = resolve(&tester, &fresh, || saved(Some("stale"), Some("nope")), None)
            .await
            .unwrap_err();
        assert!(matches!(e, AppError::SudoPasswordRequired(Tried::Saved)));
        let e = resolve(&tester, &fresh, || saved(Some("stale"), Some("nope")), None)
            .await
            .unwrap_err();
        assert!(
            matches!(e, AppError::SudoPasswordRequired(Tried::Saved)),
            "no saved password is tried twice"
        );
        // A typed one replaces all that.
        let (_, typed) = resolve(
            &tester,
            &fresh,
            Saved::default,
            Some(Zeroizing::new("testpass".into())),
        )
        .await
        .unwrap();
        assert_eq!(typed, Via::Typed);
    }
}
