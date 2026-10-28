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
    use std::sync::Arc;

    #[test]
    fn a_poisoned_mutex_is_still_usable() {
        let m = Arc::new(Mutex::new(vec![1]));
        let held = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        m.locked().push(2);
        assert_eq!(*m.locked(), vec![1, 2]);
    }

    /// How many times code outside tests would still panic on a poisoned lock: a
    /// bare `.lock().unwrap()` or `.lock().expect(…)`. Line comments are dropped
    /// (the docs may name the pattern) and whitespace is squeezed out, because
    /// rustfmt puts each call of a long chain on its own line.
    fn bare_lock_unwraps(src: &str) -> usize {
        // Up to the first test MODULE: a `#[cfg(test)]` on a single item (a
        // test-only variant in sftp.rs, a helper in webview2.rs) sits in the
        // middle of production code.
        let end = src
            .match_indices("#[cfg(test)]")
            .map(|(i, m)| i + m.len())
            .find(|&after| src[after..].trim_start().starts_with("mod "))
            .map_or(src.len(), |after| after - "#[cfg(test)]".len());
        let code = &src[..end];
        let squeezed: String = code
            .lines()
            .map(|l| l.split("//").next().unwrap_or(l))
            .flat_map(str::chars)
            .filter(|c| !c.is_whitespace())
            .collect();
        squeezed.matches(".lock().unwrap()").count() + squeezed.matches(".lock().expect(").count()
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
            .filter(|(path, _)| !path.ends_with("locks.rs"))
            .filter_map(|(path, src)| match bare_lock_unwraps(src) {
                0 => None,
                n => Some(format!("{path}: {n}")),
            })
            .collect();
        assert!(
            offenders.is_empty(),
            "use `.locked()` (crate::locks::Locked) instead of a bare lock unwrap:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn the_gate_catches_its_own_violations() {
        assert_eq!(bare_lock_unwraps("let a = m.lock().unwrap();"), 1);
        assert_eq!(bare_lock_unwraps("let a = m.lock() .expect(\"x\");"), 1);
        let split =
            "let a = state\n            .servers\n            .lock()\n            .unwrap();";
        assert_eq!(bare_lock_unwraps(split), 1);
        assert_eq!(bare_lock_unwraps("// m.lock().unwrap() in a comment"), 0);
        assert_eq!(
            bare_lock_unwraps("let a = m.locked(); // not m.lock().unwrap()"),
            0
        );
        assert_eq!(bare_lock_unwraps("let a = m.locked();"), 0);
        assert_eq!(
            bare_lock_unwraps("fn f() {}\n#[cfg(test)]\nmod t { fn f() { m.lock().unwrap(); } }"),
            0
        );
        // A test-only item before production code does not hide what follows it.
        assert_eq!(
            bare_lock_unwraps("#[cfg(test)]\nfn helper() {}\nfn f() { m.lock().unwrap(); }"),
            1
        );
    }
}
