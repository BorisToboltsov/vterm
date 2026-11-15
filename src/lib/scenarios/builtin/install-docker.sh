#!/bin/sh
# vterm:
#   name: Install Docker
#   description: Docker Engine and the compose plugin from Docker's repository; the user joins the docker group
#   os: [debian, ubuntu, fedora, centos, rhel, rocky, almalinux]
#   sudo: true
#   check: true
#   params:
#     DOCKER_USER: { label: User to add to the docker group, hint: empty — the login of the connection }
set -eu

os_like() ( . /etc/os-release 2>/dev/null; echo " ${ID:-} ${ID_LIKE:-} " )
target_user() { echo "${DOCKER_USER:-${SUDO_USER:-$(id -un)}}"; }

check() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "would install Docker Engine and compose"
    return 1
  fi
  u=$(target_user)
  if [ "$u" != root ] && ! id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    echo "Docker is installed; would add $u to the docker group"
    return 1
  fi
  echo "already so: $(docker --version 2>/dev/null)"
}

apply() {
  if ! command -v docker >/dev/null 2>&1; then
    case "$(os_like)" in
      *" rocky "* | *" almalinux "*)
        dnf -y -q install dnf-plugins-core
        dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        dnf -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
        ;;
      *" debian "* | *" ubuntu "* | *" fedora "* | *" centos "* | *" rhel "*)
        command -v curl >/dev/null 2>&1 || { echo "curl is needed to fetch Docker's installer" >&2; exit 3; }
        curl -fsSL https://get.docker.com | sh
        ;;
      *)
        echo "this system is not one the recipe knows: $(os_like)" >&2
        exit 3
        ;;
    esac
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  u=$(target_user)
  if [ "$u" != root ]; then
    usermod -aG docker "$u"
    echo "$u is in the docker group (a new login picks it up)"
  fi
  echo "installed: $(docker --version)"
}

case "${VTERM_MODE:-apply}" in check) check ;; *) apply ;; esac
