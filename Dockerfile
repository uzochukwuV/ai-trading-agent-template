# ──────────────────────────────────────────────────────────────────────────────
# AI Trading Agent — Dockerfile
# ──────────────────────────────────────────────────────────────────────────────

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY hardhat.config.ts ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY contracts/ ./contracts/
COPY test/ ./test/

# Install hardhat deps and compile contracts
RUN npx hardhat compile 2>/dev/null || true

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install system deps + Kraken CLI
RUN apk add --no-cache curl wget tar

# Download and install Kraken CLI (x86_64-linux-musl)
RUN wget -q https://github.com/krakenfx/kraken-cli/releases/download/v0.3.0/kraken-cli-x86_64-unknown-linux-musl.tar.gz \
    && tar -xzf kraken-cli-x86_64-unknown-linux-musl.tar.gz \
    && mv kraken-cli-x86_64-unknown-linux-musl/kraken /usr/local/bin/kraken \
    && chmod +x /usr/local/bin/kraken \
    && rm -rf kraken-cli-x86_64-unknown-linux-musl.tar.gz kraken-cli-x86_64-unknown-linux-musl

# Copy built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts ./artifacts
COPY --from=builder /app/cache ./cache 2>/dev/null || true

# Copy source (ts-node runs at runtime — no separate build step needed)
COPY package.json package-lock.json tsconfig.json ./
COPY hardhat.config.ts ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Copy env template
COPY .env.example .env.example

# ── Runtime config ────────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# Health check — agent writes checkpoints every tick
HEALTHCHECK --interval=120s --timeout=10s --start-period=30s --retries=3 \
  CMD test -f checkpoints.jsonl && test $(wc -l < checkpoints.jsonl) -gt 0 || exit 1

EXPOSE 3000

# ── Entrypoint ────────────────────────────────────────────────────────────────
# Default: run the unified scanner agent
# Override: docker run ... npm run run-momentum
CMD ["npx", "ts-node", "--transpile-only", "scripts/run-agent.ts"]
