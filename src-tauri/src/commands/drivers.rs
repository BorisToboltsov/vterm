// The panel drivers (ADR 0005): git, docker, kubectl, the network probes and the
// access check — one dispatcher over the session's transport (principle 3), the
// execution itself in `exec.rs`, each driver's argv policy in its own module.

use crate::error::{AppError, AppResult};
use crate::locks::Locked;
use crate::{
    container, exec, git, kube, netcheck, netprobe, register_cancel, secrets, session_arc, sync,
    AppState,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

/// One driver call (`exec`, ADR 0005): the command line an SSH tab runs, the
/// spawn a local tab makes, and how the run is reported.
struct DriverCall<'a> {
    /// Names the run in a timeout note ("git timed out after 20s").
    label: &'a str,
    remote: String,
    local: exec::Local<'a>,
    timeout_secs: u64,
    /// Why a local tab may not run this argv (the probes' program allowlist).
    local_refusal: Option<String>,
    /// `(tag, command)` written to the session recording — mutating ops only.
    audit: Option<(&'a str, String)>,
}

/// Run a driver command over whichever transport the session has (principle 3):
/// a dedicated exec channel for an SSH tab, a local spawn for a local shell tab.
/// The argv was checked by the driver's policy before it got here.
async fn run_driver(
    state: &State<'_, AppState>,
    session_id: &str,
    call: DriverCall<'_>,
) -> AppResult<exec::ExecOutput> {
    let timeout = call.timeout_secs.max(1);
    if let Ok(session) = session_arc(state, session_id).await {
        let outcome = match call.local.stdin {
            Some(input) => {
                session
                    .exec_captured_stdin(&call.remote, input, timeout)
                    .await?
            }
            None => session.exec_captured(&call.remote, timeout).await?,
        };
        let out = exec::from_remote(outcome, call.label, timeout);
        if let Some((tag, command)) = &call.audit {
            session.record_output(exec::mirror(tag, command, &out).as_bytes());
        }
        return Ok(out);
    }
    if let Some(pty) = state.local_pty(session_id) {
        if let Some(why) = call.local_refusal {
            return Err(AppError::Message(why));
        }
        let out = exec::run_local(call.local, timeout).await?;
        if let Some((tag, command)) = &call.audit {
            pty.record_output(exec::mirror(tag, command, &out).as_bytes());
        }
        return Ok(out);
    }
    Err(AppError::NoSession)
}

/// Run one `git` command in `cwd` for the Git panel (Phase 29). Dispatches by
/// session kind exactly like [`read_shell_history`]: SSH tabs execute remotely
/// on a dedicated exec channel, local shell tabs spawn `git` locally. Argument
/// building and output parsing are pure frontend logic (`git.ts`); this only
/// executes and captures. `timed_out` from the SSH path collapses into a
/// non-zero exit + stderr note so the frontend sees a uniform `ExecOutput`.
/// `mirror` (mutating ops only) audits the command into the active session
/// recording as `[git] $ …` output — never emitted to the live terminal, so the
/// GUI stays clean while the recording keeps a complete audit trail.
#[tauri::command]
pub async fn git_run(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<exec::ExecOutput> {
    git::check_args(&args)?;
    let local_args = git::local_args(&cwd, &args);
    let call = DriverCall {
        label: "git",
        remote: git::ssh_command(&cwd, &args),
        local: exec::Local {
            program: "git",
            args: &local_args,
            env: &[("GIT_TERMINAL_PROMPT", "0")],
            stdin: None,
            missing: exec::Missing::Error,
            timeout_hint: git::TIMEOUT_HINT,
        },
        timeout_secs,
        local_refusal: None,
        audit: mirror.then(|| ("git", format!("git {}", args.join(" ")))),
    };
    run_driver(&state, &session_id, call).await
}

/// Network access check for the Utilities panel (v1.0.36): "can this host reach
/// those ports?". Transport by session presence (principle 3): an SSH tab runs
/// the frontend-built script (`args`, see netcheck.ts) on the server; a local
/// tab answers natively (`netcheck::run_native`) — the one narrow, click-only
/// exception to the offline invariant. Both reply in the same line protocol, so
/// the frontend parses one format. `targets` is what the local side connects to;
/// on SSH the script already embeds them. Not mirrored here: the raw protocol
/// says nothing to a reader — the frontend records the parsed report through
/// [`record_audit`]. `cancel_id` registers the run in the shared cancel map, so
/// `sftp_cancel(cancel_id)` stops it (ADR 0032): the server's script is
/// signalled and its channel closed, a local run starts no further connect.
/// A stopped run answers [`AppError::Cancelled`]. `local_tool` names one of the
/// user's probe tools for a local tab (ADR 0033) — only the name: the argv is
/// `netcheck::LocalTool`'s, never `args`; none means the native connect.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn netcheck_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    targets: Vec<netcheck::NetTarget>,
    connect_timeout_secs: u64,
    timeout_secs: u64,
    cancel_id: String,
    local_tool: Option<String>,
) -> AppResult<exec::ExecOutput> {
    netcheck::validate(&targets).map_err(AppError::Message)?;
    let tool =
        match local_tool.as_deref() {
            None => None,
            Some(name) => Some(netcheck::LocalTool::parse(name).ok_or_else(|| {
                AppError::Message(format!("netcheck: {name} is not a probe tool"))
            })?),
        };
    let cancel = register_cancel(&state, &cancel_id);
    let res = netcheck_exec(
        &state,
        &session_id,
        &args,
        &targets,
        connect_timeout_secs,
        timeout_secs,
        &cancel,
        tool,
    )
    .await;
    state.cancels.locked().remove(&cancel_id);
    res
}

/// The body of [`netcheck_run`], between registering its stop flag and removing it.
#[allow(clippy::too_many_arguments)]
async fn netcheck_exec(
    state: &State<'_, AppState>,
    session_id: &str,
    args: &[String],
    targets: &[netcheck::NetTarget],
    connect_timeout_secs: u64,
    timeout_secs: u64,
    cancel: &AtomicBool,
    tool: Option<netcheck::LocalTool>,
) -> AppResult<exec::ExecOutput> {
    if let Ok(session) = session_arc(state, session_id).await {
        if args.is_empty() {
            return Err(AppError::Message("netcheck: no arguments".into()));
        }
        let timeout = timeout_secs.max(1);
        let outcome = session
            .exec_captured_until(&exec::remote_command(args), timeout, Some(cancel))
            .await?;
        return Ok(exec::from_remote(outcome, "netcheck", timeout));
    }
    let local = state.local_pty(session_id);
    if local.is_some() {
        let timeout = std::time::Duration::from_secs(connect_timeout_secs.clamp(1, 30));
        // Dropping the run on a stop drops its connects in flight as well — and
        // kills a tool's children (`kill_on_drop`).
        let run = async {
            Ok(match tool {
                Some(tool) => netcheck::run_tool(targets, timeout, cancel, tool).await,
                None => netcheck::run_native(targets, timeout, cancel).await,
            })
        };
        let stdout = sync::until_cancelled(run, cancel).await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        return Ok(exec::ExecOutput {
            stdout,
            stderr: String::new(),
            exit_code: 0,
        });
    }
    Err(AppError::NoSession)
}

/// Run one network-diagnostic command for the Utilities panel (Phase 34).
/// Transport by session (INVARIANTS principle 3): on an SSH tab the probe runs
/// on the user's server via a dedicated exec channel, so the traffic originates
/// from that server. On a local tab (ADR 0014) the user's own `curl`/`openssl`
/// is spawned on this machine — only those two programs (`netprobe::
/// local_program_allowed`), only on the user's click, never through a shell.
/// `stdin` feeds the child (closing it), which lets a two-step probe pipe one
/// tool into the next without `sh -c` (Windows has no `sh`). Argument building
/// and output parsing are pure frontend logic; this only executes and captures.
/// A timeout collapses into a non-zero exit + stderr note so the frontend sees a
/// uniform `ExecOutput`. Not mirrored here: the argv carries header values and
/// request bodies, the output whole responses — the frontend records a masked
/// summary of the parsed result through [`record_audit`].
#[tauri::command]
pub async fn probe_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    timeout_secs: u64,
    stdin: Option<String>,
) -> AppResult<exec::ExecOutput> {
    let Some(program) = args.first() else {
        return Err(AppError::Message("probe: no arguments".into()));
    };
    let call = DriverCall {
        label: "probe",
        remote: exec::remote_command(&args),
        local: exec::Local {
            program,
            args: &args[1..],
            env: &[],
            stdin: stdin.as_deref().map(str::as_bytes),
            missing: exec::Missing::Exit127,
            timeout_hint: "",
        },
        timeout_secs,
        local_refusal: (!netprobe::local_program_allowed(program))
            .then(|| format!("probe: {program} is not a local probe tool")),
        audit: None,
    };
    run_driver(&state, &session_id, call).await
}

/// Run one `docker` command for the Docker panel (Phase 35). Dispatches by
/// session kind exactly like [`git_run`]: SSH tabs execute remotely on a
/// dedicated exec channel, local shell tabs spawn `docker` locally. `args[0]` is
/// the program (`docker`), the rest its arguments; argument building and output
/// parsing are pure frontend logic (`docker.ts`), this only executes and
/// captures. A timeout collapses into a non-zero exit + stderr note so the
/// frontend sees a uniform `ExecOutput`. `mirror` (mutating ops only, set by
/// the frontend) audits the command into the active session recording as
/// `[docker] $ …` output — never emitted to the live terminal, exactly like
/// `git_run`. Reads/polls pass `mirror = false`; registry login goes through the
/// dedicated `docker_login` (secret on stdin) and is never mirrored.
#[tauri::command]
pub async fn container_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<exec::ExecOutput> {
    container::check_args(&args)?;
    let call = DriverCall {
        label: "docker",
        remote: exec::remote_command(&args),
        local: exec::Local {
            program: &args[0],
            args: &args[1..],
            env: &[],
            stdin: None,
            missing: exec::Missing::Exit127,
            timeout_hint: "",
        },
        timeout_secs,
        local_refusal: None,
        audit: mirror.then(|| ("docker", args.join(" "))),
    };
    run_driver(&state, &session_id, call).await
}

/// Store a Docker registry password in the OS keychain, keyed by registry url
/// (Phase 36). The non-secret half (url + username) lives in frontend settings;
/// the password is only ever here and fed to `docker login --password-stdin`.
#[tauri::command]
pub fn set_registry_secret(url: String, secret: String) -> AppResult<()> {
    let secret = zeroize::Zeroizing::new(secret);
    secrets::set_registry_password(&url, &secret)
}

/// Forget a stored Docker registry password (Phase 36).
#[tauri::command]
pub fn delete_registry_secret(url: String) -> AppResult<()> {
    secrets::delete_registry_password(&url)
}

/// Log the session's docker into a registry (Phase 36). Reads the password from
/// the keychain (never crossing the JS boundary at login time) and feeds it to
/// `docker login --password-stdin` so it never appears on a command line, in
/// `ps`, or in the recording. Dispatches by session kind like `container_run`;
/// the network call originates from the user's host, keeping the offline
/// invariant intact. `args` is built by the frontend (`docker.ts loginArgs`).
#[tauri::command]
pub async fn docker_login(
    state: State<'_, AppState>,
    session_id: String,
    url: String,
    args: Vec<String>,
) -> AppResult<exec::ExecOutput> {
    container::check_login_args(&args)?;
    let Some(secret) = secrets::get_registry_password(&url) else {
        return Err(AppError::Message(
            "no saved password for this registry".into(),
        ));
    };
    let call = DriverCall {
        label: "docker login",
        remote: exec::remote_command(&args),
        local: exec::Local {
            program: &args[0],
            args: &args[1..],
            env: &[],
            stdin: Some(secret.as_bytes()),
            missing: exec::Missing::Error,
            timeout_hint: "",
        },
        timeout_secs: 30,
        local_refusal: None,
        // Never mirrored: a registry login, its secret on stdin.
        audit: None,
    };
    run_driver(&state, &session_id, call).await
}

/// Run one `kubectl` command for the Kubernetes panel (Phase 37). Dispatches by
/// session kind exactly like [`container_run`]: SSH tabs execute remotely on a
/// dedicated exec channel, local shell tabs spawn `kubectl` locally. `args` is a
/// full argv whose leading token(s) are the program (`kubectl`, or a configured
/// wrapper like `k3s kubectl`) with the `--context`/`--namespace`/`-A` scope
/// already baked in by the frontend (`k8s.ts`); argument building and output
/// parsing are pure frontend logic, this only executes and captures. A timeout
/// collapses into a non-zero exit + stderr note so the frontend sees a uniform
/// `ExecOutput`. `mirror` (mutating ops only, set by the frontend) audits the
/// command into the active session recording as `[k8s] $ …` output — never
/// emitted to the live terminal, exactly like `container_run`. Reads/polls pass
/// `mirror = false`.
#[tauri::command]
pub async fn kubectl_run(
    state: State<'_, AppState>,
    session_id: String,
    args: Vec<String>,
    timeout_secs: u64,
    mirror: bool,
) -> AppResult<exec::ExecOutput> {
    kube::check_args(&args)?;
    let call = DriverCall {
        label: "kubectl",
        remote: exec::remote_command(&args),
        local: exec::Local {
            program: &args[0],
            args: &args[1..],
            env: &[],
            stdin: None,
            missing: exec::Missing::Exit127,
            timeout_hint: "",
        },
        timeout_secs,
        local_refusal: None,
        audit: mirror.then(|| ("k8s", args.join(" "))),
    };
    run_driver(&state, &session_id, call).await
}
