# EVAL-1: Validate Phase 1 & 2 Feature Implementation

## Ticket Summary

| Field | Value |
|-------|-------|
| **Key** | EVAL-1 |
| **Title** | Validate Phase 1 (Foundation) and Phase 2 (Network) Implementation |
| **Priority** | High |
| **Epic** | Epic: DevEx |
| **Phase** | Phase 2: Network |
| **Estimate** | 2 points |
| **Depends On** | 2.2 (Authentication & rate limiting) |

---

## What Was Built

### Phase 1: Foundation (4 tickets completed)

| Ticket | Feature | Description |
|--------|---------|-------------|
| **1.1** | Git Repository Identity | Detects canonical identity for any git repo, including worktrees, clones, and forks |
| **1.2** | Collection Name Migration | New 12-char hash naming for Milvus collections (backward compatible with 8-char legacy) |
| **1.3** | Repository Registry | In-memory registry that maps paths to canonical IDs, detects duplicates |
| **5.1** | Snapshot V3 Format | New snapshot format that groups worktrees under single canonical repo identity |

### Phase 2: Network Access (2 tickets completed)

| Ticket | Feature | Description |
|--------|---------|-------------|
| **2.1** | HTTP Transport | Streamable HTTP transport layer using MCP SDK's StreamableHTTPServerTransport |
| **2.2** | Auth & Rate Limiting | Bearer token authentication + sliding window rate limiter (60 req/min default) |

---

## Prerequisites

### 1. System Requirements

```bash
# Check Node.js version (requires 20+)
node --version  # Should show v20.x or higher

# Check pnpm is installed
pnpm --version  # Should show 8.x or higher
```

### 2. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/180SC/claude-context.git
cd claude-context

# Checkout the feature branch
git checkout claude/code-search-mcp-server-y10ns

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### 3. Environment Variables

Create a `.env` file or export these variables:

```bash
# Required for full testing (use real credentials)
export OPENAI_API_KEY="sk-your-openai-key"
export MILVUS_ADDRESS="https://your-instance.cloud.zilliz.com"
export MILVUS_TOKEN="your-zilliz-token"

# For HTTP transport testing
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
```

**Note:** For Phase 1 tests only, you can use dummy values:
```bash
export OPENAI_API_KEY="test"
export MILVUS_ADDRESS="test"
```

---

## Quick Evaluation (Automated Script)

Run the automated evaluation script:

```bash
# Phase 1 Foundation tests only (no real credentials needed)
OPENAI_API_KEY=test MILVUS_ADDRESS=test ./scripts/run-evaluation.sh --identity-only

# Full evaluation (requires real Milvus credentials)
./scripts/run-evaluation.sh --full
```

**Expected Output for Phase 1:**
```
✓ PASS: Worktrees resolve to same canonical ID
✓ PASS: SSH and HTTPS URLs normalize to same value
✓ PASS: Non-git directories fall back to path-hash
✓ PASS: Canonical uses 12-char hash, legacy uses 8-char hash
✓ PASS: Registry correctly identifies worktree as same repo
✓ PASS: V1 snapshot migrates to V3 format

Total tests: 6
Passed: 6
Failed: 0

All tests passed!
```

---

## Step-by-Step Manual Evaluation

### Step 1: Run Unit Tests (5 minutes)

```bash
# Run core package tests (79 tests)
cd packages/core && pnpm test
```

**Expected Output:**
```
PASS src/identity/__tests__/repo-identity.test.ts (37 tests)
PASS src/identity/__tests__/collection-migrator.test.ts (22 tests)
PASS src/identity/__tests__/repo-registry.test.ts (20 tests)

Test Suites: 3 passed, 3 total
Tests:       79 passed, 79 total
```

```bash
# Run MCP package tests (11 tests)
cd ../mcp && pnpm test
```

**Expected Output:**
```
PASS src/__tests__/snapshot-v3.test.ts (11 tests)

Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
```

---

### Step 2: Test Git Identity Detection (5 minutes)

This validates that worktrees, clones, and different URL formats all resolve to the same canonical ID.

```bash
# Create test repositories
mkdir -p /tmp/eval-test && cd /tmp/eval-test

# Create main repo with a remote
git init main && cd main
git config user.email "test@test.com"
git config user.name "Test User"
git config commit.gpgsign false
echo "# Test Repo" > README.md
git add README.md && git commit -m "Initial commit"
git remote add origin https://github.com/test-user/eval-repo.git

# Create a worktree (same repo, different path)
git worktree add ../worktree -b feature

# Go back to project
cd /home/user/claude-context
```

**Test: Worktrees resolve to same ID**

```bash
pnpm exec tsx -e "
import { resolveIdentity } from './packages/core/dist/identity/repo-identity.js';

const main = await resolveIdentity('/tmp/eval-test/main');
const worktree = await resolveIdentity('/tmp/eval-test/worktree');

console.log('Main repo:');
console.log('  Path:', main.repoPath);
console.log('  Canonical ID:', main.canonicalId);
console.log('  Is worktree:', main.isWorktree);

console.log('');
console.log('Worktree:');
console.log('  Path:', worktree.repoPath);
console.log('  Canonical ID:', worktree.canonicalId);
console.log('  Is worktree:', worktree.isWorktree);

console.log('');
console.log('✓ Same canonical ID:', main.canonicalId === worktree.canonicalId);
"
```

**Expected Output:**
```
Main repo:
  Path: /tmp/eval-test/main
  Canonical ID: github.com_test-user_eval-repo
  Is worktree: false

Worktree:
  Path: /tmp/eval-test/worktree
  Canonical ID: github.com_test-user_eval-repo
  Is worktree: true

✓ Same canonical ID: true
```

**Test: URL Normalization (SSH vs HTTPS)**

```bash
pnpm exec tsx -e "
import { normalizeGitUrl } from './packages/core/dist/identity/git-utils.js';

const ssh = 'git@github.com:user/repo.git';
const https = 'https://github.com/user/repo.git';

console.log('SSH URL:  ', ssh);
console.log('Normalized:', normalizeGitUrl(ssh));
console.log('');
console.log('HTTPS URL:', https);
console.log('Normalized:', normalizeGitUrl(https));
console.log('');
console.log('✓ Same result:', normalizeGitUrl(ssh) === normalizeGitUrl(https));
"
```

**Expected Output:**
```
SSH URL:   git@github.com:user/repo.git
Normalized: github.com/user/repo

HTTPS URL: https://github.com/user/repo.git
Normalized: github.com/user/repo

✓ Same result: true
```

---

### Step 3: Test Collection Naming (2 minutes)

Validates the new 12-character hash format for Milvus collections.

```bash
pnpm exec tsx -e "
import {
  generateCanonicalCollectionName,
  generateLegacyCollectionName
} from './packages/core/dist/identity/collection-migrator.js';

const canonicalId = 'github.com_user_repo';
const legacyPath = '/home/user/my-project';

const canonical = generateCanonicalCollectionName(canonicalId);
const legacy = generateLegacyCollectionName(legacyPath);

console.log('Canonical ID:', canonicalId);
console.log('  Collection name:', canonical);
console.log('  Hash length:', canonical.split('_').pop().length, '(should be 12)');
console.log('');
console.log('Legacy path:', legacyPath);
console.log('  Collection name:', legacy);
console.log('  Hash length:', legacy.split('_').pop().length, '(should be 8)');
"
```

**Expected Output:**
```
Canonical ID: github.com_user_repo
  Collection name: codebase_xxxxxxxxxxxx
  Hash length: 12 (should be 12)

Legacy path: /home/user/my-project
  Collection name: codebase_xxxxxxxx
  Hash length: 8 (should be 8)
```

---

### Step 4: Test Repository Registry (3 minutes)

Validates that the registry detects when different paths point to the same repo.

```bash
pnpm exec tsx -e "
import { RepoRegistry } from './packages/core/dist/identity/repo-registry.js';

const registry = new RepoRegistry();

// Register main repo
console.log('1. Registering main repo at /tmp/eval-test/main...');
registry.register('/tmp/eval-test/main', {
  isIndexed: true,
  collectionName: 'codebase_abc123def456',
  indexedFiles: 100,
  totalChunks: 500
});
console.log('   Registry size:', registry.size);

// Try to resolve worktree (should find existing repo)
console.log('');
console.log('2. Resolving worktree at /tmp/eval-test/worktree...');
const result = registry.resolve('/tmp/eval-test/worktree');
console.log('   Found:', result.found);
console.log('   Is new path for existing repo:', result.isNewPathForExistingRepo);
console.log('   Existing collection:', result.record?.collectionName);

// Registry should still have size 1 (not 2)
console.log('');
console.log('3. Final registry size:', registry.size, '(should be 1, not 2)');
console.log('');
console.log('✓ Registry correctly identifies worktree as same repo');
"
```

**Expected Output:**
```
1. Registering main repo at /tmp/eval-test/main...
   Registry size: 1

2. Resolving worktree at /tmp/eval-test/worktree...
   Found: true
   Is new path for existing repo: true
   Existing collection: codebase_abc123def456

3. Final registry size: 1 (should be 1, not 2)

✓ Registry correctly identifies worktree as same repo
```

---

### Step 5: Test Snapshot V3 Migration (3 minutes)

Validates that old snapshot formats migrate to V3.

```bash
# Create a V1 format snapshot
mkdir -p /tmp/snapshot-test/.context
cat > /tmp/snapshot-test/.context/mcp-codebase-snapshot.json << 'EOF'
{
  "indexedCodebases": ["/tmp/eval-test/main"],
  "indexingCodebases": [],
  "lastUpdated": "2024-01-01T00:00:00.000Z"
}
EOF

echo "Created V1 snapshot:"
cat /tmp/snapshot-test/.context/mcp-codebase-snapshot.json
echo ""
```

```bash
# Load and migrate the snapshot
HOME=/tmp/snapshot-test pnpm exec tsx -e "
import { SnapshotManager } from './packages/mcp/dist/snapshot.js';
import * as fs from 'fs';

const snapshotPath = '/tmp/snapshot-test/.context/mcp-codebase-snapshot.json';
const manager = new SnapshotManager(snapshotPath);

console.log('Loading V1 snapshot...');
manager.loadCodebaseSnapshot();

console.log('Saving (triggers migration to V3)...');
manager.saveCodebaseSnapshot();

const saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
console.log('');
console.log('Migrated snapshot:');
console.log(JSON.stringify(saved, null, 2));
console.log('');
console.log('✓ Format version:', saved.formatVersion);
console.log('✓ Has repositories object:', typeof saved.repositories === 'object');
" 2>&1 | grep -v "SNAPSHOT-DEBUG"
```

**Expected Output:**
```
Loading V1 snapshot...
Saving (triggers migration to V3)...

Migrated snapshot:
{
  "formatVersion": "v3",
  "repositories": {
    "github.com_test-user_eval-repo": {
      ...
    }
  },
  "lastUpdated": "..."
}

✓ Format version: v3
✓ Has repositories object: true
```

---

### Step 6: Test HTTP Transport (5 minutes)

**Requires real credentials for stable testing. With test credentials, the server will crash after ~5 seconds.**

**Test: Server requires MCP_AUTH_TOKEN**

```bash
cd packages/mcp
timeout 5 pnpm start --transport http 2>&1 || true
```

**Expected Output:**
```
[AUTH] ERROR: MCP_AUTH_TOKEN environment variable is required when using HTTP transport.
[AUTH] Set MCP_AUTH_TOKEN to a secure random value before starting the server.
```

**Test: Server starts with token and responds to health check**

```bash
# Start server in background
MCP_AUTH_TOKEN=test-token-12345 \
OPENAI_API_KEY=$OPENAI_API_KEY \
MILVUS_ADDRESS=$MILVUS_ADDRESS \
MILVUS_TOKEN=$MILVUS_TOKEN \
pnpm start --transport http --port 3100 &
SERVER_PID=$!

# Wait for server to start
sleep 5

# Test health endpoint (no auth required)
echo "Health check:"
curl -s http://localhost:3100/health | jq .

# Test auth rejection (no token)
echo ""
echo "Without auth token:"
curl -s http://localhost:3100/mcp | jq .

# Test auth rejection (wrong token)
echo ""
echo "With wrong token:"
curl -s http://localhost:3100/mcp -H "Authorization: Bearer wrong-token" | jq .

# Test auth acceptance (correct token)
echo ""
echo "With correct token:"
curl -s http://localhost:3100/mcp \
  -H "Authorization: Bearer test-token-12345" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":1}' | jq .

# Cleanup
kill $SERVER_PID 2>/dev/null
```

**Expected Output:**
```
Health check:
{
  "status": "ok",
  "version": "1.0.0",
  "transport": "http",
  "uptime": 5,
  "activeSessions": 0
}

Without auth token:
{
  "error": "Unauthorized",
  "message": "Authorization header required"
}

With wrong token:
{
  "error": "Unauthorized",
  "message": "Invalid token"
}

With correct token:
{
  "jsonrpc": "2.0",
  "result": { ... },
  "id": 1
}
```

---

### Step 7: Test Docker Deployment (Optional, 10 minutes)

```bash
# Build Docker image
docker build -t context-mcp-server -f packages/mcp/Dockerfile .

# Run with docker-compose (includes local Milvus)
docker-compose up -d

# Wait for services to start
sleep 30

# Check health
curl http://localhost:3000/health

# Cleanup
docker-compose down
```

---

## Evaluation Checklist

### Phase 1: Foundation ✓

| # | Test | Command | Expected | Pass? |
|---|------|---------|----------|-------|
| 1.1.1 | Worktrees same ID | `resolveIdentity` on main + worktree | Same canonicalId | ☐ |
| 1.1.2 | URL normalization | `normalizeGitUrl` SSH vs HTTPS | Same output | ☐ |
| 1.1.3 | Non-git fallback | `resolveIdentity` on non-git dir | identitySource='path-hash' | ☐ |
| 1.2.1 | Canonical hash | `generateCanonicalCollectionName` | 12-char hash | ☐ |
| 1.2.2 | Legacy hash | `generateLegacyCollectionName` | 8-char hash | ☐ |
| 1.3.1 | Registry register | `registry.register()` | Entry created | ☐ |
| 1.3.2 | Registry detect | `registry.resolve()` on worktree | found=true, isNewPath=true | ☐ |
| 5.1.1 | V1 migration | Load V1 snapshot | Converts to V3 | ☐ |
| INT-1 | Core tests | `pnpm test` in packages/core | 79 tests pass | ☐ |
| INT-2 | MCP tests | `pnpm test` in packages/mcp | 11 tests pass | ☐ |

### Phase 2: Network Access ✓

| # | Test | Command | Expected | Pass? |
|---|------|---------|----------|-------|
| 2.1.1 | HTTP startup | `--transport http` | Listens on port | ☐ |
| 2.1.2 | Health endpoint | `GET /health` | 200 + JSON status | ☐ |
| 2.2.1 | Token required | Start without MCP_AUTH_TOKEN | Exit code 2 | ☐ |
| 2.2.2 | No auth header | Request without Authorization | 401 Unauthorized | ☐ |
| 2.2.3 | Wrong token | `Authorization: Bearer wrong` | 401 Unauthorized | ☐ |
| 2.2.4 | Correct token | `Authorization: Bearer correct` | Request proceeds | ☐ |
| 2.2.5 | Rate limiting | 61+ requests in 1 min | 429 Too Many Requests | ☐ |

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `packages/core/src/identity/repo-identity.ts` | Git repository identity detection |
| `packages/core/src/identity/git-utils.ts` | URL normalization, worktree detection |
| `packages/core/src/identity/collection-migrator.ts` | Collection name generation |
| `packages/core/src/identity/repo-registry.ts` | Path-to-identity registry |
| `packages/mcp/src/snapshot.ts` | Snapshot V3 format and migration |
| `packages/mcp/src/transports/http-transport.ts` | HTTP transport layer |
| `packages/mcp/src/middleware/auth.ts` | Bearer token authentication |
| `packages/mcp/src/middleware/rate-limiter.ts` | Sliding window rate limiter |
| `packages/mcp/src/index.ts` | CLI entry point with transport modes |

---

## Cleanup

```bash
# Remove test artifacts
rm -rf /tmp/eval-test /tmp/snapshot-test

# Stop any running servers
pkill -f "tsx src/index.ts" 2>/dev/null || true
```

---

_Last updated: 2024-01-28_
_Branch: claude/code-search-mcp-server-y10ns_
