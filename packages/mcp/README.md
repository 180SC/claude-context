# @zilliz/claude-context-mcp

![](../../assets/claude-context.png)
MCP server that gives Claude Code semantic search across your codebases. Index a repo once, then search it with natural language.


## How It Works

1. **Index** — Point the server at a codebase directory. It parses your code using AST-aware splitting (TypeScript, Python, Java, Go, Rust, C++, C#, Scala, with fallback for other languages), generates embeddings, and stores them in Zilliz Cloud.
2. **Search** — Ask a natural language question. The server runs hybrid search (BM25 + dense vector) and returns ranked code snippets with file locations.
3. **Cross-repo search** — `search_all` fans out your query to every indexed repo in parallel, so you can find patterns across your entire codebase collection.

## Quick Start

### What you need

- **Node.js 20+** (check with `node --version`)
- **OpenAI API key** (or VoyageAI, Gemini, Ollama — see [embedding providers](#embedding-providers))
- **Zilliz Cloud account** — [sign up free](https://cloud.zilliz.com/signup?utm_source=github&utm_medium=referral&utm_campaign=2507-codecontext-readme), then copy your API key

### Install from source (this fork)

```bash
# Clone and build
git clone https://github.com/180sc/claude-context.git
cd claude-context
nvm use 20     # or ensure node 20+ is active
pnpm install
pnpm build
```

### Configure Claude Code

Add the MCP server to your `~/.claude.json` under the top-level `"mcpServers"` key:

```json
{
  "mcpServers": {
    "claude-context": {
      "command": "/path/to/claude-context/packages/mcp/start-stdio.sh",
      "args": [],
      "env": {
        "OPENAI_API_KEY": "sk-your-openai-api-key",
        "MILVUS_ADDRESS": "https://your-cluster.cloud.zilliz.com",
        "MILVUS_TOKEN": "your-zilliz-cloud-api-key"
      }
    }
  }
}
```

Replace `/path/to/claude-context` with the absolute path to where you cloned the repo. The `start-stdio.sh` script handles nvm and runs the compiled server.

Restart Claude Code. You should see `claude-context` in your available MCP tools.

### Try it out

Once Claude Code restarts, you can use these tools in conversation:

```
1. Index a repo:     index_codebase path="/home/you/projects/my-app"
2. Search it:        search_code path="/home/you/projects/my-app" query="authentication middleware"
3. Search all repos: search_all query="error handling patterns"
```

## Embedding Providers

The default is OpenAI (`text-embedding-3-small`). Set `EMBEDDING_PROVIDER` to switch.

| Provider | Key env var | Default model |
|----------|------------|---------------|
| OpenAI | `OPENAI_API_KEY` | `text-embedding-3-small` |
| VoyageAI | `VOYAGEAI_API_KEY` | `voyage-code-3` |
| Gemini | `GEMINI_API_KEY` | `gemini-embedding-001` |
| Ollama | (local, no key) | `nomic-embed-text` |

Set `EMBEDDING_MODEL` to override the default model for any provider.

> For the full list of environment variables, see the [Environment Variables Guide](../../docs/getting-started/environment-variables.md).

<details>
<summary><strong>Provider setup details</strong></summary>

**OpenAI** — Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Supports `text-embedding-3-small`, `text-embedding-3-large`, and others. Set `OPENAI_BASE_URL` for Azure OpenAI or compatible services.

**VoyageAI** — Get a key at [dash.voyageai.com](https://dash.voyageai.com/). Specialized for code embeddings.

**Gemini** — Get a key at [aistudio.google.com](https://aistudio.google.com/). Good multilingual support. Set `GEMINI_BASE_URL` for custom endpoints.

**Ollama** — Install from [ollama.ai](https://ollama.ai/), then `ollama pull nomic-embed-text && ollama serve`. Set `OLLAMA_HOST` if not running on `127.0.0.1:11434`.

</details>

## Zilliz Cloud Setup

Claude Context stores embeddings in Zilliz Cloud (Milvus). [Sign up free](https://cloud.zilliz.com/signup?utm_source=github&utm_medium=referral&utm_campaign=2507-codecontext-readme) and copy your Personal Key.

![](../../assets/signup_and_get_apikey.png)

```bash
MILVUS_ADDRESS=https://your-cluster.cloud.zilliz.com
MILVUS_TOKEN=your-zilliz-cloud-api-key
```

## Available Tools

### `index_codebase`

Index a codebase directory for semantic search.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Absolute path to the codebase directory |
| `force` | No | Force re-index even if already indexed (default: false) |
| `splitter` | No | `ast` (syntax-aware, default) or `langchain` (character-based) |
| `customExtensions` | No | Extra file extensions, e.g. `[".vue", ".svelte"]` |
| `ignorePatterns` | No | Extra ignore globs, e.g. `["static/**", "*.tmp"]` |

### `search_code`

Search a single indexed repo with natural language.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Absolute path to the indexed codebase |
| `query` | Yes | Natural language search query |
| `limit` | No | Max results (default: 10, max: 50) |
| `extensionFilter` | No | Filter by extension, e.g. `[".ts", ".py"]` |

### `clear_index`

Remove the search index for a codebase.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Absolute path to the codebase to clear |

### `get_indexing_status`

Check indexing progress or completion status.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Absolute path to the codebase to check |

### `search_all`

Search across ALL indexed repositories at once.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Natural language search query |
| `limit` | No | Max total results (default: 20, max: 50) |
| `repos` | No | Filter to specific repo names or IDs |
| `extensionFilter` | No | Filter by extension, e.g. `[".ts", ".py"]` |

**How it works:**

`search_all` discovers repos from two sources — the local snapshot (maintained as you index) and Zilliz Cloud (by listing collections directly). Both are always merged, so repos are found even if the local snapshot is stale.

Results are ranked by raw cosine similarity, so a strong match in one repo ranks higher than a weak match in another regardless of which repo it came from.

**`search_all` vs `search_code`:**

| | `search_code` | `search_all` |
|---|---|---|
| **Scope** | Single repo (by path) | All indexed repos |
| **Best for** | Focused work in one codebase | Finding patterns across projects |
| **Requires** | Absolute path | Nothing — auto-discovers repos |
| **Performance** | Fast (single collection) | Slightly slower (parallel fan-out, 5s/collection timeout) |

**Good to know:**
- Requires Zilliz Cloud (each repo = separate collection; local FAISS only supports one).
- Collections that take >5s are skipped. Check server logs if results seem incomplete.
- Use the `repos` filter to narrow to specific projects.

### `search_all` examples

**Learn from your own repos.** The real power of cross-repo search is finding how you (or your team) already solved something. Instead of Googling for generic patterns, search your own codebases first:

```
search_all query="Makefile with help target and section headers"
search_all query="Docker Compose with health checks"
search_all query="retry logic with exponential backoff"
search_all query="database migration pattern"
```

**Find best practices across projects.** When you're about to build something, see how your other repos handle it:

```
search_all query="error handling middleware"
search_all query="authentication and authorization flow"
search_all query="CI/CD pipeline configuration"
search_all query="environment variable configuration and validation"
search_all query="WebSocket connection management"
search_all query="rate limiting implementation"
```

**Spot code smells and inconsistencies.** Search for patterns you want to standardize or clean up:

```
search_all query="hardcoded API URLs or secrets"
search_all query="TODO or FIXME or HACK comments"
search_all query="bare except or catch without specific error type"
search_all query="sleep or setTimeout used for synchronization"
search_all query="deprecated function calls"
```

**Understand how a concept is implemented differently.** Compare approaches across repos:

```
search_all query="logging setup and configuration"
search_all query="test fixtures and factory patterns"
search_all query="API client wrapper or SDK initialization"
search_all query="caching strategy"
```

**Narrow to specific repos or file types when you know where to look:**

```
search_all query="deployment configuration" repos=["stream-ops", "virtius-ai"]
search_all query="data model definitions" extensionFilter=[".py"]
search_all query="type definitions and interfaces" extensionFilter=[".ts"]
```

## Optional Configuration

```bash
# Tune embedding throughput (default: 100)
EMBEDDING_BATCH_SIZE=512

# Include extra file types beyond defaults
CUSTOM_EXTENSIONS=.vue,.svelte,.astro,.twig

# Exclude extra patterns beyond defaults
CUSTOM_IGNORE_PATTERNS=temp/**,*.backup,private/**,uploads/**
```

## Features

- **Hybrid search** — BM25 + dense vector for better recall than either alone
- **AST-aware chunking** — Syntax-aware splitting for TypeScript, Python, Java, Go, Rust, C++, C#, Scala (automatic fallback for other languages)
- **Incremental indexing** — Only re-indexes changed files using Merkle trees
- **Cross-repo search** — `search_all` searches every indexed repo in parallel
- **Scalable** — Zilliz Cloud handles codebases of any size
- **HTTP transport** — Network-accessible with bearer token auth and rate limiting ([deployment guide](../../docs/deployment.md))
- **Multi-session** — Multiple LLMs can connect simultaneously via isolated HTTP sessions

<details>
<summary><strong>Other MCP Clients</strong></summary>

The server uses stdio transport and follows the standard MCP protocol. Any MCP-compatible client can use it. The basic pattern for JSON-based configs:

```json
{
  "mcpServers": {
    "claude-context": {
      "command": "npx",
      "args": ["@zilliz/claude-context-mcp@latest"],
      "env": {
        "OPENAI_API_KEY": "your-openai-api-key",
        "MILVUS_TOKEN": "your-zilliz-cloud-api-key"
      }
    }
  }
}
```

Tested with: Cursor, VS Code, Windsurf, Claude Desktop, Cline, Roo Code, Cherry Studio, Augment, Zencoder, Qwen Code, OpenAI Codex CLI, Gemini CLI, and LangChain/LangGraph.

For client-specific paths and quirks, see the [upstream README](https://github.com/zilliztech/claude-context/blob/master/packages/mcp/README.md).

</details>

## Contributing

This is a fork of [zilliztech/claude-context](https://github.com/zilliztech/claude-context). See:

- [Main Contributing Guide](../../CONTRIBUTING.md)
- [MCP Package Contributing](CONTRIBUTING.md)

## License

MIT - See [LICENSE](../../LICENSE) for details
