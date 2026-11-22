use crate::error::{AppError, AppResult};
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
    /// Whether a sudo password is saved in the keychain for this server (ADR
    /// 0073): a hint for the form, set when sudo took one with "remember", cleared
    /// with the server's other secrets.
    #[serde(default)]
    pub has_saved_sudo: bool,
    /// Optional group/folder for organizing the server list.
    #[serde(default)]
    pub group: Option<String>,
    /// Free-form tags for filtering/search.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Production flag: confirmations and no autonomous AI (enforced by the
    /// frontend). `None` = saved before the flag existed — the frontend then falls
    /// back to the old exact `prod`/`production` tag convention.
    #[serde(default)]
    pub prod: Option<bool>,
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
    /// How path sync ("follow terminal") starts on this server: `auto` — on every
    /// connect, `manual` — by hand, without the question; None → ask when it is
    /// turned on. Frontend-owned value (`pathsync.ts`): a value it does not know
    /// reads as None there, so a mode added by a newer build never makes the
    /// profiles file unreadable for an older one.
    #[serde(default)]
    pub path_sync: Option<String>,
    /// Free-form user notes (Markdown) about this server. Edited in the notes
    /// window, not the server form; `update_server` leaves it untouched so the two
    /// paths never clobber each other. Persisted inline in the profiles JSON.
    #[serde(default)]
    pub notes: String,
    /// Pictogram key shown before the alias in the list (see `servericons.ts`).
    /// Empty → the generic server glyph. Frontend-owned value.
    #[serde(default)]
    pub icon: String,
    /// Colour key tinting the pictogram (see `servericons.ts`). Empty → muted.
    #[serde(default)]
    pub icon_color: String,
    /// The server's other logins (ADR 0074); the profile's own `username` /
    /// `auth_method` / `key_path` are its first login, id `""`. Older builds read
    /// the first alone.
    #[serde(default)]
    pub logins: Vec<ServerLogin>,
    /// The login a plain "Connect" uses: `""` — the first; an id of `logins`
    /// otherwise (one that is gone reads as the first).
    #[serde(default)]
    pub default_login: String,
    /// Ask which login on every connect, instead of the default one.
    #[serde(default)]
    pub ask_login: bool,
    /// The databases this server reaches (ADR 0080): spoken to through its SSH
    /// connection, addressed as the server sees them. Older builds read none.
    #[serde(default)]
    pub databases: Vec<DbProfile>,
}

/// Which database server a profile speaks to (ADR 0080).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    Mysql,
}

/// A database a server — or this computer — reaches (ADR 0080). `host` is as
/// the server sees it (`127.0.0.1`, a container's address, a host of its
/// network) or, starting with `/`, a unix socket: PostgreSQL's socket folder,
/// MySQL's socket file. Its password lives in the keychain under
/// `secrets::db_scope`, never here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbProfile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub has_saved_password: bool,
    /// Opened read-only. A prod server's databases are read-only whatever this says.
    #[serde(default)]
    pub read_only: bool,
    /// The container it was found in: the console runs its client there.
    #[serde(default)]
    pub container: Option<String>,
}

/// Another login of a server (ADR 0074): whom it logs in as and how. Its
/// secrets live in the keychain under its own scope (`secrets::login_scope`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerLogin {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_saved_password: bool,
    #[serde(default)]
    pub has_saved_sudo: bool,
}

/// A login as the form sends it: the window names a new one's id itself
/// (`crypto.randomUUID`), so its secret can be saved under it at once.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewServerLogin {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
}

/// Which login a tab connects with: a saved one (`""` — the profile's own), or a
/// user typed for this connection only, logging in with a password.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum LoginChoice {
    Saved { id: String },
    Once { once: String },
}

/// A login resolved against its profile: whom to log in as, how, and where its
/// secrets are in the keychain (`None` for a one-off login — nothing is kept).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLogin {
    /// `Some("")` — the profile's own login; `Some(id)` — one of `logins`.
    pub login_id: Option<String>,
    pub username: String,
    pub auth_method: AuthMethod,
    pub key_path: Option<String>,
    pub scope: Option<String>,
}

/// A login id the keychain scope and the store can carry: short, plain.
pub fn valid_login_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A user name as `ssh` would take it: no spaces, no control characters.
pub fn valid_login_user(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name.len() <= 64
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The logins the form sends, merged into what was saved: the hints of what is
/// in the keychain stay with each id; ids that are gone come back to have their
/// secrets removed. Refused: a bad id, an id twice, an empty user.
pub fn merge_logins(
    old: &[ServerLogin],
    new: Vec<NewServerLogin>,
) -> AppResult<(Vec<ServerLogin>, Vec<String>)> {
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::with_capacity(new.len());
    for l in new {
        if !valid_login_id(&l.id) || !seen.insert(l.id.clone()) {
            return Err(AppError::Message(format!(
                "a login id is not usable: {}",
                l.id
            )));
        }
        if !valid_login_user(&l.username) {
            return Err(AppError::Message("a login needs a user name".into()));
        }
        let was = old.iter().find(|o| o.id == l.id);
        merged.push(ServerLogin {
            id: l.id,
            username: l.username.trim().to_string(),
            auth_method: l.auth_method,
            key_path: l.key_path,
            has_saved_password: was.is_some_and(|w| w.has_saved_password),
            has_saved_sudo: was.is_some_and(|w| w.has_saved_sudo),
        });
    }
    let gone = old
        .iter()
        .filter(|o| !merged.iter().any(|m| m.id == o.id))
        .map(|o| o.id.clone())
        .collect();
    Ok((merged, gone))
}

impl ServerProfile {
    /// The login a plain connect uses: the default one, or the first when the
    /// default is gone.
    pub fn default_login_id(&self) -> &str {
        if self.logins.iter().any(|l| l.id == self.default_login) {
            &self.default_login
        } else {
            ""
        }
    }

    /// Whom a tab logs in as (`None` — the default login), or `LoginGone` when
    /// the login it names was removed from the profile meanwhile.
    pub fn resolve_login(&self, choice: Option<&LoginChoice>) -> AppResult<ResolvedLogin> {
        let id = match choice {
            Some(LoginChoice::Once { once }) => {
                if !valid_login_user(once) {
                    return Err(AppError::Message(format!("not a user name: {once}")));
                }
                return Ok(ResolvedLogin {
                    login_id: None,
                    username: once.trim().to_string(),
                    auth_method: AuthMethod::Password,
                    key_path: None,
                    scope: None,
                });
            }
            Some(LoginChoice::Saved { id }) => id.as_str(),
            None => self.default_login_id(),
        };
        if id.is_empty() {
            return Ok(ResolvedLogin {
                login_id: Some(String::new()),
                username: self.username.clone(),
                auth_method: self.auth_method,
                key_path: self.key_path.clone(),
                scope: Some(crate::secrets::login_scope(&self.id, "")),
            });
        }
        let l = self
            .logins
            .iter()
            .find(|l| l.id == id)
            .ok_or(AppError::LoginGone)?;
        Ok(ResolvedLogin {
            login_id: Some(l.id.clone()),
            username: l.username.clone(),
            auth_method: l.auth_method,
            key_path: l.key_path.clone(),
            scope: Some(crate::secrets::login_scope(&self.id, &l.id)),
        })
    }

    /// The keychain hints of a login: (password saved, sudo password saved).
    pub fn login_hints_mut(&mut self, login_id: &str) -> Option<(&mut bool, &mut bool)> {
        if login_id.is_empty() {
            return Some((&mut self.has_saved_password, &mut self.has_saved_sudo));
        }
        self.logins
            .iter_mut()
            .find(|l| l.id == login_id)
            .map(|l| (&mut l.has_saved_password, &mut l.has_saved_sudo))
    }

    /// The ids of the other logins — whose keychain scopes go with the server.
    pub fn login_ids(&self) -> Vec<String> {
        self.logins.iter().map(|l| l.id.clone()).collect()
    }

    /// Ids of the server's databases (ADR 0080) — whose passwords go with it.
    pub fn database_ids(&self) -> Vec<String> {
        self.databases.iter().map(|d| d.id.clone()).collect()
    }

    /// Whether this is a production server. The same rule as `isProdServer`
    /// (aiexec.ts): the explicit flag wins; a profile saved before the flag
    /// existed (`None`) falls back to an exact `prod`/`production` tag (case-
    /// insensitive, trimmed) — never a substring, or `non-prod` would count.
    pub fn is_prod(&self) -> bool {
        self.prod.unwrap_or_else(|| {
            self.tags.iter().any(|t| {
                let t = t.trim();
                t.eq_ignore_ascii_case("prod") || t.eq_ignore_ascii_case("production")
            })
        })
    }

    /// Whether the assistant's dialog modes may run commands here (`ai_exec`):
    /// never on a prod server, never on one marked off-limits to the assistant.
    pub fn ai_exec_allowed(&self) -> bool {
        !self.no_ai && !self.is_prod()
    }
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
    pub prod: Option<bool>,
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
    #[serde(default)]
    pub path_sync: Option<String>,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub icon_color: String,
    #[serde(default)]
    pub logins: Vec<NewServerLogin>,
    #[serde(default)]
    pub default_login: String,
    #[serde(default)]
    pub ask_login: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_logins() -> ServerProfile {
        let mut p: ServerProfile = serde_json::from_value(serde_json::json!({
            "id": "srv", "alias": "web", "host": "h", "port": 22, "username": "root",
            "authMethod": "key", "keyPath": "/k"
        }))
        .unwrap();
        p.logins = vec![ServerLogin {
            id: "dep".into(),
            username: "deploy".into(),
            auth_method: AuthMethod::Password,
            key_path: None,
            has_saved_password: true,
            has_saved_sudo: true,
        }];
        p
    }

    fn new_login(id: &str, user: &str) -> NewServerLogin {
        NewServerLogin {
            id: id.into(),
            username: user.into(),
            auth_method: AuthMethod::Password,
            key_path: None,
        }
    }

    #[test]
    fn a_profile_of_an_older_build_has_one_login_its_own() {
        let p: ServerProfile = serde_json::from_value(serde_json::json!({
            "id": "srv", "alias": "web", "host": "h", "port": 22, "username": "root"
        }))
        .unwrap();
        assert!(p.logins.is_empty());
        assert_eq!(p.default_login_id(), "");
        let first = p.resolve_login(None).unwrap();
        assert_eq!(
            (first.username.as_str(), first.scope.as_deref()),
            ("root", Some("srv"))
        );
    }

    #[test]
    fn each_login_resolves_to_its_user_and_its_own_keychain_scope() {
        let mut p = with_logins();
        let dep = p
            .resolve_login(Some(&LoginChoice::Saved { id: "dep".into() }))
            .unwrap();
        assert_eq!(dep.username, "deploy");
        assert_eq!(dep.auth_method, AuthMethod::Password);
        assert_eq!(dep.scope.as_deref(), Some("srv::login::dep"));
        assert_eq!(dep.login_id.as_deref(), Some("dep"));
        // The default follows the profile; a default that is gone is the first.
        p.default_login = "dep".into();
        assert_eq!(p.resolve_login(None).unwrap().username, "deploy");
        p.default_login = "gone".into();
        assert_eq!(p.resolve_login(None).unwrap().username, "root");
    }

    #[test]
    fn a_removed_login_is_said_not_swapped_for_another() {
        let p = with_logins();
        assert!(matches!(
            p.resolve_login(Some(&LoginChoice::Saved { id: "gone".into() })),
            Err(AppError::LoginGone)
        ));
    }

    #[test]
    fn a_one_off_login_logs_in_with_a_password_and_keeps_nothing() {
        let p = with_logins();
        let once = p
            .resolve_login(Some(&LoginChoice::Once {
                once: " admin ".into(),
            }))
            .unwrap();
        assert_eq!(once.username, "admin");
        assert_eq!(once.auth_method, AuthMethod::Password);
        assert_eq!((once.scope, once.login_id), (None, None));
        assert!(p
            .resolve_login(Some(&LoginChoice::Once { once: "a b".into() }))
            .is_err());
    }

    #[test]
    fn the_choice_comes_from_the_window_as_an_id_or_a_user() {
        let saved: LoginChoice = serde_json::from_str(r#"{"id":""}"#).unwrap();
        assert_eq!(saved, LoginChoice::Saved { id: String::new() });
        let once: LoginChoice = serde_json::from_str(r#"{"once":"admin"}"#).unwrap();
        assert_eq!(
            once,
            LoginChoice::Once {
                once: "admin".into()
            }
        );
    }

    #[test]
    fn merging_the_forms_logins_keeps_the_hints_and_names_what_went() {
        let old = with_logins().logins;
        let (merged, gone) = merge_logins(
            &old,
            vec![new_login("dep", " deployer "), new_login("adm", "admin")],
        )
        .unwrap();
        assert_eq!(merged[0].username, "deployer");
        assert!(
            merged[0].has_saved_password && merged[0].has_saved_sudo,
            "the keychain hints stay with the id"
        );
        assert!(!merged[1].has_saved_password);
        assert!(gone.is_empty());
        let (_, gone) = merge_logins(&merged, vec![new_login("adm", "admin")]).unwrap();
        assert_eq!(gone, ["dep"]);
    }

    #[test]
    fn a_login_the_store_or_the_keychain_could_not_carry_is_refused() {
        assert!(merge_logins(&[], vec![new_login("a::b", "u")]).is_err());
        assert!(merge_logins(&[], vec![new_login("", "u")]).is_err());
        assert!(merge_logins(&[], vec![new_login("a", "u"), new_login("a", "v")]).is_err());
        assert!(merge_logins(&[], vec![new_login("a", "  ")]).is_err());
    }

    #[test]
    fn the_keychain_hints_of_a_login_are_its_own() {
        let mut p = with_logins();
        *p.login_hints_mut("").unwrap().0 = true;
        assert!(p.has_saved_password);
        *p.login_hints_mut("dep").unwrap().1 = false;
        assert!(!p.logins[0].has_saved_sudo);
        assert!(p.login_hints_mut("gone").is_none());
    }

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
            has_saved_sudo: false,
            group: Some("Prod/EU".into()),
            tags: vec!["web".into(), "eu".into()],
            prod: Some(true),
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
            path_sync: Some("auto".into()),
            notes: "deploys via CI\nkeep npm cache warm".into(),
            icon: "database".into(),
            icon_color: "green".into(),
            logins: Vec::new(),
            default_login: String::new(),
            ask_login: false,
            databases: Vec::new(),
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
        assert_eq!(back.prod, Some(true));
        assert!(json.contains("\"prod\":true"));
        assert!(back.auto_record);
        assert!(back.no_ai);
        assert_eq!(back.chat_prompt_id.as_deref(), Some("p-1"));
        assert_eq!(back.exec_mode.as_deref(), Some("confirm"));
        assert_eq!(back.path_sync.as_deref(), Some("auto"));
        assert!(json.contains("\"pathSync\":\"auto\"")); // camelCase for the TS frontend
        assert_eq!(back.notes, "deploys via CI\nkeep npm cache warm");
        assert_eq!(back.icon, "database");
        assert_eq!(back.icon_color, "green");
        assert!(json.contains("\"iconColor\":\"green\"")); // camelCase for the TS frontend
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
        assert_eq!(p.path_sync, None); // legacy profiles ask before path sync
        assert!(p.proxy.is_none()); // legacy profiles default to a direct connection

        // No flag saved yet — `None`, so the frontend can fall back to the old
        // prod-tag convention instead of silently dropping production safeguards.
        assert_eq!(p.prod, None);
    }

    fn profile(prod: Option<bool>, tags: &[&str], no_ai: bool) -> ServerProfile {
        let mut p: ServerProfile =
            serde_json::from_str(r#"{"id":"1","alias":"a","host":"h","port":22,"username":"u"}"#)
                .unwrap();
        p.prod = prod;
        p.tags = tags.iter().map(|t| t.to_string()).collect();
        p.no_ai = no_ai;
        p
    }

    /// The same cases as `isProdServer` in aiexec.test.ts.
    #[test]
    fn prod_is_the_flag_or_for_legacy_profiles_an_exact_tag() {
        assert!(profile(Some(true), &[], false).is_prod());
        assert!(!profile(Some(false), &["prod"], false).is_prod()); // the flag wins
        assert!(profile(None, &["prod"], false).is_prod());
        assert!(profile(None, &[" Production "], false).is_prod());
        assert!(profile(None, &["PROD"], false).is_prod());
        assert!(!profile(
            None,
            &["non-prod", "pre-prod", "prod-like", "staging"],
            false
        )
        .is_prod());
        assert!(!profile(None, &[], false).is_prod());
    }

    #[test]
    fn ai_exec_runs_only_off_prod_and_where_the_assistant_is_allowed() {
        assert!(profile(Some(false), &[], false).ai_exec_allowed());
        assert!(!profile(Some(true), &[], false).ai_exec_allowed());
        assert!(!profile(None, &["production"], false).ai_exec_allowed());
        assert!(!profile(Some(false), &[], true).ai_exec_allowed());
    }

    #[test]
    fn new_server_profile_defaults() {
        let payload = r#"{"alias":"A","host":"h","port":22,"username":"u"}"#;
        let np: NewServerProfile = serde_json::from_str(payload).unwrap();
        assert_eq!(np.auth_method, AuthMethod::Password);
        assert!(np.tags.is_empty());
        assert_eq!(np.group, None);
        assert_eq!(np.prod, None);
        assert_eq!(np.path_sync, None);
    }
}
