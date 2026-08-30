FROM oven/bun:latest

RUN apt-get update && apt-get install -y \
    openssh-server \
    git \
    curl \
    unzip \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash claude

# Tell Playwright to use the system Chromium rather than downloading its own copy
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install Claude Code as claude user
USER claude
RUN bun install -g @anthropic-ai/claude-code \
 && mkdir -p /home/claude/.bun/bin \
 && ln -sf $(find /home/claude/.bun/install/global/node_modules -name "claude" -not -path "*musl*" | head -1) /home/claude/.bun/bin/claude
USER root

# Install mesh as root so its config and data are inaccessible to the claude user
RUN curl -fsSL https://raw.githubusercontent.com/kaizen-hq/mesh/main/install.sh | MESH_REF=v4.8.0 bash

# Install app dependencies (includes @playwright/mcp)
# Use USER directive (not su -l) so Docker ENV vars are inherited —
# specifically PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 to prevent browser downloads.
COPY --chown=claude:claude package.json /home/claude/app/
USER claude
RUN cd ~/app && bun install
USER root
COPY --chown=claude:claude src/ /home/claude/app/src/

ENV PATH="/root/.local/bin:/home/claude/.bun/bin:/home/claude/.local/bin:/usr/local/bin:$PATH"

# Make PATH available to all SSH sessions (login and non-login shells)
RUN echo 'export PATH="/root/.local/bin:/home/claude/.bun/bin:/home/claude/.local/bin:/usr/local/bin:$PATH"' \
      > /etc/profile.d/joey-agent.sh \
 && chmod +x /etc/profile.d/joey-agent.sh

# SSH setup — run on port 2222 (no special capabilities needed)
RUN mkdir -p /var/run/sshd \
 && mkdir -p /home/claude/.ssh && chmod 700 /home/claude/.ssh

COPY authorized_keys /home/claude/.ssh/authorized_keys
RUN chmod 600 /home/claude/.ssh/authorized_keys \
 && chown -R claude:claude /home/claude/.ssh

RUN sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/#Port 22/Port 2222/' /etc/ssh/sshd_config \
 && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config

# Skip TLS verification for local mesh git endpoint
RUN su -l claude -c "git config --global http.https://localhost:7979.sslVerify false"

RUN mkdir -p /workspace && chown claude:claude /workspace

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

EXPOSE 2222 7979 8080

ENTRYPOINT ["/entrypoint.sh"]
