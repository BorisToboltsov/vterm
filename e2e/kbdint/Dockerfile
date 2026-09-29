# Disposable sshd that logs in ONLY through keyboard-interactive (PAM), like UniFi
# OS consoles and many PAM setups: the `password` method is off. Two accounts:
#   kbd / kbdpass  — the password is the answer to PAM's "Password:" question
#   otp / otppass  — then a second question, "Verification code:" (Google
#                    Authenticator; answer with a scratch code from
#                    google_authenticator, each works once — recreate the
#                    container to reset them)
# Used by the ignored `live_kbdint` tests in src-tauri/src/ssh.rs.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server libpam-google-authenticator \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash kbd && echo 'kbd:kbdpass' | chpasswd \
 && useradd -m -s /bin/bash otp && echo 'otp:otppass' | chpasswd
COPY google_authenticator /home/otp/.google_authenticator
RUN chown otp:otp /home/otp/.google_authenticator && chmod 400 /home/otp/.google_authenticator
# After common-auth: the password first, then the code. `nullok` skips users
# without ~/.google_authenticator (kbd).
RUN echo 'auth required pam_google_authenticator.so nullok' >> /etc/pam.d/sshd
COPY kbdint.conf /etc/ssh/sshd_config.d/kbdint.conf
# sshd itself stays root: it must switch to the logging-in user (accepted in
# .trivyignore.yaml for this file only). An unprivileged port, though.
EXPOSE 2222
HEALTHCHECK --interval=5s --timeout=3s --retries=6 CMD bash -c 'echo > /dev/tcp/127.0.0.1/2222' || exit 1
CMD ["/usr/sbin/sshd", "-D", "-e"]
