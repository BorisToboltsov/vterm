// How a source gate reads Rust: without comments and, where only what ships
// counts, without test modules — wherever they stand. A cut at a file's first
// test marker hid the production code below it, and `split("//")` hid the rest
// of a line after a URL. Test-only (`lib.rs` mounts it under `cfg(test)`).
//
//   shipped_code     — calls and shapes of code as it ships, no literal counts
//   shipped          — the same with the literals as written: an event name, a marker
//   code_only        — calls and shapes of code, tests and all
//   without_comments — the same with the literals as written
//   call_args        — what a call is given

/// `code` without its test modules, wherever they stand: production code can
/// follow one. A `#[cfg(test)]` on anything else (a test-only variant in
/// sftp.rs, a helper in webview2.rs) hides nothing.
pub(crate) fn without_test_modules(code: &str) -> String {
    const TEST_ONLY: &str = "#[cfg(test)]";
    let mut kept = String::new();
    let mut rest = code;
    while let Some(at) = rest.find(TEST_ONLY) {
        kept.push_str(&rest[..at]);
        let item = &rest[at + TEST_ONLY.len()..];
        let (head, body) = item.split_at(item.find(['{', ';']).unwrap_or(item.len()));
        let words: Vec<&str> = head.split_whitespace().collect();
        let module = body.starts_with('{')
            && matches!(words[..], ["mod", _] | ["pub" | "pub(crate)", "mod", _]);
        rest = if module {
            &body[block_len(body)..]
        } else {
            item
        };
    }
    kept + rest
}

/// How long the `{…}` that `code` starts with is.
fn block_len(code: &str) -> usize {
    let mut depth = 0;
    for (i, c) in code.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return i + 1;
        }
    }
    panic!("a block that never closes");
}

/// `src` with its comments dropped and its literals emptied: neither the
/// pattern, nor a brace, nor a `//` counts inside one.
pub(crate) fn code_only(src: &str) -> String {
    rewritten(src, |_| "\"\"".to_owned())
}

/// `src` as it ships, with its comments dropped and its literals emptied.
pub(crate) fn shipped_code(src: &str) -> String {
    without_test_modules(&code_only(src))
}

/// `src` with its comments dropped and its literals as written, tests and all.
/// Every line keeps its number.
pub(crate) fn without_comments(src: &str) -> String {
    rewritten(src, str::to_owned)
}

/// `src` as it ships: no comments, no test modules, the literals as written.
/// The modules are cut with a number standing in for each literal, so a brace
/// or a marker inside one opens and closes nothing.
pub(crate) fn shipped(src: &str) -> String {
    let mut literals = Vec::new();
    let numbered = rewritten(src, |literal| {
        literals.push(literal.to_owned());
        format!("\"{}\"", literals.len() - 1)
    });
    without_test_modules(&numbered)
        .split('"')
        .enumerate()
        .map(|(i, part)| match i % 2 {
            0 => part,
            _ => &literals[part.parse::<usize>().expect("a literal's number")],
        })
        .collect()
}

/// What each call in the code of `src` that begins with one of `heads` is given,
/// as written: a head ends at the call's `(`. A head or a bracket inside a
/// literal or a comment is none.
pub(crate) fn call_args(src: &str, heads: &[String]) -> Vec<String> {
    let code = without_comments(src);
    // Each literal blanked to its length: a place in `shape` is the same in `code`.
    let shape = rewritten(&code, |literal| " ".repeat(literal.len()));
    let mut found = Vec::new();
    for head in heads {
        for (at, _) in shape.match_indices(head.as_str()) {
            let start = at + head.len();
            let mut open = 1;
            let len = shape[start..]
                .find(|c| {
                    open += match c {
                        '(' => 1,
                        ')' => -1,
                        _ => 0,
                    };
                    open == 0
                })
                .expect("a call that closes");
            found.push(code[start..start + len].to_owned());
        }
    }
    found
}

/// `src` with LF line ends, its comments dropped along with the blanks before
/// them, and every literal as `literal` writes it.
fn rewritten(src: &str, mut literal: impl FnMut(&str) -> String) -> String {
    let src = src.replace("\r\n", "\n");
    let mut code = String::new();
    let mut rest = src.as_str();
    while let Some(c) = rest.chars().next() {
        let in_word = code.ends_with(|p: char| p.is_alphanumeric() || p == '_');
        let (kept, len) = if rest.starts_with("//") {
            // `}` and `;` before a comment still end their line: gates look for that.
            code.truncate(code.trim_end_matches([' ', '\t']).len());
            (String::new(), rest.find('\n').unwrap_or(rest.len()))
        } else if rest.starts_with("/*") {
            let len = comment_len(rest);
            let breaks = rest[..len].matches('\n').count();
            (format!(" {}", "\n".repeat(breaks)), len)
        } else if let Some(len) = literal_len(rest, in_word) {
            (literal(&rest[..len]), len)
        } else {
            (c.to_string(), c.len_utf8())
        };
        code.push_str(&kept);
        rest = &rest[len..];
    }
    code
}

/// How long the block comment `src` starts with is; they nest.
fn comment_len(src: &str) -> usize {
    let (mut depth, mut at) = (0, 0);
    while at < src.len() {
        match &src.as_bytes()[at..] {
            [b'/', b'*', ..] => (depth, at) = (depth + 1, at + 2),
            [b'*', b'/', ..] => (depth, at) = (depth - 1, at + 2),
            _ => at += 1,
        }
        if depth == 0 {
            return at;
        }
    }
    panic!("a comment that never closes");
}

/// How long the string or char literal `src` starts with is, if it starts with one.
fn literal_len(src: &str, in_word: bool) -> Option<usize> {
    let raw = ["r", "br", "cr"]
        .iter()
        .filter_map(|prefix| src.strip_prefix(prefix))
        .find(|body| !in_word && body.trim_start_matches('#').starts_with('"'));
    if let Some(body) = raw {
        let hashes = body.len() - body.trim_start_matches('#').len();
        let close = format!("\"{}", "#".repeat(hashes));
        let text = &body[hashes + 1..];
        let end = text.find(&close).expect("a raw string that closes") + close.len();
        return Some(src.len() - text.len() + end);
    }
    let mut chars = src.chars();
    let quote = chars.next().filter(|&c| c == '"' || c == '\'')?;
    // A quote that does not close after one char is a lifetime's.
    if quote == '\'' && chars.next()? != '\\' && chars.next()? != '\'' {
        return None;
    }
    let mut escaped = false;
    for (i, c) in src.char_indices().skip(1) {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            _ if c == quote => return Some(i + 1),
            _ => {}
        }
    }
    panic!("a literal that never closes");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_ships_keeps_literals_and_the_code_below_a_test_module() {
        let src = r##"fn a() { emit("window://close"); } // an event
/* } */
#[cfg(test)]
mod tests {
    const IN: &str = "} // {";
}
#[cfg(test)]
fn helper() {}
fn below() { open("https://x", r#"{"k":"1"}"#, '"'); dial(); }
"##;
        let code = shipped(src);
        for kept in [
            r#"emit("window://close"); }"#,
            "fn helper() {}",
            r##"open("https://x", r#"{"k":"1"}"#, '"'); dial(); }"##,
        ] {
            assert!(code.contains(kept), "{kept}: {code}");
        }
        for gone in ["an event", "mod tests", "const IN", "/*"] {
            assert!(!code.contains(gone), "{gone}: {code}");
        }
    }

    #[test]
    fn a_calls_args_end_at_its_own_bracket() {
        let src = "say(\"1) — готово\", f(x), ')'); /* say( */ g(\"say(\"); say(\"(\"); h();";
        assert_eq!(
            call_args(src, &["say(".to_owned()]),
            ["\"1) — готово\", f(x), ')'", "\"(\""]
        );
    }

    #[test]
    fn without_comments_a_line_keeps_its_number_and_its_end() {
        let src = "let a = f(\"//\"); // why\r\n/* one\r\ntwo */g();\r\n} // end\r\n";
        assert_eq!(without_comments(src), "let a = f(\"//\");\n \ng();\n}\n");
    }
}
