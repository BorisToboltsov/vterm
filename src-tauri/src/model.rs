use serde::{Deserialize, Serialize};

/// How vterm authenticates to a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Password,
    Key,
}

/// Kind of proxy used to reach a server. Only `Jump` (an SSH bastion / ProxyJump)
/// is implemented so far; `Socks5`/`Http` are reserved so the data model and UI
/// are ready — selecting them yields a typed `proxy-unsupported` error at connect
/// time until the transports land (see ssh.rs / lib.rs `connect_session`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    /// Intermediate SSH server (bastion): a `direct-tcpip` tunnel to the target.
    #[default]
    Jump,
    /// Generic SOCKS5 proxy (reserved — not yet implemented).
    Socks5,
    /// HTTP CONNECT proxy (reserved — not yet implemented).
    Http,
}

/// A proxy/jump host a server connects through. Mirrors `ServerProxy` in
/// src/lib/types.ts. Like the parent profile, secrets never live here — the jump
/// host's password/passphrase are in the keychain under a proxy-scoped id
/// (`secrets.rs`); `has_saved_password` is a UI hint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProxy {
    #[serde(default)]
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    /// Login on the jump host (SSH jump kind).
    #[serde(default)]
    pub username: String,
    /// Auth method for the jump host (SSH jump kind).
    #[serde(default)]
    pub auth_method: AuthMethod,
    /// Path to the jump host's private key (used when `auth_method == Key`).
    #[serde(default)]
    pub key_path: Option<String>,
    /// Whether a proxy secret is stored in the keychain — a UI hint.
    #[serde(default)]
    pub has_saved_password: bool,
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
    /// Mark this server off-limits to the AI assistant: the frontend blocks
    /// attaching session context, executing proposed commands, and auto-run
    /// (Phase 17.7 — production safety).
    #[serde(default)]
    pub no_ai: bool,
    /// Chat prompt (by id, from `settings.ai.prompts.chat`) the assistant uses on
    /// this server; None → the active chat prompt. Frontend-owned reference.
    #[serde(default)]
    pub chat_prompt_id: Option<String>,
    /// Per-server command-execution mode override (`suggest`/`confirm`/`auto`);
    /// None → the global `settings.ai.execMode`. Frontend-owned value.
    #[serde(default)]
    pub exec_mode: Option<String>,
    /// Optional proxy/jump host this server connects through (None → direct).
    #[serde(default)]
    pub proxy: Option<ServerProxy>,
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
    #[serde(default)]
    pub no_ai: bool,
    #[serde(default)]
    pub chat_prompt_id: Option<String>,
    #[serde(default)]
    pub exec_mode: Option<String>,
    #[serde(default)]
    pub proxy: Option<ServerProxy>,
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
            no_ai: true,
            chat_prompt_id: Some("p-1".into()),
            exec_mode: Some("confirm".into()),
            proxy: Some(ServerProxy {
                kind: ProxyKind::Jump,
                host: "bastion.corp".into(),
                port: 22,
                username: "jump".into(),
                auth_method: AuthMethod::Key,
                key_path: Some("/home/u/.ssh/jump".into()),
                has_saved_password: false,
            }),
        };
        let json = serde_json::to_string(&p).unwrap();
        // Field names must be camelCase for the TS frontend.
        assert!(json.contains("\"authMethod\":\"key\""));
        assert!(json.contains("\"keyPath\""));
        assert!(json.contains("\"hasSavedPassword\":true"));
        assert!(json.contains("\"autoRecord\":true"));
        assert!(json.contains("\"noAi\":true"));
        assert!(json.contains("\"proxy\":{"));
        assert!(json.contains("\"kind\":\"jump\""));
        let back: ServerProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "srv-1");
        assert_eq!(back.port, 2222);
        assert_eq!(back.auth_method, AuthMethod::Key);
        assert_eq!(back.tags, vec!["web", "eu"]);
        assert!(back.auto_record);
        assert!(back.no_ai);
        assert_eq!(back.chat_prompt_id.as_deref(), Some("p-1"));
        assert_eq!(back.exec_mode.as_deref(), Some("confirm"));
        let proxy = back.proxy.expect("proxy round-trips");
        assert_eq!(proxy.kind, ProxyKind::Jump);
        assert_eq!(proxy.host, "bastion.corp");
        assert_eq!(proxy.auth_method, AuthMethod::Key);
    }

    #[test]
    fn proxy_kind_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&ProxyKind::Jump).unwrap(), "\"jump\"");
        assert_eq!(
            serde_json::to_string(&ProxyKind::Socks5).unwrap(),
            "\"socks5\""
        );
        assert_eq!(serde_json::to_string(&ProxyKind::Http).unwrap(), "\"http\"");
        assert_eq!(ProxyKind::default(), ProxyKind::Jump);
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
        assert!(!p.no_ai); // legacy profiles default to AI-allowed
        assert_eq!(p.chat_prompt_id, None);
        assert_eq!(p.exec_mode, None);
        assert!(p.proxy.is_none()); // legacy profiles default to a direct connection
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
