#!/usr/bin/env node
/**
 * Creates the "General-Purpose Code Search MCP Server" project in Linear
 * with all epics (as labels), issues, sub-issues, and dependency links.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_xxx node scripts/create-linear-project.mjs [--team TEAM_KEY] [--assignee EMAIL]
 *
 * Required:
 *   LINEAR_API_KEY  — Personal API key from Linear (Settings > API > Personal API keys)
 *
 * Optional:
 *   --team TEAM_KEY — Linear team key (e.g. "ENG"). If omitted, uses first team found.
 *   --assignee EMAIL — Email of the user to assign all issues to. If omitted, assigns to API key owner.
 *   --dry-run       — Print what would be created without making API calls.
 *   --repo URL      — GitHub repo URL to link to the project (default: github.com/180SC/claude-context)
 */

import { execSync } from "node:child_process";

const API_URL = "https://api.linear.app/graphql";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
const DRY_RUN = args.includes("--dry-run");
const TEAM_KEY = getArg("team");
const ASSIGNEE_EMAIL = getArg("assignee");
const REPO_URL = getArg("repo") || "https://github.com/180SC/claude-context";
const API_KEY = process.env.LINEAR_API_KEY;

if (!API_KEY) {
  console.error("ERROR: LINEAR_API_KEY environment variable is required.");
  console.error("Create one at: Linear > Settings > API > Personal API keys");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------
async function gql(query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = execSync(
        `curl -sS -X POST "${API_URL}" -H "Content-Type: application/json" -H "Authorization: ${API_KEY}" -d @-`,
        { input: payload, encoding: "utf-8", timeout: 30000 }
      );
      const trimmed = result.trim();
      let json;
      try {
        json = JSON.parse(trimmed);
      } catch (parseErr) {
        if (attempt < maxRetries) {
          console.warn(`  [Retry ${attempt}/${maxRetries}] Non-JSON response, retrying in ${attempt * 2}s...`);
          execSync(`sleep ${attempt * 2}`);
          continue;
        }
        throw new Error(`Non-JSON response from Linear API: ${trimmed.substring(0, 200)}`);
      }
      if (json.errors) {
        // Don't retry permanent GraphQL errors (validation, auth, etc.)
        console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
        const err = new Error(json.errors[0].message);
        err.isGraphQL = true;
        throw err;
      }
      return json.data;
    } catch (err) {
      if (attempt < maxRetries && !err.isGraphQL) {
        console.warn(`  [Retry ${attempt}/${maxRetries}] ${err.message}, retrying in ${attempt * 2}s...`);
        execSync(`sleep ${attempt * 2}`);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve team & user
// ---------------------------------------------------------------------------
async function resolveTeam() {
  const data = await gql(`query { teams { nodes { id key name } } }`);
  const teams = data.teams.nodes;
  if (TEAM_KEY) {
    const team = teams.find((t) => t.key === TEAM_KEY);
    if (!team) {
      console.error(`Team "${TEAM_KEY}" not found. Available: ${teams.map((t) => t.key).join(", ")}`);
      process.exit(1);
    }
    return team;
  }
  return teams[0];
}

async function resolveAssignee() {
  const data = await gql(`query { users { nodes { id email displayName isMe } } }`);
  const users = data.users.nodes;
  if (ASSIGNEE_EMAIL) {
    const user = users.find((u) => u.email === ASSIGNEE_EMAIL);
    if (!user) {
      console.error(`User "${ASSIGNEE_EMAIL}" not found. Available: ${users.map((u) => u.email).join(", ")}`);
      process.exit(1);
    }
    return user;
  }
  // Default: API key owner
  return users.find((u) => u.isMe) || users[0];
}

async function getWorkflowStates(teamId) {
  const data = await gql(
    `query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }`,
    { teamId }
  );
  return data.workflowStates.nodes;
}

// ---------------------------------------------------------------------------
// Create helpers
// ---------------------------------------------------------------------------
async function createProject(name, description, teamIds) {
  // Check if project already exists (from a previous partial run)
  const existing = await gql(
    `query { projects { nodes { id name url slugId } } }`
  );
  const found = existing.projects.nodes.find((p) => p.name === name);
  if (found) {
    console.log(`  Found existing project: ${found.name}`);
    return found;
  }

  const data = await gql(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        success
        project { id name url slugId }
      }
    }`,
    {
      input: {
        name,
        description,
        teamIds,
      },
    }
  );
  return data.projectCreate.project;
}

async function createLabel(teamId, name, color, description) {
  // Check if label already exists (workspace-level)
  const existing = await gql(
    `query {
      issueLabels {
        nodes { id name }
      }
    }`
  );
  const found = existing.issueLabels.nodes.find((l) => l.name === name);
  if (found) return found;

  // Try workspace-level label first (no teamId), fall back to team-level
  try {
    const data = await gql(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      { input: { name, color, description } }
    );
    return data.issueLabelCreate.issueLabel;
  } catch (err) {
    // Fall back to team-level label
    const data = await gql(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      { input: { teamId, name, color, description } }
    );
    return data.issueLabelCreate.issueLabel;
  }
}

async function createIssue(input) {
  const data = await gql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }`,
    { input }
  );
  return data.issueCreate.issue;
}

async function createIssueRelation(issueId, relatedIssueId, type = "blocks") {
  await gql(
    `mutation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) { success }
    }`,
    { input: { issueId, relatedIssueId, type } }
  );
}

// ---------------------------------------------------------------------------
// Issue definitions
// ---------------------------------------------------------------------------
// Each issue is structured for:
// - LLM consumption: explicit file paths, test commands, structured acceptance criteria
// - Human traceability: clear titles, phase/epic labels, numbered test steps
// - Incremental testability: each issue has a "How to verify" section that can be run independently

const EPIC_LABELS = [
  { name: "Epic: Repo Identity", color: "#4338ca", description: "Repository identity & worktree reconciliation" },
  { name: "Epic: Network Transport", color: "#0891b2", description: "HTTP/SSE transport & multi-client access" },
  { name: "Epic: Code Intelligence", color: "#c026d3", description: "Cross-repo search & code intelligence" },
  { name: "Epic: Repo Management", color: "#059669", description: "Repository management & discovery" },
  { name: "Epic: Data Model", color: "#d97706", description: "Snapshot & data model modernization" },
  { name: "Epic: DevEx", color: "#dc2626", description: "Developer experience & documentation" },
];

const PHASE_LABELS = [
  { name: "Phase 1: Foundation", color: "#1e3a5f", description: "Prerequisites for everything else" },
  { name: "Phase 2: Network", color: "#1e5f3a", description: "Network access" },
  { name: "Phase 3: Intelligence", color: "#5f1e3a", description: "Cross-repo intelligence" },
  { name: "Phase 4: Advanced", color: "#3a1e5f", description: "Advanced features" },
  { name: "Phase 5: Polish", color: "#5f3a1e", description: "Polish & documentation" },
];

function issueBody(sections) {
  let md = "";
  if (sections.overview) md += `${sections.overview}\n\n`;
  if (sections.context) md += `## Context\n${sections.context}\n\n`;
  if (sections.requirements) {
    md += `## Requirements\n`;
    for (const r of sections.requirements) md += `- ${r}\n`;
    md += "\n";
  }
  if (sections.files) {
    md += `## Key Files\n`;
    for (const f of sections.files) md += `- \`${f}\`\n`;
    md += "\n";
  }
  if (sections.acceptance) {
    md += `## Acceptance Criteria\n`;
    for (const a of sections.acceptance) md += `- [ ] ${a}\n`;
    md += "\n";
  }
  if (sections.verify) {
    md += `## How to Verify (Incremental Test Steps)\n`;
    for (let i = 0; i < sections.verify.length; i++) {
      md += `${i + 1}. ${sections.verify[i]}\n`;
    }
    md += "\n";
  }
  if (sections.llmNotes) {
    md += `## Notes for LLM Implementation\n${sections.llmNotes}\n\n`;
  }
  md += `---\n_GitHub: ${REPO_URL}_\n`;
  return md;
}

// The full issue list, ordered by implementation sequence
function buildIssues(epicLabelIds, phaseLabelIds) {
  return [
    // ── Phase 1: Foundation ──────────────────────────────────────────────
    {
      key: "1.1",
      title: "Git repository identity detection",
      priority: 1, // Urgent
      labels: [epicLabelIds["Epic: Repo Identity"], phaseLabelIds["Phase 1: Foundation"]],
      estimate: 3,
      dependsOn: [],
      body: issueBody({
        overview: "Build a module that determines the canonical identity of a git repository given a filesystem path. This is the foundation for all worktree reconciliation and cross-repo features.",
        context: "Currently `getCollectionName()` in `packages/core/src/context.ts:234-240` uses `md5(path.resolve(codebasePath))` to generate collection names. Two worktrees of the same repo get different names. We need to replace this with git-aware identity.",
        requirements: [
          "Detect `.git` directory (regular repo) vs `.git` file (worktree) by walking up from given path",
          "For worktrees: read `.git` file → resolve main worktree → shared object store",
          "Extract canonical identity as composite key: (1) normalized remote origin URL (strip `.git`, normalize SSH↔HTTPS), (2) fallback: SHA of initial commit, (3) last resort: path-based hash",
          "Expose `RepoIdentity` type: `{ canonicalId: string; remoteUrl?: string; mainWorktreePath?: string; detectedPaths: string[] }`",
          "Normalize SSH URLs: `git@github.com:user/repo.git` → `github.com/user/repo`",
          "Normalize HTTPS URLs: `https://github.com/user/repo.git` → `github.com/user/repo`",
        ],
        files: [
          "NEW: packages/core/src/identity/repo-identity.ts",
          "NEW: packages/core/src/identity/git-utils.ts",
          "NEW: packages/core/src/identity/__tests__/repo-identity.test.ts",
        ],
        acceptance: [
          "Given two paths that are worktrees of the same repo, `resolveIdentity()` returns the same `canonicalId`",
          "Given two clones (different dirs) with the same remote, both return the same `canonicalId`",
          "Non-git directory falls back to path-based hash (backward compat)",
          "SSH and HTTPS variants of the same GitHub remote produce the same `canonicalId`",
          "Unit tests pass for: regular repo, worktree, bare repo, no-remote repo, non-git dir, SSH vs HTTPS normalization",
        ],
        verify: [
          "Create test git repo: `git init /tmp/test-repo && cd /tmp/test-repo && git commit --allow-empty -m init`",
          "Add remote: `git remote add origin git@github.com:test/repo.git`",
          "Create worktree: `git worktree add /tmp/test-repo-wt`",
          "Run: `resolveIdentity('/tmp/test-repo')` and `resolveIdentity('/tmp/test-repo-wt')` → same `canonicalId`",
          "Run: `resolveIdentity('/tmp/not-a-repo')` → returns path-based fallback hash",
          "Run unit tests: `pnpm test --filter=@zilliz/claude-context-core -- --grep identity`",
        ],
        llmNotes: "Use `child_process.execSync` for git commands (sync is fine here — identity resolution is fast and happens once per operation). The key normalization function should handle: `git@host:user/repo.git`, `ssh://git@host/user/repo.git`, `https://host/user/repo.git`, `https://host/user/repo`, `git://host/user/repo.git`. Strip trailing `.git` and protocol prefix to produce `host/user/repo`.",
      }),
    },
    {
      key: "1.2",
      title: "Collection name migration to canonical identity",
      priority: 2, // High
      labels: [epicLabelIds["Epic: Repo Identity"], phaseLabelIds["Phase 1: Foundation"]],
      estimate: 3,
      dependsOn: ["1.1"],
      body: issueBody({
        overview: "Migrate Milvus collection naming from `md5(absolutePath).substring(0,8)` to `md5(canonicalId).substring(0,12)` with backward compatibility so existing indices keep working.",
        context: "Current naming in `packages/core/src/context.ts:234-240` produces 8-char path hashes like `hybrid_code_chunks_a1b2c3d4`. New naming uses 12-char canonical-ID hashes for lower collision risk across repos. Must detect and support both formats during transition.",
        requirements: [
          "New naming: `hybrid_code_chunks_{md5(canonicalId).substring(0,12)}`",
          "On `getCollectionName()`: first check if a legacy (8-char) collection exists for this path; if so, use it (backward compat)",
          "If no legacy collection exists, use canonical-ID-based name",
          "Store mapping in `~/.context/collection-migration.json`: `{ oldName: string, newName: string, canonicalId: string, path: string }[]`",
          "Add `--migrate` CLI flag that batch-migrates all legacy collections to new names (rename in Milvus, update snapshot)",
        ],
        files: [
          "MODIFY: packages/core/src/context.ts — getCollectionName(), getPreparedCollection()",
          "MODIFY: packages/mcp/src/snapshot.ts — store canonicalId alongside paths",
          "NEW: packages/core/src/identity/collection-migrator.ts",
        ],
        acceptance: [
          "Existing collections (8-char hash) continue to be found and used without re-indexing",
          "New collections use 12-char canonical-ID hash",
          "`--migrate` renames old collections and updates the snapshot",
          "Migration is idempotent — running twice doesn't break anything",
          "Migration log written to `~/.context/collection-migration.json`",
        ],
        verify: [
          "Index a repo using the OLD code → produces `hybrid_code_chunks_XXXXXXXX` collection",
          "Upgrade to new code → call `getCollectionName()` for the same path → still resolves to old collection",
          "Index a NEW repo → produces `hybrid_code_chunks_XXXXXXXXXXXX` (12-char) collection",
          "Run `--migrate` → old collection renamed to 12-char name, snapshot updated",
          "Run `search_code` against migrated collection → results identical to pre-migration",
        ],
        llmNotes: "Milvus supports `rename_collection()` via the SDK (`packages/core/src/vectordb/milvus-vectordb.ts`). Use `listCollections()` to find all `code_chunks_*` and `hybrid_code_chunks_*` collections, then match them against snapshot paths to build the migration plan.",
      }),
    },
    {
      key: "5.1",
      title: "Snapshot format v3 with repository identity",
      priority: 2,
      labels: [epicLabelIds["Epic: Data Model"], phaseLabelIds["Phase 1: Foundation"]],
      estimate: 2,
      dependsOn: ["1.1"],
      body: issueBody({
        overview: "Upgrade the snapshot persistence layer from v1/v2 (path-keyed flat lists) to v3 (canonical-ID-keyed repository records with branch and worktree tracking).",
        context: "Current snapshot at `~/.context/mcp-codebase-snapshot.json` stores arrays of paths keyed by status. `packages/mcp/src/snapshot.ts` already handles v1→v2 migration. We need v3 that stores `canonicalId` as the primary key with rich metadata per repo.",
        requirements: [
          "Define `CodebaseSnapshotV3` interface with `formatVersion: 'v3'` and `repositories: Record<canonicalId, RepoSnapshot>`",
          "`RepoSnapshot` includes: `displayName`, `remoteUrl?`, `knownPaths: string[]`, `worktrees: string[]`, `branches: Record<branchName, BranchSnapshot>`, `lastIndexed: string`",
          "`BranchSnapshot` includes: `status`, `indexedFiles`, `totalChunks`, `lastCommit`, `lastIndexed`",
          "Auto-migrate v1 and v2 on load: resolve git identity for each stored path, group by canonical ID",
          "Backward-compatible: if identity resolution fails during migration, keep path as the key",
        ],
        files: [
          "MODIFY: packages/mcp/src/config.ts — new CodebaseSnapshotV3 and related interfaces",
          "MODIFY: packages/mcp/src/snapshot.ts — v3 load/save/migrate, extend SnapshotManager",
          "NEW: packages/mcp/src/__tests__/snapshot-v3.test.ts",
        ],
        acceptance: [
          "Loading a v1 snapshot auto-migrates to v3 in memory and persists",
          "Loading a v2 snapshot auto-migrates to v3",
          "Loading a v3 snapshot works directly",
          "`getIndexedCodebases()` returns paths from the new structure (backward compat for callers)",
          "Two paths for the same repo are merged under one canonical ID entry",
        ],
        verify: [
          "Create a fake v2 snapshot file with 3 paths (2 being worktrees of same repo)",
          "Load via `SnapshotManager` → v3 format, 2 entries (worktrees merged)",
          "Save and re-load → stable round-trip",
          "`getIndexedCodebases()` returns all 3 original paths (backward compat)",
          "Existing MCP tools (`get_indexing_status`) still work after migration",
        ],
        llmNotes: "The existing `loadCodebaseSnapshot()` in `packages/mcp/src/snapshot.ts` already detects v1 vs v2 via format markers. Add v3 detection the same way. The migration needs `resolveIdentity()` from issue 1.1, so import it. Handle the case where git is not available (e.g., CI) by falling back to path-based grouping.",
      }),
    },
    {
      key: "1.3",
      title: "Repository registry with path-to-identity resolution",
      priority: 2,
      labels: [epicLabelIds["Epic: Repo Identity"], phaseLabelIds["Phase 1: Foundation"]],
      estimate: 3,
      dependsOn: ["1.1", "5.1"],
      body: issueBody({
        overview: "Build the `RepoRegistry` class that maps multiple filesystem paths to their canonical repository identity, preventing duplicate indexing across worktrees and clones.",
        context: "With identity detection (1.1) and snapshot v3 (5.1) in place, we need the runtime registry that handlers query before indexing. This is the gatekeeper: when `index_codebase` is called, the registry determines whether to index, skip, or incrementally update.",
        requirements: [
          "`RepoRegistry` class backed by the v3 snapshot",
          "`resolve(path)` → `RepoRecord | null`: resolve identity and check if already registered",
          "`register(path, identity)` → adds path to existing repo record or creates new one",
          "`isAlreadyIndexed(identity)` → boolean: check if this canonical ID has an active index",
          "`getByCanonicalId(id)` → `RepoRecord`: retrieve full record",
          "`listAll()` → all registered repos with metadata",
          "Integrate into `handleIndexCodebase()`: check registry before indexing, skip if duplicate",
          "Persist registry state via snapshot v3",
        ],
        files: [
          "NEW: packages/core/src/identity/repo-registry.ts",
          "MODIFY: packages/mcp/src/handlers.ts — handleIndexCodebase() checks registry",
          "MODIFY: packages/mcp/src/index.ts — initialize registry on startup",
        ],
        acceptance: [
          "Index `/home/user/repo-main` → creates index, registers in registry",
          "Index `/home/user/repo-worktree` (same repo) → skips indexing, registers path as alias, returns message 'Already indexed as repo-main'",
          "Registry persists across server restarts",
          "`listAll()` shows both paths grouped under one canonical ID",
        ],
        verify: [
          "Start server, index repo at path A → success, collection created",
          "Create worktree at path B for same repo, call index on path B → response says 'already indexed', no new collection",
          "Call `get_indexing_status` with path B → returns status from path A's index",
          "Restart server → registry loaded from snapshot, same behavior",
          "Call `list_repositories` (new tool) → shows one repo with two paths",
        ],
        llmNotes: "The registry should be a thin layer on top of the v3 snapshot — not a separate persistence file. The `SnapshotManager` already handles I/O. The registry adds the lookup-by-identity behavior. In `handleIndexCodebase()` (packages/mcp/src/handlers.ts:169+), add the registry check right after path validation but before calling `context.indexCodebase()`.",
      }),
    },

    // ── Phase 2: Network Access ──────────────────────────────────────────
    {
      key: "2.1",
      title: "Streamable HTTP transport layer",
      priority: 1,
      labels: [epicLabelIds["Epic: Network Transport"], phaseLabelIds["Phase 2: Network"]],
      estimate: 5,
      dependsOn: [],
      body: issueBody({
        overview: "Add Streamable HTTP transport alongside stdio so the MCP server can be accessed over the network by any client (Agno, remote Claude, browser tools, etc.).",
        context: "Currently `packages/mcp/src/index.ts:252` only creates a `StdioServerTransport`. The MCP SDK (`@modelcontextprotocol/sdk`) already provides `StreamableHTTPServerTransport` for HTTP-based communication with SSE streaming. We need to support both transports.",
        requirements: [
          "Add `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`",
          "CLI flag: `--transport stdio|http|both` (default: `stdio` for backward compat)",
          "CLI flag: `--port PORT` (default: 3100, env: `MCP_PORT`)",
          "When `http` or `both`: start HTTP server on configured port with `/mcp` endpoint",
          "When `both`: run stdio and HTTP simultaneously (two transports, one MCP server)",
          "CORS headers: `Access-Control-Allow-Origin: *` (configurable)",
          "Health check: `GET /health` returns `{ status: 'ok', version: '...', transport: 'http', uptime: ... }`",
          "Graceful shutdown: handle SIGTERM/SIGINT, close HTTP server and MCP connections",
        ],
        files: [
          "MODIFY: packages/mcp/src/index.ts — add transport selection, HTTP server setup",
          "NEW: packages/mcp/src/transports/http-transport.ts — HTTP server wrapper",
          "MODIFY: packages/mcp/package.json — add express or native http deps if needed",
        ],
        acceptance: [
          "`npx @zilliz/claude-context-mcp` (no flags) → stdio transport, identical to current behavior",
          "`npx @zilliz/claude-context-mcp --transport http --port 3100` → HTTP server on :3100",
          "`npx @zilliz/claude-context-mcp --transport both` → both transports active",
          "`curl http://localhost:3100/health` → returns JSON health status",
          "Agno MCPTools with `transport='streamable-http'` can connect and call `search_code`",
          "All 4 existing tools work identically over HTTP",
        ],
        verify: [
          "Start with `--transport http --port 3100`",
          "`curl -s http://localhost:3100/health | jq .` → `{ status: 'ok', ... }`",
          "Use MCP Inspector or a test client to call `get_indexing_status` over HTTP → valid response",
          "Start with `--transport both`, verify stdio still works by piping JSON-RPC",
          "Start with no flags → verify stdio-only (no HTTP port open)",
          "Send SIGTERM → server shuts down cleanly within 5s",
        ],
        llmNotes: "The MCP SDK's `StreamableHTTPServerTransport` handles the SSE streaming protocol. You just need to wire it to an HTTP server (Node's built-in `http` module or Express). The key is that both transports share the same `McpServer` instance and `ToolHandlers`. Reference the MCP SDK examples for `StreamableHTTPServerTransport` setup. Use `import { parseArgs } from 'node:util'` for CLI flag parsing (Node 18.3+).",
      }),
    },
    {
      key: "2.2",
      title: "Authentication & rate limiting for HTTP transport",
      priority: 2,
      labels: [epicLabelIds["Epic: Network Transport"], phaseLabelIds["Phase 2: Network"]],
      estimate: 2,
      dependsOn: ["2.1"],
      body: issueBody({
        overview: "Add bearer token authentication and rate limiting to the HTTP transport so the server can be safely exposed on a network.",
        requirements: [
          "Bearer token auth: `Authorization: Bearer <token>` header required for all HTTP requests",
          "Token configured via `MCP_AUTH_TOKEN` environment variable",
          "If HTTP transport is active and no token is set → refuse to start with clear error message",
          "Rate limiting: configurable RPM per client IP (default: 60, env: `MCP_RATE_LIMIT`)",
          "429 response when rate limit exceeded, with `Retry-After` header",
          "Audit log: log every tool invocation with timestamp, client IP, tool name, and args summary to stderr",
          "stdio transport is completely unaffected (no auth required)",
        ],
        files: [
          "NEW: packages/mcp/src/middleware/auth.ts",
          "NEW: packages/mcp/src/middleware/rate-limiter.ts",
          "MODIFY: packages/mcp/src/transports/http-transport.ts — apply middleware",
        ],
        acceptance: [
          "HTTP request without `Authorization` header → 401 Unauthorized",
          "HTTP request with wrong token → 401 Unauthorized",
          "HTTP request with correct token → 200, tool executes",
          "61st request in 1 minute → 429 Too Many Requests with `Retry-After` header",
          "stdio transport continues to work without any auth",
          "Starting with `--transport http` and no `MCP_AUTH_TOKEN` → exits with error code 2",
        ],
        verify: [
          "Set `MCP_AUTH_TOKEN=test123`, start with `--transport http`",
          "`curl -s http://localhost:3100/health` → 200 (health check is unauthenticated)",
          "`curl -s http://localhost:3100/mcp -H 'Authorization: Bearer wrong'` → 401",
          "`curl -s http://localhost:3100/mcp -H 'Authorization: Bearer test123'` → 200",
          "Send 61 requests in quick succession → 429 on the 61st",
          "Unset `MCP_AUTH_TOKEN`, start with `--transport http` → process exits with code 2",
          "Start with `--transport stdio` (no token) → works fine",
        ],
        llmNotes: "Rate limiting should use a simple sliding window per IP. Use a `Map<string, { count: number, resetTime: number }>` — no need for Redis. The auth middleware is HTTP-layer only; it intercepts before the request reaches the MCP transport. Keep the health endpoint (`/health`) unauthenticated so monitoring tools can probe it.",
      }),
    },
    {
      key: "6.1",
      title: "CLI flags for transport, port, migration, and logging",
      priority: 2,
      labels: [epicLabelIds["Epic: DevEx"], phaseLabelIds["Phase 2: Network"]],
      estimate: 2,
      dependsOn: ["2.1"],
      body: issueBody({
        overview: "Add CLI argument parsing so users can control transport mode, port, migration, repo discovery, and log format from the command line.",
        requirements: [
          "`--transport stdio|http|both` (default: `stdio`)",
          "`--port PORT` (default: 3100, env override: `MCP_PORT`)",
          "`--migrate` — run collection migration from legacy format, then exit",
          "`--scan` — trigger repo discovery on startup before starting server",
          "`--log-format text|json` (default: `text`)",
          "`--help` — print usage and exit",
          "`--version` — print version from package.json and exit",
          "Exit codes: 0 = success, 1 = runtime error, 2 = configuration error",
        ],
        files: [
          "MODIFY: packages/mcp/src/index.ts — add parseArgs-based CLI parsing",
          "MODIFY: packages/mcp/src/config.ts — CLI config interface",
        ],
        acceptance: [
          "All flags documented in `--help` output",
          "`--version` prints correct version",
          "Invalid flag → helpful error message + exit code 2",
          "Flags override env vars (e.g., `--port 4000` overrides `MCP_PORT=3100`)",
        ],
        verify: [
          "`npx @zilliz/claude-context-mcp --help` → prints usage with all flags",
          "`npx @zilliz/claude-context-mcp --version` → prints version number",
          "`npx @zilliz/claude-context-mcp --transport invalid` → error + exit code 2",
          "`npx @zilliz/claude-context-mcp --transport http --port 4000` → HTTP server on :4000",
        ],
        llmNotes: "Use `import { parseArgs } from 'node:util'` (available since Node 18.3). This is already a native Node API — no external dependency needed. Define options as `{ transport: { type: 'string', default: 'stdio' }, port: { type: 'string', default: '3100' }, ... }`.",
      }),
    },

    // ── Phase 3: Cross-Repo Intelligence ─────────────────────────────────
    {
      key: "3.1",
      title: "Cross-repository search (search_all tool)",
      priority: 1,
      labels: [epicLabelIds["Epic: Code Intelligence"], phaseLabelIds["Phase 3: Intelligence"]],
      estimate: 5,
      dependsOn: ["1.3"],
      body: issueBody({
        overview: "Add the `search_all` MCP tool — the primary feature for 'how did I build X?' questions. Searches across all indexed repositories simultaneously and returns merged, re-ranked results attributed to their source repos.",
        context: "This is the core user-facing feature. Today's `search_code` requires a specific path. `search_all` removes that constraint. Example query: *'Tell me how I'm building the Makefile help menu'* → finds Makefile help patterns across all indexed repos.",
        requirements: [
          "New MCP tool: `search_all`",
          "Parameters: `query` (required), `limit` (default: 20), `repos` (optional string[] filter by repo name/ID), `extensionFilter` (optional string, e.g., '.py,.ts')",
          "Fan out query to all indexed collections (from registry)",
          "Per-collection: run same hybrid search as `search_code`",
          "Merge results across collections, normalize scores (min-max per collection, then global re-rank)",
          "Results include: `repoName`, `repoCanonicalId`, `relativePath`, `content`, `startLine`, `endLine`, `score`, `language`",
          "If `repos` filter provided, only search those repos",
          "Respect collection-level timeout (5s per collection, 15s total max)",
        ],
        files: [
          "MODIFY: packages/core/src/context.ts — new semanticSearchMulti() method",
          "MODIFY: packages/mcp/src/handlers.ts — new handleSearchAll() method",
          "MODIFY: packages/mcp/src/index.ts — register search_all tool",
        ],
        acceptance: [
          "With 3 repos indexed, `search_all` query returns results from all 3",
          "Results are ranked by relevance across repos (not just concatenated)",
          "Each result includes the repo name and relative path",
          "`repos` filter correctly restricts scope",
          "`extensionFilter` correctly filters by file type",
          "Query about Makefile patterns finds results in repos that have Makefiles",
          "Performance: < 5s for 20 repos",
        ],
        verify: [
          "Index 3 different repos with `index_codebase`",
          "Call `search_all` with query 'error handling' → results from multiple repos",
          "Call `search_all` with `repos: ['repo-a']` → results only from repo-a",
          "Call `search_all` with `extensionFilter: '.py'` → only Python files",
          "Call `search_all` with query 'Makefile help' → finds Makefile help targets",
          "Call `search_all` with query that matches in only 1 repo → returns results only from that repo",
          "Measure time with 5+ repos indexed → < 5s",
        ],
        llmNotes: "The fan-out is straightforward: get all collection names from the registry, call `semanticSearch()` for each in parallel with `Promise.allSettled()`, merge results. For score normalization: within each collection, normalize scores to [0,1] using min-max, then merge all and sort by normalized score. Use the existing `context.semanticSearch()` method for each collection — don't rewrite the search logic.",
      }),
    },
    {
      key: "4.1",
      title: "List repositories tool",
      priority: 2,
      labels: [epicLabelIds["Epic: Repo Management"], phaseLabelIds["Phase 3: Intelligence"]],
      estimate: 1,
      dependsOn: ["1.3"],
      body: issueBody({
        overview: "Add the `list_repositories` MCP tool that returns all known/indexed repositories with metadata, worktree relationships, and index status.",
        requirements: [
          "New MCP tool: `list_repositories`",
          "Parameters: `status` (optional: 'indexed' | 'indexing' | 'failed' | 'discovered'), `name` (optional: substring filter)",
          "Returns array of: `{ displayName, canonicalId, remoteUrl, knownPaths, worktrees, status, lastIndexed, indexedFiles, totalChunks, branches }`",
          "Shows which paths map to the same repo (worktree/clone relationships)",
          "Data sourced from the registry (issue 1.3)",
        ],
        files: [
          "MODIFY: packages/mcp/src/handlers.ts — new handleListRepositories()",
          "MODIFY: packages/mcp/src/index.ts — register list_repositories tool",
        ],
        acceptance: [
          "With 3 repos indexed (1 having 2 worktrees), `list_repositories` returns 3 entries, the multi-worktree repo showing both paths",
          "Filtering by `status: 'indexed'` returns only indexed repos",
          "Filtering by `name: 'api'` returns repos with 'api' in their display name",
        ],
        verify: [
          "Index 2 repos, call `list_repositories` → 2 entries with correct metadata",
          "Index a worktree of repo #1 → `list_repositories` still shows 2 entries, but #1 has 2 paths",
          "Call with `status: 'indexed'` → returns indexed repos only",
          "Call with `name: 'myapi'` → returns only matching repos",
        ],
        llmNotes: "This is a thin wrapper over `registry.listAll()` with filtering. The tool schema should use `object` input type with optional `status` and `name` fields.",
      }),
    },
    {
      key: "5.2",
      title: "Vector document schema enhancement with repo metadata",
      priority: 2,
      labels: [epicLabelIds["Epic: Data Model"], phaseLabelIds["Phase 3: Intelligence"]],
      estimate: 3,
      dependsOn: ["1.1", "1.3"],
      body: issueBody({
        overview: "Enrich the metadata stored in each vector document with repository identity, branch info, and structural metadata to support cross-repo search result attribution and future code intelligence features.",
        requirements: [
          "Add to `VectorDocument` metadata: `canonicalRepoId`, `repoDisplayName`, `branch`, `commitHash`",
          "Add to `VectorDocument` metadata (for future): `importStatements` (string[]), `symbolDefinitions` (string[])",
          "Backward compatible: old documents without new fields still work in search",
          "New documents always include the new fields",
          "Extract imports/symbols during chunk creation (extend AST splitter output)",
        ],
        files: [
          "MODIFY: packages/core/src/vectordb/types.ts — VectorDocument interface",
          "MODIFY: packages/core/src/context.ts — document creation in indexCodebase()",
          "MODIFY: packages/core/src/splitter/ — extract imports/symbols from AST",
        ],
        acceptance: [
          "Newly indexed documents contain `canonicalRepoId`, `repoDisplayName`, `branch`, `commitHash`",
          "Old documents without these fields still return correctly in search results",
          "TypeScript files have `importStatements` populated with extracted import paths",
          "Functions/classes in chunks populate `symbolDefinitions`",
        ],
        verify: [
          "Index a repo with the new code → inspect Milvus documents → new fields present",
          "Search against an OLD collection (pre-enhancement) → results returned without error",
          "Index a TypeScript file with imports → `importStatements` field contains the import paths",
          "Index a file with function definitions → `symbolDefinitions` contains function names",
        ],
        llmNotes: "The AST splitter (`packages/core/src/splitter/ast-code-splitter.ts`) already parses the tree-sitter AST. Extend it to extract: (1) import/require nodes → store as `importStatements`, (2) function_declaration / class_declaration / type_alias_declaration nodes → store as `symbolDefinitions`. For Milvus schema, these can be VARCHAR fields with JSON-encoded arrays. Use `JSON.stringify()` for storage and `JSON.parse()` for retrieval.",
      }),
    },
    {
      key: "3.2",
      title: "Pattern detection tool (find_patterns)",
      priority: 2,
      labels: [epicLabelIds["Epic: Code Intelligence"], phaseLabelIds["Phase 3: Intelligence"]],
      estimate: 5,
      dependsOn: ["3.1"],
      body: issueBody({
        overview: "Add the `find_patterns` MCP tool that identifies recurring code patterns, idioms, and conventions across indexed codebases by category.",
        context: "This builds on `search_all` by using curated 'pattern queries' for each category, then clustering and deduplicating the results to show distinct patterns with frequency counts.",
        requirements: [
          "New MCP tool: `find_patterns`",
          "Parameters: `repos` (optional), `category` (optional: 'error-handling' | 'logging' | 'testing' | 'api-design' | 'state-management' | 'authentication' | 'database' | 'configuration'), `limit` (default: 10)",
          "Predefined query sets per category (e.g., error-handling: ['try catch error handling', 'custom error class', 'error middleware', 'error boundary', ...])",
          "Run `search_all` for each query in the category, collect all results",
          "Cluster results by structural similarity (simple: group by file extension + similar code structure via edit distance)",
          "Return grouped results: `{ patternName: string, frequency: number, repos: string[], examples: CodeSnippet[] }`",
          "Extensible: custom pattern queries via configuration",
        ],
        files: [
          "NEW: packages/core/src/intelligence/pattern-detector.ts",
          "NEW: packages/core/src/intelligence/pattern-categories.ts",
          "MODIFY: packages/mcp/src/handlers.ts — new handleFindPatterns()",
          "MODIFY: packages/mcp/src/index.ts — register find_patterns tool",
        ],
        acceptance: [
          "`find_patterns` with category 'error-handling' returns grouped error handling approaches",
          "Results show frequency (how many files/repos use each pattern)",
          "Each pattern group has representative code examples",
          "Cross-repo patterns are identified when multiple repos have similar code",
        ],
        verify: [
          "Index 3 repos that use different error handling approaches",
          "Call `find_patterns` with `category: 'error-handling'` → grouped results showing distinct patterns",
          "Verify each group has correct frequency count",
          "Call `find_patterns` with no category → returns patterns across all categories",
          "Call `find_patterns` with `repos: ['repo-a']` → patterns from only that repo",
        ],
        llmNotes: "Start simple: for each category, define 5-10 semantic search queries. Run them via `search_all`, collect top results. Group by: (1) same file extension, (2) fuzzy code similarity (Jaccard distance on tokenized code). Don't over-engineer the clustering — simple grouping by file extension and keyword overlap is a good v1. The LLM consuming the results will do the final pattern synthesis.",
      }),
    },

    // ── Phase 4: Advanced Features ───────────────────────────────────────
    {
      key: "3.3",
      title: "Best practices audit tool (audit_practices)",
      priority: 3,
      labels: [epicLabelIds["Epic: Code Intelligence"], phaseLabelIds["Phase 4: Advanced"]],
      estimate: 5,
      dependsOn: ["3.2"],
      body: issueBody({
        overview: "Add the `audit_practices` MCP tool that compares indexed code against known best practices and produces a structured findings report.",
        requirements: [
          "New MCP tool: `audit_practices`",
          "Parameters: `repos` (optional), `language` (optional), `focus` (optional: 'security' | 'performance' | 'testing' | 'documentation')",
          "Curated best-practice reference patterns per language/focus area",
          "Anti-pattern detection: search for known bad patterns (e.g., SQL string concatenation, hardcoded secrets)",
          "Missing-pattern detection: check for absence of expected patterns (e.g., no error boundaries in React)",
          "Output: `{ findings: Array<{ severity, category, description, affectedFiles, suggestion }> }`",
          "Start with TypeScript/JavaScript; extensible to Python, Go",
        ],
        files: [
          "NEW: packages/core/src/intelligence/best-practices.ts",
          "NEW: packages/core/src/intelligence/rules/ — per-language rule sets",
          "MODIFY: packages/mcp/src/handlers.ts — new handleAuditPractices()",
          "MODIFY: packages/mcp/src/index.ts — register audit_practices tool",
        ],
        acceptance: [
          "`audit_practices` for a TypeScript repo produces at least 1 finding",
          "Findings include severity, category, affected files, and suggestions",
          "Security-focused audit catches SQL string concatenation and hardcoded secrets patterns",
          "No false positives for excluded patterns",
        ],
        verify: [
          "Create a test repo with known anti-patterns (SQL concat, console.log instead of logger, no error handling)",
          "Index it and run `audit_practices` → findings include all planted anti-patterns",
          "Run with `focus: 'security'` → only security-related findings",
          "Run against a well-structured repo → minimal/no findings",
        ],
        llmNotes: "This is a search-based audit, not static analysis. For each rule: define a search query that finds instances of the anti-pattern, then format matches as findings. Example rule: `{ name: 'sql-injection', query: 'SQL query string concatenation', severity: 'high', suggestion: 'Use parameterized queries' }`. The consuming LLM will interpret the raw results — keep the tool output structured but raw.",
      }),
    },
    {
      key: "3.4",
      title: "Dependency & architecture mapping tools",
      priority: 3,
      labels: [epicLabelIds["Epic: Code Intelligence"], phaseLabelIds["Phase 4: Advanced"]],
      estimate: 5,
      dependsOn: ["5.2"],
      body: issueBody({
        overview: "Add `map_architecture` and `find_usages` MCP tools for dependency graph visualization and cross-repo symbol usage search.",
        requirements: [
          "`map_architecture` tool: `repo` (required), `depth` (default: 2), `focus` (optional: module/dir path)",
          "Parse `importStatements` from vector document metadata to build dependency DAG",
          "Identify: module clusters, layers, circular dependencies",
          "Return structured output: `{ modules: [], dependencies: [], clusters: [], circularDeps: [] }`",
          "`find_usages` tool: `symbol` (required), `repos` (optional), `type` (optional: 'function' | 'class' | 'type')",
          "Search for symbol name across all indexed repos using semantic + keyword search",
          "Return: `{ symbol, usages: Array<{ repo, file, line, context }> }`",
        ],
        files: [
          "NEW: packages/core/src/intelligence/dependency-mapper.ts",
          "NEW: packages/core/src/intelligence/usage-finder.ts",
          "MODIFY: packages/mcp/src/handlers.ts — new handlers",
          "MODIFY: packages/mcp/src/index.ts — register both tools",
        ],
        acceptance: [
          "`map_architecture` produces dependency graph for a TypeScript project",
          "Circular dependencies are detected and flagged",
          "`find_usages` for a known function name returns all call sites across repos",
        ],
        verify: [
          "Index a multi-module TypeScript project",
          "Call `map_architecture` → returns dependency graph with modules and edges",
          "Manually verify a few edges against actual import statements",
          "Introduce a circular import → re-index → `map_architecture` flags it",
          "Call `find_usages` with a function defined in shared-lib → finds usages in consuming repos",
        ],
        llmNotes: "The dependency graph is built from the `importStatements` metadata field added in issue 5.2. Query all documents for a collection, extract `importStatements`, resolve relative imports to module paths, build adjacency list. For circular deps, use DFS with a visited/recursion-stack check. For `find_usages`, combine semantic search (query: the symbol name + 'usage call invocation') with keyword search (exact match on symbol name).",
      }),
    },
    {
      key: "4.2",
      title: "Branch-aware indexing",
      priority: 3,
      labels: [epicLabelIds["Epic: Repo Management"], phaseLabelIds["Phase 4: Advanced"]],
      estimate: 3,
      dependsOn: ["1.3", "5.2"],
      body: issueBody({
        overview: "Support indexing specific branches of a repo and filtering search results by branch.",
        requirements: [
          "`index_codebase` gains `branch` parameter (optional, defaults to current branch)",
          "Index metadata stores branch name and commit hash per document",
          "`search_code` and `search_all` gain optional `branch` filter",
          "Multiple branches of same repo stored in same collection, differentiated by metadata",
          "Background sync detects branch switches and handles gracefully",
        ],
        files: [
          "MODIFY: packages/core/src/context.ts — branch metadata, filter support",
          "MODIFY: packages/mcp/src/handlers.ts — branch parameter",
          "MODIFY: packages/core/src/sync/synchronizer.ts — branch-aware change detection",
        ],
        acceptance: [
          "Index `main` branch → documents tagged with `branch: 'main'`",
          "Switch to `feature-x`, index again → new/changed documents tagged with `branch: 'feature-x'`",
          "`search_code` with `branch: 'main'` → only main branch results",
          "`search_code` without branch filter → results from all branches",
        ],
        verify: [
          "Index repo on `main` branch → inspect docs, verify branch metadata",
          "Checkout `feature` branch, add new file, index → verify new doc has `branch: 'feature'`",
          "Search with `branch: 'main'` → does NOT return the new file",
          "Search without branch filter → returns the new file",
          "Switch back to `main`, trigger sync → no errors",
        ],
        llmNotes: "Branch detection: `git rev-parse --abbrev-ref HEAD`. Commit hash: `git rev-parse HEAD`. Store as metadata in each VectorDocument. For Milvus filtering, use `filterExpr: 'branch == \"main\"'` which is already supported by the search interface.",
      }),
    },
    {
      key: "2.3",
      title: "Remote repository support (clone & index by URL)",
      priority: 3,
      labels: [epicLabelIds["Epic: Network Transport"], phaseLabelIds["Phase 4: Advanced"]],
      estimate: 3,
      dependsOn: ["1.3", "2.1"],
      body: issueBody({
        overview: "Allow indexing repositories by git URL (not just local path) — the server clones to a managed cache and indexes from there.",
        requirements: [
          "`index_codebase` gains `url` parameter (alternative to `path`) accepting git clone URLs",
          "Clone to `~/.context/repo-cache/{canonicalId}/` (shallow clone by default for speed)",
          "Support `branch` parameter to specify which branch to clone",
          "Deduplicate with local checkouts: if a local path for the same repo is already indexed, don't re-clone",
          "New tool: `clear_cache` to reclaim disk space from cloned repos",
          "Cloned repos persist across server restarts",
        ],
        files: [
          "NEW: packages/core/src/identity/repo-cache.ts",
          "MODIFY: packages/mcp/src/handlers.ts — handleIndexCodebase() accepts url",
          "MODIFY: packages/mcp/src/index.ts — register clear_cache tool",
        ],
        acceptance: [
          "`index_codebase` with `url: 'https://github.com/user/repo'` clones and indexes",
          "Second call with same URL → skips clone, uses cache",
          "If local checkout of same repo already indexed → uses existing index, no clone",
          "`clear_cache` removes the cloned directory but preserves the Milvus collection",
        ],
        verify: [
          "Call `index_codebase` with a public GitHub repo URL → cloned to cache, indexed",
          "Call again → 'already indexed' response, no re-clone",
          "Verify `~/.context/repo-cache/` contains the clone",
          "Call `clear_cache` → directory removed, but search still works (Milvus has the data)",
          "Index a local checkout of the same repo → recognized as same repo, no duplicate",
        ],
        llmNotes: "Use `git clone --depth 1 --branch <branch> <url> <dest>` for shallow clones. Resolve canonical ID from the URL directly (normalize it to `host/user/repo` format). The `repo-cache.ts` module manages the cache directory lifecycle. Use `fs.promises` for all I/O.",
      }),
    },
    {
      key: "4.3",
      title: "Auto-discovery of repositories",
      priority: 4,
      labels: [epicLabelIds["Epic: Repo Management"], phaseLabelIds["Phase 4: Advanced"]],
      estimate: 2,
      dependsOn: ["1.3"],
      body: issueBody({
        overview: "Allow the server to scan configured directories and auto-discover git repos, so users don't have to manually index each of their dozens of repos.",
        requirements: [
          "Config: `REPO_SCAN_PATHS` env var — comma-separated dirs to scan (e.g., `~/code,~/work`)",
          "Scanner walks directories up to depth 3, looking for `.git` dirs/files",
          "Groups worktrees with their parent repos",
          "New tool: `discover_repositories` — triggers scan, returns newly found repos",
          "Discovered repos added to registry with status 'discovered' (NOT auto-indexed)",
          "`--scan` CLI flag triggers discovery on startup",
          "Respects `.gitignore`-style exclusion patterns",
        ],
        files: [
          "NEW: packages/core/src/identity/repo-scanner.ts",
          "MODIFY: packages/mcp/src/handlers.ts — handleDiscoverRepositories()",
          "MODIFY: packages/mcp/src/index.ts — register tool, startup scan",
        ],
        acceptance: [
          "Setting `REPO_SCAN_PATHS=~/code` discovers all git repos under ~/code",
          "Worktrees grouped with their parent repos in discovery results",
          "Discovered repos are NOT auto-indexed (user must explicitly index)",
          "`discover_repositories` returns list of found repos with paths",
        ],
        verify: [
          "Create 3 git repos under /tmp/code/, one with a worktree",
          "Set `REPO_SCAN_PATHS=/tmp/code`, call `discover_repositories`",
          "→ Returns 3 repos (worktree grouped), all status 'discovered'",
          "Call `list_repositories` → shows discovered repos with status 'discovered'",
          "Index one → status changes to 'indexed'",
        ],
        llmNotes: "The scanner is a simple recursive directory walker. At each directory up to depth 3, check for `.git` (directory → regular repo) or `.git` (file → worktree). Use `resolveIdentity()` from issue 1.1 for each found repo to get canonical IDs and group worktrees. Return the results sorted by display name.",
      }),
    },

    // ── Phase 5: Polish ──────────────────────────────────────────────────
    {
      key: "6.2",
      title: "Client configuration examples and Docker deployment",
      priority: 3,
      labels: [epicLabelIds["Epic: DevEx"], phaseLabelIds["Phase 5: Polish"]],
      estimate: 2,
      dependsOn: ["2.1", "2.2"],
      body: issueBody({
        overview: "Provide tested configuration examples for all major MCP clients and a Docker setup for running the server as a persistent service.",
        requirements: [
          "Configuration snippets for: Claude Code, Claude Desktop, Cursor, Cline, Gemini CLI, OpenAI Codex, Agno, VS Code, generic HTTP MCP client",
          "Each snippet shows both stdio and Streamable HTTP connection",
          "Dockerfile + docker-compose.yml for running as a service",
          "Docker setup includes health check, volume mounts for cache/config, env var documentation",
          "Environment variable reference doc listing all vars with defaults",
        ],
        files: [
          "NEW: docs/getting-started/client-configurations.md",
          "NEW: docs/getting-started/docker-deployment.md",
          "NEW: Dockerfile",
          "NEW: docker-compose.yml",
        ],
        acceptance: [
          "Each client has a tested configuration example that connects successfully",
          "`docker compose up` starts the server with HTTP transport",
          "Docker health check passes",
          "Env var reference covers all configuration options",
        ],
        verify: [
          "Follow Claude Code config example → connects and runs `search_code`",
          "Follow Agno config example → Python agent connects and calls tools",
          "`docker compose up` → server starts, `curl localhost:3100/health` → 200",
          "Stop and restart container → state preserved (volume mount)",
        ],
        llmNotes: "For Agno, the config example should use `MCPTools(transport='streamable-http', url='http://localhost:3100/mcp', headers={'Authorization': 'Bearer <token>'})`. For Claude Code, both `stdio` (existing) and `url`-based (new) config should be shown.",
      }),
    },
    {
      key: "6.3",
      title: "Integration test suite",
      priority: 3,
      labels: [epicLabelIds["Epic: DevEx"], phaseLabelIds["Phase 5: Polish"]],
      estimate: 5,
      dependsOn: ["3.1", "2.1", "1.3"],
      body: issueBody({
        overview: "Build an end-to-end integration test suite covering the full lifecycle: repo discovery, identity resolution, indexing, cross-repo search, HTTP transport, and data migration.",
        requirements: [
          "Test fixtures: create sample git repos with worktrees, multiple remotes, various languages",
          "Tests cover: worktree reconciliation, cross-repo search, HTTP transport + auth, branch-aware indexing, pattern detection, snapshot v1→v2→v3 migration",
          "Use a test Milvus instance (Docker or Milvus Lite)",
          "CI pipeline integration (GitHub Actions)",
          "Target: > 80% coverage on new code, all tests pass in < 5 minutes",
        ],
        files: [
          "NEW: packages/mcp/src/__tests__/integration/ directory",
          "NEW: packages/core/src/__tests__/integration/ directory",
          "NEW: .github/workflows/integration-tests.yml",
          "NEW: scripts/setup-test-fixtures.sh",
        ],
        acceptance: [
          "All integration tests pass locally",
          "All integration tests pass in CI (GitHub Actions)",
          "Coverage > 80% for packages/core/src/identity/ and packages/mcp/src/transports/",
          "Tests complete in < 5 minutes",
        ],
        verify: [
          "`pnpm test:integration` → all tests pass",
          "Push to branch → GitHub Actions runs integration tests → green",
          "Coverage report shows > 80% on target directories",
          "Tests include: create repo, create worktree, index both, verify same collection, search across repos, connect via HTTP, authenticate, rate limit triggers",
        ],
        llmNotes: "Use `jest` (already a dev dependency). For git fixtures, create temp directories with `fs.mkdtemp`, init repos with `child_process.execSync`. For Milvus, use Milvus Lite (embedded) or mock the vector DB interface. For HTTP tests, start the server in-process and use `fetch()`. Each test file should be self-contained with setup/teardown.",
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Linear Project Creator for General-Purpose Code Search MCP Server ===\n");

  if (DRY_RUN) {
    console.log("[DRY RUN] Would create the following:\n");
    const issues = buildIssues({}, {});
    console.log(`Project: General-Purpose Code Search MCP Server`);
    console.log(`Labels: ${EPIC_LABELS.map((l) => l.name).join(", ")}`);
    console.log(`Phase Labels: ${PHASE_LABELS.map((l) => l.name).join(", ")}`);
    console.log(`\nIssues (${issues.length}):\n`);
    for (const issue of issues) {
      console.log(`  [${issue.key}] ${issue.title}`);
      console.log(`    Priority: ${["", "Urgent", "High", "Medium", "Low"][issue.priority]} | Estimate: ${issue.estimate} pts`);
      console.log(`    Depends on: ${issue.dependsOn.length ? issue.dependsOn.join(", ") : "none"}`);
      console.log("");
    }
    return;
  }

  // 1. Resolve team and user
  console.log("Resolving team and user...");
  const team = await resolveTeam();
  const user = await resolveAssignee();
  console.log(`  Team: ${team.name} (${team.key})`);
  console.log(`  Assignee: ${user.displayName} (${user.email || "API key owner"})`);

  // 2. Get workflow states
  const states = await getWorkflowStates(team.id);
  const backlogState = states.find((s) => s.type === "backlog") || states.find((s) => s.name.toLowerCase() === "backlog");
  const todoState = states.find((s) => s.name.toLowerCase() === "todo") || backlogState;
  console.log(`  Default state: ${(todoState || backlogState || states[0]).name}`);

  // 3. Create project
  console.log("\nCreating project...");
  const project = await createProject(
    "General-Purpose Code Search MCP Server",
    `Network-accessible, multi-repo code search & intelligence MCP server. GitHub: ${REPO_URL}`,
    [team.id]
  );
  console.log(`  Project: ${project.name} (${project.url})`);

  // 4. Create labels
  console.log("\nCreating epic labels...");
  const epicLabelIds = {};
  for (const label of EPIC_LABELS) {
    const created = await createLabel(team.id, label.name, label.color, label.description);
    epicLabelIds[label.name] = created.id;
    console.log(`  ✓ ${label.name}`);
  }

  console.log("Creating phase labels...");
  const phaseLabelIds = {};
  for (const label of PHASE_LABELS) {
    const created = await createLabel(team.id, label.name, label.color, label.description);
    phaseLabelIds[label.name] = created.id;
    console.log(`  ✓ ${label.name}`);
  }

  // 5. Create issues
  console.log("\nCreating issues...");
  const issues = buildIssues(epicLabelIds, phaseLabelIds);
  const createdIssues = {};

  for (const issue of issues) {
    const stateId = (todoState || backlogState || states[0]).id;
    const created = await createIssue({
      teamId: team.id,
      title: `[${issue.key}] ${issue.title}`,
      description: issue.body,
      priority: issue.priority,
      stateId,
      assigneeId: user.id,
      labelIds: issue.labels.filter(Boolean),
      projectId: project.id,
      estimate: issue.estimate,
    });
    createdIssues[issue.key] = created;
    console.log(`  ✓ ${created.identifier}: ${issue.title}`);
  }

  // 6. Create dependency relations
  console.log("\nLinking dependencies...");
  let depCount = 0;
  for (const issue of issues) {
    for (const depKey of issue.dependsOn) {
      if (createdIssues[depKey] && createdIssues[issue.key]) {
        await createIssueRelation(createdIssues[depKey].id, createdIssues[issue.key].id, "blocks");
        depCount++;
      }
    }
  }
  console.log(`  ✓ ${depCount} dependency links created`);

  // 7. Summary
  console.log("\n=== Done! ===\n");
  console.log(`Project: ${project.url}`);
  console.log(`Issues created: ${Object.keys(createdIssues).length}`);
  console.log(`Dependencies linked: ${depCount}`);
  console.log(`\nAll issues assigned to: ${user.displayName}`);
  console.log(`\nIssue list:`);
  for (const [key, issue] of Object.entries(createdIssues)) {
    console.log(`  ${issue.identifier}: ${issue.url}`);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
