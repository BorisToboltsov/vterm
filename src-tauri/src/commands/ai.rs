// AI assistant commands of the bridge layer (ADR 0006): the endpoint keys in the
// keychain and the dialog loop's executor. The chat broker itself lives in `ai.rs`.

use crate::error::{AppError, AppResult};
use crate::{ai, secrets, session_arc, AppState};
use tauri::State;

/// Store an AI endpoint's API key in the keychain (Phase 17). Never logged.
#[tauri::command]
pub fn set_ai_key(endpoint_id: String, key: String) -> AppResult<()> {
    secrets::set_ai_key(&endpoint_id, &key)
}

/// Forget an AI endpoint's API key (on key clear or endpoint removal).
#[tauri::command]
pub fn forget_ai_key(endpoint_id: String) -> AppResult<()> {
    secrets::delete_ai_key(&endpoint_id)
}

/// Result of an AI agent command execution (17.8), returned to the dialog loop.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
}

/// Execute a single command for the AI dialog/agent loop (17.8) on a dedicated
/// exec channel, capturing stdout/stderr/exit code. The step is mirrored into the
/// live terminal (`term://out`) and the active recording so the agent's actions
/// stay visible and audited. SSH sessions only; the frontend gates this by mode
/// and bars it on prod/`noAi` servers.
#[tauri::command]
pub async fn ai_exec(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_secs: u64,
) -> AppResult<AiExecResult> {
    let session = session_arc(&state, &session_id).await?;
    // The dialog modes never run on a prod or AI-disabled server. The frontend
    // gates them; the backend holds the same line (the WebView is a trust
    // boundary), reading the server's current profile.
    match state.session_server(&session_id) {
        Some(server) if server.ai_exec_allowed() => {}
        _ => {
            // The frontend does not ask this — a refusal here is the boundary
            // holding against a page that did (ADR 0036).
            tracing::warn!(
                source = "ai",
                code = "ai-exec-refused",
                sid = %session_id,
                "assistant command refused: prod or AI disabled"
            );
            return Err(AppError::Message(
                "AI commands do not run on this server (prod or AI disabled)".into(),
            ));
        }
    }
    let started = std::time::Instant::now();
    let outcome = session.exec_captured(&command, timeout_secs).await?;
    // The command itself is kept by the recording and shown in the terminal;
    // the diagnostics keep that it ran and how it ended.
    tracing::info!(
        source = "ai",
        code = "ai-exec",
        sid = %session_id,
        exit = outcome.exit_code,
        timed_out = outcome.timed_out,
        ms = started.elapsed().as_millis() as u64,
        "assistant ran a command"
    );

    // Mirror the step into the live terminal + recording so it stays visible + audited.
    let mirror = ai::agent_mirror(
        &command,
        &outcome.stdout,
        &outcome.stderr,
        outcome.exit_code,
        outcome.timed_out,
        timeout_secs,
    );
    session.gate().output(mirror.clone().into_bytes());
    session.record_output(mirror.as_bytes());

    Ok(AiExecResult {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
    })
}
