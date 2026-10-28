// Docker panel backend (Phase 35). `container_run` runs one `docker` command over
// the session's transport (see `exec`): SSH tabs on a dedicated exec channel,
// local shell tabs by spawning `docker` here. All argument building and output
// parsing lives on the frontend (`src/lib/docker.ts`).
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
    &["start"],
    &["stop"],
    &["restart"],
    &["rm"],
    &["rmi"],
    &["logout"],
    &["network", "ls"],
    &["network", "rm"],
    &["network", "prune"],
    &["volume", "ls"],
    &["volume", "rm"],
    &["volume", "prune"],
    &["container", "prune"],
    &["image", "prune"],
    &["system", "prune"],
];

/// What `docker compose` may do: the project-scoped actions the panel offers.
const COMPOSE_ACTIONS: &[&str] = &["logs", "up", "down", "restart"];

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
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "docker: `{}` is not a command the Docker panel runs",
            rest.first().map(String::as_str).unwrap_or("")
        ))
    }
}

/// `docker compose [-p <project>] [--project-directory <dir>] <action> …`: the
/// project comes from the containers' labels, the action from the panel. Any
/// other option before the action — `-f`/`--file`, `--env-file`, `--profile` —
/// would point compose at a definition of the caller's choosing.
fn check_compose(rest: &[String]) -> Result<(), String> {
    let mut tokens = rest.iter();
    while let Some(token) = tokens.next() {
        match token.as_str() {
            "-p" | "--project-directory" => {
                tokens.next();
            }
            action if COMPOSE_ACTIONS.contains(&action) => return Ok(()),
            other => return Err(format!("docker compose: `{other}` is not allowed")),
        }
    }
    Err("docker compose: no action".into())
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
            &["docker", "compose", "-f", "/tmp/evil.yml", "up"],
            &["docker", "compose", "--file=/tmp/evil.yml", "up"],
            &["docker", "compose", "-p", "web", "run", "svc", "sh"],
            &["docker", "compose", "-p", "web"],
            &["docker", "login", "-u", "x"],
        ] {
            assert!(check_args(&argv(bad)).is_err(), "{bad:?}");
        }
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
