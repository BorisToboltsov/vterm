// Editor commands of the bridge layer (ADR 0076): formatting a buffer with the
// project's own tool where the file lives — over SSH in the file's folder, or on
// this computer for a local tab (principle 3). The policy and the command shape
// are `format.rs`'s; this file only runs them.

use crate::diag::{Logged, Unheard};
use crate::error::AppResult;
use crate::format::{self, FormatRun};
use crate::{exec, session_arc, sftp, uuid_like, AppState};
use tauri::State;

/// Format `content` with `argv` (built by `format.ts`, checked here first) in
/// `dir`, where the file lives: on the session's server, or — `session_id`
/// absent — on this computer (a local file, whichever tab shows it). A program that is not installed comes back as
/// `found: false`, not as an error: the editor offers to install it.
/// `ansible-lint --fix` works on a hidden copy beside the file (`name` gives its
/// extension) and answers with the copy as it was left.
#[tauri::command]
pub async fn format_run(
    state: State<'_, AppState>,
    session_id: Option<String>,
    argv: Vec<String>,
    dir: String,
    name: String,
    content: String,
) -> AppResult<FormatRun> {
    exec::policy("format", &argv, format::check_args(&argv))?;
    format::check_dir(&dir)?;
    let started = std::time::Instant::now();
    let session = match &session_id {
        Some(sid) => Some(session_arc(&state, sid).await?),
        None => None,
    };
    let run = if let Some(session) = session {
        if format::is_fixer(&argv) {
            fix_remote(&session, &argv, &dir, &name, &content).await?
        } else {
            let outcome = session
                .exec_captured_stdin(
                    &format::remote_command(&dir, &argv),
                    content.as_bytes(),
                    format::FORMAT_TIMEOUT,
                )
                .await?;
            run_of(
                outcome.stdout,
                outcome.stderr,
                outcome.exit_code,
                outcome.timed_out,
            )
        }
    } else {
        if format::is_fixer(&argv) {
            fix_local(&argv, &dir, &name, &content).await?
        } else {
            let out = exec::run_local(
                exec::Local {
                    program: &argv[0],
                    args: &argv[1..],
                    env: &[],
                    stdin: Some(content.as_bytes()),
                    missing: exec::Missing::Exit127,
                    timeout_hint: "",
                    cwd: Some(&dir),
                },
                format::FORMAT_TIMEOUT,
            )
            .await?;
            run_of(out.stdout, out.stderr, out.exit_code, false)
        }
    };
    tracing::debug!(
        source = "editor",
        sid = %session_id.as_deref().unwrap_or("local"),
        tool = %argv[0],
        found = run.found,
        exit = run.code,
        ms = started.elapsed().as_millis() as u64,
        "formatter ran"
    );
    Ok(run)
}

fn run_of(stdout: String, stderr: String, code: i32, timed_out: bool) -> FormatRun {
    if timed_out {
        return FormatRun {
            found: true,
            stdout: String::new(),
            stderr: format!("timed out after {}s", format::FORMAT_TIMEOUT),
            code: -1,
        };
    }
    FormatRun {
        found: !format::not_found(code, &stderr),
        stdout,
        stderr,
        code,
    }
}

/// The fixer's argv with what the backend adds: no colour, quiet, the copy.
fn fixer_argv(argv: &[String], copy: &str) -> Vec<String> {
    let mut a = argv.to_vec();
    a.push("--nocolor".into());
    a.push(copy.into());
    a
}

async fn fix_remote(
    session: &crate::ssh::SshSession,
    argv: &[String],
    dir: &str,
    name: &str,
    content: &str,
) -> AppResult<FormatRun> {
    let sftp = session.sftp().await?;
    let copy = format::fixer_copy(dir, name, &uuid_like());
    sftp::write_bytes(&sftp, &copy, content.as_bytes()).await?;
    let outcome = session
        .exec_captured(
            &format::remote_command(dir, &fixer_argv(argv, &copy)),
            format::FIX_TIMEOUT,
        )
        .await;
    let fixed = sftp::read_text(&sftp, &copy, 64 * 1024 * 1024).await;
    sftp.remove_file(copy.clone()).await.log_warn(
        "editor",
        "the working copy of ansible-lint --fix was not removed and stays beside the file",
    );
    let outcome = outcome?;
    let mut run = run_of(
        String::new(),
        format!("{}{}", outcome.stdout, outcome.stderr),
        outcome.exit_code,
        outcome.timed_out,
    );
    if run.found {
        run.stdout = fixed?.content;
    }
    Ok(run)
}

async fn fix_local(argv: &[String], dir: &str, name: &str, content: &str) -> AppResult<FormatRun> {
    let copy = format::fixer_copy(dir, name, &uuid_like());
    tokio::fs::write(&copy, content.as_bytes())
        .await
        .map_err(|e| format!("the working copy was not written: {e}"))?;
    let full = fixer_argv(argv, &copy);
    let out = exec::run_local(
        exec::Local {
            program: &full[0],
            args: &full[1..],
            env: &[],
            stdin: None,
            missing: exec::Missing::Exit127,
            timeout_hint: "",
            cwd: Some(dir),
        },
        format::FIX_TIMEOUT,
    )
    .await;
    let fixed = tokio::fs::read_to_string(&copy).await;
    tokio::fs::remove_file(&copy).await.log_warn(
        "editor",
        "the working copy of ansible-lint --fix was not removed and stays beside the file",
    );
    let out = out?;
    let mut run = run_of(
        String::new(),
        format!("{}{}", out.stdout, out.stderr),
        out.exit_code,
        false,
    );
    if run.found {
        run.stdout = fixed.map_err(|e| format!("the working copy was not read back: {e}"))?;
    }
    Ok(run)
}

// ── Language servers (ADR 0079) ─────────────────────────────────────────────

/// What `lsp_start` answers: the running server's id, or that it is not installed.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LspStart {
    pub id: Option<String>,
    pub found: bool,
}

/// What `lsp://closed/{id}` carries: how the server ended.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LspClosed {
    pub code: Option<i32>,
    /// It ended because it was asked to (the editor closed, the tab went).
    pub asked: bool,
}

/// Start the catalogue's `server` in the project folder `root`: on the session's
/// server, or — `local` — on this computer (a local file of the tab). It lives as
/// long as the tab's session (`end_session` stops it) or until `lsp_stop`. Its
/// messages arrive on `lsp://msg/{id}`, its end on `lsp://closed/{id}`.
#[tauri::command]
pub async fn lsp_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local: bool,
    server: String,
    root: String,
) -> AppResult<LspStart> {
    use tauri::Manager;
    let Some(spec) = crate::lsp::server(&server) else {
        tracing::warn!(source = "editor", server = %server, "a language server outside the catalogue was asked for");
        return Err(format!("unknown language server: {server}").into());
    };
    crate::lsp::check_root(&root)?;
    let id = uuid_like();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let started = std::time::Instant::now();
    if local {
        // A local file's server still belongs to its tab: the tab's end stops it.
        if session_arc(&state, &session_id).await.is_err() && state.local_pty(&session_id).is_none()
        {
            return Err(crate::error::AppError::NoSession);
        }
        let (resolved, path) = crate::localenv::resolved_local(spec.program).await;
        let mut cmd = tokio::process::Command::new(&resolved);
        cmd.args(spec.args)
            .env("PATH", &path)
            .current_dir(&root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        crate::localenv::no_console_window(&mut cmd);
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LspStart {
                    id: None,
                    found: false,
                })
            }
            Err(e) => return Err(format!("{} did not start: {e}", spec.program).into()),
        };
        app.state::<crate::lsp::Lsps>()
            .insert(id.clone(), session_id.clone(), tx);
        tokio::spawn(run_local(
            app.clone(),
            id.clone(),
            child,
            rx,
            started,
            spec.id,
        ));
    } else {
        let session = session_arc(&state, &session_id).await?;
        let chk = session
            .run_command(&crate::lsp::check_command(spec))
            .await
            .unwrap_or_default();
        if !chk.contains("__VTERM_OK__") {
            return Ok(LspStart {
                id: None,
                found: false,
            });
        }
        let channel = session
            .exec_channel(&crate::lsp::remote_command(&root, spec))
            .await?;
        app.state::<crate::lsp::Lsps>()
            .insert(id.clone(), session_id.clone(), tx);
        tokio::spawn(run_remote(
            app.clone(),
            id.clone(),
            channel,
            rx,
            started,
            spec.id,
        ));
    }
    tracing::info!(source = "editor", sid = %session_id, server = spec.id, root = %root, local, "language server started");
    Ok(LspStart {
        id: Some(id),
        found: true,
    })
}

/// Hand one JSON-RPC message to a running server.
#[tauri::command]
pub fn lsp_send(app: tauri::AppHandle, id: String, message: String) -> AppResult<()> {
    use tauri::Manager;
    if app.state::<crate::lsp::Lsps>().send(&id, &message) {
        Ok(())
    } else {
        Err("the language server is not running".into())
    }
}

/// Stop a server (the last editor of its folder closed).
#[tauri::command]
pub fn lsp_stop(app: tauri::AppHandle, id: String) {
    use tauri::Manager;
    app.state::<crate::lsp::Lsps>().stop(&id);
}

fn emit_messages(app: &tauri::AppHandle, id: &str, msgs: Vec<String>) {
    use tauri::Emitter;
    for m in msgs {
        app.emit(&crate::lsp::message_event(id), m).log_unheard(
            "editor",
            "a language server's message was sent to the windows",
        );
    }
}

fn ended(
    app: &tauri::AppHandle,
    id: &str,
    server: &str,
    code: Option<i32>,
    asked: bool,
    started: std::time::Instant,
    why: Option<String>,
) {
    use tauri::{Emitter, Manager};
    app.state::<crate::lsp::Lsps>().forget(id);
    let ms = started.elapsed().as_millis() as u64;
    match why {
        Some(w) => tracing::warn!(
            source = "editor",
            server,
            ms,
            "a language server was stopped: {w}"
        ),
        None if asked => tracing::info!(source = "editor", server, ms, "language server stopped"),
        None => tracing::warn!(
            source = "editor",
            server,
            code,
            ms,
            "a language server ended by itself: the editor lost its hints"
        ),
    }
    app.emit(&crate::lsp::closed_event(id), LspClosed { code, asked })
        .log_unheard(
            "editor",
            "the end of a language server was sent to the windows",
        );
}

async fn run_remote(
    app: tauri::AppHandle,
    id: String,
    channel: russh::Channel<russh::client::Msg>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<crate::lsp::Input>,
    started: std::time::Instant,
    server: &'static str,
) {
    use russh::ChannelMsg;
    let (mut read, write) = channel.split();
    let mut framer = crate::lsp::Framer::default();
    let mut code = None;
    let mut asked = false;
    let mut why = None;
    loop {
        tokio::select! {
            input = rx.recv() => match input {
                Some(crate::lsp::Input::Message(bytes)) => {
                    if let Err(e) = write.data_bytes(bytes).await {
                        why = Some(format!("its input was not written: {e}"));
                        break;
                    }
                }
                Some(crate::lsp::Input::Stop) | None => {
                    asked = true;
                    write.eof().await.log_debug("editor", "the end of a language server's input was not sent");
                    write.close().await.log_debug("editor", "a language server's channel was not closed");
                    break;
                }
            },
            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) => match framer.push(&data) {
                    Ok(msgs) => emit_messages(&app, &id, msgs),
                    Err(e) => {
                        why = Some(e);
                        write.close().await.log_debug("editor", "a language server's channel was not closed");
                        break;
                    }
                },
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }
    ended(&app, &id, server, code, asked, started, why);
}

async fn run_local(
    app: tauri::AppHandle,
    id: String,
    mut child: tokio::process::Child,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<crate::lsp::Input>,
    started: std::time::Instant,
    server: &'static str,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
        ended(
            &app,
            &id,
            server,
            None,
            false,
            started,
            Some("its pipes were not opened".into()),
        );
        return;
    };
    let mut framer = crate::lsp::Framer::default();
    let mut buf = vec![0u8; 64 * 1024];
    let mut asked = false;
    let mut why = None;
    loop {
        tokio::select! {
            input = rx.recv() => match input {
                Some(crate::lsp::Input::Message(bytes)) => {
                    if let Err(e) = stdin.write_all(&bytes).await {
                        why = Some(format!("its input was not written: {e}"));
                        break;
                    }
                }
                Some(crate::lsp::Input::Stop) | None => {
                    asked = true;
                    break;
                }
            },
            n = stdout.read(&mut buf) => match n {
                Ok(0) => break,
                Ok(n) => match framer.push(&buf[..n]) {
                    Ok(msgs) => emit_messages(&app, &id, msgs),
                    Err(e) => {
                        why = Some(e);
                        break;
                    }
                },
                Err(e) => {
                    why = Some(format!("its output was not read: {e}"));
                    break;
                }
            },
        }
    }
    drop(stdin);
    if asked || why.is_some() {
        child.kill().await.log_debug(
            "editor",
            "a language server was not killed: it ends with the app",
        );
    }
    let code = child.wait().await.ok().and_then(|s| s.code());
    ended(&app, &id, server, code, asked, started, why);
}
