//! Secret storage in the OS keychain via the `keyring` crate.
//!
//! Two kinds of secrets are stored per server id:
//! - the login password (service `vterm:password`)
//! - the private-key passphrase (service `vterm:passphrase`)
//!
//! macOS uses the Keychain, Windows the Credential Manager.

use crate::error::AppResult;
use keyring::{Entry, Error};
use zeroize::Zeroizing;

const PASSWORD_SERVICE: &str = "vterm:password";
const PASSPHRASE_SERVICE: &str = "vterm:passphrase";
/// AI endpoint API key, keyed by endpoint id (Phase 17). Never logged.
const AI_KEY_SERVICE: &str = "vterm:ai-key";

/// Read a secret, wrapped in `Zeroizing` so vterm's in-memory copy is wiped on
/// drop (the keychain remains the authoritative store).
fn read(service: &str, id: &str) -> Option<Zeroizing<String>> {
    match Entry::new(service, id).and_then(|e| e.get_password()) {
        Ok(value) => Some(Zeroizing::new(value)),
        Err(Error::NoEntry) => None,
        Err(_) => None,
    }
}

fn write(service: &str, id: &str, value: &str) -> AppResult<()> {
    Entry::new(service, id)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("keychain write failed: {e}").into())
}

fn delete(service: &str, id: &str) -> AppResult<()> {
    match Entry::new(service, id).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}").into()),
    }
}

// ── Password ──────────────────────────────────────────────────────────────────

pub fn get_password(id: &str) -> Option<Zeroizing<String>> {
    read(PASSWORD_SERVICE, id)
}
pub fn set_password(id: &str, value: &str) -> AppResult<()> {
    write(PASSWORD_SERVICE, id, value)
}
pub fn delete_password(id: &str) -> AppResult<()> {
    delete(PASSWORD_SERVICE, id)
}

// ── Key passphrase ────────────────────────────────────────────────────────────

pub fn get_passphrase(id: &str) -> Option<Zeroizing<String>> {
    read(PASSPHRASE_SERVICE, id)
}
pub fn set_passphrase(id: &str, value: &str) -> AppResult<()> {
    write(PASSPHRASE_SERVICE, id, value)
}
pub fn delete_passphrase(id: &str) -> AppResult<()> {
    delete(PASSPHRASE_SERVICE, id)
}

// ── AI endpoint API key (Phase 17) ──────────────────────────────────────────────

pub fn get_ai_key(id: &str) -> Option<Zeroizing<String>> {
    read(AI_KEY_SERVICE, id)
}
pub fn set_ai_key(id: &str, value: &str) -> AppResult<()> {
    write(AI_KEY_SERVICE, id, value)
}
pub fn delete_ai_key(id: &str) -> AppResult<()> {
    delete(AI_KEY_SERVICE, id)
}

/// Remove all secrets for a server (used when the profile is deleted).
pub fn delete_all(id: &str) -> AppResult<()> {
    delete_password(id)?;
    delete_passphrase(id)
}
