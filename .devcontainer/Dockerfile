FROM node:24.13.1-bookworm-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server gosu \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssh/ssh_host_* \
    && usermod -p '*' node \
    && mkdir -p /run/sshd /var/lib/ssh-host-keys /workspace

COPY .devcontainer/sshd_config /etc/ssh/sshd_config
COPY .devcontainer/entrypoint.sh /usr/local/bin/pantry-entrypoint
RUN chmod 755 /usr/local/bin/pantry-entrypoint

WORKDIR /workspace
EXPOSE 22 3000 5173
ENTRYPOINT ["pantry-entrypoint"]
CMD ["sh", "-c", "npm ci && npm run build && npm run db:migrate && exec npm run dev"]
