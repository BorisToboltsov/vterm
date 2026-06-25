use serde::{Deserialize, Serialize};

/// How vterm authenticates to a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Password,
    Key,
}

/// A saved SSH server. Mirrors `ServerProfile` in src/lib/types.ts.
/// Note: secrets are never stored on this struct — passwords and key passphrases
/// live in the OS keychain (see secrets.rs). `has_saved_password` is a UI hint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    /// Path to a private key file (used when `auth_method == Key`).
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_saved_password: bool,
    /// Optional group/folder for organizing the server list.
    #[serde(default)]
    pub group: Option<String>,
    /// Free-form tags for filtering/search.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Automatically start recording when a session to this server connects
    /// (e.g. for production servers — an audit trail of every session).
    #[serde(default)]
    pub auto_record: bool,
}

/// Payload for creating/updating a profile. The backend assigns the `id`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewServerProfile {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub auto_record: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_method_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&AuthMethod::Password).unwrap(),
            "\"password\""
        );
        assert_eq!(serde_json::to_string(&AuthMethod::Key).unwrap(), "\"key\"");
        assert_eq!(AuthMethod::default(), AuthMethod::Password);
    }

    #[test]
    fn server_profile_round_trips_camel_case() {
        let p = ServerProfile {
            id: "srv-1".into(),
            alias: "Web".into(),
            host: "10.0.0.1".into(),
            port: 2222,
            username: "root".into(),
            auth_method: AuthMethod::Key,
            key_path: Some("/home/u/.ssh/id_ed25519".into()),
            has_saved_password: true,
            group: Some("Prod/EU".into()),
            tags: vec!["web".into(), "eu".into()],
            auto_record: true,
        };
        let json = serde_json::to_string(&p).unwrap();
        // Field names must be camelCase for the TS frontend.
        assert!(json.contains("\"authMethod\":\"key\""));
        assert!(json.contains("\"keyPath\""));
        assert!(json.contains("\"hasSavedPassword\":true"));
        assert!(json.contains("\"autoRecord\":true"));
        let back: ServerProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "srv-1");
        assert_eq!(back.port, 2222);
        assert_eq!(back.auth_method, AuthMethod::Key);
        assert_eq!(back.tags, vec!["web", "eu"]);
        assert!(back.auto_record);
    }

    #[test]
    fn server_profile_defaults_for_legacy_json() {
        // An old profile from before group/tags/auth_method existed.
        let legacy = r#"{
            "id": "srv-old",
            "alias": "Legacy",
            "host": "host",
            "port": 22,
            "username": "u"
        }"#;
        let p: ServerProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(p.auth_method, AuthMethod::Password);
        assert_eq!(p.key_path, None);
        assert!(!p.has_saved_password);
        assert_eq!(p.group, None);
        assert!(p.tags.is_empty());
        assert!(!p.auto_record); // legacy profiles default to off
    }

    #[test]
    fn new_server_profile_defaults() {
        let payload = r#"{"alias":"A","host":"h","port":22,"username":"u"}"#;
        let np: NewServerProfile = serde_json::from_str(payload).unwrap();
        assert_eq!(np.auth_method, AuthMethod::Password);
        assert!(np.tags.is_empty());
        assert_eq!(np.group, None);
    }
}
