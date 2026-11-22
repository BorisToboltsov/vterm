# Disposable sshd that lets connections through to the databases of its compose
# network (`direct-tcpip`) and to PostgreSQL's socket shared with it
# (`direct-streamlocal`), like a database host reached over SSH. Account:
#   tester / testpass
# Used by the ignored `live_db` tests in src-tauri/src/db/mod.rs.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash tester && echo 'tester:testpass' | chpasswd
COPY db.conf /etc/ssh/sshd_config.d/db.conf
# sshd itself stays root: it must switch to the logging-in user (accepted in
# .trivyignore.yaml for this file only). An unprivileged port, though.
EXPOSE 2222
HEALTHCHECK --interval=5s --timeout=3s --retries=6 CMD bash -c 'echo > /dev/tcp/127.0.0.1/2222' || exit 1
CMD ["/usr/sbin/sshd", "-D", "-e"]
