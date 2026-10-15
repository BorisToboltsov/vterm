//! Explicit GitHub update requests. No polling and no WebView network access.
use crate::{
    error::{AppError, AppResult},
    update_helper::{self, Plan},
    update_protocol::{self as protocol, Kind},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State, WebviewWindow};

fn err(e: impl ToString) -> AppError {
    AppError::Message(e.to_string())
}
#[derive(Default)]
pub struct Updates {
    busy: tokio::sync::Mutex<()>,
    release: Mutex<Option<Release>>,
    prepared: Mutex<Option<Prepared>>,
    answers: Mutex<HashMap<String, bool>>,
    transaction: Mutex<Option<String>>,
}
struct Prepared {
    directory: tempfile::TempDir,
    plan: Plan,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub current: String,
    pub version: String,
    pub notes: String,
    pub url: String,
    pub available: bool,
    pub kind: Option<Kind>,
    pub trusted_updates: bool,
    pub ready: bool,
}
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: u64,
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("vterm-updater")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(900))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let allowed = matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "api.github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            );
            if url.scheme() == "https" && allowed && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.error("update-redirect")
            }
        }))
        .build()
        .map_err(err)
}
async fn metadata(url: &str) -> AppResult<Vec<u8>> {
    let response = client()?
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| err("update-network"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(err("update-unpublished"));
    }
    let response = response
        .error_for_status()
        .map_err(|_| err("update-network"))?;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| err("update-network"))?;
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(err("update-manifest"));
        }
        bytes.extend(chunk);
    }
    Ok(bytes)
}

fn installed() -> AppResult<(Option<Kind>, PathBuf, PathBuf, String)> {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    let exe = std::env::current_exe().map_err(err)?;
    if cfg!(debug_assertions) {
        return Ok((None, exe.clone(), exe, std::env::consts::ARCH.into()));
    }
    let kind = match bundle_type() {
        Some(BundleType::App) => Some(Kind::Mac),
        Some(BundleType::AppImage) => Some(Kind::Appimage),
        Some(BundleType::Msi) => Some(Kind::Msi),
        Some(BundleType::Nsis) => Some(Kind::Nsis),
        Some(BundleType::Deb) => Some(Kind::Deb),
        Some(BundleType::Rpm) => Some(Kind::Rpm),
        _ if cfg!(windows) => {
            let mut f = fs::File::open(&exe).map_err(err)?;
            Some(
                if crate::webview2::read_trailer(&mut f)
                    .map_err(err)?
                    .is_some()
                {
                    Kind::PortableWebview2
                } else {
                    Kind::Portable
                },
            )
        }
        _ => None,
    };
    let target = match kind {
        Some(Kind::Mac) => exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or_else(|| err("update-format"))?
            .to_path_buf(),
        Some(Kind::Appimage) => {
            PathBuf::from(std::env::var_os("APPIMAGE").ok_or_else(|| err("update-format"))?)
        }
        _ => exe.clone(),
    };
    let executable = if kind == Some(Kind::Appimage) {
        target.clone()
    } else {
        exe
    };
    let arch = if kind == Some(Kind::Mac) {
        "universal"
    } else {
        std::env::consts::ARCH
    };
    Ok((kind, target, executable, arch.into()))
}
fn result_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_local_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("update-result.json"))
}

#[tauri::command]
pub fn update_snapshot(state: State<Updates>) -> Option<Release> {
    let mut release = state.release.lock().unwrap().clone()?;
    release.ready = state
        .prepared
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|p| p.plan.version == release.version);
    Some(release)
}

#[tauri::command]
pub async fn update_check(state: State<'_, Updates>) -> AppResult<Release> {
    let _busy = state.busy.try_lock().map_err(|_| err("update-busy"))?;
    let bytes =
        metadata("https://api.github.com/repos/BorisToboltsov/vterm/releases/latest").await?;
    let release: GithubRelease =
        serde_json::from_slice(&bytes).map_err(|_| err("update-manifest"))?;
    let version = release
        .tag_name
        .strip_prefix('v')
        .ok_or_else(|| err("update-manifest"))?;
    semver::Version::parse(version).map_err(|_| err("update-manifest"))?;
    if release.draft || release.prerelease {
        return Err(err("update-manifest"));
    }
    let current = env!("CARGO_PKG_VERSION");
    let result = Release {
        current: current.into(),
        version: version.into(),
        notes: release.body.unwrap_or_default(),
        url: format!("{}/releases/tag/v{version}", protocol::REPO),
        available: protocol::newer(version, current),
        kind: installed()?.0,
        trusted_updates: !protocol::PUBLIC_KEY.trim().is_empty(),
        ready: state
            .prepared
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.plan.version == version),
    };
    *state.release.lock().unwrap() = Some(result.clone());
    Ok(result)
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, Updates>,
    progress: Channel<Progress>,
    version: String,
) -> AppResult<()> {
    let _busy = state.busy.try_lock().map_err(|_| err("update-busy"))?;
    let release = state
        .release
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| err("update-check-first"))?;
    if !release.available || release.version != version {
        return Err(err("update-check-first"));
    }
    let (kind, target, executable, arch) = installed()?;
    let kind = kind.ok_or_else(|| err("update-format"))?;
    if protocol::PUBLIC_KEY.trim().is_empty() {
        return Err(err("update-key"));
    }
    let bytes = metadata(&protocol::asset_url(&release.version, protocol::MANIFEST)).await?;
    let manifest =
        protocol::verified(&bytes, protocol::PUBLIC_KEY, &release.version).map_err(err)?;
    let asset = protocol::select(&manifest, &kind, &arch).map_err(err)?;
    let directory = tempfile::Builder::new()
        .prefix("vterm-update-")
        .tempdir()
        .map_err(err)?;
    let payload = directory.path().join(&asset.name);
    let manifest_path = directory.path().join(protocol::MANIFEST);
    fs::write(&manifest_path, &bytes).map_err(err)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&payload)
        .map_err(err)?;
    let response = client()?
        .get(protocol::asset_url(&release.version, &asset.name))
        .send()
        .await
        .map_err(|_| err("update-network"))?
        .error_for_status()
        .map_err(|_| err("update-network"))?;
    let mut downloaded = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| err("update-network"))?;
        downloaded += chunk.len() as u64;
        if downloaded > asset.size {
            return Err(err("update-signature"));
        }
        file.write_all(&chunk).map_err(err)?;
        let _ = progress.send(Progress {
            downloaded,
            total: asset.size,
        });
    }
    file.sync_all().map_err(err)?;
    protocol::verify_file(&payload, asset).map_err(err)?;
    let plan = Plan {
        version: release.version,
        kind,
        arch,
        target,
        executable,
        payload,
        manifest: manifest_path,
        parent_pid: std::process::id(),
        parent_start: update_helper::identity(std::process::id())
            .ok_or_else(|| err("update-process"))?,
        result: result_path(&app)?,
    };
    *state.prepared.lock().unwrap() = Some(Prepared { directory, plan });
    Ok(())
}

#[tauri::command]
pub fn update_window_ready(
    window: WebviewWindow,
    state: State<Updates>,
    token: String,
    dirty: bool,
) {
    if state.transaction.lock().unwrap().as_ref() == Some(&token) {
        state
            .answers
            .lock()
            .unwrap()
            .insert(window.label().into(), dirty);
    }
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Updates>,
    version: String,
) -> AppResult<()> {
    if window.label() != crate::appwin::MAIN {
        return Err(err("update-main-window"));
    }
    let _busy = state.busy.try_lock().map_err(|_| err("update-busy"))?;
    if state
        .prepared
        .lock()
        .unwrap()
        .as_ref()
        .is_none_or(|p| p.plan.version != version)
    {
        return Err(err("update-download-first"));
    }
    let token = format!("{}-{}", std::process::id(), crate::now_secs());
    state.answers.lock().unwrap().clear();
    *state.transaction.lock().unwrap() = Some(token.clone());
    let outcome = async {
        for (label, window) in app.webview_windows() {
            if label != crate::dragghost::LABEL {
                window.set_enabled(false).map_err(err)?;
            }
        }
        app.emit("update://prepare", &token).map_err(err)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let labels: Vec<_> = app
                .webview_windows()
                .keys()
                .filter(|s| *s != crate::dragghost::LABEL)
                .cloned()
                .collect();
            let answers = state.answers.lock().unwrap().clone();
            if labels.iter().all(|s| answers.contains_key(s)) {
                if labels.iter().any(|s| answers[s]) {
                    return Err(err("update-unsaved"));
                }
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(err("update-window-timeout"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // Copy this known app, never execute a downloaded helper before verification.
        let (dir, plan) = {
            let prepared = state.prepared.lock().unwrap();
            let p = prepared
                .as_ref()
                .ok_or_else(|| err("update-download-first"))?;
            (p.directory.path().to_path_buf(), p.plan.clone())
        };
        let helper = dir.join(if cfg!(windows) {
            "vterm-update-helper.exe"
        } else {
            "vterm-update-helper"
        });
        let source = if plan.kind == Kind::Appimage {
            plan.target.clone()
        } else {
            std::env::current_exe().map_err(err)?
        };
        fs::copy(source, &helper).map_err(err)?;
        let _ = fs::remove_file(dir.join("helper-ready"));
        let _ = fs::remove_file(dir.join("commit"));
        let _ = fs::remove_file(dir.join("helper-error"));
        let plan_path = dir.join("plan.json");
        fs::write(&plan_path, serde_json::to_vec(&plan).map_err(err)?).map_err(err)?;
        let mut child = Command::new(helper)
            .arg(update_helper::FLAG)
            .arg(&plan_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(err)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        while !dir.join("helper-ready").exists() {
            if child.try_wait().map_err(err)?.is_some() {
                return Err(err(fs::read_to_string(dir.join("helper-error"))
                    .unwrap_or_else(|_| "update-helper".into())));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(err("update-helper"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        fs::write(dir.join("commit"), b"install").map_err(err)?;
        // The helper owns staged files after handoff; keep them through process exit.
        if let Some(p) = state.prepared.lock().unwrap().take() {
            let _ = p.directory.keep();
        }
        crate::appwin::quit_app(app.clone(), app.state());
        Ok(())
    }
    .await;
    if outcome.is_err() {
        *state.transaction.lock().unwrap() = None;
        for (_, window) in app.webview_windows() {
            let _ = window.set_enabled(true);
        }
        let _ = app.emit("update://resume", ());
    }
    outcome
}

#[tauri::command]
pub async fn update_startup(app: AppHandle, window: WebviewWindow) -> AppResult<Option<String>> {
    if window.label() != crate::appwin::MAIN {
        return Ok(None);
    }
    let updated_launch = update_helper::acknowledge().map_err(err)?;
    let path = result_path(&app)?;
    // The helper writes the outcome after seeing our acknowledgement.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while updated_launch && !path.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let status = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    if status.is_some() {
        let _ = fs::remove_file(path);
    }
    Ok(status)
}
