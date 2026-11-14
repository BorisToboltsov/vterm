// CI panel backend (ADR 0069): the runs of a repository's GitHub Actions and
// GitLab CI, read and acted on through the user's own `gh` and `glab` — the
// programs they push with, on the host the session runs on (principle 3). The
// app opens no socket for this: the traffic is those programs', as it is
// `curl`'s in the HTTP client (ADR 0014). Argument building and parsing live on
// the frontend (`src/lib/ci/`); this module only says which argv may run.
//
// Only the REST API (`gh api`, `glab api`), and only the paths of a
// repository's runs: listing them, a run, its jobs, a job's log, the workflow
// files, a commit of an action (to pin it by SHA), and the four things the panel
// does — run again, run the failed jobs again, cancel, start a run by hand. Not
// `gh api` at large: it reaches every endpoint the user's token reaches —
// deleting a repository is one call. A write is spelled out (`-X POST`), so a
// field added to a read cannot quietly turn it into one, and no option reads a
// file (`--input`, `-F key=@path`).

/// What runs the API of each forge.
pub const PROGRAMS: [&str; 2] = ["gh", "glab"];

/// The environment of every run: no prompt to hang a non-interactive channel on,
/// no update notice in the output, no colour, no pager.
pub const ENV: &[(&str, &str)] = &[
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1"),
    ("GH_PAGER", "cat"),
    ("NO_PROMPT", "1"),
    ("GLAB_CHECK_UPDATE", "false"),
    ("NO_COLOR", "1"),
];

/// Why a run may hang past its timeout.
pub const TIMEOUT_HINT: &str = " — the forge did not answer in time; check the connection to it";

/// The command line an SSH tab runs: the environment, then every token quoted.
pub fn ssh_command(args: &[String]) -> String {
    let env = ENV
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{env} {}", crate::exec::remote_command(args))
}

/// The command written to the session recording: the values a person typed
/// into a run started by hand stay out of it — an input may well be a version,
/// but it may as well be something they would not have written down.
pub fn audit_command(args: &[String]) -> String {
    let mut out = Vec::with_capacity(args.len());
    let mut field = false;
    for a in args {
        if field {
            let name = a.split('=').next().unwrap_or(a);
            out.push(if name == "ref" {
                a.clone()
            } else {
                format!("{name}=…")
            });
            field = false;
            continue;
        }
        field = matches!(a.as_str(), "-f" | "--raw-field" | "-F" | "--field");
        out.push(a.clone());
    }
    out.join(" ")
}

/// Whether the call carries fields — a run started by hand; its argv is not
/// written to the diagnostics either (`exec::writes_argv`).
pub fn has_fields(args: &[String]) -> bool {
    args.iter()
        .any(|a| matches!(a.as_str(), "-f" | "--raw-field" | "-F" | "--field"))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Method {
    Get,
    Post,
}

/// What a write may carry: nothing, a workflow's dispatch (`ref` and
/// `inputs[name]`), or a GitLab pipeline's (`ref`, `variables` as JSON).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fields {
    None,
    Dispatch,
    Pipeline,
}

/// A path segment the panel builds: an owner, a repository, a URL-encoded
/// GitLab project path, a workflow file, a ref. Nothing that leaves the segment.
fn segment_ok(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '%'))
}

fn number(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.chars().all(|c| c.is_ascii_digit())
}

/// The query of a list read: known keys, encoded values.
fn query_ok(query: Option<&str>, keys: &[&str]) -> bool {
    let Some(q) = query else { return true };
    q.split('&').all(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        keys.contains(&k)
            && v.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '%'))
    })
}

const GH_RUNS_QUERY: &[&str] = &["per_page", "page", "branch", "event", "status", "head_sha"];
const GL_PIPELINES_QUERY: &[&str] = &[
    "per_page", "page", "ref", "sha", "status", "order_by", "sort",
];

/// The GitHub endpoints the panel uses, and what each may carry.
fn github_route(method: Method, path: &[&str], query: Option<&str>) -> Option<Fields> {
    let [repos, owner, repo, rest @ ..] = path else {
        return None;
    };
    if *repos != "repos" || !segment_ok(owner) || !segment_ok(repo) {
        return None;
    }
    let q = |keys: &[&str]| query_ok(query, keys);
    match (method, rest) {
        (Method::Get, ["actions", "runs"]) if q(GH_RUNS_QUERY) => Some(Fields::None),
        (Method::Get, ["actions", "runs", id]) if number(id) && query.is_none() => {
            Some(Fields::None)
        }
        (Method::Get, ["actions", "runs", id, "jobs"])
            if number(id) && q(&["per_page", "page", "filter"]) =>
        {
            Some(Fields::None)
        }
        (Method::Get, ["actions", "jobs", id, "logs"]) if number(id) && query.is_none() => {
            Some(Fields::None)
        }
        (Method::Get, ["actions", "workflows"]) if q(&["per_page", "page"]) => Some(Fields::None),
        (Method::Get, ["actions", "workflows", file, "runs"])
            if segment_ok(file) && q(GH_RUNS_QUERY) =>
        {
            Some(Fields::None)
        }
        // The commit a tag or branch of an action points at — "pin by SHA".
        (Method::Get, ["commits", r]) if segment_ok(r) && query.is_none() => Some(Fields::None),
        (Method::Post, ["actions", "runs", id, "rerun" | "rerun-failed-jobs" | "cancel"])
            if number(id) && query.is_none() =>
        {
            Some(Fields::None)
        }
        (Method::Post, ["actions", "workflows", file, "dispatches"])
            if segment_ok(file) && query.is_none() =>
        {
            Some(Fields::Dispatch)
        }
        _ => None,
    }
}

/// The GitLab endpoints the panel uses, and what each may carry.
fn gitlab_route(method: Method, path: &[&str], query: Option<&str>) -> Option<Fields> {
    let [projects, project, rest @ ..] = path else {
        return None;
    };
    if *projects != "projects" || !segment_ok(project) {
        return None;
    }
    let q = |keys: &[&str]| query_ok(query, keys);
    match (method, rest) {
        (Method::Get, ["pipelines"]) if q(GL_PIPELINES_QUERY) => Some(Fields::None),
        (Method::Get, ["pipelines", id]) if number(id) && query.is_none() => Some(Fields::None),
        (Method::Get, ["pipelines", id, "jobs" | "bridges"])
            if number(id) && q(&["per_page", "page", "include_retried"]) =>
        {
            Some(Fields::None)
        }
        (Method::Get, ["jobs", id, "trace"]) if number(id) && query.is_none() => Some(Fields::None),
        (Method::Post, ["pipelines", id, "retry" | "cancel"]) if number(id) && query.is_none() => {
            Some(Fields::None)
        }
        (Method::Post, ["pipeline"]) if query.is_none() => Some(Fields::Pipeline),
        _ => None,
    }
}

/// A host name, with a port at most.
fn host_ok(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

/// A field a write may carry.
fn field_ok(fields: Fields, flag: &str, value: &str) -> bool {
    let (name, val) = value.split_once('=').unwrap_or((value, ""));
    let raw = matches!(flag, "-f" | "--raw-field");
    match fields {
        Fields::None => false,
        Fields::Dispatch => {
            raw && (name == "ref"
                || name
                    .strip_prefix("inputs[")
                    .and_then(|n| n.strip_suffix(']'))
                    .is_some_and(|n| {
                        !n.is_empty()
                            && n.chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                    }))
        }
        // `-F` reads `@file` for a value in some versions: only a JSON array is
        // passed that way, and only as the pipeline's variables.
        Fields::Pipeline => {
            (raw && name == "ref") || (!raw && name == "variables" && val.starts_with('['))
        }
    }
}

/// Whether the WebView may run this argv: `gh`/`glab`, then `auth status` or one
/// `api` call to a path of the panel's (see the module comment).
pub fn check_args(args: &[String]) -> Result<(), String> {
    let Some(program) = args.first().map(String::as_str) else {
        return Err("ci: no arguments".into());
    };
    if !PROGRAMS.contains(&program) {
        return Err(format!("ci: `{program}` is not a CI program"));
    }
    let rest = &args[1..];
    match rest.first().map(String::as_str) {
        Some("auth") => {
            let ok = match &rest[1..] {
                [s] => s == "status",
                [s, flag, host] => s == "status" && flag == "--hostname" && host_ok(host),
                _ => false,
            };
            return if ok {
                Ok(())
            } else {
                Err(format!(
                    "ci: only `{program} auth status [--hostname H]` is allowed"
                ))
            };
        }
        Some("api") => {}
        _ => {
            return Err(format!(
                "ci: only `{program} api` and `{program} auth status` run here"
            ))
        }
    }
    let mut method = Method::Get;
    let mut explicit = false;
    let mut endpoint: Option<&str> = None;
    let mut fields: Vec<(&str, &str)> = Vec::new();
    let mut tokens = rest[1..].iter();
    while let Some(token) = tokens.next() {
        match token.as_str() {
            "--hostname" => {
                let host = tokens.next().ok_or("ci: --hostname needs a host")?;
                if !host_ok(host) {
                    return Err(format!("ci: `{host}` is not a host name"));
                }
            }
            "-X" | "--method" => {
                method = match tokens.next().map(String::as_str) {
                    Some("GET") => Method::Get,
                    Some("POST") => Method::Post,
                    other => return Err(format!("ci: method {other:?} is not allowed")),
                };
                explicit = true;
            }
            flag @ ("-f" | "--raw-field" | "-F" | "--field") => {
                let value = tokens.next().ok_or("ci: a field needs a value")?;
                fields.push((flag, value));
            }
            t if t.starts_with('-') => return Err(format!("ci: option `{t}` is not allowed")),
            t => {
                if endpoint.replace(t).is_some() {
                    return Err("ci: one endpoint per call".into());
                }
            }
        }
    }
    let endpoint = endpoint.ok_or("ci: no endpoint")?;
    if method == Method::Post && !explicit {
        return Err("ci: a write is spelled out with -X POST".into());
    }
    let (path, query) = match endpoint.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (endpoint, None),
    };
    if path.starts_with('/') || path.contains("//") {
        return Err(format!("ci: `{endpoint}` is not a path of the panel"));
    }
    let segments: Vec<&str> = path.split('/').collect();
    let route = if program == "gh" {
        github_route(method, &segments, query)
    } else {
        gitlab_route(method, &segments, query)
    };
    let Some(allowed) = route else {
        return Err(format!("ci: `{endpoint}` is not a path of the panel"));
    };
    for (flag, value) in fields {
        if !field_ok(allowed, flag, value) {
            return Err(format!("ci: field `{flag} {value}` is not allowed here"));
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

    /// The argv shapes `ci/ciapi.ts` builds — every one must pass.
    #[test]
    fn what_the_ci_panel_runs_is_allowed() {
        let gh = "repos/BorisToboltsov/vterm";
        let gl = "projects/boris%2Fvterm";
        for ok in [
            vec!["gh", "auth", "status", "--hostname", "github.com"],
            vec!["glab", "auth", "status", "--hostname", "192.168.20.80"],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/runs?per_page=30"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/runs?per_page=30&branch=feat%2Fci-runs"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/runs/42701787236"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/runs/42701787236/jobs?per_page=100&filter=latest"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/jobs/129448099178/logs"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/workflows?per_page=100"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                &format!("{gh}/actions/workflows/ci.yml/runs?per_page=20"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                "repos/actions/checkout/commits/v4",
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                "-X",
                "POST",
                &format!("{gh}/actions/runs/1/rerun-failed-jobs"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                "-X",
                "POST",
                &format!("{gh}/actions/runs/1/rerun"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                "-X",
                "POST",
                &format!("{gh}/actions/runs/1/cancel"),
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "github.com",
                "-X",
                "POST",
                &format!("{gh}/actions/workflows/deploy.yml/dispatches"),
                "-f",
                "ref=main",
                "-f",
                "inputs[environment]=staging",
                "-f",
                "inputs[dry_run]=true",
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "192.168.20.80",
                &format!("{gl}/pipelines?per_page=30&ref=main"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                &format!("{gl}/pipelines/77"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                &format!("{gl}/pipelines/77/jobs?per_page=100"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                &format!("{gl}/pipelines/77/bridges?per_page=100"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                &format!("{gl}/jobs/9/trace"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                "-X",
                "POST",
                &format!("{gl}/pipelines/77/retry"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                "-X",
                "POST",
                &format!("{gl}/pipelines/77/cancel"),
            ],
            vec![
                "glab",
                "api",
                "--hostname",
                "gitlab.com",
                "-X",
                "POST",
                &format!("{gl}/pipeline"),
                "-f",
                "ref=main",
                "-F",
                r#"variables=[{"key":"DEPLOY","value":"staging"}]"#,
            ],
        ] {
            assert_eq!(check_args(&argv(&ok)), Ok(()), "{ok:?}");
        }
    }

    /// Everything else `gh`/`glab` can do is out of reach: other commands, other
    /// endpoints, a write not spelled out, options that read a file or reach
    /// further, fields where none belong.
    #[test]
    fn the_ci_panel_reaches_only_the_runs_of_a_repository() {
        let gh = "repos/o/r";
        for bad in [
            vec!["gh"],
            vec!["git", "api", "repos/o/r/actions/runs"],
            vec!["sh", "-c", "gh api user"],
            vec!["gh", "repo", "delete", "o/r", "--yes"],
            vec!["gh", "run", "list"],
            vec!["gh", "auth", "token"],
            vec!["gh", "auth", "status", "--show-token"],
            vec!["gh", "secret", "list"],
            vec!["gh", "api", "user"],
            vec!["gh", "api", "repos/o/r"],
            vec!["gh", "api", "-X", "DELETE", "repos/o/r"],
            vec!["gh", "api", "--method", "PATCH", "repos/o/r/actions/runs/1"],
            vec!["gh", "api", "repos/o/r/actions/secrets"],
            vec!["gh", "api", "repos/o/r/../../user/actions/runs"],
            vec!["gh", "api", "/repos/o/r/actions/runs"],
            vec!["gh", "api", "repos/o/r/actions/runs/1/rerun"],
            vec!["gh", "api", "repos/o/r/actions/runs/abc"],
            vec!["gh", "api", "repos/o/r/actions/runs?per_page=1&secret=1"],
            vec!["gh", "api", "repos/o/r/actions/runs?branch=a;rm"],
            vec![
                "gh",
                "api",
                "repos/o/r/actions/runs",
                "--input",
                "/etc/passwd",
            ],
            vec!["gh", "api", "repos/o/r/actions/runs", "-H", "Accept: x"],
            vec!["gh", "api", "repos/o/r/actions/runs", "--paginate"],
            vec!["gh", "api", "repos/o/r/actions/runs", "-f", "x=1"],
            vec![
                "gh",
                "api",
                "repos/o/r/actions/workflows/ci.yml/dispatches",
                "-f",
                "ref=main",
            ],
            vec![
                "gh",
                "api",
                "-X",
                "POST",
                "repos/o/r/actions/workflows/ci.yml/dispatches",
                "-F",
                "ref=@/etc/passwd",
            ],
            vec![
                "gh",
                "api",
                "-X",
                "POST",
                "repos/o/r/actions/workflows/ci.yml/dispatches",
                "-f",
                "inputs[a b]=x",
            ],
            vec![
                "gh",
                "api",
                "-X",
                "POST",
                "repos/o/r/actions/runs/1/cancel",
                "-f",
                "ref=main",
            ],
            vec![
                "gh",
                "api",
                "--hostname",
                "-evil",
                &format!("{gh}/actions/runs"),
            ],
            vec![
                "gh",
                "api",
                &format!("{gh}/actions/runs"),
                &format!("{gh}/actions/runs"),
            ],
            vec!["glab", "api", "projects/p/variables"],
            vec![
                "glab",
                "api",
                "-X",
                "POST",
                "projects/p/pipeline",
                "-F",
                "variables=@/etc/passwd",
            ],
            vec![
                "glab",
                "api",
                "-X",
                "POST",
                "projects/p/pipeline",
                "-f",
                "variables=[]",
            ],
            vec![
                "glab",
                "api",
                "projects/p/pipelines",
                "--placeholder",
                "x=y",
            ],
            vec!["glab", "api", "repos/o/r/actions/runs"],
            vec!["gh", "api", "projects/p/pipelines"],
        ] {
            assert!(check_args(&argv(&bad)).is_err(), "allowed: {bad:?}");
        }
    }

    #[test]
    fn a_run_started_by_hand_keeps_its_inputs_out_of_the_record() {
        let args = argv(&[
            "gh",
            "api",
            "-X",
            "POST",
            "repos/o/r/actions/workflows/d.yml/dispatches",
            "-f",
            "ref=main",
            "-f",
            "inputs[token]=s3cr3t",
        ]);
        let written = audit_command(&args);
        assert!(written.contains("-f ref=main"), "{written}");
        assert!(written.contains("-f inputs[token]=…"), "{written}");
        assert!(!written.contains("s3cr3t"), "{written}");
        assert!(has_fields(&args));
        assert!(!has_fields(&argv(&["gh", "api", "repos/o/r/actions/runs"])));
    }

    #[test]
    fn the_remote_command_carries_the_quiet_environment() {
        let cmd = ssh_command(&argv(&["gh", "api", "repos/o/r/actions/runs"]));
        assert!(cmd.starts_with("GH_PROMPT_DISABLED=1 "), "{cmd}");
        assert!(cmd.contains("NO_COLOR=1"), "{cmd}");
        assert!(
            cmd.ends_with("'gh' 'api' 'repos/o/r/actions/runs'"),
            "{cmd}"
        );
    }
}
