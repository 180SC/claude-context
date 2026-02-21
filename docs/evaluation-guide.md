# Evaluation Guide: General-Purpose Code Search MCP Server

This guide provides step-by-step instructions for evaluating the implemented features of the General-Purpose Code Search MCP Server. It covers Phase 1 (Foundation) and Phase 2 (Network Access) features.

## Prerequisites

### Required Environment Variables

```bash
# Required for all modes
export OPENAI_API_KEY="your-openai-api-key"
export MILVUS_ADDRESS="your-milvus-address"
export MILVUS_TOKEN="your-milvus-token"

# Required for HTTP transport mode
export MCP_AUTH_TOKEN="your-secure-token"

# Optional
export MCP_PORT="3100"           # HTTP server port (default: 3100)
export MCP_RATE_LIMIT="60"       # Requests per minute (default: 60)
```

### Build the Project

```bash
cd /home/user/claude-context
pnpm install
pnpm build
```

---

## Phase 1: Foundation Features

### 1.1 Git Repository Identity Detection

**Purpose:** Verify that the system correctly identifies repositories by their canonical identity rather than filesystem path.

#### Test Case 1.1.1: Same Repository, Different Paths (Worktrees)

```bash
# Create a test repository
mkdir -p /tmp/eval-test
cd /tmp/eval-test
git init main-repo
cd main-repo
git config user.email "test@example.com"
git config user.name "Test User"
echo "# Test Repo" > README.md
git add README.md
git commit -m "Initial commit"
git remote add origin https://github.com/test-user/eval-repo.git

# Create a worktree
git worktree add ../worktree-repo -b feature-branch

# Verify both paths resolve to the same canonical ID
cd /home/user/claude-context
pnpm exec tsx -e "
import { resolveIdentity } from './packages/core/src/identity/repo-identity.js';

const main = await resolveIdentity('/tmp/eval-test/main-repo');
const worktree = await resolveIdentity('/tmp/eval-test/worktree-repo');

console.log('Main repo ID:', main.canonicalId);
console.log('Worktree ID:', worktree.canonicalId);
console.log('Same identity:', main.canonicalId === worktree.canonicalId);
console.log('Main is worktree:', main.isWorktree);
console.log('Worktree is worktree:', worktree.isWorktree);
"
```

**Expected Result:**
- Both paths should resolve to the same `canonicalId`
- `main.isWorktree` should be `false`
- `worktree.isWorktree` should be `true`

#### Test Case 1.1.2: SSH vs HTTPS Remote Normalization

```bash
pnpm exec tsx -e "
import { normalizeGitUrl } from './packages/core/src/identity/git-utils.js';

const ssh = normalizeGitUrl('git@github.com:user/repo.git');
const https = normalizeGitUrl('https://github.com/user/repo.git');

console.log('SSH normalized:', ssh);
console.log('HTTPS normalized:', https);
console.log('Same result:', ssh === https);
"
```

**Expected Result:** Both URLs should normalize to the same value.

#### Test Case 1.1.3: Non-Git Directory Fallback

```bash
mkdir -p /tmp/eval-test/non-git-dir
pnpm exec tsx -e "
import { resolveIdentity } from './packages/core/src/identity/repo-identity.js';

const identity = await resolveIdentity('/tmp/eval-test/non-git-dir');
console.log('Identity source:', identity.identitySource);
console.log('Is git repo:', identity.isGitRepo);
console.log('Canonical ID:', identity.canonicalId);
"
```

**Expected Result:**
- `identitySource` should be `'path-hash'`
- `isGitRepo` should be `false`

---

### 1.2 Collection Name Migration

**Purpose:** Verify that collection naming uses canonical IDs and legacy collections are handled correctly.

#### Test Case 1.2.1: Canonical Collection Name Generation

```bash
pnpm exec tsx -e "
import { generateCanonicalCollectionName, generateLegacyCollectionName } from './packages/core/src/identity/collection-migrator.js';

const canonicalId = 'github.com_user_repo';
const path = '/home/user/code/repo';

const canonical = generateCanonicalCollectionName(canonicalId);
const legacy = generateLegacyCollectionName(path);

console.log('Canonical name:', canonical);
console.log('Legacy name:', legacy);
console.log('Canonical hash length:', canonical.split('_').pop().length);
console.log('Legacy hash length:', legacy.split('_').pop().length);
"
```

**Expected Result:**
- Canonical name should use 12-character hash
- Legacy name should use 8-character hash

---

### 1.3 Repository Registry

**Purpose:** Verify that the registry correctly tracks repositories and prevents duplicate indexing.

#### Test Case 1.3.1: Registry Registration and Resolution

```bash
pnpm exec tsx -e "
import { RepoRegistry } from './packages/core/src/identity/repo-registry.js';
import { resolveIdentity } from './packages/core/src/identity/repo-identity.js';

const registry = new RepoRegistry();

// Register the main repo
const identity = await resolveIdentity('/tmp/eval-test/main-repo');
registry.register('/tmp/eval-test/main-repo', {
  isIndexed: true,
  collectionName: 'test_collection_abc123',
  indexedFiles: 10,
  totalChunks: 50
});

console.log('Registry size:', registry.size);
console.log('Indexed repos:', registry.listIndexed().length);

// Try to resolve the worktree
const result = registry.resolve('/tmp/eval-test/worktree-repo');
console.log('Worktree found in registry:', result.found);
console.log('Is new path for existing repo:', result.isNewPathForExistingRepo);
console.log('Already indexed:', result.record?.isIndexed);
"
```

**Expected Result:**
- Registry should have 1 entry
- Worktree should resolve to the same repository
- `isNewPathForExistingRepo` should be `true`

---

### 5.1 Snapshot Format V3

**Purpose:** Verify that v1/v2 snapshots migrate correctly to v3 format.

#### Test Case 5.1.1: V1 to V3 Migration

```bash
# Create a v1 snapshot
mkdir -p /tmp/eval-snapshot/.context
cat > /tmp/eval-snapshot/.context/mcp-codebase-snapshot.json << 'EOF'
{
  "codebases": [
    {
      "path": "/home/user/project",
      "status": "indexed",
      "indexedFiles": 100,
      "totalChunks": 500,
      "lastIndexed": "2024-01-01T00:00:00.000Z"
    }
  ]
}
EOF

HOME=/tmp/eval-snapshot pnpm exec tsx -e "
import { SnapshotManager } from './packages/mcp/src/snapshot.js';

const manager = new SnapshotManager('/tmp/eval-snapshot/.context/mcp-codebase-snapshot.json');
manager.loadCodebaseSnapshot();

const repos = manager.getAllRepositories();
console.log('Migrated repositories:', repos.size);

for (const [id, repo] of repos) {
  console.log('  Canonical ID:', id);
  console.log('  Known paths:', repo.knownPaths);
  console.log('  Display name:', repo.displayName);
}

manager.saveCodebaseSnapshot();
console.log('\\nSnapshot saved in v3 format');
"

# Verify the saved format
cat /tmp/eval-snapshot/.context/mcp-codebase-snapshot.json | head -20
```

**Expected Result:**
- Snapshot should migrate to v3 format
- Repository should be keyed by canonical ID
- Original path should be in `knownPaths`

---

## Phase 2: Network Access Features

### 2.1 Streamable HTTP Transport

**Purpose:** Verify that the HTTP transport layer works correctly.

#### Test Case 2.1.1: Start HTTP Server

```bash
# Start the server in HTTP mode (requires MCP_AUTH_TOKEN)
MCP_AUTH_TOKEN=eval-test-token \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
timeout 10 pnpm start --transport http --port 3100 2>&1 || true
```

**Expected Result:**
- Server should start on port 3100
- Should see "MCP HTTP server listening on port 3100"

#### Test Case 2.1.2: Health Check Endpoint

```bash
# Start server in background
MCP_AUTH_TOKEN=eval-test-token \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
pnpm start --transport http --port 3100 &
SERVER_PID=$!
sleep 5

# Test health endpoint (no auth required)
curl -s http://localhost:3100/health | jq .

kill $SERVER_PID 2>/dev/null
```

**Expected Result:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "transport": "http",
  "uptime": 1,
  "activeSessions": 0
}
```

#### Test Case 2.1.3: Dual Transport Mode

```bash
MCP_AUTH_TOKEN=eval-test-token \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
timeout 10 pnpm start --transport both --port 3100 2>&1 || true
```

**Expected Result:**
- Should see "Mode: both"
- Should start both HTTP and stdio transports

---

### 2.2 Authentication & Rate Limiting

**Purpose:** Verify that HTTP transport is secured with bearer token authentication and rate limiting.

#### Test Case 2.2.1: Missing Auth Token Startup Failure

```bash
# Try to start HTTP server without MCP_AUTH_TOKEN
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
timeout 10 pnpm start --transport http 2>&1
echo "Exit code: $?"
```

**Expected Result:**
- Should fail with exit code 2
- Should show error about missing MCP_AUTH_TOKEN

#### Test Case 2.2.2: Authentication Flow

```bash
# Start server
MCP_AUTH_TOKEN=eval-test-token \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
pnpm start --transport http --port 3100 &
SERVER_PID=$!
sleep 5

echo "=== Test: No Authorization header ==="
curl -s http://localhost:3100/mcp | jq .

echo ""
echo "=== Test: Wrong token ==="
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer wrong-token" | jq .

echo ""
echo "=== Test: Correct token ==="
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer eval-test-token" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"}},"id":1}' | jq .

kill $SERVER_PID 2>/dev/null
```

**Expected Result:**
- No auth header: 401 Unauthorized
- Wrong token: 401 Unauthorized
- Correct token: Proceeds to MCP protocol handling

#### Test Case 2.2.3: Rate Limiting

```bash
# Start server with low rate limit for testing
MCP_AUTH_TOKEN=eval-test-token \
MCP_RATE_LIMIT=5 \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
pnpm start --transport http --port 3100 &
SERVER_PID=$!
sleep 5

# Send requests rapidly to trigger rate limit
for i in {1..10}; do
  echo "Request $i:"
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/mcp \
    -H "Authorization: Bearer eval-test-token" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"jsonrpc":"2.0","method":"ping","id":'$i'}'
done

kill $SERVER_PID 2>/dev/null
```

**Expected Result:**
- First 5 requests: 200 or protocol response
- Requests 6+: 429 Too Many Requests

#### Test Case 2.2.4: stdio Transport Without Auth

```bash
# stdio mode should work without MCP_AUTH_TOKEN
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
timeout 5 pnpm start --transport stdio 2>&1 || true
```

**Expected Result:**
- Should start successfully without requiring MCP_AUTH_TOKEN

---

## Practical End-to-End Test Scenarios

### Scenario A: Worktree Deduplication

This tests the main user story: "worktrees of the same repo should share an index."

```bash
#!/bin/bash
set -e

# Setup
echo "=== Setting up test repositories ==="
rm -rf /tmp/e2e-test
mkdir -p /tmp/e2e-test
cd /tmp/e2e-test

# Create main repo
git init main-repo
cd main-repo
git config user.email "test@example.com"
git config user.name "Test"
echo "function hello() { return 'world'; }" > index.js
git add index.js
git commit -m "Initial"
git remote add origin https://github.com/test/worktree-test.git

# Create worktree
git worktree add ../feature-worktree -b feature

# Start server
cd /home/user/claude-context/packages/mcp
MCP_AUTH_TOKEN=test \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
pnpm start --transport http --port 3100 &
SERVER_PID=$!
sleep 5

# Index main repo (would need MCP client to fully test)
echo "=== Server running, manual testing can proceed ==="
echo "Main repo: /tmp/e2e-test/main-repo"
echo "Worktree: /tmp/e2e-test/feature-worktree"
echo ""
echo "Expected behavior:"
echo "1. Indexing main-repo should create an index"
echo "2. Indexing feature-worktree should detect it's the same repo"
echo "3. Both paths should share the same collection"

# Cleanup
read -p "Press Enter to stop server..."
kill $SERVER_PID 2>/dev/null
```

### Scenario B: HTTP Client Connection

This tests connecting from a remote MCP client.

```bash
#!/bin/bash

# Start server
MCP_AUTH_TOKEN=secure-token-123 \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
pnpm start --transport http --port 3100 &
SERVER_PID=$!
sleep 5

# Initialize MCP session
echo "=== Initialize MCP Session ==="
RESPONSE=$(curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer secure-token-123" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "eval-client",
        "version": "1.0"
      }
    },
    "id": 1
  }')

echo "$RESPONSE" | jq .

# Extract session ID from response headers would be needed for full flow
# This demonstrates the basic connectivity

kill $SERVER_PID 2>/dev/null
```

---

## Verification Checklist

### Phase 1: Foundation

| Feature | Test Case | Status |
|---------|-----------|--------|
| Git Identity Detection | 1.1.1 Worktrees same ID | |
| Git Identity Detection | 1.1.2 SSH/HTTPS normalization | |
| Git Identity Detection | 1.1.3 Non-git fallback | |
| Collection Migration | 1.2.1 Canonical naming | |
| Repository Registry | 1.3.1 Registration & resolution | |
| Snapshot V3 | 5.1.1 V1 to V3 migration | |

### Phase 2: Network Access

| Feature | Test Case | Status |
|---------|-----------|--------|
| HTTP Transport | 2.1.1 Server startup | |
| HTTP Transport | 2.1.2 Health endpoint | |
| HTTP Transport | 2.1.3 Dual mode | |
| Authentication | 2.2.1 Missing token fails | |
| Authentication | 2.2.2 Token validation | |
| Rate Limiting | 2.2.3 Rate limit enforced | |
| stdio | 2.2.4 No auth required | |

### Phase 3: Intelligence

| Feature | Test Case | Status |
|---------|-----------|--------|
| Cross-repo Search | 3.1.1 search_all basic query | |
| Cross-repo Search | 3.1.2 search_all with repos filter | |
| Cross-repo Search | 3.1.3 search_all with extension filter | |
| Cross-repo Search | 3.1.4 search_all timeout handling | |

---

## Phase 3: Intelligence Features

### 3.1 Cross-Repository Search (search_all)

**Purpose:** Verify that the system can search across ALL indexed repositories simultaneously.

#### Test Case 3.1.1: Basic Cross-Repository Query

```bash
# Requires multiple repositories to be indexed first
# Use the MCP client to test search_all tool

# Example curl test (requires valid session):
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_all",
      "arguments": {
        "query": "authentication implementation",
        "limit": 20
      }
    },
    "id": 1
  }'
```

**Expected Result:**
- Returns results from all indexed repositories
- Each result includes `repoName` and `repoCanonicalId`
- Results are sorted by normalized score (descending)
- Summary shows distribution of results by repository

#### Test Case 3.1.2: Filtered Cross-Repository Query

```bash
# Search only in specific repositories
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_all",
      "arguments": {
        "query": "error handling",
        "limit": 10,
        "repos": ["myproject", "otherproject"]
      }
    },
    "id": 1
  }'
```

**Expected Result:**
- Only returns results from filtered repositories
- Other indexed repositories are not queried

#### Test Case 3.1.3: Extension Filter

```bash
# Search only in TypeScript files across all repos
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_all",
      "arguments": {
        "query": "API endpoints",
        "extensionFilter": [".ts", ".tsx"]
      }
    },
    "id": 1
  }'
```

**Expected Result:**
- Only returns results from .ts and .tsx files
- Extension filter is applied per-collection

#### Test Case 3.1.4: Timeout Handling

The search_all tool has built-in timeout handling:
- 5 second timeout per collection
- 15 second total timeout

To test timeout handling, index a very large repository and verify:
- Slow collections are skipped after 5 seconds
- Total search completes within 15 seconds
- Results from fast collections are still returned

---

## Troubleshooting

### Common Issues

1. **"OPENAI_API_KEY is required"**
   - Ensure OPENAI_API_KEY is exported in your shell

2. **"MCP_AUTH_TOKEN environment variable is required"**
   - Set MCP_AUTH_TOKEN when using `--transport http` or `--transport both`

3. **"Port 3100 is already in use"**
   - Kill any existing process on port 3100: `lsof -ti:3100 | xargs kill`

4. **Git worktree tests fail**
   - Ensure git user.email and user.name are configured
   - Check that /tmp has write permissions

### Logs

Server logs are written to stderr. To capture:
```bash
pnpm start --transport http 2>&1 | tee server.log
```

Look for:
- `[HTTP]` - HTTP transport messages
- `[AUDIT]` - Authentication and request logging
- `[REGISTRY]` - Repository registry operations
- `[SNAPSHOT-DEBUG]` - Snapshot loading/saving

---

## Next Steps

After completing evaluation:
1. Document any issues found
2. Note performance observations
3. Test with real-world repositories
4. Validate with actual MCP clients (Claude Code, etc.)
