//! SSH session handling on top of `russh` (Phase 1).
//!
//! Flow: connect → password auth → open a session channel → request a PTY and a
//! shell → split the channel. The read half is driven by a background task that
//! forwards bytes to the frontend via Tauri events; the write half is kept in
//! the session registry so commands can send keystrokes and window resizes.

use crate::error::{AppError, AppResult};
use crate::store;
use async_http_proxy::{http_connect_tokio, http_connect_tokio_with_basic_auth};
use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf};
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_socks::tcp::Socks5Stream;
use zeroize::Zeroizing;

/// After `KEEPALIVE_MAX` unanswered keepalives the connection is dropped
/// (so dead links — sleeping server, lost Wi-Fi — are detected).
const KEEPALIVE_MAX: usize = 3;

/// How vterm decides whether to trust a server's host key.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HostKeyPolicy {
    /// Trust only a key already recorded for this host (reject unknown/changed).
    Strict,
    /// Trust-on-first-use: record an unknown key, but reject a changed one.
    TofuReject,
    /// Trust any key (insecure — original Phase 1 behavior).
    AcceptAny,
}

impl HostKeyPolicy {
    pub fn from_str(s: &str) -> Self {
        match s {
            "strict" => HostKeyPolicy::Strict,
            "accept" => HostKeyPolicy::AcceptAny,
            _ => HostKeyPolicy::TofuReject,
        }
    }
}

// Credential-rejection and host-key-rejection are typed as AppError::AuthRejected
// / AppError::HostKeyRejected (see error.rs); their Display strings carry the
// `auth-rejected` / `host-key-rejected` markers the frontend matches on.

/// Event name carrying raw terminal output bytes for a session.
pub fn output_event(session_id: &str) -> String {
    format!("term://out/{session_id}")
}

/// Event name signalling the remote shell/connection closed.
pub fn closed_event(session_id: &str) -> String {
    format!("term://closed/{session_id}")
}

/// Event name carrying live output chunks of a server-tool install (Phase 20.14).
/// Payload is a UTF-8 string chunk; the frontend appends it to the install dialog's
/// streaming console so a long `apt install` shows progress instead of a dead button.
pub fn install_output_event(session_id: &str) -> String {
    format!("install://out/{session_id}")
}

/// Event name carrying connection-phase progress for the connecting overlay.
/// Payloads mirror the sequential stages of [`connect`], so the UI shows a real
/// (not faux) step indicator. When a proxy is configured its own sub-phases are
/// emitted first: jump host → `"proxyConnecting"`, `"proxyAuthenticating"`,
/// `"proxyTunnel"`; SOCKS5/HTTP → `"proxyConnecting"`, `"proxyHandshake"`. Then
/// the target: `"connecting"` (TCP + SSH handshake), `"authenticating"`,
/// `"session"` (opening the channel / PTY / shell).
pub fn phase_event(session_id: &str) -> String {
    format!("term://phase/{session_id}")
}

/// Client handler that verifies the server host key against vterm's own
/// `known_hosts.json` according to the configured policy.
struct ClientHandler {
    host: String,
    port: u16,
    policy: HostKeyPolicy,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(Default::default())
            .to_string();
        let id = format!("{}:{}", self.host, self.port);
        let known = store::known_host_key(&id);
        let trusted = match self.policy {
            HostKeyPolicy::AcceptAny => {
                store::remember_host_key(&id, &fingerprint);
                true
            }
            HostKeyPolicy::Strict => known.as_deref() == Some(fingerprint.as_str()),
            HostKeyPolicy::TofuReject => match known {
                None => {
                    store::remember_host_key(&id, &fingerprint);
                    true
                }
                Some(existing) => existing == fingerprint,
            },
        };
        Ok(trusted)
    }
}

/// A live SSH session: the channel write half plus the handles that must stay
/// alive for the connection and the reader task to keep running.
pub struct SshSession {
    write: ChannelWriteHalf<Msg>,
    handle: Handle<ClientHandler>,
    reader: JoinHandle<()>,
    /// Lazily-opened SFTP subsystem on the same SSH connection.
    sftp: Mutex<Option<Arc<SftpSession>>>,
    /// Active session recorder, if recording (shared with the reader task).
    recorder: Arc<std::sync::Mutex<Option<crate::recording::Recorder>>>,
    /// The proxy/jump host connection, when this session is tunneled through one.
    /// Held only to keep it alive — dropping it closes the underlying tunnel.
    _proxy_handle: Option<Handle<ClientHandler>>,
}

impl SshSession {
    /// Send user keystrokes to the remote shell (recording input first if active).
    pub async fn write_input(&self, data: Vec<u8>) -> AppResult<()> {
        if let Ok(mut g) = self.recorder.lock() {
            if let Some(r) = g.as_mut() {
                r.input(&data);
            }
        }
        self.write
            .data_bytes(data)
            .await
            .map_err(|e| format!("write failed: {e}").into())
    }

    /// Begin recording on this session.
    pub fn begin_recording(&self, rec: crate::recording::Recorder) {
        *self.recorder.lock().unwrap() = Some(rec);
    }

    /// Stop recording; returns the file path if a recording was active.
    pub fn end_recording(&self) -> Option<std::path::PathBuf> {
        self.recorder
            .lock()
            .unwrap()
            .take()
            .map(|r| r.path().to_path_buf())
    }

    /// Pause or resume the active recording (no-op if not recording).
    pub fn set_recording_paused(&self, paused: bool) {
        if let Some(rec) = self.recorder.lock().unwrap().as_mut() {
            rec.set_paused(paused);
        }
    }

    /// Write an audit annotation into the active recording (no-op if not recording).
    pub fn annotate_recording(&self, text: &str) {
        if let Some(rec) = self.recorder.lock().unwrap().as_mut() {
            rec.annotate(text);
        }
    }

    /// Inform the remote PTY of a new terminal size.
    pub async fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.write
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| format!("resize failed: {e}").into())
    }

    /// Get (opening on first use) the SFTP session over this connection.
    pub async fn sftp(&self) -> AppResult<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("could not open SFTP channel: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("SFTP subsystem request failed: {e}"))?;
        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("SFTP init failed: {e}"))?;
        let arc = Arc::new(session);
        *guard = Some(arc.clone());
        Ok(arc)
    }

    /// Run a one-shot command on a dedicated exec channel and return its stdout.
    /// Used for lightweight metric polling without disturbing the interactive shell.
    pub async fn run_command(&self, command: &str) -> AppResult<String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("exec channel failed: {e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("exec failed: {e}"))?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Like [`run_command`](Self::run_command) but writes `stdin` to the command
    /// first (then EOF). Used to feed a `sudo -S` password without it appearing in
    /// the process list. Only stdout is collected.
    pub async fn run_command_stdin(&self, command: &str, stdin: &[u8]) -> AppResult<String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("exec channel failed: {e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("exec failed: {e}"))?;
        if !stdin.is_empty() {
            channel
                .data(stdin)
                .await
                .map_err(|e| format!("stdin write failed: {e}"))?;
            let _ = channel.eof().await;
        }
        let mut out: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Like [`run_command_stdin`](Self::run_command_stdin) but invokes `on_chunk`
    /// with each output chunk as it arrives, so callers can stream progress live
    /// (server-tool install console, Phase 20.14). Still accumulates and returns the
    /// full output so the one-shot contract is preserved. The command is expected to
    /// merge stderr into stdout (`2>&1`); `ExtendedData` is folded in for safety.
    pub async fn run_command_stdin_streaming<F: FnMut(&[u8])>(
        &self,
        command: &str,
        stdin: &[u8],
        mut on_chunk: F,
    ) -> AppResult<String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("exec channel failed: {e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("exec failed: {e}"))?;
        if !stdin.is_empty() {
            channel
                .data(stdin)
                .await
                .map_err(|e| format!("stdin write failed: {e}"))?;
            let _ = channel.eof().await;
        }
        let mut out: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    on_chunk(&data);
                    out.extend_from_slice(&data);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Run a command on a dedicated exec channel, capturing stdout, stderr and the
    /// exit code, bounded by `timeout_secs`. Used by the AI dialog/agent loop
    /// (17.8): a clean, deterministic result to feed back to the model. Stateless
    /// between calls (its own shell — no shared cwd/env with the interactive PTY).
    pub async fn exec_captured(&self, command: &str, timeout_secs: u64) -> AppResult<ExecOutcome> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("exec channel failed: {e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("exec failed: {e}"))?;

        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        let mut code: i32 = -1;
        let collect = async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                    Some(ChannelMsg::ExtendedData { data, ext }) => {
                        // ext == 1 is stderr; anything else joins stdout.
                        if ext == 1 {
                            err.extend_from_slice(&data);
                        } else {
                            out.extend_from_slice(&data);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status as i32,
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        };

        let timed_out = timeout(Duration::from_secs(timeout_secs.max(1)), collect)
            .await
            .is_err();
        if timed_out {
            let _ = channel.close().await;
        }
        Ok(ExecOutcome {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit_code: code,
            timed_out,
        })
    }

    /// Like [`exec_captured`](Self::exec_captured) but writes `stdin` to the
    /// command first (then EOF). Used for `docker login --password-stdin` (Phase
    /// 36) so the registry password reaches docker over the encrypted channel
    /// without ever appearing on a command line, while still capturing
    /// stdout/stderr/exit so login success/failure is known.
    pub async fn exec_captured_stdin(
        &self,
        command: &str,
        stdin: &[u8],
        timeout_secs: u64,
    ) -> AppResult<ExecOutcome> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("exec channel failed: {e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("exec failed: {e}"))?;
        if !stdin.is_empty() {
            channel
                .data(stdin)
                .await
                .map_err(|e| format!("stdin write failed: {e}"))?;
            let _ = channel.eof().await;
        }

        let mut out: Vec<u8> = Vec::new();
        let mut err: Vec<u8> = Vec::new();
        let mut code: i32 = -1;
        let collect = async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                    Some(ChannelMsg::ExtendedData { data, ext }) => {
                        if ext == 1 {
                            err.extend_from_slice(&data);
                        } else {
                            out.extend_from_slice(&data);
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status as i32,
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        };

        let timed_out = timeout(Duration::from_secs(timeout_secs.max(1)), collect)
            .await
            .is_err();
        if timed_out {
            let _ = channel.close().await;
        }
        Ok(ExecOutcome {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit_code: code,
            timed_out,
        })
    }

    /// Push bytes into the active recording as output (no-op if not recording).
    /// Used to mirror AI-executed commands into the session recording (17.8).
    pub fn record_output(&self, data: &[u8]) {
        if let Ok(mut g) = self.recorder.lock() {
            if let Some(r) = g.as_mut() {
                r.output(data);
            }
        }
    }
}

/// Result of [`SshSession::exec_captured`].
pub struct ExecOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // Stop the reader task; dropping `_handle` closes the SSH connection.
        self.reader.abort();
    }
}

/// Best-effort check whether a private key file is passphrase-protected
/// (so the UI knows whether to prompt). A missing/invalid file also returns
/// `true`, letting the real error surface at connect time.
pub fn key_is_encrypted(path: &str) -> bool {
    load_secret_key(path, None).is_err()
}

/// Standard OpenSSH private-key filenames, in the order `ssh(1)` itself tries
/// them (most modern/preferred first). Lives under `~/.ssh/` on every platform —
/// macOS/Linux use `$HOME/.ssh`, Windows OpenSSH uses `%USERPROFILE%\.ssh`.
const DEFAULT_KEY_NAMES: &[&str] = &[
    "id_ed25519",
    "id_ecdsa_sk",
    "id_ed25519_sk",
    "id_ecdsa",
    "id_rsa",
    "id_dsa",
];

/// First existing private key inside `ssh_dir`, by OpenSSH preference order.
/// Split out from [`default_key_path`] so it can be unit-tested against a tmp dir.
fn find_default_key(ssh_dir: &std::path::Path) -> Option<String> {
    DEFAULT_KEY_NAMES
        .iter()
        .map(|name| ssh_dir.join(name))
        .find(|p| p.is_file())
        .and_then(|p| p.to_str().map(str::to_string))
}

/// Locate a default private key in the user's `~/.ssh/` directory, used when a
/// server is set to key auth but has no explicit key path. `None` if there is no
/// home directory or `~/.ssh` holds no recognized key.
pub fn default_key_path() -> Option<String> {
    let home = directories::UserDirs::new()?.home_dir().to_path_buf();
    find_default_key(&home.join(".ssh"))
}

/// Decide which key file to authenticate with: the explicit per-server path when
/// set (and non-blank), otherwise a default discovered via `fallback`.
fn pick_key_path(
    explicit: Option<&str>,
    fallback: impl FnOnce() -> Option<String>,
) -> Option<String> {
    match explicit {
        Some(p) if !p.trim().is_empty() => Some(p.to_string()),
        _ => fallback(),
    }
}

/// Resolve the key path for a server: explicit path if present, else a default
/// from `~/.ssh/`.
pub fn resolve_key_path(explicit: Option<&str>) -> Option<String> {
    pick_key_path(explicit, default_key_path)
}

/// What to authenticate with. Secret material is wrapped in `Zeroizing` so
/// vterm's in-memory copy is wiped when the credential is dropped.
pub enum Credential {
    Password(Zeroizing<String>),
    Key {
        path: String,
        passphrase: Option<Zeroizing<String>>,
    },
}

/// A jump host to tunnel the real connection through (SSH ProxyJump). vterm first
/// connects and authenticates here, then opens a `direct-tcpip` channel to the
/// target and runs the real SSH session over it.
pub struct ProxyJump {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub cred: Credential,
}

/// Optional basic auth for a "dumb" TCP proxy (SOCKS5 / HTTP CONNECT): a
/// username with an optional password. `None` username → connect without auth.
pub struct ProxyTcpAuth {
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
}

/// A proxy to reach the target server through. `Jump` tunnels via an intermediate
/// SSH server (`direct-tcpip`); `Socks5`/`Http` route the target TCP connection
/// through a generic proxy. All three produce a byte stream the real SSH session
/// then runs over via `connect_stream`.
pub enum Proxy {
    Jump(ProxyJump),
    Socks5 {
        host: String,
        port: u16,
        auth: ProxyTcpAuth,
    },
    Http {
        host: String,
        port: u16,
        auth: ProxyTcpAuth,
    },
}

/// Tunables passed from the frontend Settings panel, plus the initial PTY size.
pub struct ConnectOptions {
    pub term_type: String,
    pub connect_timeout: Duration,
    pub keepalive_interval: Duration,
    pub host_key_policy: HostKeyPolicy,
    /// Initial terminal size for the shell's PTY request.
    pub cols: u32,
    pub rows: u32,
    /// Optional proxy to reach the server through (None → connect directly).
    pub proxy: Option<Proxy>,
}

/// The generic "connection timed out" error, shared by direct and proxied paths.
fn conn_timeout(d: Duration) -> AppError {
    AppError::Message(format!("connection timed out after {}s", d.as_secs()))
}

/// Open a plain TCP connection to a SOCKS5/HTTP proxy. Kept separate from the
/// proxy handshake so each is its own observable phase (`proxyConnecting` then
/// `proxyHandshake`) — the connecting overlay shows real, not faux, sub-steps.
async fn proxy_tcp_connect(host: &str, port: u16, timeout_dur: Duration) -> AppResult<TcpStream> {
    timeout(timeout_dur, TcpStream::connect((host, port)))
        .await
        .map_err(|_| {
            AppError::Message(format!(
                "proxy connection timed out after {}s",
                timeout_dur.as_secs()
            ))
        })?
        .map_err(|e| AppError::Message(format!("proxy connection failed: {e}")))
}

/// SOCKS5 negotiation over an already-connected `socket` (optional user/pass
/// auth). The returned stream is what the SSH session runs over.
async fn socks5_negotiate(
    socket: TcpStream,
    target_host: &str,
    target_port: u16,
    auth: &ProxyTcpAuth,
    timeout_dur: Duration,
) -> AppResult<Socks5Stream<TcpStream>> {
    let target = (target_host, target_port);
    let negotiate = async {
        match &auth.username {
            Some(user) => {
                let pass = auth.password.as_deref().map(|p| p.as_str()).unwrap_or("");
                Socks5Stream::connect_with_password_and_socket(socket, target, user, pass).await
            }
            None => Socks5Stream::connect_with_socket(socket, target).await,
        }
    };
    timeout(timeout_dur, negotiate)
        .await
        .map_err(|_| {
            AppError::Message(format!(
                "SOCKS5 handshake timed out after {}s",
                timeout_dur.as_secs()
            ))
        })?
        .map_err(|e| AppError::Message(format!("SOCKS5 proxy failed: {e}")))
}

/// HTTP CONNECT handshake over an already-connected `socket` (optional basic
/// auth). The returned stream is what the SSH session runs over.
async fn http_negotiate(
    mut socket: TcpStream,
    target_host: &str,
    target_port: u16,
    auth: &ProxyTcpAuth,
    timeout_dur: Duration,
) -> AppResult<TcpStream> {
    let negotiate = async {
        match &auth.username {
            Some(user) => {
                let pass = auth.password.as_deref().map(|p| p.as_str()).unwrap_or("");
                http_connect_tokio_with_basic_auth(
                    &mut socket,
                    target_host,
                    target_port,
                    user,
                    pass,
                )
                .await
            }
            None => http_connect_tokio(&mut socket, target_host, target_port).await,
        }
        .map_err(|e| AppError::Message(format!("HTTP CONNECT failed: {e}")))?;
        Ok::<TcpStream, AppError>(socket)
    };
    timeout(timeout_dur, negotiate).await.map_err(|_| {
        AppError::Message(format!(
            "HTTP CONNECT timed out after {}s",
            timeout_dur.as_secs()
        ))
    })?
}

/// Map a russh handshake error to a typed `AppError`, recognizing a rejected host
/// key (russh reports it as a generic handshake error).
fn map_handshake_err(e: russh::Error) -> AppError {
    let msg = e.to_string();
    if msg.contains("UnknownKey") || msg.to_lowercase().contains("key") {
        AppError::HostKeyRejected
    } else {
        AppError::Message(format!("connection failed: {e}"))
    }
}

/// Authenticate an open SSH transport with a password or public key. Returns
/// whether the server accepted the credential. Shared by the target connection
/// and the proxy/jump host so both honour the same timeout and key handling.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    cred: Credential,
    timeout_dur: Duration,
) -> AppResult<bool> {
    let auth = match cred {
        Credential::Password(password) => timeout(
            timeout_dur,
            handle.authenticate_password(username, password.to_string()),
        )
        .await
        .map_err(|_| "authentication timed out".to_string())?
        .map_err(|e| format!("authentication error: {e}"))?,

        Credential::Key { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_ref().map(|p| p.as_str()))
                .map_err(|e| format!("could not load key {path}: {e}"))?;
            // RSA needs a modern signature hash; the server tells us which it accepts.
            let hash_alg = if key.algorithm().is_rsa() {
                handle
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten()
            } else {
                None
            };
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
            timeout(timeout_dur, handle.authenticate_publickey(username, key))
                .await
                .map_err(|_| "authentication timed out".to_string())?
                .map_err(|e| format!("authentication error: {e}"))?
        }
    };
    Ok(auth.success())
}

/// Open a connection, authenticate, and start an interactive shell.
pub async fn connect(
    app: AppHandle,
    session_id: String,
    host: &str,
    port: u16,
    username: &str,
    cred: Credential,
    opts: ConnectOptions,
) -> AppResult<SshSession> {
    let connect_timeout = opts.connect_timeout;
    let config = Arc::new(client::Config {
        keepalive_interval: Some(opts.keepalive_interval),
        keepalive_max: KEEPALIVE_MAX,
        ..Default::default()
    });

    let handler = ClientHandler {
        host: host.to_string(),
        port,
        policy: opts.host_key_policy,
    };

    // Phase 1: reach the target's SSH transport (host-key check), optionally via a
    // proxy. Each branch yields the target `Handle`. The jump host emits its own
    // `proxy` phase first and its SSH `Handle` is kept alive for the session's
    // lifetime (dropping it tears down the `direct-tcpip` tunnel); SOCKS5/HTTP
    // hand ownership of their stream to `connect_stream`, so nothing extra to keep.
    let mut proxy_handle: Option<Handle<ClientHandler>> = None;
    let mut handle = match opts.proxy {
        None => {
            let _ = app.emit(&phase_event(&session_id), "connecting");
            timeout(
                connect_timeout,
                client::connect(config, (host, port), handler),
            )
            .await
            .map_err(|_| conn_timeout(connect_timeout))?
            .map_err(map_handshake_err)?
        }
        Some(Proxy::Jump(p)) => {
            // Jump host mirrors a full SSH connect: its own connect → auth →
            // tunnel sub-phases, each a real emitted stage.
            let _ = app.emit(&phase_event(&session_id), "proxyConnecting");
            let jump_handler = ClientHandler {
                host: p.host.clone(),
                port: p.port,
                policy: opts.host_key_policy,
            };
            let mut jump = timeout(
                connect_timeout,
                client::connect(config.clone(), (p.host.as_str(), p.port), jump_handler),
            )
            .await
            .map_err(|_| conn_timeout(connect_timeout))?
            .map_err(map_handshake_err)?;
            let _ = app.emit(&phase_event(&session_id), "proxyAuthenticating");
            if !authenticate(&mut jump, &p.username, p.cred, connect_timeout).await? {
                return Err(AppError::ProxyAuthRejected);
            }
            let _ = app.emit(&phase_event(&session_id), "proxyTunnel");
            let channel = jump
                .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| format!("proxy tunnel to {host}:{port} failed: {e}"))?;
            proxy_handle = Some(jump);
            let _ = app.emit(&phase_event(&session_id), "connecting");
            timeout(
                connect_timeout,
                client::connect_stream(config, channel.into_stream(), handler),
            )
            .await
            .map_err(|_| conn_timeout(connect_timeout))?
            .map_err(map_handshake_err)?
        }
        Some(Proxy::Socks5 {
            host: phost,
            port: pport,
            auth,
        }) => {
            // TCP connect and SOCKS negotiation are separate awaits → separate
            // `proxyConnecting` / `proxyHandshake` sub-phases.
            let _ = app.emit(&phase_event(&session_id), "proxyConnecting");
            let socket = proxy_tcp_connect(&phost, pport, connect_timeout).await?;
            let _ = app.emit(&phase_event(&session_id), "proxyHandshake");
            let stream = socks5_negotiate(socket, host, port, &auth, connect_timeout).await?;
            let _ = app.emit(&phase_event(&session_id), "connecting");
            timeout(
                connect_timeout,
                client::connect_stream(config, stream, handler),
            )
            .await
            .map_err(|_| conn_timeout(connect_timeout))?
            .map_err(map_handshake_err)?
        }
        Some(Proxy::Http {
            host: phost,
            port: pport,
            auth,
        }) => {
            let _ = app.emit(&phase_event(&session_id), "proxyConnecting");
            let socket = proxy_tcp_connect(&phost, pport, connect_timeout).await?;
            let _ = app.emit(&phase_event(&session_id), "proxyHandshake");
            let stream = http_negotiate(socket, host, port, &auth, connect_timeout).await?;
            let _ = app.emit(&phase_event(&session_id), "connecting");
            timeout(
                connect_timeout,
                client::connect_stream(config, stream, handler),
            )
            .await
            .map_err(|_| conn_timeout(connect_timeout))?
            .map_err(map_handshake_err)?
        }
    };

    // Phase 2: authentication (password or public key).
    let _ = app.emit(&phase_event(&session_id), "authenticating");
    if !authenticate(&mut handle, username, cred, connect_timeout).await? {
        // Recognizable marker so the UI can offer to re-enter the secret
        // (distinct from network/timeout errors above).
        return Err(AppError::AuthRejected);
    }

    // Phase 3: open the session channel, request a PTY and start the shell.
    let _ = app.emit(&phase_event(&session_id), "session");
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("could not open channel: {e}"))?;
    channel
        .request_pty(true, &opts.term_type, opts.cols, opts.rows, 0, 0, &[])
        .await
        .map_err(|e| format!("pty request failed: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("shell request failed: {e}"))?;

    let (mut read, write) = channel.split();

    let out = output_event(&session_id);
    let closed = closed_event(&session_id);
    let recorder: Arc<std::sync::Mutex<Option<crate::recording::Recorder>>> =
        Arc::new(std::sync::Mutex::new(None));
    let rec_for_reader = recorder.clone();
    let reader = tokio::spawn(async move {
        loop {
            match read.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let bytes = data.to_vec();
                    if let Ok(mut g) = rec_for_reader.lock() {
                        if let Some(r) = g.as_mut() {
                            r.output(&bytes);
                        }
                    }
                    let _ = app.emit(&out, bytes);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    let _ = app.emit(&closed, ());
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(SshSession {
        write,
        handle,
        reader,
        sftp: Mutex::new(None),
        recorder,
        _proxy_handle: proxy_handle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_policy_from_str() {
        assert!(matches!(
            HostKeyPolicy::from_str("strict"),
            HostKeyPolicy::Strict
        ));
        assert!(matches!(
            HostKeyPolicy::from_str("accept"),
            HostKeyPolicy::AcceptAny
        ));
        assert!(matches!(
            HostKeyPolicy::from_str("ask"),
            HostKeyPolicy::TofuReject
        ));
        // Unknown values fall back to the safe trust-on-first-use default.
        assert!(matches!(
            HostKeyPolicy::from_str("nonsense"),
            HostKeyPolicy::TofuReject
        ));
    }

    #[test]
    fn event_names() {
        assert_eq!(output_event("abc"), "term://out/abc");
        assert_eq!(closed_event("abc"), "term://closed/abc");
        assert_eq!(phase_event("abc"), "term://phase/abc");
    }

    #[test]
    fn key_is_encrypted_missing_file_is_true() {
        // A missing/unreadable key can't be loaded, so we treat it as encrypted
        // (and let the real error surface at connect time).
        assert!(key_is_encrypted("/no/such/key/file"));
    }

    /// Generate a key with ssh-keygen; returns the private-key path, or None when
    /// ssh-keygen is unavailable (so the test skips rather than failing).
    fn gen_key(dir: &std::path::Path, name: &str, passphrase: &str) -> Option<String> {
        let path = dir.join(name);
        let status = std::process::Command::new("ssh-keygen")
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                passphrase,
                "-f",
                path.to_str().unwrap(),
            ])
            .status()
            .ok()?;
        status
            .success()
            .then(|| path.to_string_lossy().into_owned())
    }

    #[test]
    fn key_is_encrypted_detects_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let Some(plain) = gen_key(dir.path(), "plain", "") else {
            eprintln!("ssh-keygen unavailable — skipping key_is_encrypted fixture test");
            return;
        };
        let encrypted = gen_key(dir.path(), "enc", "s3cret").unwrap();
        assert!(
            !key_is_encrypted(&plain),
            "unencrypted key should not need a passphrase"
        );
        assert!(
            key_is_encrypted(&encrypted),
            "encrypted key should need a passphrase"
        );
    }

    #[test]
    fn find_default_key_empty_dir_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_default_key(dir.path()), None);
    }

    #[test]
    fn find_default_key_prefers_ssh_order() {
        let dir = tempfile::tempdir().unwrap();
        // Create two keys; id_ed25519 must win over id_rsa regardless of fs order.
        std::fs::write(dir.path().join("id_rsa"), b"x").unwrap();
        std::fs::write(dir.path().join("id_ed25519"), b"x").unwrap();
        let found = find_default_key(dir.path()).unwrap();
        assert!(found.ends_with("id_ed25519"), "got {found}");

        // With only id_rsa present, it is selected.
        let dir2 = tempfile::tempdir().unwrap();
        std::fs::write(dir2.path().join("id_rsa"), b"x").unwrap();
        assert!(find_default_key(dir2.path()).unwrap().ends_with("id_rsa"));
    }

    #[test]
    fn find_default_key_ignores_directories() {
        let dir = tempfile::tempdir().unwrap();
        // A directory named like a key must not be picked (only real files count).
        std::fs::create_dir(dir.path().join("id_ed25519")).unwrap();
        assert_eq!(find_default_key(dir.path()), None);
    }

    #[test]
    fn pick_key_path_prefers_explicit() {
        assert_eq!(
            pick_key_path(Some("/keys/mine"), || Some("fallback".into())),
            Some("/keys/mine".to_string())
        );
    }

    #[test]
    fn pick_key_path_falls_back_when_blank_or_absent() {
        assert_eq!(
            pick_key_path(None, || Some("fallback".into())),
            Some("fallback".to_string())
        );
        assert_eq!(
            pick_key_path(Some("   "), || Some("fallback".into())),
            Some("fallback".to_string())
        );
        // No explicit path and no default key → None.
        assert_eq!(pick_key_path(None, || None), None);
    }
}
