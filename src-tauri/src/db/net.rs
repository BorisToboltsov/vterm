//! Where a database's bytes go (ADR 0080): a channel of the tab's SSH
//! connection — nothing opens on this computer — or, for a database of this
//! computer, a socket to its loopback or to a socket file, and to nothing
//! further. The only sockets this module opens; the gate `app_originated_sockets_live_only_in_ssh_netcheck_and_db`
//! holds every other file of the app off them.

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;
use futures_util::future::BoxFuture;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

/// A byte stream a driver speaks over, whatever carries it.
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type Io = Box<dyn Stream>;

/// How long reaching a database may take before it is said not to answer.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// The address of a database, as whoever reaches it sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Addr {
    Tcp {
        host: String,
        port: u16,
    },
    /// A unix socket file.
    Unix(String),
}

impl Addr {
    /// The address of a profile: `host` starting with `/` is a socket —
    /// PostgreSQL's socket folder (its file is `.s.PGSQL.<port>` in it), MySQL's
    /// socket file itself.
    pub fn of(kind: crate::model::DbKind, host: &str, port: u16) -> Addr {
        let host = host.trim();
        if host.starts_with('/') {
            match kind {
                crate::model::DbKind::Postgres => {
                    Addr::Unix(format!("{}/.s.PGSQL.{port}", host.trim_end_matches('/')))
                }
                crate::model::DbKind::Mysql => Addr::Unix(host.to_string()),
            }
        } else {
            Addr::Tcp {
                host: host.to_string(),
                port,
            }
        }
    }

    /// This address as one of this computer — none for any other. A name is
    /// not resolved: `localhost` is the loopback itself, whatever hosts says.
    pub fn on_this_computer(self) -> AppResult<Addr> {
        match self {
            Addr::Unix(path) => Ok(Addr::Unix(path)),
            Addr::Tcp { host, port } => {
                let host = if host.eq_ignore_ascii_case("localhost") {
                    "127.0.0.1".to_string()
                } else {
                    host
                };
                match host.parse::<std::net::IpAddr>() {
                    Ok(ip) if ip.is_loopback() => Ok(Addr::Tcp { host, port }),
                    _ => Err(AppError::DbNotLocal),
                }
            }
        }
    }

    /// How it is named in events and messages.
    pub fn label(&self) -> String {
        match self {
            Addr::Tcp { host, port } => format!("{host}:{port}"),
            Addr::Unix(path) => path.clone(),
        }
    }
}

/// Channels to a database through an SSH connection — the tab's session, or a
/// test's own connection to a disposable server.
pub trait Tunnel: Send + Sync {
    fn tcp<'a>(&'a self, host: &'a str, port: u16) -> BoxFuture<'a, AppResult<Io>>;
    fn unix<'a>(&'a self, path: &'a str) -> BoxFuture<'a, AppResult<Io>>;
}

impl Tunnel for SshSession {
    fn tcp<'a>(&'a self, host: &'a str, port: u16) -> BoxFuture<'a, AppResult<Io>> {
        Box::pin(async move {
            let channel = self
                .direct_tcpip(host, port)
                .await
                .map_err(|e| AppError::DbTunnelRefused(e.to_string()))?;
            Ok(Box::new(channel.into_stream()) as Io)
        })
    }

    fn unix<'a>(&'a self, path: &'a str) -> BoxFuture<'a, AppResult<Io>> {
        Box::pin(async move {
            let channel = self
                .direct_streamlocal(path)
                .await
                .map_err(|e| AppError::DbTunnelRefused(e.to_string()))?;
            Ok(Box::new(channel.into_stream()) as Io)
        })
    }
}

/// Who reaches the database: an SSH connection, or this computer.
#[derive(Clone)]
pub enum Via {
    Ssh(Arc<dyn Tunnel>),
    Here,
}

/// A database's place: who reaches it and where. Opened once for the
/// connection, and again for each cancel (a cancel is a connection of its own).
#[derive(Clone)]
pub struct Target {
    pub via: Via,
    pub addr: Addr,
}

impl Target {
    /// A new stream to the database.
    pub async fn open(&self) -> AppResult<Io> {
        match (&self.via, &self.addr) {
            (Via::Ssh(tunnel), Addr::Tcp { host, port }) => tunnel.tcp(host, *port).await,
            (Via::Ssh(tunnel), Addr::Unix(path)) => tunnel.unix(path).await,
            (Via::Here, Addr::Tcp { host, port }) => {
                let connect = tokio::net::TcpStream::connect((host.as_str(), *port));
                match tokio::time::timeout(OPEN_TIMEOUT, connect).await {
                    Ok(Ok(s)) => {
                        s.set_nodelay(true).log_debug(
                            "db",
                            "the database socket kept Nagle's delay: small statements may wait a little",
                        );
                        Ok(Box::new(s))
                    }
                    Ok(Err(e)) => Err(format!("{host}:{port}: {e}").into()),
                    Err(_) => Err(format!(
                        "{host}:{port}: no answer in {} s",
                        OPEN_TIMEOUT.as_secs()
                    )
                    .into()),
                }
            }
            #[cfg(unix)]
            (Via::Here, Addr::Unix(path)) => tokio::net::UnixStream::connect(path)
                .await
                .map(|s| Box::new(s) as Io)
                .map_err(|e| format!("{path}: {e}").into()),
            #[cfg(not(unix))]
            (Via::Here, Addr::Unix(path)) => {
                Err(format!("{path}: unix sockets are not reachable on this computer").into())
            }
        }
    }
}

use crate::diag::Logged;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DbKind;

    #[test]
    fn a_socket_folder_names_the_postgres_socket_and_a_socket_file_is_mysqls() {
        assert_eq!(
            Addr::of(DbKind::Postgres, "/var/run/postgresql/", 5432),
            Addr::Unix("/var/run/postgresql/.s.PGSQL.5432".into())
        );
        assert_eq!(
            Addr::of(DbKind::Mysql, "/run/mysqld/mysqld.sock", 3306),
            Addr::Unix("/run/mysqld/mysqld.sock".into())
        );
        assert_eq!(
            Addr::of(DbKind::Postgres, " 10.0.0.5 ", 6432),
            Addr::Tcp {
                host: "10.0.0.5".into(),
                port: 6432
            }
        );
        assert_eq!(Addr::of(DbKind::Mysql, "db", 3306).label(), "db:3306");
    }

    /// Decision of ADR 0080: the exception to "offline" is this computer alone.
    #[test]
    fn a_database_of_this_computer_is_reached_on_this_computer_alone() {
        let here = |host: &str| Addr::of(DbKind::Postgres, host, 5432).on_this_computer();
        for host in ["127.0.0.1", "127.8.0.1", "::1", "/var/run/postgresql"] {
            assert!(here(host).is_ok(), "{host}");
        }
        assert_eq!(
            here("LocalHost").expect("loopback"),
            Addr::Tcp {
                host: "127.0.0.1".into(),
                port: 5432
            }
        );
        for host in [
            "10.0.0.5",
            "0.0.0.0",
            "db",
            "example.com",
            "127.0.0.1.example.com",
            "169.254.169.254",
        ] {
            assert!(matches!(here(host), Err(AppError::DbNotLocal)), "{host}");
        }
    }
}
