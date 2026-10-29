// Kubernetes panel backend (Phase 37). `kubectl_run` runs one `kubectl` command
// over the session's transport (see `exec`): SSH tabs on a dedicated exec
// channel, local shell tabs by spawning it here. All argument building and output
// parsing lives on the frontend (`src/lib/k8s.ts`). This is a distinct
// orchestration driver (its own view), not folded into the Docker panel — see
// INVARIANTS «Панели-драйверы» (the k8s row of the driver table).
//
// The leading token(s) of the argv are the program — `kubectl`, a path to it, or
// a configured wrapper like `k3s kubectl` (`settings.kubectlPath`) — and the
// `--context`/`--namespace`/`-A` scope is baked in by the frontend (`k8s.ts
// withScope`); kubeconfig is NEVER mutated here (no `config use-context`).
// Offline invariant intact: the cluster's API server is reached over the user's
// own session; the app/WebView never opens a socket.
//
// The WebView is a trust boundary (v1.25.1): `check_args` lets through only the
// verbs the panel runs. `kubectl exec`/`run`/`debug`/`cp` and plugins
// (`kubectl foo` runs `kubectl-foo` from PATH) would run code of the caller's
// choosing; `--kubeconfig` would load exec credential plugins from a file of its
// choosing, `--server` would hand the context's token to another address.

/// The verbs the Kubernetes panel runs through `kubectl_run` (k8s.ts). Shells
/// and port-forwards are typed into a terminal tab instead.
const VERBS: &[&str] = &[
    "version", "config", "get", "describe", "logs", "delete", "rollout", "scale", "top", "cordon",
    "uncordon", "drain",
];

/// Long options refused wherever they stand: credentials and endpoints other
/// than the context's own, files kubectl would write, impersonation.
const DANGEROUS_OPTIONS: &[&str] = &[
    "--kubeconfig",
    "--server",
    "--cluster",
    "--user",
    "--token",
    "--username",
    "--password",
    "--certificate-authority",
    "--client-certificate",
    "--client-key",
    "--insecure-skip-tls-verify",
    "--tls-server-name",
    "--as",
    "--as-group",
    "--as-uid",
    "--cache-dir",
    "--log-file",
    "--log-dir",
    "--profile-output",
];

/// Shorthand options the panel uses. Any other single-dash token is refused —
/// `-s` is `--server`, and shorthands bundle (`-As <url>`).
const SHORTHANDS: &[&str] = &["-A", "-o", "-c", "-n"];

/// Where the verb starts: after `kubectl` (bare or a path to it, `.exe` on
/// Windows), after the snap alias `microk8s.kubectl`, or after a `k3s`/`microk8s`
/// wrapper followed by `kubectl`.
fn verb_index(args: &[String]) -> Result<usize, String> {
    let first = args.first().ok_or("kubectl: no arguments")?;
    let base = first.rsplit(['/', '\\']).next().unwrap_or(first);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    match base {
        "kubectl" | "microk8s.kubectl" => Ok(1),
        "k3s" | "microk8s" if args.get(1).map(String::as_str) == Some("kubectl") => Ok(2),
        _ => Err(format!(
            "kubectl: `{first}` is not kubectl or a kubectl wrapper"
        )),
    }
}

/// Whether the WebView may run this argv through `kubectl_run`.
pub fn check_args(args: &[String]) -> Result<(), String> {
    let at = verb_index(args)?;
    let verb = args.get(at).map(String::as_str).unwrap_or("");
    if !VERBS.contains(&verb) {
        return Err(format!("kubectl: `{verb}` is not a command the panel runs"));
    }
    let next = args.get(at + 1).map(String::as_str);
    match verb {
        "config" if !matches!(next, Some("get-contexts" | "current-context")) => {
            return Err("kubectl: only `config get-contexts` and `config current-context` read the kubeconfig here".into());
        }
        "rollout" if next != Some("restart") => {
            return Err("kubectl: only `rollout restart` is allowed".into());
        }
        _ => {}
    }
    for token in &args[at + 1..] {
        if let Some(long) = token.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or(long);
            if DANGEROUS_OPTIONS
                .iter()
                .any(|o| o.trim_start_matches('-') == name)
            {
                return Err(format!("kubectl: option `--{name}` is not allowed"));
            }
        } else if token.starts_with('-') && !SHORTHANDS.contains(&token.as_str()) {
            return Err(format!("kubectl: option `{token}` is not allowed"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|t| t.to_string()).collect()
    }

    /// The argv shapes k8s.ts builds (with each program form and the scope
    /// `withScope` adds) — every one must pass.
    #[test]
    fn what_the_k8s_panel_runs_is_allowed() {
        for ok in [
            &["kubectl", "version", "-o", "json", "--request-timeout=5s"][..],
            &["kubectl", "config", "get-contexts", "-o", "name"],
            &["kubectl", "config", "current-context"],
            &[
                "kubectl",
                "get",
                "namespaces",
                "-o",
                "json",
                "--context",
                "prod",
            ],
            &[
                "kubectl",
                "get",
                "pods",
                "-o",
                "json",
                "--context",
                "c",
                "-A",
            ],
            &[
                "kubectl",
                "get",
                "deployments,statefulsets,daemonsets,cronjobs",
                "-o",
                "json",
            ],
            &[
                "kubectl",
                "top",
                "pods",
                "--no-headers",
                "--namespace",
                "web",
            ],
            &[
                "kubectl",
                "logs",
                "p",
                "--tail",
                "200",
                "--timestamps",
                "-c",
                "app",
            ],
            &["kubectl", "describe", "pod", "p"],
            &["kubectl", "get", "pod", "p", "-o", "yaml"],
            &["kubectl", "delete", "pod", "p", "--namespace", "web"],
            &["kubectl", "scale", "deployment", "d", "--replicas", "3"],
            &["kubectl", "rollout", "restart", "deployment/d"],
            &["kubectl", "get", "events", "-o", "json"],
            &["kubectl", "cordon", "n1"],
            &["kubectl", "uncordon", "n1"],
            &[
                "kubectl",
                "drain",
                "n1",
                "--ignore-daemonsets",
                "--delete-emptydir-data",
            ],
            &["k3s", "kubectl", "get", "nodes", "-o", "json"],
            &["microk8s", "kubectl", "get", "pods", "-o", "json"],
            &["microk8s.kubectl", "get", "pods"],
            &["/usr/local/bin/kubectl", "get", "pods"],
            &["C:\\tools\\kubectl.exe", "get", "pods"],
        ] {
            assert_eq!(check_args(&argv(ok)), Ok(()), "{ok:?}");
        }
    }

    #[test]
    fn what_runs_code_or_moves_credentials_is_refused() {
        for bad in [
            &[][..],
            &["sh", "-c", "id"],
            &["k3s", "server"],
            &["kubectl"],
            &["kubectl", "exec", "p", "--", "id"],
            &["kubectl", "run", "x", "--image", "alpine"],
            &["kubectl", "debug", "node/n1", "-it", "--image", "alpine"],
            &["kubectl", "cp", "p:/etc/passwd", "/tmp/x"],
            &["kubectl", "apply", "-f", "/tmp/x.yml"],
            &["kubectl", "evil-plugin"],
            &["kubectl", "config", "use-context", "prod"],
            &["kubectl", "config", "view", "--raw"],
            &["kubectl", "rollout", "undo", "deployment/d"],
            &["kubectl", "get", "pods", "--kubeconfig=/tmp/k"],
            &["kubectl", "get", "pods", "--server", "https://evil"],
            &["kubectl", "get", "pods", "-s", "https://evil"],
            &["kubectl", "get", "pods", "-As", "https://evil"],
            &["kubectl", "get", "pods", "--log-file=/home/u/.bashrc"],
            &["kubectl", "get", "secrets", "--as", "system:admin"],
            &["kubectl", "get", "pods", "--token=x"],
        ] {
            assert!(check_args(&argv(bad)).is_err(), "{bad:?}");
        }
    }
}
