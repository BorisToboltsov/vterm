//! Optional server-side tools (Phase 12.8): linters (yamllint/shellcheck/hadolint/
//! ruff) and the monitoring helper `sensors` (lm-sensors). vterm can detect the
//! server's package manager + which tools are present, and resolve the right
//! install command per distro. Installation itself runs on the server (its package
//! manager, its network, with sudo) — vterm only issues the command, transparently.

use serde::Serialize;
use std::collections::HashSet;

/// A known optional tool. `purpose` is a stable id the frontend localizes.
pub struct Tool {
    pub id: &'static str,
    pub name: &'static str,
    pub bin: &'static str,
}

/// The catalogue. Extension point: add an entry + a branch in [`install_command`].
pub const TOOLS: &[Tool] = &[
    Tool {
        id: "shellcheck",
        name: "shellcheck",
        bin: "shellcheck",
    },
    Tool {
        id: "yamllint",
        name: "yamllint",
        bin: "yamllint",
    },
    Tool {
        id: "hadolint",
        name: "hadolint",
        bin: "hadolint",
    },
    Tool {
        id: "ruff",
        name: "ruff",
        bin: "ruff",
    },
    Tool {
        id: "sensors",
        name: "lm-sensors",
        bin: "sensors",
    },
];

/// One tool's status on the active server, sent to the frontend.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// Install command for the detected manager (None if unknown/unsupported).
    pub command: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    /// Detected package manager ("apt"/"dnf"/…) or empty.
    pub manager: String,
    pub tools: Vec<ToolStatus>,
}

/// Shell that prints `mgr=<name>` then `have=<bin>` for each installed tool — one
/// round-trip to detect the package manager and every tool's presence.
pub fn status_command() -> String {
    let mut s = String::from(
        "if command -v apt-get >/dev/null 2>&1; then printf 'mgr=apt\\n'; \
         elif command -v dnf >/dev/null 2>&1; then printf 'mgr=dnf\\n'; \
         elif command -v yum >/dev/null 2>&1; then printf 'mgr=yum\\n'; \
         elif command -v apk >/dev/null 2>&1; then printf 'mgr=apk\\n'; \
         elif command -v pacman >/dev/null 2>&1; then printf 'mgr=pacman\\n'; \
         elif command -v zypper >/dev/null 2>&1; then printf 'mgr=zypper\\n'; \
         elif command -v brew >/dev/null 2>&1; then printf 'mgr=brew\\n'; \
         elif command -v pkg >/dev/null 2>&1; then printf 'mgr=pkg\\n'; \
         else printf 'mgr=\\n'; fi; ",
    );
    for t in TOOLS {
        s.push_str(&format!(
            "command -v {0} >/dev/null 2>&1 && printf 'have={0}\\n'; ",
            t.bin
        ));
    }
    s
}

/// Parse [`status_command`] output into (manager, set of present bins).
pub fn parse_status(raw: &str) -> (String, HashSet<String>) {
    let mut manager = String::new();
    let mut have = HashSet::new();
    for line in raw.lines() {
        if let Some(m) = line.strip_prefix("mgr=") {
            manager = m.trim().to_string();
        } else if let Some(b) = line.strip_prefix("have=") {
            have.insert(b.trim().to_string());
        }
    }
    (manager, have)
}

/// Resolve the install command for a tool under a package manager. Includes `sudo`
/// for system managers (none for `pip --user`/`brew`); `None` when unsupported.
pub fn install_command(tool: &str, mgr: &str) -> Option<String> {
    let sys = |pkg: &str| -> Option<String> {
        Some(match mgr {
            "apt" => format!("sudo apt-get install -y {pkg}"),
            "dnf" => format!("sudo dnf install -y {pkg}"),
            "yum" => format!("sudo yum install -y {pkg}"),
            "apk" => format!("sudo apk add {pkg}"),
            "pacman" => format!("sudo pacman -S --noconfirm {pkg}"),
            "zypper" => format!("sudo zypper install -y {pkg}"),
            "brew" => format!("brew install {pkg}"),
            _ => return None,
        })
    };
    let pip = |pkg: &str| Some(format!("pip install --user {pkg}"));
    match tool {
        "shellcheck" => sys("shellcheck"),
        "yamllint" => sys("yamllint").or_else(|| pip("yamllint")),
        "ruff" => {
            if mgr == "brew" {
                sys("ruff")
            } else {
                pip("ruff")
            }
        }
        "hadolint" => {
            if mgr == "brew" {
                sys("hadolint")
            } else {
                // Not packaged in most repos → fetch the release binary (server-side).
                Some(
                    "sudo curl -fsSL \"https://github.com/hadolint/hadolint/releases/latest/\
                     download/hadolint-$(uname -s)-$(uname -m)\" -o /usr/local/bin/hadolint \
                     && sudo chmod +x /usr/local/bin/hadolint"
                        .into(),
                )
            }
        }
        "sensors" => match mgr {
            "apt" | "apk" => sys("lm-sensors"),
            "dnf" | "yum" | "pacman" => sys("lm_sensors"),
            "zypper" => sys("sensors"),
            _ => None,
        },
        _ => None,
    }
}

/// Build the full status list for the frontend.
pub fn build_status(manager: &str, have: &HashSet<String>) -> ToolsStatus {
    let tools = TOOLS
        .iter()
        .map(|t| ToolStatus {
            id: t.id.to_string(),
            name: t.name.to_string(),
            installed: have.contains(t.bin),
            command: install_command(t.id, manager),
        })
        .collect();
    ToolsStatus {
        manager: manager.to_string(),
        tools,
    }
}

/// Rewrite the leading `sudo ` of an install command to read its password from
/// stdin (`sudo -S`), for the one-click install path. Later `sudo`s in the same
/// command reuse sudo's cached credential. Non-sudo commands (pip/brew) unchanged.
pub fn sudoize(command: &str) -> String {
    match command.strip_prefix("sudo ") {
        Some(rest) => format!("sudo -S -p '' {rest}"),
        None => command.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_reads_manager_and_present_bins() {
        let raw = "mgr=apt\nhave=shellcheck\nhave=sensors\n";
        let (mgr, have) = parse_status(raw);
        assert_eq!(mgr, "apt");
        assert!(have.contains("shellcheck") && have.contains("sensors"));
        assert!(!have.contains("ruff"));
        // Empty manager line.
        assert_eq!(parse_status("mgr=\n").0, "");
    }

    #[test]
    fn install_commands_per_manager() {
        assert_eq!(
            install_command("shellcheck", "apt").as_deref(),
            Some("sudo apt-get install -y shellcheck")
        );
        assert_eq!(
            install_command("yamllint", "dnf").as_deref(),
            Some("sudo dnf install -y yamllint")
        );
        // Unknown manager → fall back to pip for yamllint/ruff.
        assert_eq!(
            install_command("yamllint", "weird").as_deref(),
            Some("pip install --user yamllint")
        );
        assert_eq!(
            install_command("ruff", "apt").as_deref(),
            Some("pip install --user ruff")
        );
        // sensors uses distro-specific package names.
        assert_eq!(
            install_command("sensors", "dnf").as_deref(),
            Some("sudo dnf install -y lm_sensors")
        );
        assert_eq!(
            install_command("sensors", "apt").as_deref(),
            Some("sudo apt-get install -y lm-sensors")
        );
        assert!(install_command("hadolint", "apt")
            .unwrap()
            .contains("hadolint"));
        assert!(install_command("nope", "apt").is_none());
    }

    #[test]
    fn sudoize_targets_the_first_sudo_only() {
        assert_eq!(
            sudoize("sudo apt-get install -y x"),
            "sudo -S -p '' apt-get install -y x"
        );
        // pip/brew have no sudo → unchanged.
        assert_eq!(
            sudoize("pip install --user ruff"),
            "pip install --user ruff"
        );
        // Multi-sudo: only the first is rewritten (later ones use the cached cred).
        assert_eq!(sudoize("sudo a && sudo b"), "sudo -S -p '' a && sudo b");
    }

    #[test]
    fn build_status_marks_installed() {
        let mut have = HashSet::new();
        have.insert("shellcheck".to_string());
        let st = build_status("apt", &have);
        let sc = st.tools.iter().find(|t| t.id == "shellcheck").unwrap();
        assert!(sc.installed);
        let rf = st.tools.iter().find(|t| t.id == "ruff").unwrap();
        assert!(!rf.installed && rf.command.is_some());
    }
}
