# Disposable sshd with real `su` and `sudo`, for the file panel under the terminal's
# user (ADR 0047). Accounts:
#   tester / testpass  — sudo asks for this password
#   nopass / nopass    — sudo asks for nothing
#   plain / plain      — no sudo rights at all
#   deploy / deploypass — whom they `su` to: its home is closed to everyone else
# Used by the ignored `live_fileuser` tests in src-tauri/src/fileuser.rs.
ARG BASE=ubuntu:24.04
FROM ${BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server sudo procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash -G sudo tester && echo 'tester:testpass' | chpasswd
RUN useradd -m -s /bin/bash nopass && echo 'nopass:nopass' | chpasswd \
 && echo 'nopass ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/nopass && chmod 440 /etc/sudoers.d/nopass
RUN useradd -m -s /bin/bash plain && echo 'plain:plain' | chpasswd
RUN useradd -m -s /bin/bash deploy && echo 'deploy:deploypass' | chpasswd \
 && chmod 700 /home/deploy \
 && echo secret > /home/deploy/only-deploy.txt && chown deploy:deploy /home/deploy/only-deploy.txt
RUN printf 'Port 2222\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/sudo.conf
# sshd itself stays root: it must switch to the logging-in user. An unprivileged port, though.
EXPOSE 2222
HEALTHCHECK --interval=5s --timeout=3s --retries=6 CMD bash -c 'echo > /dev/tcp/127.0.0.1/2222' || exit 1
CMD ["/usr/sbin/sshd", "-D", "-e"]
