//! Offline replacement worker. Runs from a copy, before WebView/single-instance.
use crate::update_protocol::{self as protocol, Kind};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

pub const FLAG: &str = "--vterm-update-helper";
pub const ACK_ENV: &str = "VTERM_UPDATE_ACK";
static STARTUP_ACK: OnceLock<Option<PathBuf>> = OnceLock::new();
/// Called before threads are created so the marker is not inherited by user shells.
pub fn capture_startup() {
    let path = std::env::var_os(ACK_ENV).map(PathBuf::from);
    std::env::remove_var(ACK_ENV);
    let _ = STARTUP_ACK.set(path);
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub version: String,
    pub kind: Kind,
    pub arch: String,
    pub target: PathBuf,
    pub executable: PathBuf,
    pub payload: PathBuf,
    pub manifest: PathBuf,
    pub parent_pid: u32,
    pub parent_start: u64,
    pub result: PathBuf,
}

fn io<T>(r: std::io::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}
fn run(cmd: &mut Command) -> Result<(), String> {
    let status = io(cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("update-install: {status}"))
    }
}
fn remove(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        io(fs::remove_dir_all(path))
    } else {
        io(fs::remove_file(path))
    }
}

pub fn identity(pid: u32) -> Option<u64> {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).map(|p| p.start_time())
}

pub fn lock_path() -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("su", "vcore", "vterm").ok_or("update-path")?;
    io(fs::create_dir_all(dirs.config_dir()))?;
    Ok(dirs.config_dir().join("update.lock"))
}

/// Block a second launch during replacement. The helper-started version carries an ack path.
pub fn replacement_in_progress() -> bool {
    if STARTUP_ACK.get().is_some_and(|p| p.is_some()) {
        return false;
    }
    let Ok(path) = lock_path() else {
        return false;
    };
    let Ok(file) = fs::OpenOptions::new().write(true).open(path) else {
        return false;
    };
    file.try_lock().is_err()
}

/// A normal launch acknowledges only after its main WebView is responsive.
pub fn acknowledge() -> Result<bool, String> {
    if let Some(Some(path)) = STARTUP_ACK.get() {
        // Only a marker in our private transaction directory, never an arbitrary overwrite.
        if path.file_name().and_then(|s| s.to_str()) == Some("ready") {
            let mut marker = io(fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path))?;
            io(marker.write_all(env!("CARGO_PKG_VERSION").as_bytes()))?;
            io(marker.sync_all())?;
            return Ok(true);
        }
    }
    Ok(false)
}

/// Invoked before any runtime initialization. No network, shell or forced exit.
pub fn entry() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(FLAG)) {
        return false;
    }
    let result = (|| -> Result<(), String> {
        let path = PathBuf::from(args.next().ok_or("update-plan")?);
        if args.next().is_some() {
            return Err("update-plan".into());
        }
        let plan: Plan =
            serde_json::from_slice(&io(fs::read(&path))?).map_err(|_| "update-plan")?;
        let work = path.parent().ok_or("update-plan")?;
        // Acquire the destination lock before telling vterm it may close.
        let lock = io(fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path()?))?;
        lock.try_lock().map_err(|_| "update-busy")?;
        validate(&plan)?;
        let prepared = match prepare(&plan) {
            Ok(p) => p,
            Err(error) => {
                let _ = fs::write(work.join("helper-error"), &error);
                return Err(error);
            }
        };
        io(fs::write(work.join("helper-ready"), b"ready"))?;
        let commit_deadline = Instant::now() + Duration::from_secs(20);
        while !work.join("commit").exists() {
            if Instant::now() >= commit_deadline {
                return Err("update-cancelled".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let deadline = Instant::now() + Duration::from_secs(90);
        while identity(plan.parent_pid) == Some(plan.parent_start) {
            if Instant::now() >= deadline {
                return Err("update-close-timeout".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let outcome = install(&plan, work, prepared);
        drop(lock);
        let status = match &outcome {
            Ok(()) => "updated".into(),
            Err(e) => e.clone(),
        };
        let _ = fs::write(
            &plan.result,
            serde_json::to_vec(&status).unwrap_or_default(),
        );
        if outcome.as_ref().is_err_and(|e| e != "update-start-timeout") && plan.executable.exists()
        {
            let _ = Command::new(&plan.executable).env_remove(ACK_ENV).spawn();
        }
        if outcome.is_ok() && matches!(plan.kind, Kind::Msi | Kind::Nsis | Kind::Deb | Kind::Rpm) {
            let _ = Command::new(&plan.executable).env_remove(ACK_ENV).spawn();
        }
        if outcome.is_ok() {
            let _ = fs::remove_file(&plan.payload);
            let _ = fs::remove_file(&plan.manifest);
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(work.join("ready"));
            let _ = fs::remove_file(work.join("helper-ready"));
            let _ = fs::remove_file(work.join("commit"));
            // Windows can keep this running helper locked until the OS cleans temporary files.
            let helper_name = if cfg!(windows) {
                "vterm-update-helper.exe"
            } else {
                "vterm-update-helper"
            };
            let _ = fs::remove_file(work.join(helper_name));
            let _ = fs::remove_dir(work);
        }
        outcome
    })();
    if let Err(e) = result {
        eprintln!("{e}");
    }
    true
}

fn validate(plan: &Plan) -> Result<protocol::Asset, String> {
    if !protocol::platform_accepts(
        &plan.kind,
        &plan.arch,
        std::env::consts::OS,
        std::env::consts::ARCH,
    ) || !plan.target.is_absolute()
        || !plan.executable.is_absolute()
        || !plan.target.exists()
        || fs::symlink_metadata(&plan.target)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        || !protocol::newer(&plan.version, env!("CARGO_PKG_VERSION"))
    {
        return Err("update-plan".into());
    }
    let manifest = protocol::verified(
        &io(fs::read(&plan.manifest))?,
        protocol::PUBLIC_KEY,
        &plan.version,
    )?;
    let asset = protocol::select(&manifest, &plan.kind, &plan.arch)?.clone();
    protocol::verify_file(&plan.payload, &asset)?;
    Ok(asset)
}

type PreparedStage = Option<(tempfile::TempDir, PathBuf)>;
fn prepare(plan: &Plan) -> Result<PreparedStage, String> {
    if matches!(plan.kind, Kind::Msi | Kind::Nsis | Kind::Deb | Kind::Rpm) {
        return Ok(None);
    }
    let parent = plan.target.parent().ok_or("update-plan")?;
    // Stage on the destination volume. Never delete the old app before preparation succeeds.
    let stage = io(tempfile::Builder::new()
        .prefix(".vterm-update-")
        .tempdir_in(parent))?;
    let staged = stage.path().join(if plan.kind == Kind::Mac {
        "vterm.app"
    } else {
        "new"
    });
    if plan.kind == Kind::Mac {
        unpack_mac(&plan.payload, &staged)?;
        prepare_mac(&staged)?;
    } else {
        io(fs::copy(&plan.payload, &staged))?;
        io(fs::set_permissions(
            &staged,
            io(fs::metadata(&plan.target))?.permissions(),
        ))?;
    }
    let backup = parent.join(".vterm-previous");
    // A previous interrupted update is recoverable; never silently erase it.
    if backup.exists() {
        return Err("update-recovery-required".into());
    }
    Ok(Some((stage, staged)))
}

fn install(plan: &Plan, work: &Path, prepared: PreparedStage) -> Result<(), String> {
    validate(plan)?; // repeat after waiting; never trust a replaced staged download
    match plan.kind {
        Kind::Msi | Kind::Nsis | Kind::Deb | Kind::Rpm => {
            install_package(plan)?;
            return Ok(());
        }
        _ => {}
    }
    let (_stage, staged) = prepared.ok_or("update-plan")?;
    let parent = plan.target.parent().ok_or("update-plan")?;
    let backup = parent.join(".vterm-previous");
    let journal = parent.join(".vterm-update-transaction.json");
    io(fs::write(
        &journal,
        serde_json::to_vec(plan).map_err(|e| e.to_string())?,
    ))?;
    replace(&plan.target, &staged, &backup)?;
    let ack = work.join("ready");
    let mut child = match Command::new(&plan.executable).env(ACK_ENV, &ack).spawn() {
        Ok(child) => child,
        Err(error) => {
            restore(&plan.target, &backup)?;
            let _ = fs::remove_file(journal);
            return Err(format!("update-launch: {error}"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if fs::read_to_string(&ack).is_ok_and(|version| version == plan.version) {
            // Cleanup failure cannot turn a healthy launch into a second restart.
            // Leave the journal if the backup needs manual recovery/cleanup.
            if remove(&backup).is_ok() {
                let _ = fs::remove_file(&journal);
            }
            return Ok(());
        }
        if io(child.try_wait())?.is_some() {
            restore(&plan.target, &backup)?;
            let _ = fs::remove_file(journal);
            return Err("update-rolled-back".into());
        }
        if Instant::now() >= deadline {
            // A slow/live process must never be killed or have its files rolled back under it.
            return Err("update-start-timeout".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

pub fn replace(target: &Path, staged: &Path, backup: &Path) -> Result<(), String> {
    io(fs::rename(target, backup))?;
    if let Err(e) = fs::rename(staged, target) {
        io(fs::rename(backup, target))?;
        return Err(e.to_string());
    }
    Ok(())
}
fn restore(target: &Path, backup: &Path) -> Result<(), String> {
    remove(target)?;
    io(fs::rename(backup, target))
}

fn unpack_mac(payload: &Path, staged: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(io(fs::File::open(payload))?).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.enclosed_name().ok_or("update-archive")?;
        let relative = name
            .strip_prefix("vterm.app")
            .map_err(|_| "update-archive")?;
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("update-archive".into());
        }
        total = total.checked_add(entry.size()).ok_or("update-archive")?;
        if total > protocol::MAX_DOWNLOAD {
            return Err("update-archive".into());
        }
        let dest = staged.join(relative);
        if entry.is_dir() {
            io(fs::create_dir_all(&dest))?;
            continue;
        }
        io(fs::create_dir_all(dest.parent().ok_or("update-archive")?))?;
        let mut out = io(fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&dest))?;
        io(std::io::copy(&mut entry, &mut out))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            io(fs::set_permissions(
                &dest,
                fs::Permissions::from_mode(entry.unix_mode().unwrap_or(0o644) & 0o777),
            ))?;
        }
    }
    if !staged.join("Contents/MacOS/vterm").is_file() {
        return Err("update-archive".into());
    }
    Ok(())
}

fn prepare_mac(staged: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Only the verified vterm bundle; system Gatekeeper settings are never changed.
        let attrs = io(Command::new("/usr/bin/xattr")
            .args(["-r", "-l"])
            .arg(staged)
            .output())?;
        if !attrs.status.success() {
            return Err("update-quarantine".into());
        }
        if String::from_utf8_lossy(&attrs.stdout).contains("com.apple.quarantine") {
            run(Command::new("/usr/bin/xattr")
                .args(["-dr", "com.apple.quarantine"])
                .arg(staged))?;
        }
        let valid = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(staged)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !valid {
            run(Command::new("/usr/bin/codesign")
                .args(["--force", "--deep", "--sign", "-"])
                .arg(staged))?;
        }
        run(Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(staged))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = staged;
        Err("update-format".into())
    }
    #[cfg(target_os = "macos")]
    Ok(())
}

#[cfg(windows)]
fn windows_installer(plan: &Plan) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
    };
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }
    let file = wide(if plan.kind == Kind::Msi {
        std::ffi::OsStr::new("msiexec.exe")
    } else {
        plan.payload.as_os_str()
    });
    // Windows file names cannot contain quotes; the payload path is generated by us.
    let params = wide(std::ffi::OsStr::new(&if plan.kind == Kind::Msi {
        format!("/i \"{}\" /passive /norestart", plan.payload.display())
    } else {
        String::new()
    }));
    let verb = wide(std::ffi::OsStr::new("open"));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = 1;
    unsafe {
        if ShellExecuteExW(&mut info) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if info.hProcess.is_null() {
            return Err("update-install".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1;
        let ok = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if ok != 0 && (code == 0 || code == 3010) {
            Ok(())
        } else {
            Err(format!("update-install: {code}"))
        }
    }
}
fn install_package(plan: &Plan) -> Result<(), String> {
    match plan.kind {
        Kind::Deb => run(Command::new("pkexec")
            .args(["dpkg", "-i"])
            .arg(&plan.payload)),
        Kind::Rpm => run(Command::new("pkexec")
            .args(["rpm", "-U"])
            .arg(&plan.payload)),
        #[cfg(windows)]
        Kind::Msi | Kind::Nsis => windows_installer(plan),
        _ => Err("update-format".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_keeps_old_bytes_and_restores_on_failed_move() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("app");
        let staged = dir.path().join("new");
        let backup = dir.path().join("old");
        fs::write(&target, b"old").unwrap();
        fs::write(&staged, b"new").unwrap();
        replace(&target, &staged, &backup).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&backup).unwrap(), b"old");
        restore(&target, &backup).unwrap();
        assert!(replace(&target, &staged, &backup).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
    }
    #[test]
    fn process_identity_is_not_just_a_pid() {
        assert!(identity(std::process::id()).is_some());
    }

    #[test]
    fn archive_rejects_escaping_paths_symlinks_and_missing_executable() {
        for name in [
            "../escaped",
            "other.app/Contents/MacOS/vterm",
            "vterm.app/Contents/readme",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let payload = dir.path().join("update.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&payload).unwrap());
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"data").unwrap();
            zip.finish().unwrap();
            assert!(unpack_mac(&payload, &dir.path().join("stage")).is_err());
            assert!(!dir.path().join("escaped").exists());
        }
        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("update.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&payload).unwrap());
        zip.add_symlink(
            "vterm.app/Contents/MacOS/vterm",
            "/tmp/other",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.finish().unwrap();
        assert!(unpack_mac(&payload, &dir.path().join("stage")).is_err());
    }
}
