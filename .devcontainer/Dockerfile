FROM node:24.13.1-bookworm-slim AS node-runtime

FROM mcr.microsoft.com/devcontainers/javascript-node:5-24-bookworm

ENV NODE_VERSION=24.13.1

# Keep the repository's Node/npm pins without downloading another toolchain.
RUN rm -rf /usr/local/lib/node_modules/npm
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh gosu openssh-server ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssh/ssh_host_* \
    && usermod -p '*' node \
    && mkdir -p /run/sshd /var/lib/ssh-host-keys /workspace \
    && git config --system --add include.path /run/pantry-host-gitconfig \
    && git config --system --add safe.directory /workspace

COPY .devcontainer/sshd_config /etc/ssh/sshd_config
COPY .devcontainer/entrypoint.sh /usr/local/bin/pantry-entrypoint
RUN chmod 755 /usr/local/bin/pantry-entrypoint

WORKDIR /workspace
EXPOSE 22 3000 5173
ENTRYPOINT ["pantry-entrypoint"]
CMD ["sleep", "infinity"]
