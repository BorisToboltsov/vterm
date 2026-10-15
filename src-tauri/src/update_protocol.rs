//! Signed release metadata, shared by the app and its offline update helper.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub const REPO: &str = "https://github.com/BorisToboltsov/vterm";
pub const PUBLIC_KEY: &str = include_str!("../update-public-key.txt");
pub const MANIFEST: &str = "vterm-update.json";
pub const MAX_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Mac,
    Portable,
    PortableWebview2,
    Nsis,
    Msi,
    Appimage,
    Deb,
    Rpm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub kind: Kind,
    pub arch: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub assets: Vec<Asset>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

pub fn newer(version: &str, current: &str) -> bool {
    match (
        semver::Version::parse(version),
        semver::Version::parse(current),
    ) {
        (Ok(v), Ok(c)) => v > c && v.pre.is_empty(),
        _ => false,
    }
}

pub fn platform_accepts(kind: &Kind, arch: &str, os: &str, cpu: &str) -> bool {
    match os {
        "macos" => *kind == Kind::Mac && arch == "universal",
        "windows" => {
            matches!(
                kind,
                Kind::Portable | Kind::PortableWebview2 | Kind::Msi | Kind::Nsis
            ) && arch == cpu
        }
        "linux" => matches!(kind, Kind::Appimage | Kind::Deb | Kind::Rpm) && arch == cpu,
        _ => false,
    }
}

pub fn verified(bytes: &[u8], key: &str, version: &str) -> Result<Manifest, String> {
    let public: [u8; 32] = STANDARD
        .decode(key.trim())
        .map_err(|_| "update-key")?
        .try_into()
        .map_err(|_| "update-key")?;
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "update-manifest")?;
    let payload = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "update-manifest")?;
    let signature = Signature::from_slice(
        &STANDARD
            .decode(envelope.signature)
            .map_err(|_| "update-signature")?,
    )
    .map_err(|_| "update-signature")?;
    VerifyingKey::from_bytes(&public)
        .map_err(|_| "update-key")?
        .verify_strict(&payload, &signature)
        .map_err(|_| "update-signature")?;
    let manifest: Manifest = serde_json::from_slice(&payload).map_err(|_| "update-manifest")?;
    if manifest.schema != 1
        || manifest.version != version
        || semver::Version::parse(version).is_err()
    {
        return Err("update-manifest".into());
    }
    for asset in &manifest.assets {
        if asset.name.is_empty()
            || !asset
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || asset.size == 0
            || asset.size > MAX_DOWNLOAD
            || asset.sha256.len() != 64
            || !asset.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("update-manifest".into());
        }
    }
    Ok(manifest)
}

pub fn select<'a>(manifest: &'a Manifest, kind: &Kind, arch: &str) -> Result<&'a Asset, String> {
    let found: Vec<_> = manifest
        .assets
        .iter()
        .filter(|a| &a.kind == kind && a.arch == arch)
        .collect();
    if found.len() != 1 {
        return Err("update-format".into());
    }
    Ok(found[0])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn verify_file(path: &Path, asset: &Asset) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != asset.size {
        return Err("update-signature".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if hex(&hash.finalize()) != asset.sha256.to_lowercase() {
        return Err("update-signature".into());
    }
    Ok(())
}

pub fn asset_url(version: &str, name: &str) -> String {
    format!("{REPO}/releases/download/v{version}/{name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn signed(version: &str) -> (Vec<u8>, String) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let payload = serde_json::to_vec(&Manifest {
            schema: 1,
            version: version.into(),
            assets: vec![],
        })
        .unwrap();
        let env = Envelope {
            payload: STANDARD.encode(&payload),
            signature: STANDARD.encode(key.sign(&payload).to_bytes()),
        };
        (
            serde_json::to_vec(&env).unwrap(),
            STANDARD.encode(key.verifying_key().as_bytes()),
        )
    }
    #[test]
    fn signatures_bind_metadata_to_the_release_and_key() {
        let (bytes, key) = signed("1.19.0");
        assert!(verified(&bytes, &key, "1.19.0").is_ok());
        assert!(verified(&bytes, &key, "1.20.0").is_err());
        assert!(verified(&bytes, &STANDARD.encode([8; 32]), "1.19.0").is_err());
        assert!(verified(&bytes, "", "1.19.0").is_err());
        let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
        envelope.payload = STANDARD.encode(b"{}");
        assert!(verified(&serde_json::to_vec(&envelope).unwrap(), &key, "1.19.0").is_err());
    }
    #[test]
    fn helper_refuses_cross_platform_payloads() {
        assert!(platform_accepts(
            &Kind::Mac,
            "universal",
            "macos",
            "aarch64"
        ));
        assert!(!platform_accepts(
            &Kind::Portable,
            "x86_64",
            "macos",
            "x86_64"
        ));
        assert!(platform_accepts(
            &Kind::PortableWebview2,
            "x86_64",
            "windows",
            "x86_64"
        ));
        assert!(!platform_accepts(
            &Kind::Msi,
            "x86_64",
            "windows",
            "aarch64"
        ));
        assert!(platform_accepts(&Kind::Deb, "x86_64", "linux", "x86_64"));
        assert!(!platform_accepts(&Kind::Deb, "x86_64", "android", "x86_64"));
    }
    #[test]
    fn versions_are_semantic_and_never_downgrade() {
        assert!(newer("1.10.0", "1.9.0"));
        for v in ["1.9.0", "1.8.9", "1.10.0-beta.1", "latest", "v1.10.0"] {
            assert!(!newer(v, "1.9.0"));
        }
    }
    #[test]
    fn selects_exact_format_and_arch_and_rejects_duplicates() {
        let asset = Asset {
            kind: Kind::PortableWebview2,
            arch: "x86_64".into(),
            name: "full.exe".into(),
            size: 3,
            sha256: hex(&Sha256::digest(b"abc")),
        };
        let mut m = Manifest {
            schema: 1,
            version: "1.19.0".into(),
            assets: vec![asset.clone()],
        };
        assert!(select(&m, &Kind::Portable, "x86_64").is_err());
        assert!(select(&m, &Kind::PortableWebview2, "aarch64").is_err());
        assert!(select(&m, &Kind::PortableWebview2, "x86_64").is_ok());
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), b"abc").unwrap();
        assert!(verify_file(f.path(), &asset).is_ok());
        std::fs::write(f.path(), b"abd").unwrap();
        assert!(verify_file(f.path(), &asset).is_err());
        m.assets.push(asset);
        assert!(select(&m, &Kind::PortableWebview2, "x86_64").is_err());
    }
}
