//! Unified error type for the backend.
//!
//! Commands previously returned `Result<T, String>`; they now return
//! [`AppResult`] so error categories are typed (`thiserror`). Two variants carry
//! the markers the frontend matches on (`auth-rejected`, `host-key-rejected`).
//!
//! `AppError` serializes to its message string, so the value the frontend
//! receives from `invoke()` is unchanged (a plain string).

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Server rejected the credentials (distinct from a network/timeout error).
    /// The frontend matches the `auth-rejected` marker to re-prompt for a secret.
    #[error("auth-rejected: wrong password or key not accepted")]
    AuthRejected,

    /// The server's host key failed verification under the active policy.
    #[error("host-key-rejected: server key not trusted")]
    HostKeyRejected,

    /// No live SSH session is registered for the given id.
    #[error("no active session")]
    NoSession,

    /// No server profile matches the given id.
    #[error("unknown server")]
    UnknownServer,

    /// Any other, message-carrying error (network, I/O, protocol, validation…).
    #[error("{0}")]
    Message(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Message(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Message(s.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Message(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Message(e.to_string())
    }
}

// Tauri requires command error types to be `Serialize`. Serialize as the message
// string so the frontend keeps receiving a plain string (backward compatible).
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_are_present_in_display() {
        assert!(AppError::AuthRejected.to_string().contains("auth-rejected"));
        assert!(AppError::HostKeyRejected
            .to_string()
            .contains("host-key-rejected"));
    }

    #[test]
    fn message_passthrough_and_conversions() {
        assert_eq!(AppError::from("boom").to_string(), "boom");
        assert_eq!(AppError::from("x".to_string()).to_string(), "x");
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        assert!(AppError::from(io).to_string().contains("missing"));
    }

    #[test]
    fn serializes_as_plain_string() {
        let json = serde_json::to_string(&AppError::UnknownServer).unwrap();
        assert_eq!(json, "\"unknown server\"");
        let json = serde_json::to_string(&AppError::Message("oops".into())).unwrap();
        assert_eq!(json, "\"oops\"");
    }
}
