//! A one-connection relay for the MySQL driver (ADR 0080).
//!
//! `mysql_async` connects only by itself — to an address or a socket file — and
//! takes no stream from outside. A database behind an SSH server is reached
//! through a channel, so the driver is given a door that leads into it: a unix
//! socket in a folder only this user may enter (`0700`), or, on Windows, a
//! loopback port. The door takes exactly one connection and closes behind it;
//! the bytes then go between that connection and the channel until either ends.
//!
//! On Windows the loopback port is open to this computer's other processes for
//! the moment between binding and the driver's connect; one that took it would
//! reach the database's port — and still need its login (SECURITY.md).

use super::net::{Io, OPEN_TIMEOUT};
use crate::diag::Logged;
use crate::error::AppResult;

/// Where the driver is to connect: a socket file, or a loopback port.
pub enum Door {
    #[cfg(unix)]
    Socket(String),
    #[cfg(not(unix))]
    Port(u16),
}

/// Open a door to `upstream` for one connection.
pub async fn open(upstream: Io) -> AppResult<Door> {
    #[cfg(unix)]
    {
        let dir = tempfile::Builder::new().prefix("vterm-db-").tempdir()?;
        let path = dir.path().join("s");
        let listener = tokio::net::UnixListener::bind(&path)?;
        let door = path.to_string_lossy().into_owned();
        tokio::spawn(async move {
            let accepted = tokio::time::timeout(OPEN_TIMEOUT, listener.accept()).await;
            drop(listener);
            // The one connection is in: nobody else may come through the door.
            std::fs::remove_file(&path)
                .log_debug("db", "the relay's socket file stayed until its folder goes");
            match accepted {
                Ok(Ok((sock, _))) => carry(sock, upstream).await,
                Ok(Err(why)) => {
                    tracing::debug!(source = "db", reason = %why.kind(), "the relay took no connection")
                }
                Err(_) => tracing::debug!(source = "db", "the relay's connection never came"),
            }
            drop(dir);
        });
        Ok(Door::Socket(door))
    }
    #[cfg(not(unix))]
    {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        tokio::spawn(async move {
            let accepted = tokio::time::timeout(OPEN_TIMEOUT, listener.accept()).await;
            drop(listener);
            match accepted {
                Ok(Ok((sock, _))) => {
                    sock.set_nodelay(true)
                        .log_debug("db", "the relay kept Nagle's delay");
                    carry(sock, upstream).await
                }
                Ok(Err(why)) => {
                    tracing::debug!(source = "db", reason = %why.kind(), "the relay took no connection")
                }
                Err(_) => tracing::debug!(source = "db", "the relay's connection never came"),
            }
        });
        Ok(Door::Port(port))
    }
}

/// Bytes both ways until either side ends.
async fn carry<S>(mut sock: S, mut upstream: Io)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::io::copy_bidirectional(&mut sock, &mut upstream)
        .await
        .log_debug(
            "db",
            "a database relay ended with an error: the driver sees the connection close",
        );
}
