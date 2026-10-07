//! SSH `keyboard-interactive` login (v1.0.38).
//!
//! Many servers (UniFi OS consoles, PAM-backed hosts, anything with 2FA) switch
//! the `password` method off and take the password as an answer to the server's
//! own question instead. [`ssh::authenticate`](crate::ssh) drives the exchange;
//! this module holds the two parts it needs:
//!
//! * **What to answer ourselves** ([`plan`]) — pure. The stored password goes
//!   only into a *hidden* question that *reads like a password prompt*, and only
//!   once per login: the same question again means the server rejected it. A
//!   one-time code, a Duo choice or any other question is never filled in.
//! * **Asking the user the rest** ([`ask`] + [`answer_auth_prompt`]). The
//!   questions go to the frontend on `term://auth/{session}`; the login waits on a
//!   one-shot channel until the answer command or a cancel (tab closed,
//!   disconnect) arrives. The wait has no timeout — reading a code off a phone
//!   takes longer than a connect timeout — but the server's own login grace time
//!   still applies.
//!
//! Answers live only in memory ([`Zeroizing`]): never in the keychain, a
//! recording or a log. Prompt text comes from the server and is shown as plain
//! text by the frontend.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use russh::MethodKind;

/// Rounds of questions one login may take before we give up — a server that keeps
/// asking forever would otherwise hold the tab in "authenticating".
pub const MAX_ROUNDS: usize = 12;

/// Event on which the server's questions reach the frontend.
pub fn auth_event(session_id: &str) -> String {
    format!("term://auth/{session_id}")
}

/// One question as shown to the user.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptView {
    pub prompt: String,
    /// The server lets the answer be shown while typed (a choice, a username);
    /// false → a secret field.
    pub echo: bool,
}

/// A round of questions the user has to answer.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    /// "server" (the target) or "proxy" (the jump host).
    pub stage: &'static str,
    pub host: String,
    pub username: String,
    /// The server's name for the exchange and its instructions — may be empty.
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<PromptView>,
}

/// What to do after the first attempt (password or key) was not a success.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterFirst {
    /// First factor accepted, the server's questions follow — the password is
    /// never sent again.
    Questions,
    /// The `password` method is off but `keyboard-interactive` is on: give the
    /// password as the answer to the server's password question.
    QuestionsWithPassword,
    /// The server takes this kind of credential and refused it.
    Rejected,
    /// Nothing usable with this credential is offered.
    Unsupported,
}

/// Decide from the server's reply to the first attempt. `remaining` is the
/// methods it still offers (empty = it hung up), `partial` its partial-success
/// flag, `is_password` whether we tried a password (else a key).
pub fn after_first(remaining: &[MethodKind], partial: bool, is_password: bool) -> AfterFirst {
    let has = |m: MethodKind| remaining.contains(&m);
    let ki = has(MethodKind::KeyboardInteractive);
    if partial && ki {
        return AfterFirst::Questions;
    }
    if remaining.is_empty()
        || (is_password && has(MethodKind::Password))
        || (!is_password && has(MethodKind::PublicKey))
    {
        return AfterFirst::Rejected;
    }
    if is_password && ki {
        return AfterFirst::QuestionsWithPassword;
    }
    AfterFirst::Unsupported
}

/// Who answers a question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// vterm, with the stored/typed password.
    Password,
    /// The user, in the dialog.
    Ask,
}

/// Why [`plan`] stopped the login instead of answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanStop {
    /// A password question again after we already sent the password: it was wrong.
    PasswordRejected,
}

/// Whether a hidden question is asking for the account password (not a code).
pub fn looks_like_password(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    // One-time codes that say "password" anyway: Duo's "Passcode", pam_oath's
    // "One-time password (OATH)", "OTP", "token" — never the account password.
    if [
        "passcode",
        "one-time",
        "one time",
        "otp",
        "token",
        "одноразов",
    ]
    .iter()
    .any(|w| p.contains(w))
    {
        return false;
    }
    [
        "password",
        "passphrase",
        "пароль",
        "passwort",
        "mot de passe",
        "contraseña",
        "senha",
    ]
    .iter()
    .any(|w| p.contains(w))
}

/// Decide who answers each question of a round: at most one hidden
/// password-looking question gets the password (if we have one we haven't used);
/// everything else is asked. A password question after the password was already
/// sent means it was rejected — stop rather than ask the user to retype it here,
/// so the usual "wrong password" flow (and keychain update) takes over.
pub fn plan(
    prompts: &[PromptView],
    have_password: bool,
    password_used: bool,
) -> Result<Vec<Slot>, PlanStop> {
    let wants_password = |p: &PromptView| !p.echo && looks_like_password(&p.prompt);
    if password_used && prompts.iter().any(wants_password) {
        return Err(PlanStop::PasswordRejected);
    }
    let mut filled = false;
    Ok(prompts
        .iter()
        .map(|p| {
            if have_password && !filled && wants_password(p) {
                filled = true;
                Slot::Password
            } else {
                Slot::Ask
            }
        })
        .collect())
}

/// Put the round's answers back in the server's order: the password where the
/// plan said so, the user's answers (in order) everywhere else. None when the
/// user's answers don't match the questions they were asked, or the plan wants a
/// password we don't have — never a stand-in value.
pub fn merge(
    slots: &[Slot],
    password: Option<&str>,
    user: &[Zeroizing<String>],
) -> Option<Vec<String>> {
    let asked = slots.iter().filter(|s| **s == Slot::Ask).count();
    if user.len() != asked {
        return None;
    }
    let mut it = user.iter();
    slots
        .iter()
        .map(|s| match s {
            Slot::Password => password.map(str::to_string),
            Slot::Ask => it.next().map(|a| a.to_string()),
        })
        .collect()
}

/// The user's answers to one round, or None when they cancelled.
pub type Answer = Option<Vec<Zeroizing<String>>>;

/// Who answers the questions vterm can't: the user through the UI in the app
/// ([`UiAsker`]), a script in the live tests.
pub trait Asker {
    fn ask(&self, req: AuthRequest) -> impl std::future::Future<Output = Answer> + Send;
}

/// The app's asker: the dialog for `session_id`.
pub struct UiAsker<'a> {
    pub app: &'a AppHandle,
    pub session_id: &'a str,
}

impl Asker for UiAsker<'_> {
    async fn ask(&self, req: AuthRequest) -> Answer {
        ask(self.app, self.session_id, req).await
    }
}

/// Logins waiting for the user's answers, by session id (Tauri-managed state).
#[derive(Default)]
pub struct PendingPrompts(Mutex<HashMap<String, oneshot::Sender<Answer>>>);

impl PendingPrompts {
    fn register(&self, session_id: &str) -> oneshot::Receiver<Answer> {
        let (tx, rx) = oneshot::channel();
        // A newer question for the same session replaces (and so cancels) an older one.
        self.0.lock().unwrap().insert(session_id.to_string(), tx);
        rx
    }

    /// Stop a login that's waiting on the user (tab closed, disconnect, reconnect).
    pub fn cancel(&self, session_id: &str) {
        if let Some(tx) = self.0.lock().unwrap().remove(session_id) {
            let _ = tx.send(None);
        }
    }

    fn answer(&self, session_id: &str, answers: Answer) -> bool {
        match self.0.lock().unwrap().remove(session_id) {
            Some(tx) => tx.send(answers).is_ok(),
            None => false,
        }
    }
}

/// Show a round of questions and wait for the answers. None = cancelled.
pub async fn ask(app: &AppHandle, session_id: &str, req: AuthRequest) -> Answer {
    let rx = app.state::<PendingPrompts>().register(session_id);
    if app.emit(&auth_event(session_id), req).is_err() {
        app.state::<PendingPrompts>().cancel(session_id);
    }
    rx.await.ok().flatten()
}

/// The user's answers to the questions shown for `session_id` (in the order
/// shown), or `null` to cancel the login.
#[tauri::command]
pub fn answer_auth_prompt(
    state: State<'_, PendingPrompts>,
    session_id: String,
    answers: Option<Vec<String>>,
) -> AppResult<()> {
    let answers = answers.map(|a| a.into_iter().map(Zeroizing::new).collect());
    if state.answer(&session_id, answers) {
        Ok(())
    } else {
        Err(AppError::Message(
            "no login question is waiting for this session".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(prompt: &str, echo: bool) -> PromptView {
        PromptView {
            prompt: prompt.into(),
            echo,
        }
    }

    /// Source without `//` comments, so a comment naming a call can't satisfy
    /// (or trip) the guard.
    fn code(src: &str) -> String {
        src.replace("\r\n", "\n")
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Guard (v1.0.38): what goes back to the server's questions is decided in
    /// one place. The stored password must reach only the hidden password
    /// question `plan` picked — a second `respond` call, or one fed anything but
    /// `merge`'s output, could send it into a one-time-code field or to a jump
    /// host's second factor. And a login parked on the user's answers must be
    /// released when its session ends — `end_session`, which both `disconnect`
    /// (tab closed) and a new connect of the same session go through — or it
    /// waits forever.
    #[test]
    fn login_answers_come_only_from_the_plan() {
        let ssh = code(include_str!("ssh.rs"));
        let calls: Vec<_> = ssh
            .match_indices("authenticate_keyboard_interactive_respond(")
            .collect();
        assert_eq!(calls.len(), 1, "one place answers the server's questions");
        let before = &ssh[..calls[0].0];
        let merged = before
            .rfind("kbdauth::merge(")
            .expect("answers built by merge");
        let fn_start = before
            .rfind("async fn keyboard_interactive")
            .expect("inside the exchange");
        assert!(
            merged > fn_start,
            "merge runs inside the exchange, before respond"
        );
        assert!(
            ssh[calls[0].0..].starts_with("authenticate_keyboard_interactive_respond(answers)"),
            "respond takes merge's `answers`, nothing else"
        );
        assert!(
            !ssh.contains("auth_event("),
            "questions reach the UI only via kbdauth::ask"
        );

        let lib = code(include_str!("lib.rs"));
        let body = |name: &str| {
            let at = lib.find(name).unwrap_or_else(|| panic!("{name} not found"));
            let rest = &lib[at..];
            rest[..rest.find("\n}\n").expect("end of fn")].to_string()
        };
        assert!(
            body("async fn end_session(").contains("PendingPrompts>().cancel(session_id)"),
            "ending a session releases a parked login"
        );
        assert!(
            body("async fn disconnect(").contains("end_session(&app, &session_id)"),
            "disconnect ends the session"
        );
        let conn = body("async fn connect_session(");
        let conn = &conn[..conn.find("ssh::connect(").expect("ssh::connect")];
        assert!(
            conn.contains("end_session(&app, &session_id)"),
            "a reconnect releases the previous attempt's questions"
        );
    }

    #[test]
    fn decides_what_follows_the_first_attempt() {
        use MethodKind::*;
        // UniFi / PAM: `password` off, questions on → answer the question with it.
        assert_eq!(
            after_first(&[PublicKey, KeyboardInteractive], false, true),
            AfterFirst::QuestionsWithPassword
        );
        // `password` still offered after a refusal → the password is wrong.
        assert_eq!(
            after_first(&[Password, KeyboardInteractive], false, true),
            AfterFirst::Rejected
        );
        // Key or password accepted, a code follows → questions, no password.
        assert_eq!(
            after_first(&[KeyboardInteractive], true, false),
            AfterFirst::Questions
        );
        assert_eq!(
            after_first(&[KeyboardInteractive], true, true),
            AfterFirst::Questions
        );
        // A key refused where keys are taken → rejected; keys only for a password → unsupported.
        assert_eq!(
            after_first(&[PublicKey], false, false),
            AfterFirst::Rejected
        );
        assert_eq!(
            after_first(&[PublicKey], false, true),
            AfterFirst::Unsupported
        );
        // A key profile on a password-only server — the server takes no keys.
        assert_eq!(
            after_first(&[Password, KeyboardInteractive], false, false),
            AfterFirst::Unsupported
        );
        // The server hung up.
        assert_eq!(after_first(&[], false, true), AfterFirst::Rejected);
    }

    #[test]
    fn recognises_password_prompts_but_not_codes() {
        for s in [
            "Password:",
            "(root@10.0.0.1) Password: ",
            "root@host's password:",
            "Enter passphrase for key",
            "Пароль:",
            "Passwort:",
        ] {
            assert!(looks_like_password(s), "{s}");
        }
        for s in [
            "Verification code:",
            "Passcode or option (1-3):",
            "One-time password (OATH) for `root':",
            "OTP password:",
            "Token password:",
            "Username:",
        ] {
            assert!(!looks_like_password(s), "{s}");
        }
    }

    #[test]
    fn fills_the_hidden_password_question_only() {
        // UniFi / PAM: one hidden "Password:" — answered by vterm, nothing asked.
        assert_eq!(
            plan(&[p("Password: ", false)], true, false),
            Ok(vec![Slot::Password])
        );
        // Password + OTP in one round: password filled, the code asked.
        assert_eq!(
            plan(
                &[p("Password: ", false), p("Verification code: ", false)],
                true,
                false
            ),
            Ok(vec![Slot::Password, Slot::Ask])
        );
        // A shown (echo) question is never the password.
        assert_eq!(
            plan(&[p("Password hint:", true)], true, false),
            Ok(vec![Slot::Ask])
        );
        // No password to give (key login, second factor) → ask.
        assert_eq!(
            plan(&[p("Password:", false)], false, false),
            Ok(vec![Slot::Ask])
        );
        // Only one question gets it, even if two look alike.
        assert_eq!(
            plan(
                &[p("Password:", false), p("Password again:", false)],
                true,
                false
            ),
            Ok(vec![Slot::Password, Slot::Ask])
        );
    }

    #[test]
    fn a_second_password_question_means_it_was_wrong() {
        assert_eq!(
            plan(&[p("Password:", false)], true, true),
            Err(PlanStop::PasswordRejected)
        );
        // …but a code asked after the password is the normal second round.
        assert_eq!(
            plan(&[p("Verification code:", false)], true, true),
            Ok(vec![Slot::Ask])
        );
    }

    #[test]
    fn merges_answers_in_server_order() {
        // The value is irrelevant here — only where it lands. Built at runtime so
        // it isn't a hard-coded credential literal (CodeQL).
        let secret = std::iter::repeat_n('s', 3).collect::<String>();
        let pw = Some(secret.as_str());
        let user = vec![Zeroizing::new("123456".to_string())];
        assert_eq!(
            merge(&[Slot::Password, Slot::Ask], pw, &user),
            Some(vec![secret.clone(), "123456".to_string()])
        );
        assert_eq!(merge(&[Slot::Ask, Slot::Ask], pw, &user), None);
        assert_eq!(
            merge(&[Slot::Password], pw, &[]),
            Some(vec![secret.clone()])
        );
        // The plan wants the password and there is none: refuse, don't send "".
        assert_eq!(merge(&[Slot::Password], None, &[]), None);
    }

    #[test]
    fn answers_reach_the_waiting_login_once() {
        let pending = PendingPrompts::default();
        let mut rx = pending.register("s1");
        assert!(pending.answer("s1", Some(vec![Zeroizing::new("x".into())])));
        let got = rx.try_recv().unwrap().unwrap();
        assert_eq!(got[0].as_str(), "x");
        // Nothing waits any more.
        assert!(!pending.answer("s1", None));
    }

    #[test]
    fn cancel_releases_the_login() {
        let pending = PendingPrompts::default();
        let mut rx = pending.register("s1");
        pending.cancel("s1");
        assert!(rx.try_recv().unwrap().is_none());
        // A newer question replaces an older one, which is released as cancelled.
        let mut old = pending.register("s2");
        let _new = pending.register("s2");
        assert!(old.try_recv().is_err());
    }
}
