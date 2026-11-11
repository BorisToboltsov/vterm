// Kubernetes panel backend (Phase 37). `kubectl_run` runs one `kubectl` command
// over the session's transport (see `exec`): SSH tabs on a dedicated exec
// channel, local shell tabs by spawning it here. All argument building and output
// parsing lives on the frontend (`src/lib/k8s/k8s.ts`). This is a distinct
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
//
// It changes the cluster only in the shapes the panel offers (v1.36, ADR 0061):
// `rollout undo` of a Deployment to a revision, a CronJob's Job made by hand
// (`create job <name> --from=cronjob/<name>` — `create` at large would make any
// object, a ClusterRoleBinding among them). And a Secret's values are never read:
// its list comes from one template that prints keys and no value
// ([`SECRET_KEYS_TEMPLATE`]); every other `get`/`describe` of Secrets — `describe`
// prints a service-account token in clear — and `--raw`, which reads any path of
// the API, are refused.

/// The verbs the Kubernetes panel runs through `kubectl_run` (k8s.ts). Shells
/// and port-forwards are typed into a terminal tab instead.
const VERBS: &[&str] = &[
    "version", "config", "get", "describe", "logs", "delete", "rollout", "scale", "top", "cordon",
    "uncordon", "drain", "create",
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
    "--raw",
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

/// The one way the panel lists Secrets (v1.36, ADR 0061): namespace, name, type,
/// creation time and the keys, a line each — and no value. Mirrored by
/// `SECRET_KEYS_TEMPLATE` in `k8s.ts` (`k8s.test.ts` holds them equal).
pub const SECRET_KEYS_TEMPLATE: &str = r#"{{range .items}}{{.metadata.namespace}}{{"\t"}}{{.metadata.name}}{{"\t"}}{{.type}}{{"\t"}}{{.metadata.creationTimestamp}}{{"\t"}}{{range $k, $v := .data}}{{$k}}{{" "}}{{end}}{{"\n"}}{{end}}"#;

/// The options `withScope` (k8s.ts) adds, with the value each takes.
fn scope_option(token: &str) -> Option<bool> {
    match token {
        "--context" | "--namespace" | "-n" => Some(true),
        "-A" => Some(false),
        _ if token.starts_with("--context=") || token.starts_with("--namespace=") => Some(false),
        _ => None,
    }
}

/// The tokens left once the scope options and their values are taken out.
fn unscoped(rest: &[String]) -> Vec<&str> {
    let mut out = Vec::new();
    let mut tokens = rest.iter();
    while let Some(token) = tokens.next() {
        match scope_option(token) {
            Some(true) => {
                tokens.next();
            }
            Some(false) => {}
            None => out.push(token.as_str()),
        }
    }
    out
}

/// Whether a token names Secrets as a kind: `secret`, `secrets`, `Secret`,
/// `secrets.v1`, `secret/x`, or one of a comma list. A value of a scope option
/// (a namespace called `secrets`) is no kind — `unscoped` has taken it out.
fn names_secrets(token: &str) -> bool {
    !token.starts_with('-')
        && token.split(',').any(|piece| {
            let kind = piece.split('/').next().unwrap_or(piece);
            let base = kind.split('.').next().unwrap_or(kind).to_ascii_lowercase();
            base == "secret" || base == "secrets"
        })
}

/// A Kubernetes object name: lowercase letters, digits and `-`, at most 63.
fn object_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `rollout undo deployment/<name> [--to-revision=<n>]` and nothing else.
fn check_undo(rest: &[&str]) -> Result<(), String> {
    let refuse = || Err("kubectl: `rollout undo` goes only to a Deployment's revision".to_string());
    let Some((target, more)) = rest.split_first() else {
        return refuse();
    };
    let Some(name) = target
        .strip_prefix("deployment/")
        .or_else(|| target.strip_prefix("deployments/"))
    else {
        return refuse();
    };
    let revision = |t: &&str| {
        t.strip_prefix("--to-revision=")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    };
    if !object_name(name) || more.len() > 1 || !more.iter().all(revision) {
        return refuse();
    }
    Ok(())
}

/// `create job <name> --from=cronjob/<name>` and nothing else.
fn check_run_now(rest: &[&str]) -> Result<(), String> {
    match rest {
        ["job", name, from] if object_name(name) => match from.strip_prefix("--from=cronjob/") {
            Some(cronjob) if object_name(cronjob) => Ok(()),
            _ => Err("kubectl: a Job is made here only from a CronJob".into()),
        },
        _ => Err("kubectl: `create` here makes only a CronJob's Job".into()),
    }
}

/// `get secrets` with the keys template — the only read of Secrets there is.
fn reads_secret_values(verb: &str, rest: &[&str]) -> bool {
    if !rest.iter().any(|t| names_secrets(t)) {
        return false;
    }
    let keys = format!("--output=go-template={SECRET_KEYS_TEMPLATE}");
    !(verb == "get" && rest == ["secrets", keys.as_str()])
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
        "rollout" => match next {
            Some("restart") => {}
            Some("undo") => check_undo(&unscoped(&args[at + 2..]))?,
            _ => {
                return Err("kubectl: only `rollout restart` and `rollout undo` are allowed".into())
            }
        },
        "create" => check_run_now(&unscoped(&args[at + 1..]))?,
        "get" | "describe" if reads_secret_values(verb, &unscoped(&args[at + 1..])) => {
            return Err(
                "kubectl: a Secret's values are never read here — its keys are listed without them"
                    .into(),
            );
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
            &["kubectl", "config", "get-contexts"],
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
                "deployments,statefulsets,daemonsets,cronjobs,jobs",
                "-o",
                "json",
            ],
            // The route's other objects (v1.35); IngressClasses are cluster-wide.
            &[
                "kubectl",
                "get",
                "httproutes.gateway.networking.k8s.io",
                "-o",
                "json",
                "--namespace",
                "shop",
            ],
            &[
                "kubectl",
                "get",
                "ingressclasses",
                "-o",
                "json",
                "--context",
                "c",
            ],
            &["kubectl", "get", "networkpolicies", "-o", "json", "-A"],
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
            // Going back, and a CronJob run by hand (v1.36, ADR 0061).
            &[
                "kubectl",
                "rollout",
                "undo",
                "deployment/d",
                "--to-revision=3",
                "--context",
                "c",
                "--namespace",
                "web",
            ],
            &["kubectl", "rollout", "undo", "deployment/d"],
            &[
                "kubectl",
                "create",
                "job",
                "report-manual-1a2b",
                "--from=cronjob/report",
                "--namespace",
                "web",
            ],
            // Config: ConfigMaps whole, a namespace that happens to be called `secrets`,
            // an object whose name merely starts with it.
            &["kubectl", "get", "configmaps", "-o", "json", "-A"],
            &[
                "kubectl",
                "get",
                "pods",
                "-o",
                "json",
                "--namespace",
                "secrets",
            ],
            &["kubectl", "get", "deployment", "secret-store", "-o", "yaml"],
            &["kubectl", "get", "events", "-o", "json"],
            &["kubectl", "get", "jobs", "-o", "json", "--namespace", "web"],
            &[
                "kubectl",
                "get",
                "pods",
                "-A",
                "--field-selector=spec.nodeName=desktop-control-plane",
                "-o",
                "json",
                "--context",
                "c",
            ],
            &["kubectl", "top", "node", "n1", "--no-headers"],
            &[
                "kubectl",
                "get",
                "persistentvolumeclaims",
                "-o",
                "json",
                "--namespace",
                "web",
            ],
            &[
                "kubectl",
                "get",
                "pods",
                "--selector=app=rollout,env in (prod,stage),!canary",
                "-o",
                "json",
                "--namespace",
                "web",
            ],
            &[
                "kubectl",
                "get",
                "replicasets",
                "--selector=app=rollout",
                "-o",
                "json",
            ],
            &[
                "kubectl",
                "get",
                "events",
                "--field-selector=involvedObject.uid=88e4f2dc-1a6d-4c59-9355-afb2720e846c",
                "-o",
                "json",
                "--context",
                "c",
                "--namespace",
                "web",
            ],
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
        // The Secrets list, as the panel asks for it — and only so.
        let keys = format!("--output=go-template={SECRET_KEYS_TEMPLATE}");
        for scope in [&[][..], &["-A"], &["--context", "c", "--namespace", "web"]] {
            let mut list = argv(&["kubectl", "get", "secrets", &keys]);
            list.extend(argv(scope));
            assert_eq!(check_args(&list), Ok(()), "{list:?}");
        }
        assert!(SECRET_KEYS_TEMPLATE.contains("{{$k}}") && !SECRET_KEYS_TEMPLATE.contains("$v}}"));
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
    /// The cluster is changed only in the shapes the panel offers (v1.36, ADR 0061):
    /// a Deployment back to a revision, a CronJob's Job made now — `create` at
    /// large would make any object, a ClusterRoleBinding among them.
    #[test]
    fn the_cluster_is_changed_only_in_the_shapes_the_panel_offers() {
        for bad in [
            &["kubectl", "rollout", "undo", "statefulset/s"][..],
            &[
                "kubectl",
                "rollout",
                "undo",
                "deployment/d",
                "--to-revision=x",
            ],
            &[
                "kubectl",
                "rollout",
                "undo",
                "deployment/d",
                "--dry-run=server",
                "-o",
                "yaml",
            ],
            &["kubectl", "rollout", "history", "deployment/d"],
            &["kubectl", "rollout", "pause", "deployment/d"],
            &[
                "kubectl",
                "create",
                "clusterrolebinding",
                "x",
                "--clusterrole=cluster-admin",
                "--user=me",
            ],
            &["kubectl", "create", "-f", "/tmp/x.yaml"],
            &["kubectl", "create", "--filename=/tmp/x.yaml"],
            &["kubectl", "create", "job", "x", "--from=deployment/d"],
            &[
                "kubectl",
                "create",
                "job",
                "x",
                "--image=alpine",
                "--",
                "id",
            ],
            &[
                "kubectl",
                "create",
                "job",
                "x",
                "--from=cronjob/r",
                "--dry-run=client",
                "-o",
                "yaml",
            ],
            &["kubectl", "create", "job", "Bad_Name", "--from=cronjob/r"],
        ] {
            assert!(check_args(&argv(bad)).is_err(), "{bad:?}");
        }
    }

    /// A Secret's values are never read (v1.36, ADR 0061): the keys template is
    /// the one read of Secrets; `describe` prints a service-account token in
    /// clear, and `--raw` reads any path of the API.
    #[test]
    fn a_secrets_value_is_never_read_by_any_road() {
        for bad in [
            &["kubectl", "get", "secrets", "-o", "yaml"][..],
            &["kubectl", "get", "secret", "creds", "-o", "json"],
            &[
                "kubectl",
                "get",
                "Secrets.v1",
                "-o",
                "jsonpath={.items[*].data}",
            ],
            &["kubectl", "get", "deployments,secrets", "-o", "json"],
            &[
                "kubectl",
                "get",
                "deployment/d",
                "secret/creds",
                "-o",
                "yaml",
            ],
            &["kubectl", "get", "--context", "c", "secrets", "-o", "json"],
            &["kubectl", "get", "--sort-by", "x", "secrets", "-o", "json"],
            &[
                "kubectl",
                "get",
                "secrets",
                "--output=go-template={{range .items}}{{.data}}{{end}}",
            ],
            &["kubectl", "describe", "secret", "sa-token"],
            &["kubectl", "describe", "secrets"],
            &["kubectl", "get", "--raw", "/api/v1/namespaces/web/secrets"],
        ] {
            assert!(check_args(&argv(bad)).is_err(), "{bad:?}");
        }
    }
}

/// The stand against a real cluster (`#[ignore]`, docs/TESTS.md «Живой кластер k8s»): the
/// manifests of `e2e/k8s/stand.yaml` really break the way the panel must explain, and every
/// read the panel runs — and the ones its next stages will — passes [`check_args`] and is
/// answered by a real `kubectl` through `exec::run_local`, the local path of `kubectl_run`.
/// It creates and deletes its own namespace in one context only: `docker-desktop`, or the one
/// named by `VTERM_LIVE_KUBE_CONTEXT`.
#[cfg(test)]
mod live_kube {
    use super::*;
    use crate::exec;
    use serde_json::Value;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const STAND: &str = include_str!("../../e2e/k8s/stand.yaml");
    /// The cron of `report` fires on the minute; its first failed job may take that long.
    const SETTLE: Duration = Duration::from_secs(240);

    fn context() -> String {
        std::env::var("VTERM_LIVE_KUBE_CONTEXT").unwrap_or_else(|_| "docker-desktop".into())
    }

    /// The namespace of one run, deleted however the run ends.
    struct Namespace {
        ctx: String,
        name: String,
    }

    impl Namespace {
        fn create(ctx: &str) -> Self {
            let name = format!("vterm-live-{}", std::process::id());
            let made = Command::new("kubectl")
                .args(["--context", ctx, "create", "namespace", &name])
                .output()
                .expect("kubectl on PATH");
            assert!(
                made.status.success(),
                "{}",
                String::from_utf8_lossy(&made.stderr)
            );
            let ns = Namespace {
                ctx: ctx.into(),
                name,
            };
            let mut apply = Command::new("kubectl")
                .args([
                    "--context",
                    ctx,
                    "--namespace",
                    &ns.name,
                    "apply",
                    "-f",
                    "-",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .expect("kubectl on PATH");
            apply
                .stdin
                .take()
                .expect("stdin")
                .write_all(STAND.as_bytes())
                .expect("stand written");
            let applied = apply.wait_with_output().expect("apply finished");
            assert!(
                applied.status.success(),
                "{}",
                String::from_utf8_lossy(&applied.stderr)
            );
            ns
        }
    }

    impl Drop for Namespace {
        fn drop(&mut self) {
            let _ = Command::new("kubectl")
                .args([
                    "--context",
                    &self.ctx,
                    "delete",
                    "namespace",
                    &self.name,
                    "--wait=false",
                ])
                .output();
        }
    }

    /// One read as the panel sends it: checked by the policy, run locally.
    async fn read(args: &[String]) -> exec::ExecOutput {
        let argv: Vec<String> = std::iter::once("kubectl".to_string())
            .chain(args.iter().cloned())
            .collect();
        check_args(&argv).unwrap_or_else(|e| panic!("{argv:?}: {e}"));
        exec::run_local(
            exec::Local {
                program: &argv[0],
                args: &argv[1..],
                env: &[],
                stdin: None,
                missing: exec::Missing::Exit127,
                timeout_hint: "",
            },
            30,
        )
        .await
        .expect("kubectl runs")
    }

    /// A read that must succeed, as JSON when it is `-o json`.
    async fn ok(args: &[String]) -> exec::ExecOutput {
        let out = read(args).await;
        assert_eq!(out.exit_code, 0, "{args:?}: {}", out.stderr);
        out
    }

    async fn json(args: &[String]) -> Value {
        let out = ok(args).await;
        serde_json::from_str(&out.stdout).unwrap_or_else(|e| panic!("{args:?}: {e}"))
    }

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn items(list: &Value) -> &[Value] {
        list["items"].as_array().map(Vec::as_slice).unwrap_or(&[])
    }

    fn label<'a>(pod: &'a Value, key: &str) -> &'a str {
        pod["metadata"]["labels"][key].as_str().unwrap_or("")
    }

    fn condition<'a>(obj: &'a Value, kind: &str) -> Option<&'a Value> {
        obj["status"]["conditions"]
            .as_array()?
            .iter()
            .find(|c| c["type"] == kind)
    }

    /// The first container's status — every broken pod of the stand has one container.
    fn first(pod: &Value) -> &Value {
        &pod["status"]["containerStatuses"][0]
    }

    /// Which breakages of the stand have not shown yet in this pod list.
    fn missing(pods: &[Value]) -> Vec<&'static str> {
        let any = |app: &str, test: &dyn Fn(&Value) -> bool| {
            pods.iter().filter(|p| label(p, "app") == app).any(test)
        };
        let job = |prefix: &str, phase: &str| {
            pods.iter()
                .any(|p| label(p, "job-name").starts_with(prefix) && p["status"]["phase"] == phase)
        };
        let ready_rollout = pods
            .iter()
            .filter(|p| label(p, "app") == "rollout")
            .filter(|p| condition(p, "Ready").is_some_and(|c| c["status"] == "True"))
            .count();
        let checks: [(&'static str, bool); 14] = [
            ("rollout serves two pods", ready_rollout >= 2),
            (
                "web is ready",
                any("web", &|p| {
                    condition(p, "Ready").is_some_and(|c| c["status"] == "True")
                }),
            ),
            (
                "crashloop exited with 1",
                any("crashloop", &|p| {
                    first(p)["lastState"]["terminated"]["exitCode"] == 1
                }),
            ),
            (
                "oom was OOMKilled",
                any("oom", &|p| {
                    let s = first(p);
                    s["lastState"]["terminated"]["reason"] == "OOMKilled"
                        || s["state"]["terminated"]["reason"] == "OOMKilled"
                }),
            ),
            (
                "too-big is unschedulable",
                any("too-big", &|p| {
                    condition(p, "PodScheduled").is_some_and(|c| c["reason"] == "Unschedulable")
                }),
            ),
            (
                "notready runs but is not ready",
                any("notready", &|p| {
                    first(p)["started"] == true && first(p)["ready"] == false
                }),
            ),
            (
                "liveness-fail was restarted",
                any("liveness-fail", &|p| {
                    first(p)["restartCount"].as_u64().unwrap_or(0) >= 1
                }),
            ),
            (
                "bad-image cannot pull",
                any("bad-image", &|p| {
                    matches!(
                        first(p)["state"]["waiting"]["reason"].as_str(),
                        Some("ErrImagePull" | "ImagePullBackOff")
                    )
                }),
            ),
            (
                "init-fail is held by its init container",
                any("init-fail", &|p| {
                    let s = &p["status"]["initContainerStatuses"][0];
                    s["state"]["terminated"]["exitCode"] == 1
                        || s["lastState"]["terminated"]["exitCode"] == 1
                }),
            ),
            ("db runs", any("db", &|p| p["status"]["phase"] == "Running")),
            (
                "busy runs its load",
                any("busy", &|p| p["status"]["phase"] == "Running"),
            ),
            (
                "node-agent runs",
                any("node-agent", &|p| p["status"]["phase"] == "Running"),
            ),
            ("migrate succeeded", job("migrate", "Succeeded")),
            ("a report job failed", job("report-", "Failed")),
        ];
        checks
            .into_iter()
            .filter(|(_, seen)| !seen)
            .map(|(name, _)| name)
            .collect()
    }

    fn named<'a>(pods: &'a [Value], app: &str) -> &'a Value {
        pods.iter()
            .find(|p| label(p, "app") == app)
            .unwrap_or_else(|| panic!("no pod of {app}"))
    }

    fn text<'a>(v: &'a Value, path: &[&str]) -> &'a str {
        path.iter().fold(v, |v, k| &v[*k]).as_str().unwrap_or("")
    }

    /// `kubectl top` without metrics-server is an honest «absent», not a failure of the read.
    fn metrics_or_absent(out: &exec::ExecOutput, what: &str) {
        assert!(
            out.exit_code == 0 || out.stderr.contains("Metrics API not available"),
            "{what}: {}",
            out.stderr
        );
    }

    #[tokio::test]
    #[ignore]
    async fn the_stand_breaks_as_described_and_every_panel_read_is_answered() {
        let ctx = context();
        let ns = Namespace::create(&ctx);
        // Every read in the scope `withScope` gives it: `--context` always, the
        // namespace for a namespaced one.
        let cluster = |args: &[&str]| -> Vec<String> {
            let mut v = argv(args);
            v.extend(["--context".into(), ctx.clone()]);
            v
        };
        let scoped = |args: &[&str]| -> Vec<String> {
            let mut v = cluster(args);
            v.extend(["--namespace".into(), ns.name.clone()]);
            v
        };

        // Every breakage shows within the settle time — or the run names what did not.
        let started = Instant::now();
        let pods = loop {
            let list = json(&scoped(&["get", "pods", "-o", "json"])).await;
            let all = items(&list).to_vec();
            let left = missing(&all);
            if left.is_empty() {
                break all;
            }
            assert!(
                started.elapsed() < SETTLE,
                "not shown in {SETTLE:?}: {left:?}"
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
        };
        let workloads = loop {
            // The panel's own call (stage 4): the kinds and the Jobs at once.
            let list = json(&scoped(&[
                "get",
                "deployments,statefulsets,daemonsets,cronjobs,jobs",
                "-o",
                "json",
            ]))
            .await;
            let stuck = items(&list).iter().any(|w| {
                text(w, &["metadata", "name"]) == "bad-image"
                    && condition(w, "Progressing")
                        .is_some_and(|c| c["reason"] == "ProgressDeadlineExceeded")
            });
            if stuck {
                break list;
            }
            assert!(
                started.elapsed() < SETTLE,
                "bad-image never ran out of its progress deadline"
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
        };
        let kinds = |k: &str| items(&workloads).iter().filter(|w| w["kind"] == k).count();
        assert_eq!(
            items(&workloads).len() - kinds("Job"),
            16,
            "12 deployments, a statefulset, a daemonset, 2 cronjobs"
        );
        assert!(kinds("Job") >= 2, "migrate and a report run");

        // A rollout stuck halfway (stage 4): a new revision that cannot pull its image
        // while the old one keeps serving — two ReplicaSets the Deployment owns, asked
        // by its selector as the details do.
        let set = Command::new("kubectl")
            .args([
                "--context",
                &ctx,
                "--namespace",
                &ns.name,
                "set",
                "image",
                "deployment/rollout",
                "app=busybox:vterm-missing-tag",
            ])
            .output()
            .expect("kubectl on PATH");
        assert!(
            set.status.success(),
            "{}",
            String::from_utf8_lossy(&set.stderr)
        );
        let owner = items(&workloads)
            .iter()
            .find(|w| w["kind"] == "Deployment" && text(w, &["metadata", "name"]) == "rollout")
            .map(|w| text(w, &["metadata", "uid"]).to_string())
            .expect("the rollout Deployment");
        let revisions = loop {
            let list = json(&scoped(&[
                "get",
                "replicasets",
                "--selector=app=rollout",
                "-o",
                "json",
            ]))
            .await;
            let owned = items(&list)
                .iter()
                .filter(|r| {
                    r["metadata"]["ownerReferences"]
                        .as_array()
                        .is_some_and(|o| o.iter().any(|x| x["uid"] == owner.as_str()))
                })
                .count();
            if owned >= 2 {
                break owned;
            }
            assert!(
                started.elapsed() < SETTLE * 2,
                "no second revision of rollout"
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
        };
        assert_eq!(revisions, 2);
        let mine = json(&scoped(&[
            "get",
            "pods",
            "--selector=app=rollout",
            "-o",
            "json",
        ]))
        .await;
        assert!(
            items(&mine).len() >= 3,
            "two old pods serving and the new one stuck"
        );

        // A node's details and the volume claims (stage 5): the node's pods across
        // namespaces, its usage now, the claims — `data-db-0` bound, two waiting.
        let nodes = json(&cluster(&["get", "nodes", "-o", "json"])).await;
        let node = text(&items(&nodes)[0], &["metadata", "name"]).to_string();
        let on_node = format!("--field-selector=spec.nodeName={node}");
        let there = json(&cluster(&["get", "pods", "-A", &on_node, "-o", "json"])).await;
        assert!(
            items(&there)
                .iter()
                .any(|p| text(p, &["metadata", "namespace"]) == ns.name),
            "the stand's pods run on {node}"
        );
        metrics_or_absent(
            &read(&cluster(&["top", "node", &node, "--no-headers"])).await,
            "top node",
        );
        let claims = json(&scoped(&["get", "persistentvolumeclaims", "-o", "json"])).await;
        let phase = |name: &str| {
            items(&claims)
                .iter()
                .find(|c| text(c, &["metadata", "name"]) == name)
                .map(|c| text(c, &["status", "phase"]).to_string())
                .unwrap_or_default()
        };
        assert_eq!(phase("data-db-0"), "Bound");
        assert_eq!(phase("spare"), "Pending");
        assert_eq!(phase("orphan-claim"), "Pending");

        // The lists the panel polls.
        ok(&cluster(&["version", "-o", "json", "--request-timeout=5s"])).await;
        ok(&argv(&["config", "get-contexts"])).await;
        ok(&argv(&["config", "current-context"])).await;
        json(&cluster(&["get", "namespaces", "-o", "json"])).await;
        json(&cluster(&["get", "nodes", "-o", "json"])).await;
        for list in [
            "services",
            "ingress",
            "endpointslices",
            "events",
            "networkpolicies",
        ] {
            json(&scoped(&["get", list, "-o", "json"])).await;
        }
        metrics_or_absent(
            &read(&scoped(&["top", "pods", "--no-headers"])).await,
            "top pods",
        );

        // One pod's details: describe, YAML, the log — of a sidecar too.
        let crash = text(named(&pods, "crashloop"), &["metadata", "name"]);
        ok(&scoped(&["describe", "pod", crash])).await;
        ok(&scoped(&["get", "pod", crash, "-o", "yaml"])).await;
        let log = ok(&scoped(&["logs", crash, "--tail", "200", "--timestamps"])).await;
        assert!(log.stdout.contains("connecting to db"), "{}", log.stdout);
        let web = text(named(&pods, "web"), &["metadata", "name"]);
        let sidecar = [
            "logs",
            web,
            "--tail",
            "200",
            "--timestamps",
            "-c",
            "log-shipper",
        ];
        ok(&scoped(&sidecar)).await;

        // The next stages: a pod's own events by uid, its containers' usage.
        for (app, reason) in [("crashloop", "BackOff"), ("too-big", "FailedScheduling")] {
            let uid = text(named(&pods, app), &["metadata", "uid"]);
            let selector = format!("--field-selector=involvedObject.uid={uid}");
            let events = json(&scoped(&["get", "events", &selector, "-o", "json"])).await;
            let list = items(&events);
            assert!(
                list.iter()
                    .all(|e| text(e, &["involvedObject", "uid"]) == uid),
                "events of {app} are its own"
            );
            assert!(
                list.iter().any(|e| e["reason"] == reason),
                "{app} has no {reason}: {events}"
            );
        }
        metrics_or_absent(
            &read(&scoped(&[
                "top",
                "pod",
                web,
                "--containers",
                "--no-headers",
            ]))
            .await,
            "top pod --containers",
        );

        // Config (v1.36, ADR 0061): ConfigMaps whole, Secrets by their keys and no value.
        let maps = json(&scoped(&["get", "configmaps", "-o", "json"])).await;
        let config = items(&maps)
            .iter()
            .find(|m| text(m, &["metadata", "name"]) == "app-config")
            .expect("the stand's ConfigMap");
        assert_eq!(text(config, &["data", "LOG_LEVEL"]), "debug");
        let keys = format!("--output=go-template={SECRET_KEYS_TEMPLATE}");
        let secrets = ok(&scoped(&["get", "secrets", &keys])).await;
        let line = format!("{}\tapp-secret\tOpaque\t", ns.name);
        // A failed check must not print the response it is checking for leaked values.
        assert!(
            secrets.stdout.contains(&line),
            "the stand's Secret is missing"
        );
        assert!(
            secrets.stdout.contains("\ttoken \n"),
            "the token key is missing"
        );
        for value in ["vterm-stand-token", "dnRlcm0tc3RhbmQtdG9rZW4"] {
            assert!(!secrets.stdout.contains(value), "a Secret value was read");
        }

        // Going back: the stuck rollout, to the revision that worked.
        ok(&scoped(&[
            "rollout",
            "undo",
            "deployment/rollout",
            "--to-revision=1",
        ]))
        .await;
        let back = json(&scoped(&["get", "deployment", "rollout", "-o", "json"])).await;
        let image = &back["spec"]["template"]["spec"]["containers"][0]["image"];
        assert_eq!(image, "busybox:1.37", "{back}");
        assert_eq!(
            text(
                &back,
                &[
                    "metadata",
                    "annotations",
                    "deployment.kubernetes.io/revision"
                ]
            ),
            "3"
        );

        // A CronJob run now: a Job the panel files under its CronJob, by owner.
        let made = "report-manual-live";
        ok(&scoped(&["create", "job", made, "--from=cronjob/report"])).await;
        let job = json(&scoped(&["get", "job", made, "-o", "json"])).await;
        let owner = &job["metadata"]["ownerReferences"][0];
        assert_eq!(
            (owner["kind"].as_str(), owner["name"].as_str()),
            (Some("CronJob"), Some("report")),
            "{job}"
        );
        drop(ns);
    }
}
