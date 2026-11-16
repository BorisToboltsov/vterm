//! Language servers over the session's transport (ADR 0079).
//!
//! The editor talks LSP to the user's own language server where the project
//! lives: on the server, through one long-lived SSH exec channel; on this
//! computer, through a child process. This module knows which servers there
//! are (a fixed catalogue — the window names a server by its id, never an
//! argv), frames JSON-RPC messages (`Content-Length`), and keeps the registry
//! of the servers running, each tied to the session of its tab: the session's
//! end stops them. What the messages say is never written anywhere — only that
//! a server started, how it stopped and how long it ran.

use crate::locks::Locked;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// One language server the editor can start: its id, program and arguments.
pub struct Server {
    pub id: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
}

/// The catalogue. A server not here cannot be started: the window passes an id.
pub const SERVERS: &[Server] = &[
    Server {
        id: "basedpyright",
        program: "basedpyright-langserver",
        args: &["--stdio"],
    },
    Server {
        id: "pyright",
        program: "pyright-langserver",
        args: &["--stdio"],
    },
    Server {
        id: "pylsp",
        program: "pylsp",
        args: &[],
    },
    Server {
        id: "rust-analyzer",
        program: "rust-analyzer",
        args: &[],
    },
    Server {
        id: "gopls",
        program: "gopls",
        args: &[],
    },
    Server {
        id: "terraform-ls",
        program: "terraform-ls",
        args: &["serve"],
    },
    Server {
        id: "yaml-language-server",
        program: "yaml-language-server",
        args: &["--stdio"],
    },
    Server {
        id: "ansible-language-server",
        program: "ansible-language-server",
        args: &["--stdio"],
    },
    Server {
        id: "bash-language-server",
        program: "bash-language-server",
        args: &["start"],
    },
    Server {
        id: "typescript-language-server",
        program: "typescript-language-server",
        args: &["--stdio"],
    },
    Server {
        id: "docker-langserver",
        program: "docker-langserver",
        args: &["--stdio"],
    },
    Server {
        id: "helm_ls",
        program: "helm_ls",
        args: &["serve"],
    },
    Server {
        id: "clangd",
        program: "clangd",
        args: &[],
    },
];

/// The server of an id, or None — a name the catalogue does not know.
pub fn server(id: &str) -> Option<&'static Server> {
    SERVERS.iter().find(|s| s.id == id)
}

/// The largest message a server may send in one frame; a bigger one ends it.
pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;

/// The project folder a server starts in: absolute and one line.
pub fn check_root(root: &str) -> Result<(), String> {
    let abs = root.starts_with('/') || root.chars().nth(1) == Some(':') || root.starts_with("\\\\");
    if abs && !root.contains(['\n', '\r', '\0']) && root.len() <= 4096 {
        Ok(())
    } else {
        Err(format!(
            "not a folder to start a language server in: {root}"
        ))
    }
}

/// Whether the program is there, over SSH: the user's tool folders on `PATH`.
pub fn check_command(s: &Server) -> String {
    format!(
        "PATH=\"{}\" command -v {} >/dev/null 2>&1 && echo __VTERM_OK__",
        crate::format::TOOL_PATH,
        crate::git::shell_quote(s.program)
    )
}

/// The command a server runs as over SSH: in the project's folder, replacing the shell.
pub fn remote_command(root: &str, s: &Server) -> String {
    let mut cmd = format!(
        "cd {} && PATH=\"{}\" exec {}",
        crate::git::shell_quote(root),
        crate::format::TOOL_PATH,
        crate::git::shell_quote(s.program)
    );
    for a in s.args {
        cmd.push(' ');
        cmd.push_str(&crate::git::shell_quote(a));
    }
    cmd
}

/// One message as it goes to a server.
pub fn frame(message: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    out.extend_from_slice(message.as_bytes());
    out
}

/// Reads frames out of what a server prints, however it arrives in pieces.
#[derive(Default)]
pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    /// The whole messages `data` completes; an error ends the server (a frame
    /// without a length, or one over [`MAX_MESSAGE`]).
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<String>, String> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            let Some(end) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                if self.buf.len() > 8 * 1024 {
                    return Err("a header longer than 8 KiB".into());
                }
                break;
            };
            let head = String::from_utf8_lossy(&self.buf[..end]).into_owned();
            let len = head
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.trim()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())
                        .flatten()
                })
                .ok_or_else(|| "a frame without Content-Length".to_string())?;
            if len > MAX_MESSAGE {
                return Err(format!("a message of {len} bytes"));
            }
            let start = end + 4;
            if self.buf.len() < start + len {
                break;
            }
            let body = self.buf[start..start + len].to_vec();
            self.buf.drain(..start + len);
            out.push(String::from_utf8_lossy(&body).into_owned());
        }
        Ok(out)
    }
}

/// The event a server's messages arrive on, and the one that says it stopped.
pub fn message_event(id: &str) -> String {
    format!("lsp://msg/{id}")
}
pub fn closed_event(id: &str) -> String {
    format!("lsp://closed/{id}")
}

/// What reaches a running server: a framed message, or the word to stop.
pub enum Input {
    Message(Vec<u8>),
    Stop,
}

struct Conn {
    session: String,
    tx: mpsc::UnboundedSender<Input>,
}

/// The servers running, by id, each with the session it dies with.
#[derive(Default)]
pub struct Lsps {
    inner: Mutex<HashMap<String, Conn>>,
}

impl Lsps {
    pub fn insert(&self, id: String, session: String, tx: mpsc::UnboundedSender<Input>) {
        self.inner.locked().insert(id, Conn { session, tx });
    }

    /// Hand a message to a server; false — it is not running.
    pub fn send(&self, id: &str, message: &str) -> bool {
        self.inner
            .locked()
            .get(id)
            .is_some_and(|c| c.tx.send(Input::Message(frame(message))).is_ok())
    }

    /// Stop a server (it is forgotten when its reader sees the end).
    pub fn stop(&self, id: &str) {
        if let Some(c) = self.inner.locked().remove(id) {
            let _sent = c.tx.send(Input::Stop).is_ok();
        }
    }

    /// Forget a server that ended by itself.
    pub fn forget(&self, id: &str) {
        self.inner.locked().remove(id);
    }

    /// Stop every server of a session (its tab closed); how many there were.
    pub fn stop_session(&self, session: &str) -> usize {
        let mut map = self.inner.locked();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, c)| c.session == session)
            .map(|(k, _)| k.clone())
            .collect();
        for id in &ids {
            if let Some(c) = map.remove(id) {
                let _sent = c.tx.send(Input::Stop).is_ok();
            }
        }
        ids.len()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.locked().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_language_server_is_named_never_given_as_a_command() {
        assert!(server("pyright").is_some());
        assert!(server("sh").is_none());
        assert!(server("pyright; rm -rf ~").is_none());
        for s in SERVERS {
            assert!(!s.program.contains(['/', ' ', ';', '$']), "{}", s.program);
        }
        let cmd = remote_command("/srv/my app", server("terraform-ls").expect("known"));
        assert_eq!(
            cmd,
            format!(
                "cd '/srv/my app' && PATH=\"{}\" exec 'terraform-ls' 'serve'",
                crate::format::TOOL_PATH
            )
        );
        assert!(check_root("/srv").is_ok());
        assert!(check_root("C:\\work").is_ok());
        assert!(check_root("srv").is_err());
        assert!(check_root("/a\nb").is_err());
    }

    #[test]
    fn frames_survive_any_split() {
        let a = frame(r#"{"id":1}"#);
        let b = frame(r#"{"id":2,"x":"ж"}"#);
        let all = [a.clone(), b.clone()].concat();
        for cut in 0..all.len() {
            let mut f = Framer::default();
            let mut got = f.push(&all[..cut]).expect("ok");
            got.extend(f.push(&all[cut..]).expect("ok"));
            assert_eq!(
                got,
                vec![r#"{"id":1}"#.to_string(), r#"{"id":2,"x":"ж"}"#.to_string()],
                "cut at {cut}"
            );
        }
        let mut f = Framer::default();
        assert_eq!(
            f.push(b"Content-Type: x\r\ncontent-length: 2\r\n\r\n{}")
                .expect("ok"),
            vec!["{}".to_string()]
        );
    }

    #[test]
    fn a_broken_or_huge_frame_ends_the_server() {
        let mut f = Framer::default();
        assert!(f.push(b"Bogus: 1\r\n\r\n{}").is_err());
        let mut f = Framer::default();
        assert!(f
            .push(format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE + 1).as_bytes())
            .is_err());
        let mut f = Framer::default();
        assert!(f.push(&vec![b'x'; 9000]).is_err());
    }

    #[test]
    fn a_session_takes_its_servers_with_it() {
        let lsps = Lsps::default();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, _rx2) = mpsc::unbounded_channel();
        lsps.insert("a".into(), "s1".into(), tx1);
        lsps.insert("b".into(), "s2".into(), tx2);
        assert!(lsps.send("a", "{}"));
        assert!(!lsps.send("zz", "{}"));
        assert_eq!(lsps.stop_session("s1"), 1);
        assert_eq!(lsps.len(), 1);
        assert!(matches!(rx1.try_recv(), Ok(Input::Message(_))));
        assert!(matches!(rx1.try_recv(), Ok(Input::Stop)));
    }
}
