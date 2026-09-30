# Disposable sshd that logs in ONLY through keyboard-interactive (PAM), like UniFi
# OS consoles and many PAM setups: the `password` method is off. Accounts:
#   kbd / kbdpass        — the password is the answer to PAM's "Password:" question
#   otp, otpbad, otpcancel / otppass
#                        — then a second question, "Verification code:" (Google
#                          Authenticator; answer with a scratch code from
#                          google_authenticator, each works once — recreate the
#                          container to reset them)
# One account per second-factor test: the module rewrites ~/.google_authenticator
# on every attempt and REFUSES the login when it can't (another login of the same
# user is writing it) — parallel tests on one account raced into a rejection.
# Used by the ignored `live_kbdint` tests in src-tauri/src/ssh.rs.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server libpam-google-authenticator \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash kbd && echo 'kbd:kbdpass' | chpasswd
COPY google_authenticator /tmp/google_authenticator
RUN for u in otp otpbad otpcancel; do \
      useradd -m -s /bin/bash "$u" && echo "$u:otppass" | chpasswd \
      && install -o "$u" -g "$u" -m 400 /tmp/google_authenticator "/home/$u/.google_authenticator"; \
    done \
 && rm /tmp/google_authenticator
# After common-auth: the password first, then the code. `nullok` skips users
# without ~/.google_authenticator (kbd).
RUN echo 'auth required pam_google_authenticator.so nullok' >> /etc/pam.d/sshd
COPY kbdint.conf /etc/ssh/sshd_config.d/kbdint.conf
# sshd itself stays root: it must switch to the logging-in user (accepted in
# .trivyignore.yaml for this file only). An unprivileged port, though.
EXPOSE 2222
HEALTHCHECK --interval=5s --timeout=3s --retries=6 CMD bash -c 'echo > /dev/tcp/127.0.0.1/2222' || exit 1
CMD ["/usr/sbin/sshd", "-D", "-e"]
