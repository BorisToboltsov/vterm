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
    Tool {
        id: "smartmontools",
        name: "smartmontools",
        bin: "smartctl",
    },
    Tool {
        id: "sysstat",
        name: "sysstat",
        bin: "iostat",
    },
    // Probe tools the Utilities access check can be told to use (v1.0.37: the
    // method is a choice, so each missing one is offered for install). `bash`
    // itself is never missing from a server we can SSH into.
    Tool {
        id: "nc",
        name: "nc",
        bin: "nc",
    },
    Tool {
        id: "telnet",
        name: "telnet",
        bin: "telnet",
    },
    Tool {
        id: "curl",
        name: "curl",
        bin: "curl",
    },
    // YAML-family linters (Phase B). docker-compose (`docker`) and promtool ship with
    // their platform, so they're validated but not offered for one-click install here.
    Tool {
        id: "ansible-lint",
        name: "ansible-lint",
        bin: "ansible-lint",
    },
    Tool {
        id: "actionlint",
        name: "actionlint",
        bin: "actionlint",
    },
    Tool {
        id: "kubeconform",
        name: "kubeconform",
        bin: "kubeconform",
    },
    // The CI panel's way to the forges (ADR 0069): the user's own CLIs.
    Tool {
        id: "gh",
        name: "gh",
        bin: "gh",
    },
    Tool {
        id: "glab",
        name: "glab",
        bin: "glab",
    }, // The editor's formatters (ADR 0076) and language servers (ADR 0079): the
    // user's own, installed where the project lives.
    Tool {
        id: "black",
        name: "black",
        bin: "black",
    },
    Tool {
        id: "shfmt",
        name: "shfmt",
        bin: "shfmt",
    },
    Tool {
        id: "yamlfmt",
        name: "yamlfmt",
        bin: "yamlfmt",
    },
    Tool {
        id: "prettier",
        name: "prettier",
        bin: "prettier",
    },
    Tool {
        id: "rustfmt",
        name: "rustfmt",
        bin: "rustfmt",
    },
    Tool {
        id: "xmllint",
        name: "xmllint",
        bin: "xmllint",
    },
    Tool {
        id: "clang-format",
        name: "clang-format",
        bin: "clang-format",
    },
    Tool {
        id: "basedpyright",
        name: "basedpyright",
        bin: "basedpyright-langserver",
    },
    Tool {
        id: "pyright",
        name: "pyright",
        bin: "pyright-langserver",
    },
    Tool {
        id: "pylsp",
        name: "pylsp",
        bin: "pylsp",
    },
    Tool {
        id: "rust-analyzer",
        name: "rust-analyzer",
        bin: "rust-analyzer",
    },
    Tool {
        id: "gopls",
        name: "gopls",
        bin: "gopls",
    },
    Tool {
        id: "terraform-ls",
        name: "terraform-ls",
        bin: "terraform-ls",
    },
    Tool {
        id: "yaml-language-server",
        name: "yaml-language-server",
        bin: "yaml-language-server",
    },
    Tool {
        id: "ansible-language-server",
        name: "ansible-language-server",
        bin: "ansible-language-server",
    },
    Tool {
        id: "bash-language-server",
        name: "bash-language-server",
        bin: "bash-language-server",
    },
    Tool {
        id: "typescript-language-server",
        name: "typescript-language-server",
        bin: "typescript-language-server",
    },
    Tool {
        id: "docker-langserver",
        name: "docker-langserver",
        bin: "docker-langserver",
    },
    Tool {
        id: "helm_ls",
        name: "helm_ls",
        bin: "helm_ls",
    },
    Tool {
        id: "clangd",
        name: "clangd",
        bin: "clangd",
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
    let mut s = format!("PATH=\"{}\"; ", crate::format::TOOL_PATH);
    s.push_str(
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
    // A Node tool: global npm — under sudo where npm's global folder is the system's.
    let npm = |mgr: &str, pkg: &str| -> Option<String> {
        Some(if mgr == "brew" {
            format!("npm install -g {pkg}")
        } else {
            format!("sudo npm install -g {pkg}")
        })
    };
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
        // smartmontools (smartctl) and sysstat (iostat) are packaged under their
        // own name on every supported manager.
        "smartmontools" => sys("smartmontools"),
        "sysstat" => sys("sysstat"),
        // telnet: its own package on apt/rpm/zypper/brew; Alpine ships the applet
        // in busybox-extras, Arch in inetutils.
        "telnet" => match mgr {
            "apk" => sys("busybox-extras"),
            "pacman" => sys("inetutils"),
            _ => sys("telnet"),
        },
        // nc: the OpenBSD netcat (supports `-z`) under each family's name; the RHEL
        // family ships nmap's ncat as `nc`.
        "nc" => match mgr {
            "dnf" | "yum" => sys("nmap-ncat"),
            "pacman" => sys("openbsd-netcat"),
            "brew" => sys("netcat"),
            _ => sys("netcat-openbsd"),
        },
        "curl" => sys("curl"),
        // GitHub's and GitLab's CLIs are packaged as `gh` and `glab` where they are packaged.
        "gh" => sys("gh"),
        "glab" => sys("glab"),
        // ansible-lint is a Python package everywhere except brew.
        "ansible-lint" => {
            if mgr == "brew" {
                sys("ansible-lint")
            } else {
                pip("ansible-lint")
            }
        }
        // actionlint / kubeconform: brew where available, else fetch the release
        // binary server-side (not packaged in distro repos).
        "actionlint" => {
            if mgr == "brew" {
                sys("actionlint")
            } else {
                Some(
                    "sudo sh -c 'curl -fsSL \
                     https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/\
                     download-actionlint.bash | bash -s -- latest /usr/local/bin'"
                        .into(),
                )
            }
        }
        "kubeconform" => {
            if mgr == "brew" {
                sys("kubeconform")
            } else {
                Some(
                    "sudo sh -c 'curl -fsSL \
                     \"https://github.com/yannh/kubeconform/releases/latest/download/\
                     kubeconform-$(uname -s | tr A-Z a-z)-$(uname -m | \
                     sed s/x86_64/amd64/\\;s/aarch64/arm64/).tar.gz\" \
                     | tar -xz -C /usr/local/bin kubeconform'"
                        .into(),
                )
            }
        }
        // Formatters (ADR 0076).
        "black" => {
            if mgr == "brew" {
                sys("black")
            } else {
                pip("black")
            }
        }
        "shfmt" => sys("shfmt"),
        "yamlfmt" => {
            if mgr == "brew" {
                sys("yamlfmt")
            } else {
                Some("go install github.com/google/yamlfmt/cmd/yamlfmt@latest".into())
            }
        }
        "prettier" => npm(mgr, "prettier"),
        "rustfmt" => Some("rustup component add rustfmt".into()),
        "xmllint" => match mgr {
            "apt" | "apk" => sys("libxml2-utils"),
            "zypper" => sys("libxml2-tools"),
            _ => sys("libxml2"),
        },
        "clang-format" => match mgr {
            "dnf" | "yum" => sys("clang-tools-extra"),
            "apk" => sys("clang-extra-tools"),
            "pacman" => sys("clang"),
            _ => sys("clang-format"),
        },
        // Language servers (ADR 0079).
        "basedpyright" => pip("basedpyright"),
        "pyright" => pip("pyright"),
        "pylsp" => pip("python-lsp-server"),
        "rust-analyzer" => Some("rustup component add rust-analyzer".into()),
        "gopls" => Some("go install golang.org/x/tools/gopls@latest".into()),
        "terraform-ls" => (mgr == "brew").then(|| "brew install hashicorp/tap/terraform-ls".into()),
        "yaml-language-server" => npm(mgr, "yaml-language-server"),
        "ansible-language-server" => npm(mgr, "@ansible/ansible-language-server"),
        "bash-language-server" => npm(mgr, "bash-language-server"),
        "typescript-language-server" => npm(mgr, "typescript-language-server typescript"),
        "docker-langserver" => npm(mgr, "dockerfile-language-server-nodejs"),
        "helm_ls" => (mgr == "brew").then(|| "brew install helm-ls".into()),
        "clangd" => match mgr {
            "dnf" | "yum" => sys("clang-tools-extra"),
            "apk" => sys("clang-extra-tools"),
            "pacman" => sys("clang"),
            "brew" => sys("llvm"),
            _ => sys("clangd"),
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

/// Whether an install command runs under sudo (its first word).
pub fn needs_sudo(command: &str) -> bool {
    command.starts_with("sudo ")
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
            install_command("gh", "brew").as_deref(),
            Some("brew install gh")
        );
        assert_eq!(
            install_command("glab", "dnf").as_deref(),
            Some("sudo dnf install -y glab")
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
        // Monitoring helpers packaged under their own name.
        assert_eq!(
            install_command("smartmontools", "apt").as_deref(),
            Some("sudo apt-get install -y smartmontools")
        );
        assert_eq!(
            install_command("sysstat", "dnf").as_deref(),
            Some("sudo dnf install -y sysstat")
        );
        assert!(install_command("nope", "apt").is_none());
    }

    #[test]
    fn install_commands_for_telnet_per_distro() {
        assert_eq!(
            install_command("telnet", "apt").as_deref(),
            Some("sudo apt-get install -y telnet")
        );
        assert_eq!(
            install_command("telnet", "dnf").as_deref(),
            Some("sudo dnf install -y telnet")
        );
        assert_eq!(
            install_command("telnet", "yum").as_deref(),
            Some("sudo yum install -y telnet")
        );
        assert_eq!(
            install_command("telnet", "apk").as_deref(),
            Some("sudo apk add busybox-extras")
        );
        assert_eq!(
            install_command("telnet", "pacman").as_deref(),
            Some("sudo pacman -S --noconfirm inetutils")
        );
        assert!(install_command("telnet", "").is_none());
        assert!(status_command().contains("command -v telnet"));
    }

    #[test]
    fn install_commands_for_nc_and_curl_per_distro() {
        assert_eq!(
            install_command("nc", "apt").as_deref(),
            Some("sudo apt-get install -y netcat-openbsd")
        );
        assert_eq!(
            install_command("nc", "dnf").as_deref(),
            Some("sudo dnf install -y nmap-ncat")
        );
        assert_eq!(
            install_command("nc", "yum").as_deref(),
            Some("sudo yum install -y nmap-ncat")
        );
        assert_eq!(
            install_command("nc", "apk").as_deref(),
            Some("sudo apk add netcat-openbsd")
        );
        assert_eq!(
            install_command("nc", "pacman").as_deref(),
            Some("sudo pacman -S --noconfirm openbsd-netcat")
        );
        assert_eq!(
            install_command("curl", "zypper").as_deref(),
            Some("sudo zypper install -y curl")
        );
        assert!(install_command("curl", "").is_none());
        assert!(status_command().contains("command -v nc"));
        assert!(status_command().contains("command -v curl"));
        // Detected by its binary like every other tool.
        assert!(status_command().contains("command -v telnet"));
    }

    #[test]
    fn install_commands_for_yaml_linters() {
        // ansible-lint is a pip package off brew.
        assert_eq!(
            install_command("ansible-lint", "apt").as_deref(),
            Some("pip install --user ansible-lint")
        );
        assert_eq!(
            install_command("ansible-lint", "brew").as_deref(),
            Some("brew install ansible-lint")
        );
        // actionlint/kubeconform: brew package, else server-side binary fetch.
        assert_eq!(
            install_command("actionlint", "brew").as_deref(),
            Some("brew install actionlint")
        );
        assert!(install_command("actionlint", "apt")
            .unwrap()
            .contains("download-actionlint.bash"));
        assert!(install_command("kubeconform", "dnf")
            .unwrap()
            .contains("kubeconform-"));
    }

    #[test]
    fn every_formatter_and_language_server_can_be_installed_somewhere() {
        let ids = [
            "black",
            "shfmt",
            "yamlfmt",
            "prettier",
            "rustfmt",
            "xmllint",
            "clang-format",
            "basedpyright",
            "pyright",
            "pylsp",
            "rust-analyzer",
            "gopls",
            "terraform-ls",
            "yaml-language-server",
            "ansible-language-server",
            "bash-language-server",
            "typescript-language-server",
            "docker-langserver",
            "helm_ls",
            "clangd",
        ];
        for id in ids {
            assert!(TOOLS.iter().any(|t| t.id == id), "{id} in the catalogue");
            assert!(
                install_command(id, "apt").is_some() || install_command(id, "brew").is_some(),
                "{id}"
            );
        }
        assert_eq!(
            install_command("pylsp", "apt").as_deref(),
            Some("pip install --user python-lsp-server")
        );
        assert_eq!(
            install_command("yaml-language-server", "apt").as_deref(),
            Some("sudo npm install -g yaml-language-server")
        );
        assert_eq!(install_command("terraform-ls", "apt"), None);
        assert!(status_command().starts_with("PATH=\""));
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
