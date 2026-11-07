// Docker panel backend (Phase 35). `container_run` runs one `docker` command over
// the session's transport (see `exec`): SSH tabs on a dedicated exec channel,
// local shell tabs by spawning `docker` here. All argument building and output
// parsing lives on the frontend (`src/lib/docker/docker.ts`).
//
// Offline invariant intact: the Docker daemon is reached over the user's own
// session (remote host or local machine); the app/WebView never opens a socket.
//
// The WebView is a trust boundary (v1.25.1): the argv it sends must be one of
// the commands the panel runs (`check_args`). `docker run -v /:/host …`,
// `docker exec`, `docker cp` or a CLI plugin would each run code of the caller's
// choosing — on the host, as whoever can reach the daemon. The interactive shell
// into a container is typed into a terminal tab, not run here.

/// The commands the Docker panel runs (docker.ts), as the words after `docker`.
/// `compose` is checked on its own (`check_compose`).
const COMMANDS: &[&[&str]] = &[
    &["version"],
    &["ps"],
    &["images"],
    &["stats"],
    &["logs"],
    &["inspect"],
    // An image's layers, for its details (v1.33) — read-only.
    &["history"],
    &["start"],
    &["stop"],
    &["restart"],
    &["rm"],
    &["rmi"],
    &["logout"],
    &["network", "ls"],
    &["network", "inspect"],
    &["network", "rm"],
    &["network", "prune"],
    &["volume", "ls"],
    &["volume", "inspect"],
    &["volume", "rm"],
    &["volume", "prune"],
    &["container", "prune"],
    &["image", "prune"],
    &["system", "prune"],
    // How much the images, containers, volumes and build cache take, and which of
    // them are in use (`-v`) — read-only (v1.33).
    &["system", "df"],
    // What happened to the containers in the last minutes — only as a snapshot
    // that ends (`--until`, see `check_args`), never as the stream it is by default.
    &["events"],
];

/// What `docker compose` may do: the project-scoped actions the panel offers.
const COMPOSE_ACTIONS: &[&str] = &[
    "logs", "up", "down", "restart", "start", "stop", "ps", "config",
];

/// The one action that may name the stack's own files (`-f`, `--env-file`): `config`
/// renders them and runs nothing — reading a file is what the file panels already
/// do. Every action that starts something takes the definition from the project
/// alone, never from a file the caller names (v1.33).
const COMPOSE_READS_FILES: &str = "config";

/// Whether the WebView may run this argv through `container_run`. The program is
/// `docker` by name (resolved on PATH, never a path the caller chose) and the
/// words after it name one of [`COMMANDS`] — a global option (`-H`, `--config`,
/// `--context`) never stands in their place.
pub fn check_args(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("docker") => {}
        Some(other) => return Err(format!("docker: `{other}` is not the docker CLI")),
        None => return Err("docker: no arguments".into()),
    }
    let rest = &args[1..];
    if rest.first().map(String::as_str) == Some("compose") {
        return check_compose(&rest[1..]);
    }
    let allowed = COMMANDS
        .iter()
        .any(|cmd| rest.len() >= cmd.len() && cmd.iter().zip(rest).all(|(w, a)| *w == a.as_str()));
    if allowed && rest.first().map(String::as_str) == Some("events") && !ends_events(rest) {
        return Err("docker: `events` runs only as a snapshot with `--until`".into());
    }
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "docker: `{}` is not a command the Docker panel runs",
            rest.first().map(String::as_str).unwrap_or("")
        ))
    }
}

/// Whether a `docker events` argv ends by itself: `--until <time>` (or
/// `--until=<time>`) is what turns the stream into a snapshot of the past. Without
/// it the call would hold a channel open until its timeout killed it.
fn ends_events(rest: &[String]) -> bool {
    rest.iter().enumerate().any(|(i, a)| {
        (a == "--until"
            && rest
                .get(i + 1)
                .is_some_and(|v| !v.is_empty() && !v.starts_with('-')))
            || a.strip_prefix("--until=").is_some_and(|v| !v.is_empty())
    })
}

/// `docker compose [-p <project>] [--project-directory <dir>] <action> …`: the
/// project comes from the containers' labels, the action from the panel. Any
/// other option before the action — `-f`/`--file`, `--env-file`, `--profile` —
/// would point compose at a definition of the caller's choosing.
fn check_compose(rest: &[String]) -> Result<(), String> {
    let mut tokens = rest.iter();
    let mut names_files = false;
    while let Some(token) = tokens.next() {
        match token.as_str() {
            "-p" | "--project-directory" => {
                tokens.next();
            }
            "-f" | "--file" | "--env-file" => {
                names_files = true;
                tokens.next();
            }
            action if COMPOSE_ACTIONS.contains(&action) => {
                if names_files && action != COMPOSE_READS_FILES {
                    return Err(format!(
                        "docker compose: `{action}` takes the stack from the project, not from a named file"
                    ));
                }
                return Ok(());
            }
            other => return Err(format!("docker compose: `{other}` is not allowed")),
        }
    }
    Err("docker compose: no action".into())
}

/// What a `docker compose` argv names that has to be the stack's own (v1.33): the
/// project, the directory compose reads its definition from, the files and env
/// files. The policy above cannot tell whether a directory is the stack's — a
/// path is a path — so `container_run` asks docker for the labels the stack's
/// containers were created with and holds the argv to them ([`check_stack`]):
/// otherwise `up` with `--project-directory` would read a `compose.yaml` from
/// any directory the page can write a file into.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ComposeNames {
    pub project: Option<String>,
    pub dir: Option<String>,
    pub files: Vec<String>,
    pub env_files: Vec<String>,
}

impl ComposeNames {
    /// Whether it names anything compose would read a definition from.
    pub fn reads_definition(&self) -> bool {
        self.dir.is_some() || !self.files.is_empty() || !self.env_files.is_empty()
    }
}

/// The names of a `docker compose` argv (the options before its action); None
/// when it is not a compose argv.
pub fn compose_names(args: &[String]) -> Option<ComposeNames> {
    if args.first().map(String::as_str) != Some("docker")
        || args.get(1).map(String::as_str) != Some("compose")
    {
        return None;
    }
    let mut names = ComposeNames::default();
    let mut tokens = args[2..].iter();
    while let Some(token) = tokens.next() {
        let value = || tokens.clone().next().cloned();
        match token.as_str() {
            "-p" => names.project = value(),
            "--project-directory" => names.dir = value(),
            "-f" | "--file" => names.files.extend(value()),
            "--env-file" => names.env_files.extend(value()),
            _ => break,
        }
        tokens.next();
    }
    Some(names)
}

/// Label keys compose writes on every container of a stack.
const LABEL_PROJECT: &str = "com.docker.compose.project";
const LABEL_WORKDIR: &str = "com.docker.compose.project.working_dir";
const LABEL_FILES: &str = "com.docker.compose.project.config_files";
const LABEL_ENV: &str = "com.docker.compose.project.environment_file";

/// What the stack's containers say they were brought up from: one line per
/// container, `dir␟files␟env file` (the files comma-joined, as compose writes them).
pub fn stack_labels_args(project: &str) -> Vec<String> {
    let fmt = [LABEL_WORKDIR, LABEL_FILES, LABEL_ENV]
        .map(|k| format!("{{{{.Label \"{k}\"}}}}"))
        .join("\u{1f}");
    vec![
        "docker".into(),
        "ps".into(),
        "-a".into(),
        "--filter".into(),
        format!("label={LABEL_PROJECT}={project}"),
        "--format".into(),
        fmt,
    ]
}

/// Whether what a compose argv names is the stack's own, by its containers'
/// labels (`stack_labels_args`' output): the directory one of them was brought
/// up from, files and env files among the ones they were brought up with. A
/// directory or a file named without the project, or for a project no container
/// belongs to, is refused — there is nothing to hold it to.
pub fn check_stack(names: &ComposeNames, labels: &str) -> Result<(), String> {
    if !names.reads_definition() {
        return Ok(());
    }
    let Some(project) = names.project.as_deref().filter(|p| !p.is_empty()) else {
        return Err("docker compose: a directory or a file is named without the project".into());
    };
    let rows: Vec<Vec<&str>> = labels
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.split('\u{1f}').map(str::trim).collect())
        .collect();
    if rows.is_empty() {
        return Err(format!(
            "docker compose: no container of `{project}` says where it was brought up from"
        ));
    }
    let dirs: Vec<&str> = rows
        .iter()
        .filter_map(|r| r.first().copied())
        .filter(|d| !d.is_empty())
        .collect();
    let files: Vec<&str> = rows
        .iter()
        .filter_map(|r| r.get(1))
        .flat_map(|f| f.split(',').map(str::trim))
        .filter(|f| !f.is_empty())
        .collect();
    let envs: Vec<&str> = rows
        .iter()
        .filter_map(|r| r.get(2).copied())
        .filter(|e| !e.is_empty())
        .collect();
    if let Some(dir) = &names.dir {
        if !dirs.contains(&dir.as_str()) {
            return Err(format!(
                "docker compose: `{dir}` is not the directory `{project}` was brought up from"
            ));
        }
    }
    if let Some(file) = names.files.iter().find(|f| !files.contains(&f.as_str())) {
        return Err(format!(
            "docker compose: `{file}` is not a file `{project}` was brought up with"
        ));
    }
    if let Some(env) = names.env_files.iter().find(|e| !envs.contains(&e.as_str())) {
        return Err(format!(
            "docker compose: `{env}` is not the env file `{project}` was brought up with"
        ));
    }
    Ok(())
}

/// Whether the argv is a registry login (`docker_login`): `docker login …`, and
/// nothing else rides on the secret fed to its stdin.
pub fn check_login_args(args: &[String]) -> Result<(), String> {
    match (args.first(), args.get(1)) {
        (Some(p), Some(c)) if p == "docker" && c == "login" => Ok(()),
        _ => Err("docker login: the argv must be `docker login …`".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|t| t.to_string()).collect()
    }

    /// The argv shapes docker.ts builds — every one must pass.
    #[test]
    fn what_the_docker_panel_runs_is_allowed() {
        for ok in [
            &["docker", "version", "--format", "{{.Server.Version}}"][..],
            &["docker", "ps", "-a", "--format", "{{json .}}"],
            &["docker", "images", "--format", "x"],
            &["docker", "network", "ls", "--format", "x"],
            &["docker", "volume", "ls", "--format", "x"],
            &["docker", "stats", "--no-stream", "--format", "x"],
            &["docker", "logs", "--tail", "200", "--timestamps", "abc"],
            &[
                "docker",
                "compose",
                "-p",
                "web",
                "logs",
                "--tail",
                "200",
                "--timestamps",
                "--no-color",
            ],
            &["docker", "inspect", "abc"],
            &["docker", "inspect", "--format", "{{.Id}}", "a", "b"],
            &["docker", "start", "a"],
            &["docker", "stop", "a"],
            &["docker", "restart", "a"],
            &["docker", "rm", "-f", "a"],
            &["docker", "rmi", "-f", "a"],
            &["docker", "volume", "rm", "v"],
            &["docker", "network", "rm", "n"],
            &["docker", "container", "prune", "-f"],
            &["docker", "image", "prune", "-f"],
            &["docker", "volume", "prune", "-f"],
            &["docker", "network", "prune", "-f"],
            &["docker", "system", "prune", "-f"],
            &["docker", "system", "df", "--format", "{{json .}}"],
            &["docker", "system", "df", "-v", "--format", "{{json .}}"],
            &[
                "docker",
                "events",
                "--since",
                "10m",
                "--until",
                "0s",
                "--filter",
                "type=container",
                "--format",
                "x",
            ],
            &["docker", "events", "--since", "10m", "--until=0s"],
            &["docker", "history", "--no-trunc", "--format", "x", "abc"],
            &[
                "docker", "compose", "-p", "web", "ps", "-a", "--format", "json",
            ],
            &["docker", "compose", "-p", "web", "restart", "api"],
            &["docker", "compose", "-p", "web", "stop", "api"],
            &["docker", "compose", "-p", "web", "start", "api"],
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "-f",
                "/srv/web/compose.yaml",
                "-f",
                "/srv/web/compose.prod.yaml",
                "--env-file",
                "/srv/web/prod.env",
                "config",
            ],
            &["docker", "network", "inspect", "web_default"],
            &["docker", "volume", "inspect", "data"],
            &[
                "docker",
                "ps",
                "-a",
                "--filter",
                "ancestor=abc",
                "--format",
                "x",
            ],
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "up",
                "-d",
            ],
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "down",
            ],
            &["docker", "compose", "-p", "web", "restart"],
            &["docker", "logout", "registry.example.com"],
        ] {
            assert_eq!(check_args(&argv(ok)), Ok(()), "{ok:?}");
        }
    }

    #[test]
    fn what_runs_code_of_the_callers_choosing_is_refused() {
        for bad in [
            &[][..],
            &["docker"],
            &["sh", "-c", "id"],
            &["/usr/bin/docker", "ps"],
            &["docker", "run", "-v", "/:/h", "alpine"],
            &["docker", "exec", "abc", "id"],
            &["docker", "cp", "x", "abc:/"],
            &["docker", "build", "."],
            &["docker", "-H", "tcp://evil:2375", "ps"],
            &["docker", "--config", "/tmp/x", "ps"],
            &["docker", "network", "create", "n"],
            &["docker", "network", "connect", "n", "c"],
            &["docker", "volume", "create", "v"],
            &["docker", "system", "info"],
            &["docker", "events"],
            &["docker", "events", "--since", "10m"],
            &["docker", "events", "--until"],
            &["docker", "events", "--until", "--since"],
            &["docker", "events", "--until="],
            &["docker", "system", "dial-stdio"],
            &["docker", "compose", "-f", "/tmp/evil.yml", "up"],
            &["docker", "compose", "--file=/tmp/evil.yml", "up"],
            &[
                "docker",
                "compose",
                "-p",
                "web",
                "-f",
                "/tmp/evil.yml",
                "up",
                "-d",
            ],
            &[
                "docker",
                "compose",
                "--env-file",
                "/tmp/x.env",
                "-p",
                "web",
                "up",
            ],
            &[
                "docker",
                "compose",
                "-p",
                "web",
                "-f",
                "/tmp/evil.yml",
                "restart",
            ],
            &[
                "docker",
                "compose",
                "-p",
                "web",
                "-f",
                "/tmp/evil.yml",
                "run",
                "x",
            ],
            &["docker", "compose", "-p", "web", "run", "svc", "sh"],
            &["docker", "compose", "-p", "web"],
            &["docker", "login", "-u", "x"],
        ] {
            assert!(check_args(&argv(bad)).is_err(), "{bad:?}");
        }
    }

    const US: &str = "\u{1f}";
    fn labels(rows: &[[&str; 3]]) -> String {
        rows.iter()
            .map(|r| r.join(US))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_compose_argv_names_its_project_directory_files_and_env_files() {
        let names = compose_names(&argv(&[
            "docker",
            "compose",
            "--project-directory",
            "/srv/web",
            "-p",
            "web",
            "-f",
            "/srv/web/a.yaml",
            "-f",
            "/srv/web/b.yaml",
            "--env-file",
            "/srv/web/prod.env",
            "config",
            "-f",
            "ignored",
        ]))
        .unwrap();
        assert_eq!(
            names,
            ComposeNames {
                project: Some("web".into()),
                dir: Some("/srv/web".into()),
                files: vec!["/srv/web/a.yaml".into(), "/srv/web/b.yaml".into()],
                env_files: vec!["/srv/web/prod.env".into()],
            }
        );
        assert!(compose_names(&argv(&["docker", "ps"])).is_none());
        assert!(
            !compose_names(&argv(&["docker", "compose", "-p", "web", "restart", "api"]))
                .unwrap()
                .reads_definition()
        );
    }

    #[test]
    fn a_compose_command_reads_only_the_definition_its_stack_was_brought_up_from() {
        let own = labels(&[
            [
                "/srv/web",
                "/srv/web/a.yaml,/srv/web/b.yaml",
                "/srv/web/prod.env",
            ],
            [
                "/srv/web",
                "/srv/web/a.yaml,/srv/web/b.yaml",
                "/srv/web/prod.env",
            ],
        ]);
        let check = |a: &[&str], l: &str| check_stack(&compose_names(&argv(a)).unwrap(), l);
        // The stack's own directory, files and env file pass.
        assert!(check(
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "up",
                "-d"
            ],
            &own
        )
        .is_ok());
        assert!(check(
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "-f",
                "/srv/web/b.yaml",
                "--env-file",
                "/srv/web/prod.env",
                "config"
            ],
            &own,
        )
        .is_ok());
        // Nothing named: nothing to check.
        assert!(check(&["docker", "compose", "-p", "web", "stop", "api"], "").is_ok());
        // Another directory, another file, another env file — refused.
        for bad in [
            &[
                "docker",
                "compose",
                "--project-directory",
                "/tmp/evil",
                "-p",
                "web",
                "up",
                "-d",
            ][..],
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "-f",
                "/tmp/evil.yaml",
                "config",
            ],
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "--env-file",
                "/tmp/x.env",
                "config",
            ],
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "up",
                "-d",
            ],
        ] {
            assert!(check(bad, &own).is_err(), "{bad:?}");
        }
        // A project no container belongs to: nothing to hold the directory to.
        assert!(check(
            &[
                "docker",
                "compose",
                "--project-directory",
                "/srv/web",
                "-p",
                "web",
                "up"
            ],
            ""
        )
        .is_err());
    }

    #[test]
    fn the_labels_are_asked_of_the_project_by_filter() {
        let a = stack_labels_args("web");
        assert_eq!(
            &a[..5],
            &argv(&[
                "docker",
                "ps",
                "-a",
                "--filter",
                "label=com.docker.compose.project=web"
            ])[..]
        );
        assert!(check_args(&a).is_ok());
        assert_eq!(a[6].matches("{{.Label").count(), 3);
    }

    #[test]
    fn a_compose_argv_is_held_to_its_stack_before_it_runs() {
        // The order is the contract: the labels are asked and checked, then the argv runs.
        // A Windows checkout ends lines with CRLF: the function's end is sought in LF.
        let src = include_str!("commands/drivers.rs").replace("\r\n", "\n");
        let body = &src[src.find("pub async fn container_run(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let checked = body
            .find("container::check_stack(")
            .expect("container_run checks the stack");
        let runs = body
            .rfind("run_driver(&state, &session_id, call)")
            .expect("container_run runs the argv");
        assert!(checked < runs, "the stack is checked before the argv runs");
        assert!(body.contains("container::compose_names(&args)"));
    }

    #[test]
    fn a_registry_login_is_only_docker_login() {
        assert_eq!(
            check_login_args(&argv(&[
                "docker",
                "login",
                "-u",
                "me",
                "--password-stdin",
                "r.io"
            ])),
            Ok(())
        );
        for bad in [&["docker", "ps"][..], &["sh", "login"], &["docker"]] {
            assert!(check_login_args(&argv(bad)).is_err(), "{bad:?}");
        }
    }
}

/// Against a real docker (`#[ignore]`, see docs/TESTS.md «Живой стек compose»): a
/// throwaway stack of `alpine` is brought up from a temp directory, its real
/// labels are asked the way `container_run` asks them, and the check passes its
/// own directory and refuses another; the stack is taken down after.
#[cfg(test)]
mod live_compose {
    use super::*;
    use std::process::Command;

    fn docker(args: &[&str]) -> std::process::Output {
        Command::new("docker")
            .args(args)
            .output()
            .expect("docker on PATH")
    }

    #[test]
    #[ignore]
    fn a_real_stack_passes_its_own_directory_and_refuses_another() {
        let project = "vterm-live-compose";
        let dir = std::env::temp_dir().join(project);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("compose.yaml"),
            "services:\n  idle:\n    image: alpine:latest\n    command: [\"sleep\", \"300\"]\n",
        )
        .unwrap();
        let dir_s = dir.to_string_lossy().to_string();
        let up = docker(&[
            "compose",
            "--project-directory",
            &dir_s,
            "-p",
            project,
            "up",
            "-d",
        ]);
        assert!(
            up.status.success(),
            "{}",
            String::from_utf8_lossy(&up.stderr)
        );

        let query = stack_labels_args(project);
        let args: Vec<&str> = query[1..].iter().map(String::as_str).collect();
        let labels = String::from_utf8_lossy(&docker(&args).stdout).to_string();
        let names = |d: &str| {
            compose_names(&[
                "docker".into(),
                "compose".into(),
                "--project-directory".into(),
                d.into(),
                "-p".into(),
                project.into(),
                "up".into(),
                "-d".into(),
            ])
            .unwrap()
        };
        let own = check_stack(
            &names(labels.split('\u{1f}').next().unwrap_or_default().trim()),
            &labels,
        );
        let other = check_stack(&names("/tmp"), &labels);

        let down = docker(&["compose", "-p", project, "down"]);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(own.is_ok(), "{own:?} — labels: {labels}");
        assert!(other.is_err());
        assert!(
            down.status.success(),
            "{}",
            String::from_utf8_lossy(&down.stderr)
        );
    }
}
