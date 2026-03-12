FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    git \
    jq \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Claude Code refuses --dangerously-skip-permissions as root.
# Create a non-root user and give it ownership of /job.
RUN useradd -m -s /bin/bash agent \
    && mkdir -p /job \
    && chown agent:agent /job

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Install Playwright Chromium + system deps at build time (used by Playwright MCP)
# PLAYWRIGHT_BROWSERS_PATH puts browsers in a shared location so the non-root
# `agent` user can find what root installed during build.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx -y playwright install --with-deps chromium \
    && chmod -R o+rx /opt/pw-browsers

USER agent
WORKDIR /job

ENTRYPOINT ["/entrypoint.sh"]
