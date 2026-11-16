// Scenarios commands of the bridge layer (ADR 0071): a recipe run on a session,
// the checks of an Ansible or Terraform project, and the temporary folder of a
// run on the host where the project lies — all over whichever transport the
// session has (principle 3). The pure parts — the recipe wrapper, the policy,
// the commands an SSH tab runs — are `scenarios.rs`'s.

use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::scenarios::{self, Elevation, TempChunk, TempFile};
use crate::{exec, register_cancel, session_arc, AppState};
use tauri::State;

/// Run a recipe on an SSH session: the script on stdin (with the session's sudo
/// password's line before it when `elevation` asks for one), through the fixed
/// wrapper of `scenarios::run_command`. `name` and `mode` only label the run
/// for the recording and the diagnostics — the script itself is never written
/// anywhere. `sftp_cancel(cancel_id)` stops it. A local tab runs no recipe:
/// a recipe is for the servers of the catalog.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn recipe_run(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    mode: String,
    script: String,
    elevation: Elevation,
    timeout_secs: u64,
    cancel_id: String,
) -> AppResult<exec::ExecOutput> {
    let session = session_arc(&state, &session_id).await?;
    // sudo with a password: the session's (ADR 0073) — typed into the run's form
    // and given to `sudo_check` first, saved, or the login's. sudo that wants
    // none runs the recipe as `sudo -n`.
    let (elevation, password) = if elevation == Elevation::SudoPassword {
        match super::sudo::sudo_password(&state, &session_id, &session).await? {
            Some(pw) => (Elevation::SudoPassword, Some(pw)),
            None => (Elevation::Sudo, None),
        }
    } else {
        (elevation, None)
    };
    let stdin = scenarios::run_stdin(elevation, password.as_deref().map(String::as_str), &script)?;
    let timeout = timeout_secs.clamp(1, scenarios::MAX_RUN_SECS);
    let cancel = register_cancel(&state, &cancel_id);
    let started = std::time::Instant::now();
    tracing::info!(
        source = "scenarios",
        code = "recipe-started",
        sid = %session_id,
        recipe = %name,
        mode = %mode,
        elevation = ?elevation,
        "recipe run started"
    );
    let res = session
        .exec_captured_stdin_until(&scenarios::run_command(elevation), &stdin, timeout, &cancel)
        .await;
    state.cancels.locked().remove(&cancel_id);
    let ms = started.elapsed().as_millis() as u64;
    match res {
        Ok(outcome) => {
            let out = exec::from_remote(outcome, "recipe", timeout);
            // The recording keeps what ran and what it answered — the name, not
            // the script: its parameters may carry a value the person typed.
            session.record_output(
                exec::mirror("script", &format!("{name} · {mode}"), &out).as_bytes(),
            );
            if out.exit_code == 0 || (mode == "check" && out.exit_code == 1) {
                tracing::info!(
                    source = "scenarios",
                    code = "recipe-ended",
                    sid = %session_id,
                    recipe = %name,
                    mode = %mode,
                    exit = out.exit_code,
                    ms,
                    "recipe run ended"
                );
            } else {
                tracing::warn!(
                    source = "scenarios",
                    code = "recipe-failed",
                    sid = %session_id,
                    recipe = %name,
                    mode = %mode,
                    exit = out.exit_code,
                    ms,
                    "recipe run failed: the server answered exit {}",
                    out.exit_code
                );
            }
            Ok(out)
        }
        Err(AppError::Cancelled) => {
            tracing::info!(source = "scenarios", sid = %session_id, recipe = %name, ms, "recipe run stopped");
            session.record_output(
                exec::mirror(
                    "script",
                    &format!("{name} · {mode}"),
                    &exec::ExecOutput {
                        stdout: String::new(),
                        stderr: "stopped".into(),
                        exit_code: 130,
                    },
                )
                .as_bytes(),
            );
            Err(AppError::Cancelled)
        }
        Err(e) => {
            tracing::warn!(source = "scenarios", sid = %session_id, recipe = %name, ms, "recipe run failed: {e}");
            Err(e)
        }
    }
}

/// One check of an Ansible or Terraform project (ADR 0071): what it is, never
/// running it — the policy lets through `--version`s, the inventory as JSON,
/// the installed collections and a saved plan as JSON. `config` is the
/// project's `ansible.cfg`, when it has one: relative paths in it are read
/// against its folder.
#[tauri::command]
pub async fn iac_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    config: Option<String>,
    timeout_secs: u64,
) -> AppResult<exec::ExecOutput> {
    exec::policy("iac", &args, scenarios::check_iac_args(&args))?;
    let env = scenarios::iac_env(config.as_deref())?;
    let timeout = timeout_secs.clamp(1, 120);
    let started = std::time::Instant::now();
    let out = if let Ok(session) = session_arc(&state, &session_id).await {
        let outcome = session
            .exec_captured(&scenarios::iac_remote_command(&env, &args), timeout)
            .await?;
        exec::from_remote(outcome, &args[0], timeout)
    } else if state.local_pty(&session_id).is_some() {
        let pairs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        exec::run_local(
            exec::Local {
                program: &args[0],
                args: &args[1..],
                env: &pairs,
                stdin: None,
                missing: exec::Missing::Exit127,
                timeout_hint: "",
                cwd: None,
            },
            timeout,
        )
        .await?
    } else {
        return Err(AppError::NoSession);
    };
    tracing::debug!(
        source = "scenarios",
        sid = %session_id,
        command = %args.join(" "),
        exit = out.exit_code,
        ms = started.elapsed().as_millis() as u64,
        "project check ran"
    );
    Ok(out)
}

/// Make the temporary folder of a run on the session's host and write `files`
/// into it (the event collector of Ansible, an inventory from the catalog):
/// private to the user, removed by `iac_cleanup`. Its path.
#[tauri::command]
pub async fn iac_temp(
    state: State<'_, AppState>,
    session_id: String,
    files: Vec<TempFile>,
) -> AppResult<String> {
    for f in &files {
        scenarios::temp_file_name(&f.name)?;
        if f.text.len() > scenarios::MAX_TEMP_FILE {
            return Err(AppError::Message(format!("{} is too large", f.name)));
        }
    }
    let dir = if let Ok(session) = session_arc(&state, &session_id).await {
        let made = session.exec_captured(scenarios::REMOTE_MKTEMP, 15).await?;
        let dir = made.stdout.trim().to_string();
        if made.exit_code != 0 || !scenarios::is_temp_path(&dir) {
            tracing::warn!(source = "scenarios", sid = %session_id, exit = made.exit_code, "the folder of a run was not made on the server");
            return Err(AppError::Message(format!(
                "the folder of the run was not made on the server: {}",
                made.stderr.trim()
            )));
        }
        for f in &files {
            let path = format!("{dir}/{}", f.name);
            let wrote = session
                .exec_captured_stdin(&scenarios::remote_write(&path), f.text.as_bytes(), 15)
                .await?;
            if wrote.exit_code != 0 {
                return Err(AppError::Message(format!(
                    "{} was not written on the server",
                    f.name
                )));
            }
        }
        dir
    } else if state.local_pty(&session_id).is_some() {
        let dir = scenarios::local_mktemp()?;
        for f in &files {
            scenarios::local_write(&dir, f)?;
        }
        dir.to_string_lossy().into_owned()
    } else {
        return Err(AppError::NoSession);
    };
    tracing::debug!(source = "scenarios", sid = %session_id, files = files.len(), "the folder of a run was made");
    Ok(dir)
}

/// Read a file of a run's temporary folder from `offset`: the events Ansible
/// wrote so far, a saved plan's presence. Only a file of such a folder.
#[tauri::command]
pub async fn iac_read(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    offset: u64,
) -> AppResult<TempChunk> {
    if !scenarios::is_temp_path(&path) {
        return Err(AppError::Message(format!("not a file of a run: {path}")));
    }
    if let Ok(session) = session_arc(&state, &session_id).await {
        let out = session
            .exec_captured(&scenarios::remote_read(&path, offset), 15)
            .await?;
        return scenarios::parse_remote_read(out.exit_code, &out.stdout);
    }
    if state.local_pty(&session_id).is_some() {
        return scenarios::local_read(std::path::Path::new(&path), offset);
    }
    Err(AppError::NoSession)
}

/// Remove a run's temporary folder: the events (task results may hold a value
/// of the servers), the inventory, a saved plan (it holds the secrets of the
/// infrastructure). A folder that is not one is refused.
#[tauri::command]
pub async fn iac_cleanup(
    state: State<'_, AppState>,
    session_id: String,
    dir: String,
) -> AppResult<()> {
    if !scenarios::is_temp_path(&dir) {
        return Err(AppError::Message(format!("not the folder of a run: {dir}")));
    }
    if let Ok(session) = session_arc(&state, &session_id).await {
        let out = session
            .exec_captured(&scenarios::remote_cleanup(&dir), 15)
            .await?;
        if out.exit_code != 0 {
            tracing::warn!(source = "scenarios", sid = %session_id, exit = out.exit_code, "the folder of a run was not removed from the server");
            return Err(AppError::Message(
                "the folder of the run was not removed".into(),
            ));
        }
        return Ok(());
    }
    if state.local_pty(&session_id).is_some() {
        let p = std::path::Path::new(&dir);
        if !scenarios::local_removable(p) {
            return Err(AppError::Message(format!("not the folder of a run: {dir}")));
        }
        return std::fs::remove_dir_all(p)
            .map_err(|e| AppError::Message(format!("remove the folder of the run: {e}")));
    }
    Err(AppError::NoSession)
}
