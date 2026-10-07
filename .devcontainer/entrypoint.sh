#!/bin/sh
set -eu

if [ ! -s /var/lib/ssh-host-keys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /var/lib/ssh-host-keys/ssh_host_ed25519_key
fi
chmod 600 /var/lib/ssh-host-keys/ssh_host_ed25519_key
chown node:node /workspace/node_modules /home/node/.npm
if ! gosu node test -r /home/node/.npmrc || ! gosu node test -s /home/node/.npmrc; then
  echo "HOST_NPM_CONFIG_FILE must provide a nonempty npm config readable by node." >&2
  exit 1
fi
registry=$(gosu node npm config get registry)
proxy=$(gosu node npm config get proxy)
https_proxy=$(gosu node npm config get https-proxy)
if [ "$registry" = "https://registry.npmjs.org/" ] &&
   [ "$proxy" = "null" ] && [ "$https_proxy" = "null" ] &&
   [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
  echo "No configured npm registry or proxy; refusing public npm fallback." >&2
  exit 1
fi

install -d -m 700 -o node -g node /home/node/.ssh
if [ -s /run/pantry-authorized-keys ]; then
  install -m 600 -o node -g node /run/pantry-authorized-keys /home/node/.ssh/authorized_keys
else
  echo "No public SSH authorized keys supplied; SSH login is disabled." >&2
  rm -f /home/node/.ssh/authorized_keys
fi

case "${SSH_ALLOW_AGENT_FORWARDING:-false}" in
  true) forwarding=yes ;;
  false) forwarding=no ;;
  *) echo "SSH_ALLOW_AGENT_FORWARDING must be true or false." >&2; exit 1 ;;
esac
printf 'AllowAgentForwarding %s\n' "$forwarding" >/etc/ssh/sshd_config.d/agent-forwarding.conf
/usr/sbin/sshd -t
/usr/sbin/sshd -D -e &
sshd_pid=$!
trap 'kill "$sshd_pid" 2>/dev/null || true' EXIT

exec gosu node "$@"
