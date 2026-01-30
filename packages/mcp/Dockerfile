# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/core packages/core
COPY packages/mcp packages/mcp

# Build packages
RUN pnpm --filter @zilliz/claude-context-core build
RUN pnpm --filter @zilliz/claude-context-mcp build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/mcp/dist packages/mcp/dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 -G nodejs

# Create data directory for snapshots
RUN mkdir -p /data/.context && chown -R mcp:nodejs /data

USER mcp

# Environment variables
ENV NODE_ENV=production
ENV HOME=/data

# Expose HTTP port (when using HTTP transport)
EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1

# Default to stdio transport (compatible with MCP clients)
# Override with --transport http for HTTP mode
ENTRYPOINT ["node", "packages/mcp/dist/index.js"]
CMD ["--transport", "stdio"]
