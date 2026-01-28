# Deployment Guide

This guide covers how to deploy the Context MCP Server locally and in production environments.

## Table of Contents

- [Local Development with NPX](#local-development-with-npx)
- [Docker Deployment](#docker-deployment)
- [Environment Variables](#environment-variables)
- [Transport Modes](#transport-modes)
- [Production Considerations](#production-considerations)

---

## Local Development with NPX

The simplest way to run the MCP server locally is using `npx`:

### Prerequisites

- Node.js 20+ installed
- An embedding provider API key (OpenAI, VoyageAI, Gemini, or Ollama)
- A Milvus instance (local or Zilliz Cloud)

### Quick Start (stdio mode - for MCP clients)

```bash
# With OpenAI embeddings and Zilliz Cloud
OPENAI_API_KEY=sk-xxx \
MILVUS_ADDRESS=https://xxx.serverless.gcp-us-west1.cloud.zilliz.com \
MILVUS_TOKEN=your-api-key \
npx @zilliz/claude-context-mcp
```

### HTTP Mode (for API access)

```bash
# Generate a secure auth token
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)

# Start the server in HTTP mode
OPENAI_API_KEY=sk-xxx \
MILVUS_ADDRESS=https://xxx.serverless.gcp-us-west1.cloud.zilliz.com \
MILVUS_TOKEN=your-api-key \
MCP_AUTH_TOKEN=$MCP_AUTH_TOKEN \
npx @zilliz/claude-context-mcp --transport http --port 3000
```

### Using Alternative Embedding Providers

```bash
# VoyageAI
EMBEDDING_PROVIDER=VoyageAI \
VOYAGE_API_KEY=pa-xxx \
MILVUS_ADDRESS=localhost:19530 \
npx @zilliz/claude-context-mcp

# Google Gemini
EMBEDDING_PROVIDER=Gemini \
GEMINI_API_KEY=xxx \
MILVUS_ADDRESS=localhost:19530 \
npx @zilliz/claude-context-mcp

# Ollama (local, no API key required)
EMBEDDING_PROVIDER=Ollama \
OLLAMA_BASE_URL=http://localhost:11434 \
OLLAMA_MODEL=nomic-embed-text \
MILVUS_ADDRESS=localhost:19530 \
npx @zilliz/claude-context-mcp
```

### Configuring Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "context": {
      "command": "npx",
      "args": ["@zilliz/claude-context-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-xxx",
        "MILVUS_ADDRESS": "https://xxx.cloud.zilliz.com",
        "MILVUS_TOKEN": "your-api-key"
      }
    }
  }
}
```

---

## Docker Deployment

### Build the Docker Image

```bash
# From the project root
docker build -t context-mcp-server -f packages/mcp/Dockerfile .
```

### Run with Docker (stdio mode)

```bash
docker run -i --rm \
  -e OPENAI_API_KEY=sk-xxx \
  -e MILVUS_ADDRESS=https://xxx.cloud.zilliz.com \
  -e MILVUS_TOKEN=your-api-key \
  context-mcp-server
```

### Run with Docker (HTTP mode)

```bash
docker run -d \
  -p 3000:3000 \
  -e OPENAI_API_KEY=sk-xxx \
  -e MILVUS_ADDRESS=https://xxx.cloud.zilliz.com \
  -e MILVUS_TOKEN=your-api-key \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  -v mcp-data:/data \
  context-mcp-server --transport http --port 3000
```

### Docker Compose (Full Stack)

The included `docker-compose.yml` provides a complete stack with:
- MCP Server (HTTP mode)
- Local Milvus instance
- Optional Ollama for local embeddings

#### Setup

1. Create a `.env` file:

```bash
# .env
OPENAI_API_KEY=sk-xxx
MCP_AUTH_TOKEN=your-secure-random-token

# For Zilliz Cloud (comment out to use local Milvus)
# MILVUS_ADDRESS=https://xxx.cloud.zilliz.com
# MILVUS_TOKEN=your-api-key
```

2. Start the stack:

```bash
# Start MCP server + local Milvus
docker-compose up -d

# Include Ollama for local embeddings
docker-compose --profile ollama up -d
```

3. Verify the server is running:

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"1.0.0","transport":"http",...}
```

#### Using the API

```bash
# List indexed codebases
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_indexed_codebases"},"id":1}'

# Search code
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_code","arguments":{"codebase_path":"/path/to/repo","query":"authentication logic"}},"id":2}'
```

---

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key (if using OpenAI embeddings) | `sk-xxx` |
| `MILVUS_ADDRESS` | Milvus/Zilliz Cloud connection address | `localhost:19530` or `https://xxx.cloud.zilliz.com` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Embedding provider: `OpenAI`, `VoyageAI`, `Gemini`, `Ollama` | `OpenAI` |
| `EMBEDDING_MODEL` | Model to use for embeddings | Provider-specific default |
| `MILVUS_TOKEN` | Zilliz Cloud API token | (none) |
| `MCP_AUTH_TOKEN` | Bearer token for HTTP authentication (required for HTTP mode) | (none) |
| `MCP_RATE_LIMIT` | Requests per minute per client (HTTP mode) | `60` |
| `VOYAGE_API_KEY` | VoyageAI API key | (none) |
| `GEMINI_API_KEY` | Google Gemini API key | (none) |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://localhost:11434` |
| `OLLAMA_MODEL` | Ollama model for embeddings | `nomic-embed-text` |

---

## Transport Modes

### stdio (Default)

Standard input/output mode for MCP client integration:

```bash
npx @zilliz/claude-context-mcp
# or
npx @zilliz/claude-context-mcp --transport stdio
```

Use this mode with:
- Claude Desktop
- Other MCP-compatible clients
- Piped input/output

### HTTP

HTTP server mode for API access:

```bash
MCP_AUTH_TOKEN=xxx npx @zilliz/claude-context-mcp --transport http --port 3000
```

Endpoints:
- `GET /health` - Health check (no auth required)
- `POST /mcp` - MCP JSON-RPC endpoint (auth required)

Use this mode for:
- Web services
- Load-balanced deployments
- Multi-client scenarios

### Both

Run both transports simultaneously:

```bash
MCP_AUTH_TOKEN=xxx npx @zilliz/claude-context-mcp --transport both --port 3000
```

---

## Production Considerations

### Security

1. **Always use HTTPS** in production (use a reverse proxy like nginx or Caddy)
2. **Generate strong auth tokens**: `openssl rand -hex 32`
3. **Never commit credentials** to version control
4. **Use secrets management** (e.g., Docker secrets, Kubernetes secrets, AWS Secrets Manager)

### Scaling

1. **Use Zilliz Cloud** instead of local Milvus for production workloads
2. **Configure rate limiting** based on your expected traffic
3. **Monitor health endpoint** for load balancer health checks
4. **Use persistent volumes** for snapshot data

### Example Production docker-compose

```yaml
version: '3.8'

services:
  mcp-server:
    image: your-registry/context-mcp-server:latest
    deploy:
      replicas: 2
      resources:
        limits:
          memory: 1G
    environment:
      - OPENAI_API_KEY_FILE=/run/secrets/openai_key
      - MILVUS_ADDRESS=https://xxx.cloud.zilliz.com
      - MILVUS_TOKEN_FILE=/run/secrets/milvus_token
      - MCP_AUTH_TOKEN_FILE=/run/secrets/mcp_token
    secrets:
      - openai_key
      - milvus_token
      - mcp_token
    command: ["--transport", "http", "--port", "3000"]

secrets:
  openai_key:
    external: true
  milvus_token:
    external: true
  mcp_token:
    external: true
```

### Reverse Proxy (nginx example)

```nginx
upstream mcp_servers {
    server mcp-server-1:3000;
    server mcp-server-2:3000;
}

server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate /etc/ssl/certs/mcp.crt;
    ssl_certificate_key /etc/ssl/private/mcp.key;

    location / {
        proxy_pass http://mcp_servers;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://mcp_servers;
        auth_basic off;
    }
}
```
