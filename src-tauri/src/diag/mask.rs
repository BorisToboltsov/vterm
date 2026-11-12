//! The last line of defence (ADR 0063): an event's text — and every string field —
//! goes through the same masking the assistant's context gets
//! (`src/lib/ai/redact.ts`, `redactSecrets`) before it reaches the disk. A token
//! can ride inside a server's error text; not handing a secret to an event at
//! all is the caller's duty, which the gates hold.
//!
//! The rules mirror `redact.ts` one for one, in the same order; the shared
//! examples (`src/lib/ai/redact.cases.json`) are checked against both sides.
//! The JavaScript rule for `KEY="value"` matches the closing quote by a
//! backreference, which `regex` has not: here the value simply stops before it,
//! which masks the same characters.

use regex::Regex;
use std::sync::OnceLock;

/// Written in place of a masked value — the glyphs of `redact.ts` and `recording.rs`.
pub const REDACTED: &str = "‹redacted›";

/// Key names that mark a sensitive assignment (`PGPASSWORD=…`, `api_key: …`).
const SENSITIVE_KEY: &str = r"(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|client[_-]?secret|credential|passphrase|private[_-]?key)";

/// A rule: the pattern, and the capture groups masked (0 — the whole match).
struct Rule {
    re: Regex,
    groups: &'static [usize],
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rule = |pattern: &str, groups: &'static [usize]| Rule {
            // The patterns are constants, checked by the tests below.
            re: Regex::new(pattern).expect("a masking rule is a valid pattern"),
            groups,
        };
        vec![
            rule(
                &format!(
                    r#"(?i)([A-Za-z0-9_.\-]*{SENSITIVE_KEY}[A-Za-z0-9_.\-]*\s*[:=]\s*)(["']?)([^\s"']+)"#
                ),
                &[3],
            ),
            rule(r"(?i)\b(Bearer|Basic|Token)\s+([A-Za-z0-9._\-+/=]{8,})", &[2]),
            rule(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:@/]+:)([^\s:@/]+)(@)", &[2]),
            rule(r"\bAKIA[0-9A-Z]{16}\b", &[0]),
            rule(
                r"(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)",
                &[2],
            ),
            rule(r"(?i)\b((?:password|passphrase)\s*:\s+)(\S+)", &[2]),
            rule(r"\beyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+", &[0]),
            rule(r"\bgh[posru]_[A-Za-z0-9]{20,}\b", &[0]),
            rule(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", &[0]),
            rule(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", &[0]),
            rule(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b", &[0]),
            rule(r"\bAIza[0-9A-Za-z_-]{35}\b", &[0]),
            rule(r"\bya29\.[A-Za-z0-9_-]{20,}", &[0]),
        ]
    })
}

/// `text` with every recognised secret replaced by [`REDACTED`].
pub fn mask(text: &str) -> String {
    let mut out = text.to_owned();
    for rule in rules() {
        if !rule.re.is_match(&out) {
            continue;
        }
        out = rule
            .re
            .replace_all(&out, |caps: &regex::Captures<'_>| {
                let full = &caps[0];
                let masked = |g: usize| caps.get(g).map_or("", |m| m.as_str());
                // Already masked by an earlier rule: left as it is.
                if rule.groups.iter().all(|&g| masked(g) == REDACTED) {
                    return full.to_owned();
                }
                let mut result = full.to_owned();
                for &g in rule.groups {
                    let value = masked(g);
                    if !value.is_empty() {
                        result = result.replacen(value, REDACTED, 1);
                    }
                }
                result
            })
            .into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        input: String,
        output: String,
    }

    /// The examples `redact.test.ts` holds `redactSecrets` to: one masking, two sides.
    #[test]
    fn the_mask_matches_the_frontends_on_the_shared_examples() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../src/lib/ai/redact.cases.json"))
                .expect("the shared examples parse");
        assert!(cases.len() >= 10, "the shared examples are all there");
        for case in cases {
            assert_eq!(mask(&case.input), case.output, "masking {:?}", case.input);
        }
    }

    #[test]
    fn text_without_a_secret_is_left_alone() {
        let text = "connect to deploy@10.0.0.5:22 failed: connection refused (/etc/nginx)";
        assert_eq!(mask(text), text);
    }

    #[test]
    fn masking_twice_changes_nothing_more() {
        let once = mask("PGPASSWORD=hunter2 and Bearer abcdefgh12345");
        assert_eq!(mask(&once), once);
    }
}
