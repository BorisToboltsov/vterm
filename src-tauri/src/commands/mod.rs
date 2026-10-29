// Tauri commands of the bridge layer (INVARIANTS principle 1): the commands that
// work on the shared `AppState` — sessions, local shells, cancel flags — and the
// private bridges between them. A command of one domain over its own data lives
// in that domain's module (`servers.rs`, `folders.rs`, …); `lib.rs` only keeps
// the state, the helpers every command here shares, and the registration in
// `generate_handler!`.

pub mod ai;
pub mod backup;
pub mod chrome;
pub mod drivers;
pub mod recording;
pub mod session;
pub mod sftp;

/// The bridge layer's production code — `lib.rs` and every module here, each
/// cut before its test module — for the gates that read how a command is
/// written. A module added here goes into [`BRIDGE`] too; a test holds the list
/// complete, so a command cannot move out of the gates' sight.
#[cfg(test)]
pub(crate) fn bridge_source() -> String {
    BRIDGE
        .iter()
        .map(|(_, src)| {
            let src = src.replace("\r\n", "\n");
            let end = src
                .match_indices("#[cfg(test)]")
                .find(|(i, m)| src[i + m.len()..].trim_start().starts_with("mod "))
                .map_or(src.len(), |(i, _)| i);
            src[..end].to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
const BRIDGE: &[(&str, &str)] = &[
    ("../lib.rs", include_str!("../lib.rs")),
    ("ai.rs", include_str!("ai.rs")),
    ("backup.rs", include_str!("backup.rs")),
    ("chrome.rs", include_str!("chrome.rs")),
    ("drivers.rs", include_str!("drivers.rs")),
    ("recording.rs", include_str!("recording.rs")),
    ("session.rs", include_str!("session.rs")),
    ("sftp.rs", include_str!("sftp.rs")),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_source_lists_every_command_module() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".rs") && n != "mod.rs")
            .collect();
        on_disk.sort();
        let listed: Vec<&str> = BRIDGE.iter().skip(1).map(|(n, _)| *n).collect();
        assert_eq!(on_disk, listed);
    }

    #[test]
    fn the_bridge_source_holds_the_commands_without_their_tests() {
        let src = bridge_source();
        for name in [
            "async fn connect_session(",
            "async fn git_run(",
            "async fn end_session(",
        ] {
            assert!(src.contains(name), "{name}");
        }
        assert!(!src.contains("mod tests {"));
    }
}
