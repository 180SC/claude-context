# Project: General-Purpose Code Search MCP Server

## Overview

Transform the existing `claude-context` MCP server from a local-filesystem-coupled semantic code search tool into a general-purpose code search MCP server that can be accessed by any LLM client over the network, supports cross-repository search, intelligently reconciles git worktrees and repo duplicates, and provides higher-level code intelligence tools (pattern detection, best practices analysis, etc.).

### Current State

The system today is a **stdio-based MCP server** (`@zilliz/claude-context-mcp`) that:

- Requires an absolute local filesystem path to index and search
- Derives Milvus collection names by MD5-hashing the absolute path (`packages/core/src/context.ts:234-240`), meaning two worktrees of the same repo produce **two separate, unrelated collections**
- Validates that paths exist on disk via `fs.existsSync()` before every operation (`packages/mcp/src/handlers.ts:169,426`)
- Runs exclusively over stdio transport (`packages/mcp/src/index.ts:252`) — no network access
- Has no concept of repository identity, git remotes, branches, or worktrees
- Tracks indexed codebases by absolute path in a local JSON file (`~/.context/mcp-codebase-snapshot.json`)
- Supports 4 tools: `index_codebase`, `search_code`, `clear_index`, `get_indexing_status`

### Target State

A **network-accessible MCP server** that:

- Can be reached from any LLM client (Claude, GPT, Gemini, etc.) over HTTP/SSE
- Manages a **repository registry** with canonical identity (based on git remote + commit lineage), not filesystem paths
- Automatically reconciles worktrees, clones, and forks of the same repo into a unified index
- Supports **cross-repository search** ("find all error handling patterns across my projects")
- Provides **code intelligence tools** beyond raw search: pattern detection, best-practices auditing, dependency mapping
- Maintains backward compatibility with the existing stdio transport for local use

---

## Epic 1: Repository Identity & Worktree Reconciliation

**Goal:** Replace path-based identity with git-aware canonical repository identity so that multiple worktrees, clones, or checkouts of the same repo share a single index.

### 1.1 — Git Repository Identity Detection

**Description:** Build a module that, given a filesystem path, determines the canonical identity of the git repository.

**Requirements:**
- Detect whether a path is inside a git repo by walking up the directory tree looking for `.git` (directory) or `.git` (file, indicating a worktree)
- For worktrees: read the `.git` file to find the main worktree's `.git` directory, then resolve the shared object store
- Extract the "canonical identity" as a composite key:
  - Primary: normalized remote origin URL (strip `.git` suffix, normalize SSH vs HTTPS)
  - Fallback (no remote): SHA of the initial commit (`git rev-list --max-parents=0 HEAD`)
  - Last resort (not a git repo): fall back to current path-based hashing
- Expose a `RepoIdentity` type: `{ canonicalId: string; remoteUrl?: string; mainWorktreePath?: string; detectedPaths: string[] }`

**Acceptance Criteria:**
- Given `/home/user/myproject` and `/home/user/myproject-feature` (a worktree of the same repo), both resolve to the same `canonicalId`
- Given two clones of the same GitHub repo in different directories, both resolve to the same `canonicalId`
- Non-git directories still work, falling back to path-based hashing
- Unit tests cover: regular repo, worktree, bare repo, non-git directory, SSH vs HTTPS remote normalization

**Key Files to Modify/Create:**
- New: `packages/core/src/identity/repo-identity.ts`
- New: `packages/core/src/identity/git-utils.ts`
- Modify: `packages/core/src/context.ts` — `getCollectionName()` (line 234) to use canonical ID instead of path hash

---

### 1.2 — Collection Name Migration

**Description:** Migrate collection naming from path-based MD5 hashes to canonical-identity-based hashes, with backward compatibility.

**Requirements:**
- New collection naming: `hybrid_code_chunks_{md5(canonicalId).substring(0,12)}` (longer hash to reduce collision risk across repos)
- On startup, detect legacy collections (8-char hash) and offer migration
- Migration strategy: re-map existing collections by querying the `codebasePath` metadata field (already stored in each document) and resolving git identity for that path
- Maintain a mapping file (`~/.context/collection-migration.json`) to track old→new mappings during transition
- The `SnapshotManager` needs to store `canonicalId` alongside paths

**Acceptance Criteria:**
- Existing users' indices continue to work without re-indexing
- New indices use the canonical-ID-based naming
- A migration command/tool can batch-migrate old collections
- The snapshot file (v3 format) stores canonical repo identity

**Key Files to Modify:**
- `packages/core/src/context.ts` — `getCollectionName()`, `getPreparedCollection()`
- `packages/mcp/src/snapshot.ts` — new v3 snapshot format with `canonicalId`
- `packages/mcp/src/config.ts` — new `CodebaseSnapshotV3` interface

---

### 1.3 — Path-to-Repository Resolution & Registry

**Description:** Build a repository registry that maps multiple filesystem paths to their canonical repository identity.

**Requirements:**
- `RepoRegistry` class that maintains a `Map<canonicalId, RepoRecord>` where `RepoRecord` includes:
  - `canonicalId`, `displayName`, `remoteUrl`, `knownPaths: string[]`, `branches: string[]`, `lastIndexed: Date`, `indexStats`
- When `index_codebase` is called with a path, resolve the canonical identity and check if an index already exists under any other path for that repo
- If it does: skip re-indexing, just register the new path as an alias
- If the existing index is stale (different branch/commit): offer incremental re-index
- Persist registry to `~/.context/repo-registry.json`

**Acceptance Criteria:**
- Indexing `/home/user/repo-main` then calling index on `/home/user/repo-worktree` (same repo) does NOT create a duplicate index
- The registry correctly lists all known paths for a repo
- A new tool `list_repositories` returns the registry contents

**Key Files to Create/Modify:**
- New: `packages/core/src/identity/repo-registry.ts`
- Modify: `packages/mcp/src/handlers.ts` — `handleIndexCodebase()` to check registry before indexing

---

## Epic 2: Network Transport & Multi-Client Access

**Goal:** Enable the MCP server to be accessed over HTTP/SSE so that remote LLM clients can connect without needing the server to run locally alongside the codebase.

### 2.1 — HTTP/SSE Transport Layer

**Description:** Add an HTTP-based transport alongside the existing stdio transport, using the MCP SDK's Streamable HTTP support.

**Requirements:**
- Add the `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` (or implement SSE-based transport)
- Server listens on a configurable port (default: `3100`, env: `MCP_PORT`)
- Support both transports simultaneously: stdio for local/embedded use, HTTP for remote
- CLI flag: `--transport stdio|http|both` (default: `stdio` for backward compat)
- CORS headers for browser-based clients
- Health check endpoint: `GET /health`

**Acceptance Criteria:**
- `npx @zilliz/claude-context-mcp --transport http` starts an HTTP server
- An LLM client can connect via `http://localhost:3100/mcp` and invoke all existing tools
- Stdio transport still works identically
- Health check returns server status and version

**Key Files to Modify/Create:**
- Modify: `packages/mcp/src/index.ts` — add HTTP transport option
- New: `packages/mcp/src/transports/http-transport.ts`
- Modify: `packages/mcp/package.json` — add HTTP server dependencies

---

### 2.2 — Authentication & API Keys

**Description:** Add authentication for the HTTP transport so the server can be safely exposed on a network.

**Requirements:**
- Bearer token authentication: `Authorization: Bearer <token>`
- Token configured via environment variable: `MCP_AUTH_TOKEN`
- If no token is set and transport is HTTP, refuse to start (security guard)
- Rate limiting: configurable requests-per-minute per client (default: 60)
- Audit logging: log all tool invocations with client identity and timestamp

**Acceptance Criteria:**
- Unauthenticated requests to HTTP transport return 401
- Valid bearer token allows access to all tools
- Rate-limited clients receive 429 responses
- stdio transport is unaffected (no auth required)

**Key Files to Create:**
- New: `packages/mcp/src/middleware/auth.ts`
- New: `packages/mcp/src/middleware/rate-limiter.ts`

---

### 2.3 — Remote Repository Support

**Description:** Allow indexing repositories that aren't on the local filesystem by cloning them to a managed cache directory.

**Requirements:**
- New `index_codebase` parameter: `url` (alternative to `path`) — accepts git clone URLs
- When a URL is provided:
  1. Resolve canonical identity from the URL directly
  2. Check if already indexed (by canonical ID)
  3. If not: clone to `~/.context/repo-cache/{canonicalId}/` (shallow clone by default)
  4. Index from the cached clone
  5. Support `branch` parameter to specify which branch to clone/index
- Cache management: `clear_cache` tool to reclaim disk space
- Periodic pull for cached repos (configurable interval, default: disabled)

**Acceptance Criteria:**
- `search_code` with a URL or repo name (not just path) works
- Cloned repos are deduplicated with local checkouts of the same repo
- Cache can be cleared without affecting Milvus collections

**Key Files to Create/Modify:**
- New: `packages/core/src/identity/repo-cache.ts`
- Modify: `packages/mcp/src/handlers.ts` — `handleIndexCodebase()` to accept URL

---

## Epic 3: Cross-Repository Search & Code Intelligence

**Goal:** Elevate from single-repo semantic search to multi-repo code intelligence that can identify patterns, best practices, and architectural insights across an entire portfolio of code.

### 3.1 — Cross-Repository Search

**Description:** Allow searching across all indexed repositories simultaneously rather than requiring a specific path.

**Requirements:**
- New tool: `search_all` — searches across all indexed repos (or a filtered subset)
- Parameters: `query`, `limit`, `repos` (optional filter: list of repo names/IDs), `extensionFilter`
- Implementation: fan out search to all relevant Milvus collections, merge and re-rank results
- Results include repo name, relative path, and canonical ID in addition to existing fields
- Respect per-repo relevance: normalize scores across collections with different sizes

**Acceptance Criteria:**
- `search_all` with query "error handling middleware" returns results from all indexed repos, ranked by relevance
- Filtering by `repos: ["my-api", "my-frontend"]` restricts search scope
- Results are properly attributed to their source repository

**Key Files to Modify/Create:**
- Modify: `packages/mcp/src/handlers.ts` — new `handleSearchAll()` method
- Modify: `packages/mcp/src/index.ts` — register `search_all` tool
- Modify: `packages/core/src/context.ts` — new `semanticSearchMulti()` method

---

### 3.2 — Pattern Detection Tool

**Description:** Add a tool that identifies recurring code patterns, idioms, and conventions across the indexed codebase(s).

**Requirements:**
- New tool: `find_patterns` — identifies common patterns in the codebase
- Parameters: `repos` (optional), `category` (optional: "error-handling", "logging", "testing", "api-design", "state-management", etc.), `limit`
- Implementation strategy:
  1. Use semantic search with curated "pattern queries" for each category
  2. Cluster results by structural similarity (e.g., AST subtree similarity)
  3. Return grouped results: pattern description, frequency count, representative examples
- Predefined pattern categories with extensibility for custom patterns

**Acceptance Criteria:**
- `find_patterns` with category "error-handling" returns grouped examples of error handling approaches used in the codebase
- Results show frequency (how many files use each pattern) and representative code snippets
- Cross-repo patterns are identified when multiple repos are indexed

**Key Files to Create:**
- New: `packages/core/src/intelligence/pattern-detector.ts`
- New: `packages/core/src/intelligence/pattern-categories.ts`
- New: `packages/mcp/src/handlers/intelligence-handlers.ts`

---

### 3.3 — Best Practices Audit Tool

**Description:** Add a tool that compares codebase patterns against known best practices and reports deviations.

**Requirements:**
- New tool: `audit_practices` — compares indexed code against best-practice patterns
- Parameters: `repos`, `language` (optional), `focus` (optional: "security", "performance", "testing", "documentation", etc.)
- Implementation:
  1. Curated best-practice reference embeddings per language/framework
  2. Search for anti-patterns and missing patterns
  3. Produce a structured report: findings, severity, affected files, suggestions
- Start with TypeScript/JavaScript best practices; extensible to other languages

**Acceptance Criteria:**
- `audit_practices` for a TypeScript repo produces actionable findings
- Findings include severity levels and file locations
- No false positives for intentional deviations (configurable exclusions)

**Key Files to Create:**
- New: `packages/core/src/intelligence/best-practices.ts`
- New: `packages/core/src/intelligence/rules/` directory with per-language rules

---

### 3.4 — Dependency & Architecture Mapping

**Description:** Add a tool that maps out the dependency graph and architectural structure of indexed codebases.

**Requirements:**
- New tool: `map_architecture` — produces a high-level architectural overview
- Parameters: `repo`, `depth` (how many levels of dependency to trace), `focus` (module/directory to start from)
- Implementation:
  1. Parse import/require/include statements from indexed code chunks
  2. Build a dependency DAG at module/file level
  3. Identify layers, clusters, and circular dependencies
  4. Return structured output: modules, dependencies, clusters, potential issues
- New tool: `find_usages` — finds all usages of a symbol across repos
- Parameters: `symbol`, `repos` (optional), `type` (optional: "function", "class", "type", "variable")

**Acceptance Criteria:**
- `map_architecture` produces a navigable dependency graph for a repo
- Circular dependencies are flagged
- `find_usages` locates all call sites for a given function across repos

**Key Files to Create:**
- New: `packages/core/src/intelligence/dependency-mapper.ts`
- New: `packages/core/src/intelligence/usage-finder.ts`

---

## Epic 4: Enhanced Repository Management

**Goal:** Provide robust tools for managing the repository index lifecycle: listing, updating, auto-discovery, and branch-aware indexing.

### 4.1 — List Repositories Tool

**Description:** Add a tool that lists all known/indexed repositories with their metadata.

**Requirements:**
- New tool: `list_repositories`
- Returns: repo name, canonical ID, known paths, remote URL, index status, last indexed timestamp, file/chunk counts, branches indexed
- Supports filtering: `status` (indexed, indexing, failed), `name` (substring match)
- Shows worktree/clone relationships (which paths map to the same repo)

**Acceptance Criteria:**
- `list_repositories` returns all tracked repos with accurate metadata
- Worktree relationships are clearly shown
- Filtering works correctly

**Key Files to Modify:**
- Modify: `packages/mcp/src/handlers.ts` — new `handleListRepositories()` method
- Modify: `packages/mcp/src/index.ts` — register tool

---

### 4.2 — Branch-Aware Indexing

**Description:** Support indexing specific branches and tracking which branch is currently indexed.

**Requirements:**
- `index_codebase` gains a `branch` parameter
- Index metadata stores which branch/commit was indexed
- `search_code` gains an optional `branch` filter
- When a branch changes (detected during sync), offer re-index of changed files
- Support indexing multiple branches of the same repo as separate "views" within the same collection (tagged by branch in metadata)

**Acceptance Criteria:**
- Indexing `main` then `feature-x` of the same repo creates properly tagged entries
- Searching with `branch: "main"` only returns results from that branch
- Sync detects branch switches and handles them gracefully

**Key Files to Modify:**
- Modify: `packages/core/src/context.ts` — branch metadata in documents
- Modify: `packages/mcp/src/handlers.ts` — branch parameter handling
- Modify: `packages/core/src/sync/synchronizer.ts` — branch-aware change detection

---

### 4.3 — Auto-Discovery of Repositories

**Description:** Allow the server to auto-discover git repositories under configured root directories.

**Requirements:**
- Configuration: `REPO_SCAN_PATHS` — comma-separated list of directories to scan (e.g., `~/code,~/work`)
- On startup (and periodically), scan these directories for git repos (max depth: 3)
- Newly discovered repos are added to the registry with status "discovered" (not yet indexed)
- New tool: `discover_repositories` — triggers a scan and returns newly found repos
- Respects `.gitignore`-style exclusion patterns for scan paths

**Acceptance Criteria:**
- Setting `REPO_SCAN_PATHS=~/code` discovers all git repos under `~/code`
- Worktrees are correctly grouped with their parent repos
- Discovery doesn't trigger automatic indexing (user must explicitly index)

**Key Files to Create:**
- New: `packages/core/src/identity/repo-scanner.ts`
- Modify: `packages/mcp/src/handlers.ts` — new `handleDiscoverRepositories()`

---

## Epic 5: Snapshot & Data Model Modernization

**Goal:** Upgrade the internal data model and persistence layer to support all new features cleanly.

### 5.1 — Snapshot Format V3

**Description:** Design and implement the v3 snapshot format that supports repository identity, branches, and multi-path tracking.

**Requirements:**
- New `CodebaseSnapshotV3` interface:
  ```
  {
    formatVersion: "v3",
    repositories: Record<canonicalId, {
      displayName: string,
      remoteUrl?: string,
      knownPaths: string[],
      branches: Record<branchName, {
        status: "indexed" | "indexing" | "failed",
        indexedFiles: number,
        totalChunks: number,
        lastCommit: string,
        lastIndexed: string
      }>,
      worktrees: string[]
    }>,
    lastUpdated: string
  }
  ```
- Automatic migration from v1/v2 on load
- Backward-compatible: v1/v2 snapshots are upgraded in-place on first load

**Acceptance Criteria:**
- Loading a v1 or v2 snapshot auto-migrates to v3
- All existing functionality works after migration
- v3 snapshot stores all new repository metadata

**Key Files to Modify:**
- `packages/mcp/src/config.ts` — new interfaces
- `packages/mcp/src/snapshot.ts` — v3 load/save/migrate logic

---

### 5.2 — Vector Document Schema Enhancement

**Description:** Enrich the metadata stored in each vector document to support cross-repo search, branch filtering, and code intelligence.

**Requirements:**
- Add fields to `VectorDocument` metadata:
  - `canonicalRepoId` — canonical repository identity
  - `repoDisplayName` — human-readable repo name
  - `branch` — git branch name
  - `commitHash` — git commit SHA at time of indexing
  - `importStatements` — extracted imports/dependencies (for architecture mapping)
  - `symbolDefinitions` — top-level symbols defined in the chunk (functions, classes, types)
- Ensure backward compatibility: old documents without these fields still search correctly
- Batch update tool to enrich existing documents with new metadata

**Acceptance Criteria:**
- New indexed documents contain all enriched metadata fields
- Old documents without new fields don't break search
- A migration tool can backfill metadata for existing collections

**Key Files to Modify:**
- `packages/core/src/vectordb/types.ts` — `VectorDocument` interface
- `packages/core/src/context.ts` — document creation in `indexCodebase()`

---

## Epic 6: Developer Experience & Documentation

### 6.1 — CLI Improvements

**Description:** Improve the CLI to support new features and provide better operational visibility.

**Requirements:**
- `--transport` flag: `stdio`, `http`, `both`
- `--port` flag: HTTP port (default 3100)
- `--scan` flag: trigger repo discovery on startup
- `--migrate` flag: run collection migration from legacy format
- Interactive mode: `--interactive` for manual testing
- Structured JSON logging option: `--log-format json`

**Acceptance Criteria:**
- All new CLI flags work correctly
- `--help` documents all options
- Exit codes are meaningful (0 success, 1 error, 2 config error)

---

### 6.2 — Client Configuration Examples

**Description:** Provide configuration examples for all supported LLM clients to connect to the HTTP transport.

**Requirements:**
- Configuration examples for: Claude Code, Claude Desktop, Cursor, Cline, Gemini CLI, OpenAI Codex, VS Code, and generic HTTP MCP clients
- Docker compose file for running the server as a service
- Environment variable reference documentation

**Acceptance Criteria:**
- Each supported client has a tested configuration example
- Docker deployment works end-to-end

---

### 6.3 — Integration Test Suite

**Description:** Build an integration test suite that validates the full lifecycle across all new features.

**Requirements:**
- Test fixtures: sample git repos with worktrees, multiple remotes, various languages
- Tests cover:
  - Worktree reconciliation (same repo, different paths → same index)
  - Cross-repo search
  - HTTP transport + auth
  - Branch-aware indexing
  - Pattern detection
  - Migration from v1/v2 snapshots
- CI pipeline integration

**Acceptance Criteria:**
- All integration tests pass in CI
- Test coverage > 80% for new code
- Tests run in < 5 minutes

---

## Implementation Priority & Sequencing

### Phase 1 — Foundation (Prerequisites for Everything Else)
| Order | Issue | Epic | Rationale |
|-------|-------|------|-----------|
| 1 | 1.1 Git Repository Identity Detection | Epic 1 | Everything depends on canonical repo identity |
| 2 | 1.2 Collection Name Migration | Epic 1 | Must be in place before new indexing |
| 3 | 5.1 Snapshot Format V3 | Epic 5 | Data model must support new identity model |
| 4 | 1.3 Path-to-Repository Resolution & Registry | Epic 1 | Registry needed for all management features |

### Phase 2 — Network Access
| Order | Issue | Epic | Rationale |
|-------|-------|------|-----------|
| 5 | 2.1 HTTP/SSE Transport Layer | Epic 2 | Enables remote LLM access |
| 6 | 2.2 Authentication & API Keys | Epic 2 | Required for safe network exposure |
| 7 | 6.1 CLI Improvements | Epic 6 | Transport flags needed for HTTP |

### Phase 3 — Cross-Repo Intelligence
| Order | Issue | Epic | Rationale |
|-------|-------|------|-----------|
| 8 | 3.1 Cross-Repository Search | Epic 3 | Core value-add over current system |
| 9 | 4.1 List Repositories Tool | Epic 4 | Management visibility |
| 10 | 5.2 Vector Document Schema Enhancement | Epic 5 | Enriched metadata for intelligence tools |
| 11 | 3.2 Pattern Detection Tool | Epic 3 | Primary "ask questions about my code" feature |

### Phase 4 — Advanced Features
| Order | Issue | Epic | Rationale |
|-------|-------|------|-----------|
| 12 | 3.3 Best Practices Audit Tool | Epic 3 | Builds on pattern detection |
| 13 | 3.4 Dependency & Architecture Mapping | Epic 3 | Builds on enriched metadata |
| 14 | 4.2 Branch-Aware Indexing | Epic 4 | Advanced repo management |
| 15 | 2.3 Remote Repository Support | Epic 2 | Nice-to-have for hosted deployment |
| 16 | 4.3 Auto-Discovery of Repositories | Epic 4 | Convenience feature |

### Phase 5 — Polish
| Order | Issue | Epic | Rationale |
|-------|-------|------|-----------|
| 17 | 6.2 Client Configuration Examples | Epic 6 | Adoption enablement |
| 18 | 6.3 Integration Test Suite | Epic 6 | Quality gate |

---

## Technical Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Collection naming change breaks existing indices | Users lose indexed data | Automated migration with rollback support; keep legacy name resolution as fallback |
| Cross-repo search performance degrades with many repos | Slow search responses | Fan-out with per-collection timeouts; result caching; configurable max collections to search |
| Git identity detection fails for unusual repo configurations | Wrong deduplication or failure to deduplicate | Comprehensive fallback chain (remote URL → initial commit → path hash); manual override tool |
| HTTP transport exposes server to network attacks | Security vulnerability | Mandatory auth token for HTTP; rate limiting; no default HTTP exposure |
| Milvus collection limit hit faster with branch-aware indexing | Can't index all branches | Use metadata filtering within single collection per repo rather than separate collections per branch |
| Pattern detection produces noisy/irrelevant results | Poor user experience | Start with curated high-signal pattern categories; user feedback loop to refine |

---

## Glossary

| Term | Definition |
|------|------------|
| **Canonical ID** | A stable identifier for a git repository that is the same regardless of filesystem path, clone location, or worktree. Derived from the normalized remote origin URL or initial commit SHA. |
| **Worktree** | A git feature allowing multiple working directories to share a single repository's object store. Identified by a `.git` file (not directory) pointing to the main repo's `.git/worktrees/` directory. |
| **Collection** | A Milvus vector database collection containing the embeddings for one repository's code chunks. Named by hashing the canonical ID. |
| **MCP** | Model Context Protocol — an open standard for connecting AI models to external tools and data sources. |
| **Hybrid Search** | A search strategy combining dense vector similarity (semantic) with BM25 sparse vector matching (keyword) for better retrieval quality. |
| **Code Intelligence** | Higher-level analysis built on top of semantic search: pattern detection, best-practices auditing, dependency mapping, usage finding. |
