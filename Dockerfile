# ── Stage 1: Build native dependencies ──────────────────────────
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --production

# ── Stage 2: Runtime ────────────────────────────────────────────
FROM node:22-bookworm-slim

# Install runtime system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    git \
    bash \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user with home directory (needed for ~/.claude/)
RUN groupadd -r claude && useradd -r -g claude -m -s /bin/bash claude

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /build/node_modules ./node_modules

# Copy application source
COPY . .

# Create runtime directories
RUN mkdir -p src/data/reports src/logs tmp \
    && chown -R claude:claude /app /home/claude

# Copy and set entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER claude

# tmux-helper.js defaults to /bin/zsh; use bash in container
ENV SHELL=/bin/bash

EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:9999/ || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
