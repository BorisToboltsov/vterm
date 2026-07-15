//! SSH key-pair generation utility (Phase 32).
//!
//! A local, **offline** utility: it generates an OpenSSH key pair with the
//! `ssh-key` crate (the same one `russh` already pulls in — no network, no
//! shelling out to `ssh-keygen(1)`) and writes it under the user's chosen path
//! (default `~/.ssh/`). The private key is written `0600`, the public key `.pub`
//! alongside `0644`. Passphrase-encrypted keys use the same bcrypt-pbkdf +
//! aes256-ctr scheme OpenSSH uses, so the result is a drop-in `id_*` file that
//! both `ssh(1)` and vterm's own connect path ([`crate::ssh`]) read back.
//!
//! The backend is a dumb executor: which algorithm/name/path the user picked is
//! decided by the pure frontend logic in `src/lib/sshkeygen.ts`. Passphrase
//! material is wrapped in [`Zeroizing`] and never logged (security invariant).

use crate::error::{AppError, AppResult};
use ssh_key::private::RsaKeypair;
use ssh_key::{Algorithm, EcdsaCurve, HashAlg, LineEnding, PrivateKey};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Request from the frontend (`generateSshKey`). `path` may start with `~/`; it
/// is expanded against the user's home directory here.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    /// Algorithm id from the frontend registry: `ed25519` | `rsa-2048` |
    /// `rsa-4096` | `ecdsa-p256`.
    pub algorithm: String,
    /// Full destination path for the private key (public key gets `.pub`).
    pub path: String,
    /// Optional passphrase; empty/`None` writes an unencrypted key.
    #[serde(default)]
    pub passphrase: Option<String>,
    /// Optional comment (e.g. `user@host`) embedded in the public key.
    #[serde(default)]
    pub comment: Option<String>,
    /// Overwrite an existing file at `path`. Without it, an existing file is
    /// refused with [`AppError::KeyExists`] (never a silent clobber).
    #[serde(default)]
    pub overwrite: bool,
}

/// What the frontend needs after a successful generation.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    /// Absolute path the private key was written to.
    pub path: String,
    /// Absolute path of the `.pub` file.
    pub public_key_path: String,
    /// The OpenSSH public-key line (for "copy to authorized_keys").
    pub public_key: String,
    /// SHA-256 fingerprint (`SHA256:…`).
    pub fingerprint: String,
}

/// Parsed algorithm choice. RSA sizes are explicit because
/// `PrivateKey::random` hard-codes 4096 — we build the keypair directly instead.
enum KeySpec {
    Ed25519,
    Rsa(usize),
    Ecdsa(EcdsaCurve),
}

/// Map a frontend algorithm id to a [`KeySpec`]. Kept separate so it is unit-tested.
fn parse_algorithm(id: &str) -> AppResult<KeySpec> {
    match id {
        "ed25519" => Ok(KeySpec::Ed25519),
        "rsa-2048" => Ok(KeySpec::Rsa(2048)),
        "rsa-4096" => Ok(KeySpec::Rsa(4096)),
        "ecdsa-p256" => Ok(KeySpec::Ecdsa(EcdsaCurve::NistP256)),
        other => Err(AppError::Message(format!(
            "unsupported key algorithm: {other}"
        ))),
    }
}

/// Expand a leading `~` / `~/` against the home directory; other paths are
/// returned unchanged. Split out for unit-testing without touching disk.
fn expand_tilde(path: &str) -> PathBuf {
    let home = || directories::UserDirs::new().map(|u| u.home_dir().to_path_buf());
    if path == "~" {
        if let Some(h) = home() {
            return h;
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home() {
            return h.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Public-key path for a private-key path: OpenSSH appends a literal `.pub` to
/// the whole filename (so `id_ed25519` → `id_ed25519.pub`, not `id.pub`).
fn pub_path_for(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".pub");
    PathBuf::from(s)
}

/// Whether a key file already exists at `path` (after `~` expansion). Backs the
/// live collision hint in the generate dialog.
pub fn path_exists(path: &str) -> bool {
    expand_tilde(path).exists()
}

/// (Re)write the public key next to the private key (`<path>.pub`). Backs the
/// explicit "Save .pub" button on the result screen; the OpenSSH `.pub` is
/// already written during generation, so this is idempotent. Returns the path.
pub fn save_public_key(path: &str, public_key: &str) -> AppResult<String> {
    let pub_path = pub_path_for(&expand_tilde(path));
    std::fs::write(&pub_path, format!("{}\n", public_key.trim_end()))?;
    Ok(pub_path.to_string_lossy().into_owned())
}

/// Build an unencrypted private key for the given spec, using the OS CSPRNG
/// (`rand::rng()` → a rand_core 0.10 `CryptoRng`).
fn build_private_key(spec: KeySpec) -> AppResult<PrivateKey> {
    let map = |e: ssh_key::Error| AppError::Message(e.to_string());
    let mut rng = rand::rng();
    Ok(match spec {
        KeySpec::Ed25519 => PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(map)?,
        KeySpec::Ecdsa(curve) => {
            PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve }).map_err(map)?
        }
        KeySpec::Rsa(bits) => PrivateKey::from(RsaKeypair::random(&mut rng, bits).map_err(map)?),
    })
}

/// Create `dir` (and parents) if missing, with `0700` on Unix so `~/.ssh`
/// created on the fly is not world-readable.
fn ensure_key_dir(dir: &Path) -> AppResult<()> {
    if dir.as_os_str().is_empty() || dir.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Generate a key pair and write both files. CPU-heavy for RSA, so the command
/// wrapper runs this on a blocking thread.
pub fn generate(req: GenerateRequest) -> AppResult<GeneratedKey> {
    let spec = parse_algorithm(&req.algorithm)?;
    let path = expand_tilde(&req.path);
    if path.exists() && !req.overwrite {
        return Err(AppError::KeyExists);
    }

    let map = |e: ssh_key::Error| AppError::Message(e.to_string());
    let mut key = build_private_key(spec)?;
    if let Some(comment) = req.comment.as_deref().map(str::trim) {
        if !comment.is_empty() {
            key.set_comment(comment);
        }
    }

    // Public line + fingerprint are taken from the plaintext key (both are
    // public regardless of encryption) before we optionally encrypt the private.
    let public_key = key.public_key().to_openssh().map_err(map)?;
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();

    let to_write = match req.passphrase.as_deref() {
        Some(p) if !p.is_empty() => {
            let secret = Zeroizing::new(p.to_string());
            let mut rng = rand::rng();
            key.encrypt(&mut rng, secret.as_bytes()).map_err(map)?
        }
        _ => key,
    };

    if let Some(parent) = path.parent() {
        ensure_key_dir(parent)?;
    }
    to_write
        .write_openssh_file(&path, LineEnding::LF)
        .map_err(map)?;

    let pub_path = pub_path_for(&path);
    std::fs::write(&pub_path, format!("{public_key}\n"))?;

    Ok(GeneratedKey {
        path: path.to_string_lossy().into_owned(),
        public_key_path: pub_path.to_string_lossy().into_owned(),
        public_key,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::load_secret_key;

    #[test]
    fn parse_algorithm_maps_known_ids() {
        assert!(matches!(parse_algorithm("ed25519"), Ok(KeySpec::Ed25519)));
        assert!(matches!(
            parse_algorithm("rsa-2048"),
            Ok(KeySpec::Rsa(2048))
        ));
        assert!(matches!(
            parse_algorithm("rsa-4096"),
            Ok(KeySpec::Rsa(4096))
        ));
        assert!(matches!(
            parse_algorithm("ecdsa-p256"),
            Ok(KeySpec::Ecdsa(EcdsaCurve::NistP256))
        ));
        assert!(parse_algorithm("dsa").is_err());
        assert!(parse_algorithm("").is_err());
    }

    #[test]
    fn pub_path_appends_dot_pub_literally() {
        assert_eq!(
            pub_path_for(Path::new("/home/u/.ssh/id_ed25519")),
            PathBuf::from("/home/u/.ssh/id_ed25519.pub")
        );
        // A dotted name keeps its whole stem (OpenSSH appends, not replaces).
        assert_eq!(
            pub_path_for(Path::new("/tmp/key.v2")),
            PathBuf::from("/tmp/key.v2.pub")
        );
    }

    #[test]
    fn expand_tilde_leaves_plain_paths_untouched() {
        assert_eq!(expand_tilde("/etc/x"), PathBuf::from("/etc/x"));
        assert_eq!(expand_tilde("relative/x"), PathBuf::from("relative/x"));
        // `~/foo` resolves to an absolute path ending in the remainder.
        let expanded = expand_tilde("~/.ssh/id_ed25519");
        assert!(expanded.ends_with(".ssh/id_ed25519"));
        assert!(expanded.is_absolute() || directories::UserDirs::new().is_none());
    }

    #[test]
    fn generate_ed25519_writes_loadable_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        let out = generate(GenerateRequest {
            algorithm: "ed25519".into(),
            path: path.to_string_lossy().into_owned(),
            passphrase: None,
            comment: Some("me@host".into()),
            overwrite: false,
        })
        .unwrap();

        assert!(path.exists());
        assert!(Path::new(&out.public_key_path).exists());
        assert!(out.public_key.starts_with("ssh-ed25519 "));
        assert!(out.public_key.trim_end().ends_with("me@host"));
        assert!(out.fingerprint.starts_with("SHA256:"));
        // Loads without a passphrase (i.e. unencrypted).
        assert!(load_secret_key(&path, None).is_ok());
    }

    #[test]
    fn generate_with_passphrase_encrypts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        generate(GenerateRequest {
            algorithm: "ed25519".into(),
            path: path.to_string_lossy().into_owned(),
            passphrase: Some("s3cret".into()),
            comment: None,
            overwrite: false,
        })
        .unwrap();

        // Wrong/empty passphrase fails; the correct one succeeds.
        assert!(load_secret_key(&path, None).is_err());
        assert!(load_secret_key(&path, Some("s3cret")).is_ok());
    }

    #[test]
    fn generate_refuses_existing_without_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        let req = |overwrite: bool| GenerateRequest {
            algorithm: "ed25519".into(),
            path: path.to_string_lossy().into_owned(),
            passphrase: None,
            comment: None,
            overwrite,
        };
        generate(req(false)).unwrap();
        // Second run without overwrite is refused with the typed marker.
        assert!(matches!(generate(req(false)), Err(AppError::KeyExists)));
        // With overwrite it succeeds (regenerates in place).
        assert!(generate(req(true)).is_ok());
    }

    #[test]
    fn save_public_key_writes_pub_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let priv_path = dir.path().join("id_ed25519");
        let out =
            save_public_key(&priv_path.to_string_lossy(), "ssh-ed25519 AAAAC3Nz me@host").unwrap();
        assert_eq!(out, format!("{}.pub", priv_path.to_string_lossy()));
        let body = std::fs::read_to_string(&out).unwrap();
        assert_eq!(body, "ssh-ed25519 AAAAC3Nz me@host\n");
    }

    #[cfg(unix)]
    #[test]
    fn private_key_is_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        generate(GenerateRequest {
            algorithm: "ed25519".into(),
            path: path.to_string_lossy().into_owned(),
            passphrase: None,
            comment: None,
            overwrite: false,
        })
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
