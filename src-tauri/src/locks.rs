// Locks that survive a panic (v1.25.1). A std `Mutex` held during a panic is
// poisoned, and every later `lock().unwrap()` panics in turn: one failed command
// would take down every command that touches the same registry — the sessions,
// the server list, the cancel flags — for the rest of the run. The state behind
// these locks is maps and lists updated in single calls, so the guard is taken
// as it stands, the way `appwin` and `outgate` already did.

use std::sync::{Mutex, MutexGuard};

pub(crate) trait Locked<T> {
    /// `lock()`, taking the guard of a poisoned mutex instead of panicking.
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::srcscan::shipped_code;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_mutex_is_still_usable() {
        let m = Arc::new(Mutex::new(vec![1]));
        let held = Arc::clone(&m);
        let joined = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(joined.is_err(), "the thread panicked holding the lock");
        assert!(m.is_poisoned());
        m.locked().push(2);
        assert_eq!(*m.locked(), vec![1, 2]);
    }

    /// How many times code outside test modules takes a lock a poisoned one
    /// refuses: it would panic (`unwrap`, `expect`) or skip in silence what the
    /// lock guards (`if let Ok(g) = ….lock() {`, `match`, `let … else`, `ok()`).
    /// Whitespace is squeezed out, because rustfmt puts each call of a long chain
    /// on its own line.
    fn bare_locks(src: &str) -> usize {
        let squeezed: String = shipped_code(src).split_whitespace().collect();
        [".unwrap()", ".expect(", "{", "else{", ".ok()"]
            .into_iter()
            .map(|next| squeezed.matches(&format!(".lock(){next}")).count())
            .sum()
    }

    fn sources(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push((
                    path.display().to_string(),
                    std::fs::read_to_string(&path).unwrap(),
                ));
            }
        }
    }

    #[test]
    fn a_poisoned_lock_never_cascades() {
        let mut files = Vec::new();
        sources(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        assert!(files.len() > 10);
        let offenders: Vec<String> = files
            .iter()
            .filter_map(|(path, src)| match bare_locks(src) {
                0 => None,
                n => Some(format!("{path}: {n}")),
            })
            .collect();
        assert!(
            offenders.is_empty(),
            "use `.locked()` (crate::locks::Locked), which neither panics on a poisoned lock nor skips it:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn the_gate_catches_its_own_violations() {
        assert_eq!(bare_locks("let a = m.lock().unwrap();"), 1);
        assert_eq!(bare_locks("let a = m.lock() .expect(\"x\");"), 1);
        let split =
            "let a = state\n            .servers\n            .lock()\n            .unwrap();";
        assert_eq!(bare_locks(split), 1);
        assert_eq!(bare_locks("// m.lock().unwrap() in a comment"), 0);
        assert_eq!(
            bare_locks("let a = m.locked(); // not m.lock().unwrap()"),
            0
        );
        assert_eq!(bare_locks("let a = m.locked();"), 0);
        // Skipping a poisoned lock in silence is the same fault as panicking on it.
        for skip in [
            "if let Ok(mut g) = m.lock() { g.push(1); }",
            "if let Ok(g) = self.rec\n    .lock()\n{\n}",
            "while let Ok(g) = m.lock() {}",
            "match m.lock() { Ok(g) => g.len(), Err(_) => 0 };",
            "let Ok(g) = m.lock() else { return; };",
            "if let Some(g) = m.lock().ok() {}",
        ] {
            assert_eq!(bare_locks(skip), 1, "{skip}");
        }
        // A tokio lock has no poison, a guard of one's own method is no `Result`.
        for fine in [
            "if let Some(s) = map.lock().await.get(id) {}",
            "let g = m.lock().unwrap_or_else(|e| e.into_inner());",
            "if self.lock().held.is_none() {}",
        ] {
            assert_eq!(bare_locks(fine), 0, "{fine}");
        }
        assert_eq!(
            bare_locks("fn f() {}\n#[cfg(test)]\nmod t { fn f() { m.lock().unwrap(); } }"),
            0
        );
        // A test-only item before production code does not hide what follows it.
        assert_eq!(
            bare_locks("#[cfg(test)]\nfn helper() {}\nfn f() { m.lock().unwrap(); }"),
            1
        );
        // Nor does a test module in the middle of a file, or a second one after it.
        let bad = "fn f() { m.lock().unwrap(); }";
        let module = format!("#[cfg(test)]\nmod t {{ {bad} }}\n");
        assert_eq!(bare_locks(&format!("{module}{bad}")), 1);
        assert_eq!(bare_locks(&format!("{module}{bad}\n{module}{bad}")), 2);
        let visible = format!("#[cfg(test)]\npub(crate) mod t {{ {bad} }}");
        assert_eq!(bare_locks(&visible), 0);
        // A test-only field is no module, whatever module follows it.
        let field = format!("struct S {{\n#[cfg(test)]\nx: u8,\n}}\nmod live {{ {bad} }}");
        assert_eq!(bare_locks(&field), 1);
        // A brace or an attribute inside a literal or a comment is no code.
        for text in [
            r#""}""#,
            r#""{""#,
            r#""\"{""#,
            r##"r#"" {"#"##,
            r##"br#"{"#"##,
            r#"cr"{""#,
            "b'{'",
            "'\\''; '{'",
            "'}'",
            "'\\u{7d}'",
            "/* /* */ { */",
            "// {\n",
        ] {
            let test = format!("#[cfg(test)]\nmod t {{ {text}; {bad} }}\n{bad}");
            assert_eq!(bare_locks(&test), 1, "{text}");
        }
        let quoted = format!("const M: &str = \"#[cfg(test)] mod t {{\";\n{bad}");
        assert_eq!(bare_locks(&quoted), 1);
        let url = "fn f() { open(\"https://x\", m.lock().unwrap()); }";
        assert_eq!(bare_locks(url), 1);
        let lifetime = format!("fn g<'a>(x: &'a str) {{}}\n{bad}");
        assert_eq!(bare_locks(&lifetime), 1);
    }
}
