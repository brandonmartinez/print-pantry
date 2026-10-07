#!/bin/sh
set -eu

if [ ! -s /home/node/.npmrc ] || ! grep -Eq '^[[:space:]]*registry[[:space:]]*=' /home/node/.npmrc; then
  echo 'An existing npm config with an explicit registry is required as the npmrc BuildKit secret' >&2
  exit 1
fi
export NPM_CONFIG_USERCONFIG=/home/node/.npmrc
registry="$(npm config get registry)"
if ! printf '%s' "$registry" | node -e '
  const registry = require("node:fs").readFileSync(0, "utf8");
  try {
    const url = new URL(registry);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        ["registry.npmjs.org", "registry.yarnpkg.com"].includes(url.hostname)) process.exitCode = 1;
  } catch { process.exitCode = 1; }
'; then
  echo 'The configured npm registry must be an explicit non-default feed' >&2
  exit 1
fi

if [ -s /run/secrets/npm_ca ]; then
  export NPM_CONFIG_CAFILE=/run/secrets/npm_ca
  export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca
fi
if [ -s /run/secrets/npm_proxy ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy) export "$key=$value" ;;
      ''|\#*) ;;
      *) echo 'Invalid npm proxy secret: only proxy environment keys are allowed' >&2; exit 1 ;;
    esac
  done < /run/secrets/npm_proxy
fi

export npm_config_cache=/tmp/pantry-npm-cache
trap 'rm -rf /tmp/pantry-npm-cache' EXIT
case "${1:-}" in
  build) npm ci --no-audit --no-fund ;;
  runtime) npm ci --omit=dev --no-audit --no-fund ;;
  *) echo 'Usage: npm-ci.sh build|runtime' >&2; exit 1 ;;
esac
