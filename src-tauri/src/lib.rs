mod ai;
mod appwin;
mod backup;
mod commands;
mod container;
mod dragghost;
mod dragout;
mod drives;
mod error;
mod exec;
mod folders;
mod git;
mod kbdauth;
mod keygen;
mod kube;
mod localenv;
mod localfile;
mod locks;
mod metrics;
mod model;
mod netcheck;
mod netprobe;
mod outgate;
mod proccwd;
mod pty;
mod recording;
mod secrets;
mod servers;
mod servertools;
mod sftp;
mod ssh;
mod store;
mod sync;
mod textenc;
mod transfers;
mod update_helper;
mod update_protocol;
mod updater;
mod webview2;
mod winhit;

use error::{AppError, AppResult};

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::locks::Locked;
use model::ServerProfile;
use ssh::SshSession;
use tauri::{AppHandle, Emitter, Manager, State};

/// Application state: persisted server profiles + the registry of live SSH sessions.
#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) servers: Mutex<Vec<ServerProfile>>,
    /// Explicit folder paths (incl. empty/nested) for organizing the server list.
    pub(crate) folders: Mutex<Vec<String>>,
    pub(crate) sessions: tokio::sync::Mutex<HashMap<String, Arc<SshSession>>>,
    /// Live local-shell PTYs (the "+" terminal tabs), keyed by session id.
    local_ptys: Mutex<HashMap<String, Arc<pty::LocalPty>>>,
    /// Cancellation flags for in-progress transfers, sync runs and tree hashes,
    /// keyed by transfer / run id.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// The sync run applying right now, app-wide (its run id). One at a time: a
    /// run's progress rows are keyed by path alone, so two runs — in two windows,
    /// since v1.3 — would draw each other's bars.
    sync_run: Mutex<Option<String>>,
    /// Per-session sample stores for the metrics probes (CPU%, throughput, etc.);
    /// see [`metrics::MetricsSamples`]. Cleared on disconnect.
    pub(crate) metrics_samples: metrics::MetricsSamples,
    /// Files vterm was asked to open (CLI args / macOS `Opened`), drained by the
    /// frontend on startup via `take_pending_opens`.
    pending_opens: Mutex<Vec<String>>,
    /// Per-session uid→name / gid→name maps (fetched once from passwd/group), so
    /// the SFTP listing can show owner names like `ls -l`.
    id_names: Mutex<HashMap<String, IdNames>>,
    /// The server each SSH session was opened for (session id → server id): the
    /// backend's own answer to "is this a prod / AI-disabled server" (`ai_exec`),
    /// read against the current profile, not the flags the tab was opened with.
    session_servers: Mutex<HashMap<String, String>>,
}

impl AppState {
    /// The local shell PTY registered under `session_id`, if this is a local tab.
    pub(crate) fn local_pty(&self, session_id: &str) -> Option<Arc<pty::LocalPty>> {
        self.local_ptys.locked().get(session_id).cloned()
    }

    /// The current profile of the server an SSH session was opened for.
    fn session_server(&self, session_id: &str) -> Option<ServerProfile> {
        let server_id = self.session_servers.locked().get(session_id).cloned()?;
        self.servers
            .locked()
            .iter()
            .find(|s| s.id == server_id)
            .cloned()
    }
}

/// (uid→name, gid→name) maps resolved from passwd/group for one session.
type IdNames = (HashMap<u32, String>, HashMap<u32, String>);

/// The gate a session's terminal output goes through (SSH or local), if the
/// session exists — the handle a tab handoff holds the output by (ADR 0017).
pub(crate) async fn session_gate(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Option<Arc<outgate::OutputGate>> {
    if let Some(session) = state.sessions.lock().await.get(session_id) {
        return Some(session.gate().clone());
    }
    let local = state.local_ptys.locked();
    local.get(session_id).map(|pty| pty.gate().clone())
}

/// End a session and drop everything the backend keeps under its id. The one
/// way a session goes: a closed tab (`disconnect`), a replaced one (reconnect)
/// and a destroyed window all come here.
pub(crate) async fn end_session(app: &AppHandle, session_id: &str) {
    let state = app.state::<AppState>();
    // A login still waiting on the user's answers (keyboard-interactive) ends
    // here too — otherwise closing the tab would leave it parked forever.
    app.state::<kbdauth::PendingPrompts>().cancel(session_id);
    // Transfers reading from this session or writing to it stop here: each
    // holds the session open until it notices, and removes what it staged.
    app.state::<transfers::Jobs>().cancel_session(session_id);
    state.sessions.lock().await.remove(session_id);
    // Removing the LocalPty drops it, which kills the child shell.
    state.local_ptys.locked().remove(session_id);
    state.metrics_samples.clear_session(session_id);
    state.id_names.locked().remove(session_id);
    state.session_servers.locked().remove(session_id);
}

/// [`session_arc`] for code that has the app's handle, not a command's state.
pub(crate) async fn session_arc_of(
    app: &AppHandle,
    session_id: &str,
) -> AppResult<Arc<SshSession>> {
    session_arc(&app.state::<AppState>(), session_id).await
}

/// Clone out the session for `session_id`, releasing the registry lock before
/// any network round-trip so other sessions aren't blocked.
pub(crate) async fn session_arc(
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<Arc<SshSession>> {
    state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or(AppError::NoSession)
}

// ── Shared helpers of the bridge layer ──────────────────────────────────────

/// Current unix time in seconds (0 if the clock predates the epoch).
fn now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Put a fresh stop flag for `id` into the shared cancel map (`sftp_cancel` sets it).
/// The caller removes it when the operation ends.
fn register_cancel(state: &AppState, id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.locked().insert(id.to_string(), flag.clone());
    flag
}

/// Tiny unique-id helper so we don't pull in the `uuid` crate yet.
pub(crate) fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("srv-{nanos:x}")
}

/// Treat non-flag CLI arguments as file paths to open in the editor.
fn file_args(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if update_helper::entry() {
        return;
    }
    update_helper::capture_startup();
    if update_helper::replacement_in_progress() {
        return;
    }
    // «Полный» portable несёт WebView2 Runtime в хвосте exe: если системного нет,
    // распаковываем его и указываем загрузчику — до создания окна и рантайма tokio.
    #[cfg(windows)]
    webview2::prepare();

    // Files passed on the command line at first launch (Windows/Linux "open with"
    // gives the path as argv; macOS uses the `Opened` run event below).
    let initial_files = file_args(&std::env::args().collect::<Vec<_>>());

    let state = AppState {
        servers: Mutex::new(store::load_servers()),
        folders: Mutex::new(store::load_folders()),
        sessions: tokio::sync::Mutex::new(HashMap::new()),
        local_ptys: Mutex::new(HashMap::new()),
        cancels: Mutex::new(HashMap::new()),
        sync_run: Mutex::new(None),
        metrics_samples: metrics::MetricsSamples::default(),
        pending_opens: Mutex::new(initial_files),
        id_names: Mutex::new(HashMap::new()),
        session_servers: Mutex::new(HashMap::new()),
    };

    let app = tauri::Builder::default()
        .manage(updater::Updates::default())
        // single-instance must be registered first: a second launch (e.g. another
        // "open with vterm") forwards its file args to the running window instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Files open in the main window — it owns "Open with" (ADR 0017).
            for path in file_args(&argv) {
                let _ = app.emit_to(appwin::MAIN, "vterm://open-file", path);
            }
            if let Some(w) = app.get_webview_window(appwin::MAIN) {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // The window is created hidden (`visible: false`). On Windows/Linux we drop
        // the native decorations here — while still hidden, so no titled frame ever
        // flashes — and the in-window TitleBar takes over the caption + menu. macOS
        // keeps its native title bar and system menu bar untouched. Then show on all
        // platforms.
        .setup(|app| {
            let win = app
                .get_webview_window(appwin::MAIN)
                .expect("main window is defined in tauri.conf.json");
            #[cfg(not(target_os = "macos"))]
            win.set_decorations(false)?;
            win.show()?;
            // Any write of the server list or the folders reaches every window:
            // each keeps its own copy, and `prod` / `noAi` must not drift apart.
            let handle = app.handle().clone();
            store::on_catalog_change(move || {
                let _ = handle.emit("window://catalog", ());
            });
            Ok(())
        })
        .menu(|app| commands::chrome::build_app_menu(app, &commands::chrome::MenuLabels::default()))
        .on_menu_event(|app, event| {
            // A menu command is for the window the user is in; quitting is asked
            // in the main one, which lists every window's sessions.
            match event.id().as_ref() {
                "settings" => appwin::emit_to_focused(app, "menu://settings"),
                "about" => appwin::emit_to_focused(app, "menu://about"),
                "changelog" => appwin::emit_to_focused(app, "menu://changelog"),
                "updates" => appwin::emit_to_focused(app, "menu://updates"),
                "help" => appwin::emit_to_focused(app, "menu://help"),
                "manual" => appwin::emit_to_focused(app, "menu://manual"),
                "monitoring" => appwin::emit_to_focused(app, "menu://monitoring"),
                "quit" => appwin::request_quit(app),
                _ => {}
            }
        })
        .on_window_event(|window, event| {
            // Closing asks first (the main window: quit; another one: close it
            // with its sessions) — `appwin` decides, this only vetoes the close.
            let asked = appwin::on_window_event(window, event);
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if asked {
                    api.prevent_close();
                }
            }
        })
        .manage(state)
        .manage(kbdauth::PendingPrompts::default())
        .manage(appwin::Windows::default())
        .manage(transfers::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            kbdauth::answer_auth_prompt,
            servers::list_servers,
            servers::add_server,
            servers::update_server,
            servers::set_server_notes,
            servers::set_server_path_sync,
            servers::delete_server,
            servers::forget_secrets,
            servers::save_server_secret,
            servers::save_proxy_secret,
            folders::list_folders,
            folders::add_folder,
            folders::delete_folder,
            folders::delete_folder_with_servers,
            folders::move_folder,
            folders::rename_folder,
            folders::set_server_group,
            commands::backup::export_backup,
            commands::backup::import_backup,
            backup::read_backup,
            commands::session::connect_plan,
            commands::session::connect_session,
            commands::session::open_local_terminal,
            commands::session::host_os,
            commands::session::shell_exists,
            commands::session::write_to_terminal,
            commands::session::read_shell_history,
            commands::session::resize_pty,
            commands::session::disconnect,
            metrics::fetch_metrics,
            metrics::fetch_metrics_detail,
            metrics::fetch_pending_updates,
            metrics::fetch_extras,
            commands::sftp::sftp_home,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_create_file,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_access,
            commands::sftp::sftp_check_sudo,
            commands::sftp::sftp_read_bytes,
            localfile::read_local_bytes,
            commands::sftp::sftp_write_text,
            localfile::read_local_text,
            localfile::write_local_text,
            localfile::save_editor_copy,
            commands::session::local_cwd,
            commands::session::watch_local_submits,
            commands::session::local_submitted_cwd,
            commands::chrome::take_pending_opens,
            keygen::generate_ssh_key,
            keygen::key_path_exists,
            keygen::save_public_key,
            store::list_known_hosts,
            store::remove_known_host,
            store::take_store_warnings,
            localfile::local_home,
            localfile::local_list,
            localfile::local_kinds,
            localfile::local_mkdir,
            localfile::local_create_file,
            localfile::local_delete,
            localfile::local_rename,
            localfile::local_copy,
            commands::sftp::sftp_hash_tree,
            commands::sftp::local_hash_tree,
            commands::sftp::sftp_sync_apply,
            commands::sftp::sftp_grep,
            commands::sftp::lint_remote,
            commands::sftp::nginx_config_files,
            commands::sftp::server_tools_status,
            commands::sftp::run_tool_install,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_copy,
            commands::sftp::transfer_start,
            commands::sftp::transfer_list,
            commands::sftp::sftp_cancel,
            commands::chrome::read_clipboard_text,
            commands::chrome::set_menu_language,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::set_recording_paused,
            commands::recording::annotate_recording,
            commands::recording::record_audit,
            commands::recording::list_recordings,
            commands::recording::delete_recording,
            commands::recording::set_recording_meta,
            commands::recording::set_batch_label,
            commands::recording::read_recording,
            commands::recording::export_recording,
            commands::recording::import_recording,
            ai::ai_chat,
            ai::cancel_ai_chat,
            ai::ai_models,
            commands::ai::ai_exec,
            commands::drivers::git_run,
            commands::drivers::probe_run,
            commands::drivers::netcheck_run,
            commands::drivers::container_run,
            commands::drivers::kubectl_run,
            commands::drivers::docker_login,
            commands::drivers::set_registry_secret,
            commands::drivers::delete_registry_secret,
            commands::ai::set_ai_key,
            commands::ai::forget_ai_key,
            appwin::arm_close_guard,
            appwin::quit_app,
            updater::update_check,
            updater::update_snapshot,
            updater::update_download,
            updater::update_install,
            updater::update_window_ready,
            updater::update_startup,
            appwin::close_window,
            appwin::report_window_summary,
            appwin::other_windows_summary,
            appwin::detach_begin,
            appwin::detach_abort,
            appwin::detach_commit,
            appwin::take_handoff,
            appwin::decline_handoff,
            appwin::attach_session,
            appwin::announce_window,
            appwin::announce_copy_targets,
            dragout::drag_out_begin,
            appwin::drag_over,
            appwin::drag_drop,
            appwin::drag_end
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        // Any other way out the OS offers (the Dock's Quit, logout): a user
        // request carries no exit code — `quit_app`'s own `exit(0)` does, and
        // disarms the guard first anyway.
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            if appwin::quit_guarded(app_handle) {
                api.prevent_exit();
                appwin::request_quit(app_handle);
            }
        }
        // macOS delivers "Open with" / dropped files as an Opened run event (the
        // variant only exists on macOS/iOS — Windows/Linux get the path via argv,
        // handled by single-instance / initial `pending_opens`). Queue + emit so the
        // frontend opens them whether or not it's listening yet.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.pending_opens.locked().extend(paths.iter().cloned());
                }
                for p in paths {
                    let _ = app_handle.emit_to(appwin::MAIN, "vterm://open-file", p);
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_after_login_can_fail_the_connection() {
        // Guard (deep-check E2E, v1.0.31): once `ssh::connect` succeeded the session is
        // live, and an early return drops it. A keychain `set_password(..)?` did
        // exactly that on Linux without a Secret Service — the user authenticated
        // and got an error instead of a shell. Scans the code (comments stripped)
        // between the login and the end of the command for any `?`.
        // A Windows checkout carries CRLF (core.autocrlf); the markers below are LF.
        let src = crate::commands::bridge_source();
        let body = &src[src
            .find("async fn connect_session(")
            .expect("connect_session")..];
        let body = &body[..body.find("\n}\n").expect("end of connect_session")];
        let after_login = &body[body.find("ssh::connect(").expect("ssh::connect")..];
        let after_login = &after_login[after_login.find(".await?;").expect("login await") + 8..];
        let code: String = after_login
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains('?'),
            "connect_session propagates an error after login — the live session would be dropped:\n{code}"
        );
    }

    /// The body of `async fn <name>(` up to its closing `}` at column 0, with
    /// line comments stripped.
    fn command_code(src: &str, name: &str) -> String {
        let at = src
            .find(&format!("async fn {name}("))
            .unwrap_or_else(|| panic!("{name} not found"));
        let body = &src[at..];
        let body = &body[..body.find("\n}\n").expect("end of fn")];
        body.lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn network_utilities_never_record_raw_argv_or_output() {
        // Guard (v1.0.42): `probe_run` mirrored its argv and the whole response into
        // the recording — `-H 'Authorization: Bearer …'`, `--data-raw` with a
        // password, the response body and its `Set-Cookie`. The frontend records a
        // masked summary of the PARSED result through `record_audit` instead; the
        // executors themselves must not write to the recording at all.
        let src = crate::commands::bridge_source();
        for name in ["probe_run", "netcheck_run", "netcheck_exec"] {
            let code = command_code(&src, name);
            for banned in ["record_output", "annotate_recording", "audit_block"] {
                assert!(
                    !code.contains(banned),
                    "{name} writes to the recording ({banned}) — record a masked summary via record_audit"
                );
            }
        }
        // The probe goes through the drivers' dispatcher, which audits a call only
        // when asked to — and the probe never asks.
        assert!(command_code(&src, "probe_run").contains("audit: None,"));
        // …and the one recording path stays the formatted, sanitized block.
        assert!(command_code(&src, "record_audit").contains("netprobe::audit_block("));
    }

    /// Whether a netcheck run as written can be stopped: the command registers
    /// its stop flag and removes it again, the SSH path passes it to the exec
    /// (which signals and closes the channel), the local path runs under it.
    fn netcheck_is_stoppable(src: &str) -> bool {
        let run = command_code(src, "netcheck_run");
        let exec = command_code(src, "netcheck_exec");
        run.contains("register_cancel(&state, &cancel_id)")
            && run.contains("state.cancels.locked().remove(&cancel_id)")
            && exec
                .contains("exec_captured_until(&exec::remote_command(args), timeout, Some(cancel))")
            && exec.contains("sync::until_cancelled(run, cancel)")
            && !exec.contains(".exec_captured(")
    }

    #[test]
    fn a_netcheck_run_can_always_be_stopped() {
        // Guard (v1.21, ADR 0032): "Stop" on a subnet sweep must reach whatever
        // runs it — on the server and on this machine alike.
        let src = crate::commands::bridge_source();
        assert!(netcheck_is_stoppable(&src));
        // Planted: the SSH path forgets the flag, the local one runs unguarded.
        let planted = src.replacen(
            "exec_captured_until(&exec::remote_command(args), timeout, Some(cancel))",
            "exec_captured_until(&exec::remote_command(args), timeout, None)",
            1,
        );
        assert!(!netcheck_is_stoppable(&planted));
        let planted = src.replacen("sync::until_cancelled(run, cancel)", "run", 1);
        assert!(!netcheck_is_stoppable(&planted));
    }

    /// Everything before the tests, line comments stripped.
    fn code_of(src: &str) -> String {
        let src = src.replace("\r\n", "\n");
        src[..src.find("#[cfg(test)]").unwrap_or(src.len())]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn quitting_always_goes_through_the_confirmation() {
        // Guard (v1.0.33): the predefined `quit()` menu item terminates the app
        // natively, past `request_quit` — ⌘Q would silently drop every session the
        // quit dialog exists to list. And a close request must be the one the
        // guard can veto (`prevent_close`), not left to close the window.
        let code = code_of(&crate::commands::bridge_source());
        let windows = code_of(include_str!("appwin.rs"));
        assert!(
            !code.contains(".quit()") && !windows.contains(".quit()"),
            "native Quit bypasses the confirmation"
        );
        assert!(code.contains("\"quit\" => appwin::request_quit(app),"));
        // A close request is vetoed exactly when `appwin` took it over…
        let close = &code[code
            .find("appwin::on_window_event(")
            .expect("close handler")..];
        let close = &close[..close.find(".manage(").expect("end of handler")];
        assert!(close.contains("if asked {\n                    api.prevent_close();"));
        // …and it takes over only by asking: the main window to quit, any other
        // one to close itself.
        let asks = &windows[windows
            .find("WindowEvent::CloseRequested")
            .expect("close request")..];
        let asks = &asks[..asks.find("WindowEvent::Destroyed").expect("next arm")];
        assert!(asks.contains("request_quit(app);"));
        // (`code_of` cuts a line at `//`, so the event name ends at its scheme.)
        assert!(asks.contains("app.emit_to(label, \"window:"));
    }

    #[test]
    fn a_session_ends_in_one_place_and_only_for_its_owner() {
        // Guard (v1.3.0, ADR 0017): a tab can live in another window than the one
        // that connected it. The session map is emptied in `end_session` alone, and
        // the `disconnect` a window sends reaches it only past the owner check —
        // otherwise the window that gave a tab away would end the session behind
        // the new owner's back with its ordinary teardown.
        let code = code_of(&crate::commands::bridge_source());
        for removal in [
            "sessions.lock().await.remove(",
            "local_ptys.locked().remove(",
        ] {
            assert_eq!(
                code.matches(removal).count(),
                1,
                "a session is dropped outside end_session: {removal}"
            );
        }
        let end = command_code(&code, "end_session");
        assert!(end.contains("sessions.lock().await.remove(session_id)"));
        assert!(end.contains("local_ptys.locked().remove(session_id)"));
        let disconnect = command_code(&code, "disconnect");
        let check = disconnect
            .find("windows.release(&session_id, window.label())")
            .expect("owner check");
        assert!(check < disconnect.find("end_session(").expect("ends the session"));
        // A window that is gone has its sessions ended for it.
        let windows = code_of(include_str!("appwin.rs"));
        let destroyed = &windows[windows.find("WindowEvent::Destroyed").expect("destroyed")..];
        assert!(
            destroyed[..destroyed.find("_ => false").expect("end of arms")]
                .contains("crate::end_session(&app, &id).await")
        );
    }

    // ── uuid_like ─────────────────────────────────────────────────────────────
    #[test]
    fn uuid_like_has_prefix_and_is_unique() {
        let a = uuid_like();
        assert!(a.starts_with("srv-"));
        // Hex suffix only.
        assert!(a["srv-".len()..].chars().all(|c| c.is_ascii_hexdigit()));
        let b = uuid_like();
        assert_ne!(a, b);
    }
}
