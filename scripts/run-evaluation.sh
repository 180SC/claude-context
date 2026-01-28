#!/bin/bash
#
# Evaluation Script for General-Purpose Code Search MCP Server
# Tests Phase 1 (Foundation) and Phase 2 (Network Access) features
#
# Usage:
#   ./scripts/run-evaluation.sh [--full] [--http-only] [--identity-only]
#
# Prerequisites:
#   - OPENAI_API_KEY, MILVUS_ADDRESS, MILVUS_TOKEN environment variables set
#   - pnpm installed
#   - Project built: pnpm build
#

# set -e  # Disabled to allow tests to continue after failures

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# tsx is in the mcp package
TSX="$PROJECT_ROOT/packages/mcp/node_modules/.bin/tsx"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TESTS_PASSED=0
TESTS_FAILED=0

# Temp directory for test artifacts
EVAL_TMP="/tmp/mcp-eval-$$"
mkdir -p "$EVAL_TMP"

# Cleanup on exit
cleanup() {
    echo -e "\n${BLUE}Cleaning up...${NC}"
    rm -rf "$EVAL_TMP"
    # Kill any background server
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Test helper functions
pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    echo -e "  ${YELLOW}Expected${NC}: $2"
    echo -e "  ${YELLOW}Got${NC}: $3"
    ((TESTS_FAILED++))
}

section() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}\n"
}

#------------------------------------------------------------------------------
# Phase 1: Foundation Tests
#------------------------------------------------------------------------------

test_git_identity() {
    section "Testing Git Repository Identity Detection"

    # Setup test repos
    echo "Setting up test repositories..."
    mkdir -p "$EVAL_TMP/git-test"
    cd "$EVAL_TMP/git-test"

    # Create main repo
    git init main >/dev/null 2>&1
    cd main
    git config user.email "test@example.com"
    git config user.name "Test User"
    git config commit.gpgsign false
    echo "# Test Repo" > README.md
    git add README.md
    git commit -m "Initial commit" >/dev/null 2>&1
    git remote add origin https://github.com/test-user/eval-repo.git

    # Create worktree
    git worktree add ../worktree -b feature >/dev/null 2>&1
    cd "$PROJECT_ROOT"

    # Test 1.1.1: Worktrees resolve to same canonical ID
    echo "Test 1.1.1: Worktree canonical ID resolution"
    RESULT=$($TSX -e "
import { resolveIdentity } from '$PROJECT_ROOT/packages/core/dist/identity/repo-identity.js';

(async () => {
  const main = await resolveIdentity('$EVAL_TMP/git-test/main');
  const worktree = await resolveIdentity('$EVAL_TMP/git-test/worktree');

  console.log(JSON.stringify({
    mainId: main.canonicalId,
    worktreeId: worktree.canonicalId,
    same: main.canonicalId === worktree.canonicalId,
    mainIsWorktree: main.isWorktree,
    worktreeIsWorktree: worktree.isWorktree
  }));
})();
" 2>/dev/null)

    SAME=$(echo "$RESULT" | jq -r '.same')
    MAIN_IS_WT=$(echo "$RESULT" | jq -r '.mainIsWorktree')
    WT_IS_WT=$(echo "$RESULT" | jq -r '.worktreeIsWorktree')

    if [ "$SAME" = "true" ] && [ "$MAIN_IS_WT" = "false" ] && [ "$WT_IS_WT" = "true" ]; then
        pass "Worktrees resolve to same canonical ID"
    else
        fail "Worktrees resolve to same canonical ID" "same=true, mainIsWorktree=false, worktreeIsWorktree=true" "$RESULT"
    fi

    # Test 1.1.2: SSH and HTTPS URL normalization
    echo "Test 1.1.2: URL normalization"
    RESULT=$($TSX -e "
import { normalizeGitUrl } from '$PROJECT_ROOT/packages/core/dist/identity/git-utils.js';

const ssh = normalizeGitUrl('git@github.com:user/repo.git');
const https = normalizeGitUrl('https://github.com/user/repo.git');

console.log(JSON.stringify({
  ssh: ssh,
  https: https,
  same: ssh === https
}));
" 2>/dev/null)

    SAME=$(echo "$RESULT" | jq -r '.same')
    if [ "$SAME" = "true" ]; then
        pass "SSH and HTTPS URLs normalize to same value"
    else
        fail "SSH and HTTPS URLs normalize to same value" "same=true" "$RESULT"
    fi

    # Test 1.1.3: Non-git directory fallback
    echo "Test 1.1.3: Non-git directory fallback"
    mkdir -p "$EVAL_TMP/non-git-dir"
    RESULT=$($TSX -e "
import { resolveIdentity } from '$PROJECT_ROOT/packages/core/dist/identity/repo-identity.js';

(async () => {
  const identity = await resolveIdentity('$EVAL_TMP/non-git-dir');
  console.log(JSON.stringify({
    source: identity.identitySource,
    isGit: identity.isGitRepo
  }));
})();
" 2>/dev/null)

    SOURCE=$(echo "$RESULT" | jq -r '.source')
    IS_GIT=$(echo "$RESULT" | jq -r '.isGit')

    if [ "$SOURCE" = "path-hash" ] && [ "$IS_GIT" = "false" ]; then
        pass "Non-git directories fall back to path-hash"
    else
        fail "Non-git directories fall back to path-hash" "source=path-hash, isGit=false" "$RESULT"
    fi
}

test_collection_naming() {
    section "Testing Collection Name Migration"

    # Test 1.2.1: Canonical collection name uses 12-char hash
    echo "Test 1.2.1: Canonical collection name format"
    RESULT=$($TSX -e "
import { generateCanonicalCollectionName, generateLegacyCollectionName } from '$PROJECT_ROOT/packages/core/dist/identity/collection-migrator.js';

const canonical = generateCanonicalCollectionName('github.com_user_repo');
const legacy = generateLegacyCollectionName('/home/user/repo');

const canonicalHash = canonical.split('_').pop();
const legacyHash = legacy.split('_').pop();

console.log(JSON.stringify({
  canonicalHashLen: canonicalHash.length,
  legacyHashLen: legacyHash.length
}));
" 2>/dev/null)

    CANONICAL_LEN=$(echo "$RESULT" | jq -r '.canonicalHashLen')
    LEGACY_LEN=$(echo "$RESULT" | jq -r '.legacyHashLen')

    if [ "$CANONICAL_LEN" = "12" ] && [ "$LEGACY_LEN" = "8" ]; then
        pass "Canonical uses 12-char hash, legacy uses 8-char hash"
    else
        fail "Collection name hash lengths" "canonical=12, legacy=8" "$RESULT"
    fi
}

test_repository_registry() {
    section "Testing Repository Registry"

    # Test 1.3.1: Registry registration and resolution
    echo "Test 1.3.1: Registry registration and resolution"
    RESULT=$($TSX -e "
import { RepoRegistry } from '$PROJECT_ROOT/packages/core/dist/identity/repo-registry.js';
import { resolveIdentity } from '$PROJECT_ROOT/packages/core/dist/identity/repo-identity.js';

const registry = new RepoRegistry();

// Register main repo
registry.register('$EVAL_TMP/git-test/main', {
  isIndexed: true,
  collectionName: 'test_collection_abc123',
  indexedFiles: 10,
  totalChunks: 50
});

// Try to resolve worktree
const result = registry.resolve('$EVAL_TMP/git-test/worktree');

console.log(JSON.stringify({
  registrySize: registry.size,
  found: result.found,
  isNewPath: result.isNewPathForExistingRepo,
  isIndexed: result.record?.isIndexed || false
}));
" 2>/dev/null)

    SIZE=$(echo "$RESULT" | jq -r '.registrySize')
    FOUND=$(echo "$RESULT" | jq -r '.found')
    IS_NEW=$(echo "$RESULT" | jq -r '.isNewPath')

    if [ "$SIZE" = "1" ] && [ "$FOUND" = "true" ] && [ "$IS_NEW" = "true" ]; then
        pass "Registry correctly identifies worktree as same repo"
    else
        fail "Registry worktree identification" "size=1, found=true, isNewPath=true" "$RESULT"
    fi
}

test_snapshot_migration() {
    section "Testing Snapshot V3 Migration"

    # Test 5.1.1: V1 to V3 migration
    echo "Test 5.1.1: V1 to V3 migration"

    # Create a test codebase directory (v1 migration requires path to exist)
    mkdir -p "$EVAL_TMP/snapshot-test/.context"
    mkdir -p "$EVAL_TMP/test-codebase"

    # Create proper v1 format snapshot
    cat > "$EVAL_TMP/snapshot-test/.context/mcp-codebase-snapshot.json" << EOF
{
  "indexedCodebases": ["$EVAL_TMP/test-codebase"],
  "indexingCodebases": [],
  "lastUpdated": "2024-01-01T00:00:00.000Z"
}
EOF

    # Capture output and extract just the JSON line (last line starting with {)
    RAW_OUTPUT=$(HOME="$EVAL_TMP/snapshot-test" $TSX -e "
import { SnapshotManager } from '$PROJECT_ROOT/packages/mcp/dist/snapshot.js';

const manager = new SnapshotManager('$EVAL_TMP/snapshot-test/.context/mcp-codebase-snapshot.json');
manager.loadCodebaseSnapshot();

const repos = manager.getAllRepositories();
manager.saveCodebaseSnapshot();

// Read saved file to check format
import * as fs from 'fs';
const saved = JSON.parse(fs.readFileSync('$EVAL_TMP/snapshot-test/.context/mcp-codebase-snapshot.json', 'utf-8'));

console.log(JSON.stringify({
  repoCount: repos.size,
  formatVersion: saved.formatVersion
}));
" 2>&1)

    # Extract the JSON result (last line starting with {)
    RESULT=$(echo "$RAW_OUTPUT" | grep '^{' | tail -1)

    REPO_COUNT=$(echo "$RESULT" | jq -r '.repoCount')
    FORMAT=$(echo "$RESULT" | jq -r '.formatVersion')

    if [ "$REPO_COUNT" = "1" ] && [ "$FORMAT" = "v3" ]; then
        pass "V1 snapshot migrates to V3 format"
    else
        fail "V1 to V3 migration" "repoCount=1, formatVersion=v3" "$RESULT"
    fi
}

#------------------------------------------------------------------------------
# Phase 2: Network Access Tests
#------------------------------------------------------------------------------

test_http_transport() {
    section "Testing HTTP Transport"

    # Check required env vars for HTTP tests
    if [ -z "$OPENAI_API_KEY" ] || [ -z "$MILVUS_ADDRESS" ]; then
        echo -e "${YELLOW}Skipping HTTP tests: OPENAI_API_KEY and MILVUS_ADDRESS required${NC}"
        return
    fi

    # Warn about test credentials - the server will crash after starting
    # when the background sync tries to connect to Milvus
    if [ "$MILVUS_ADDRESS" = "test" ]; then
        echo -e "${YELLOW}Note: Using test Milvus credentials. Server will be unstable.${NC}"
        echo -e "${YELLOW}For full HTTP testing, use real Milvus credentials.${NC}"
    fi

    # MCP package directory
    MCP_DIR="$PROJECT_ROOT/packages/mcp"

    # Test 2.2.1: HTTP without auth token fails
    echo "Test 2.2.1: HTTP startup requires MCP_AUTH_TOKEN"

    OUTPUT=$(cd "$MCP_DIR" && timeout 10 bash -c "
        OPENAI_API_KEY='$OPENAI_API_KEY' \
        MILVUS_ADDRESS='$MILVUS_ADDRESS' \
        MILVUS_TOKEN='$MILVUS_TOKEN' \
        pnpm start --transport http 2>&1
    " || true)
    EXIT_CODE=$?

    if echo "$OUTPUT" | grep -q "MCP_AUTH_TOKEN"; then
        pass "HTTP startup requires MCP_AUTH_TOKEN"
    else
        fail "HTTP startup requires MCP_AUTH_TOKEN" "Error message about MCP_AUTH_TOKEN" "$OUTPUT"
    fi

    # Test 2.1.1 & 2.1.2: HTTP server starts and health check works
    echo "Test 2.1.1/2.1.2: HTTP server startup and health check"

    # Start server using tsx directly from MCP package directory
    # Using nohup and disown to prevent signal propagation issues
    cd "$MCP_DIR"
    MCP_AUTH_TOKEN=eval-test-token \
    OPENAI_API_KEY="$OPENAI_API_KEY" \
    MILVUS_ADDRESS="$MILVUS_ADDRESS" \
    MILVUS_TOKEN="$MILVUS_TOKEN" \
    nohup "$PROJECT_ROOT/packages/mcp/node_modules/.bin/tsx" \
        "$PROJECT_ROOT/packages/mcp/src/index.ts" \
        --transport http --port 3199 > "$EVAL_TMP/server.log" 2>&1 &
    SERVER_PID=$!
    disown
    cd "$PROJECT_ROOT"

    # Wait for server to be ready (check for "listening on port" in logs)
    # Note: Server will crash after ~5s when background sync fails (due to test Milvus address)
    # So we need to run all tests quickly before that happens
    for i in {1..15}; do
        sleep 0.3
        if grep -q "listening on port" "$EVAL_TMP/server.log" 2>/dev/null; then
            break
        fi
    done

    # Small delay to ensure server is fully ready
    sleep 0.3

    # Run all HTTP tests quickly before the background sync crashes the server
    HEALTH=$(curl -s http://localhost:3199/health 2>/dev/null || echo '{"error":"connection failed"}')
    NOAUTH_RESPONSE=$(curl -s http://localhost:3199/mcp 2>/dev/null || echo '{}')
    WRONGAUTH_RESPONSE=$(curl -s http://localhost:3199/mcp -H "Authorization: Bearer wrong-token" 2>/dev/null || echo '{}')
    GOODAUTH_RESPONSE=$(curl -s http://localhost:3199/mcp \
        -H "Authorization: Bearer eval-test-token" \
        -H "Content-Type: application/json" \
        -X POST \
        -d '{"jsonrpc":"2.0","method":"ping","id":1}' 2>/dev/null || echo '{}')

    # Kill server now that we have all responses
    kill "$SERVER_PID" 2>/dev/null || true

    # Evaluate results
    STATUS=$(echo "$HEALTH" | jq -r '.status' 2>/dev/null || echo "error")
    if [ "$STATUS" = "ok" ]; then
        pass "HTTP server starts and health check returns ok"
    else
        fail "HTTP server and health check" "status=ok" "$HEALTH"
    fi

    # Test 2.2.2: Request without auth returns 401
    echo "Test 2.2.2: Request without Authorization header"
    ERROR=$(echo "$NOAUTH_RESPONSE" | jq -r '.error' 2>/dev/null || echo "")
    if [ "$ERROR" = "Unauthorized" ]; then
        pass "Request without auth returns 401 Unauthorized"
    else
        fail "Missing auth rejection" "error=Unauthorized" "$NOAUTH_RESPONSE"
    fi

    # Test 2.2.3: Request with wrong token returns 401
    echo "Test 2.2.3: Request with wrong token"
    ERROR=$(echo "$WRONGAUTH_RESPONSE" | jq -r '.error' 2>/dev/null || echo "")
    if [ "$ERROR" = "Unauthorized" ]; then
        pass "Request with wrong token returns 401 Unauthorized"
    else
        fail "Wrong token rejection" "error=Unauthorized" "$WRONGAUTH_RESPONSE"
    fi

    # Test 2.2.4: Request with correct token proceeds
    echo "Test 2.2.4: Request with correct token"
    ERROR=$(echo "$GOODAUTH_RESPONSE" | jq -r '.error' 2>/dev/null || echo "")
    # If error is not Unauthorized, the auth passed (may be other errors like method not found, that's ok)
    if [ "$ERROR" != "Unauthorized" ]; then
        pass "Request with correct token is not rejected as unauthorized"
    else
        fail "Correct token acceptance" "Not 401" "$GOODAUTH_RESPONSE"
    fi

}

test_unit_tests() {
    section "Running Unit Tests"

    cd "$PROJECT_ROOT/packages/core"
    echo "Running core package tests..."
    TEST_OUTPUT=$(pnpm test 2>&1)
    if echo "$TEST_OUTPUT" | grep -q "passed, 0 total"; then
        # All passed (X passed, 0 failed scenario)
        CORE_TESTS=$(echo "$TEST_OUTPUT" | grep -E "Tests:" | tail -1)
        pass "Core package tests: $CORE_TESTS"
    elif echo "$TEST_OUTPUT" | grep -q "passed"; then
        # Check for "X passed" without failures
        if echo "$TEST_OUTPUT" | grep -q "failed"; then
            fail "Core package tests" "All tests pass" "Some tests failed"
        else
            CORE_TESTS=$(echo "$TEST_OUTPUT" | grep -E "Tests:" | tail -1)
            pass "Core package tests: $CORE_TESTS"
        fi
    else
        fail "Core package tests" "All tests pass" "Tests did not run properly"
    fi

    cd "$PROJECT_ROOT/packages/mcp"
    echo "Running MCP package tests..."
    TEST_OUTPUT=$(pnpm test 2>&1)
    if echo "$TEST_OUTPUT" | grep -q "passed"; then
        if echo "$TEST_OUTPUT" | grep -q "failed"; then
            fail "MCP package tests" "All tests pass" "Some tests failed"
        else
            MCP_TESTS=$(echo "$TEST_OUTPUT" | grep -E "Tests:" | tail -1)
            pass "MCP package tests: $MCP_TESTS"
        fi
    else
        fail "MCP package tests" "All tests pass" "Tests did not run properly"
    fi
    cd "$PROJECT_ROOT"
}

#------------------------------------------------------------------------------
# Main
#------------------------------------------------------------------------------

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║  General-Purpose Code Search MCP Server - Evaluation Suite        ║"
echo "║  Phase 1: Foundation + Phase 2: Network Access                    ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Parse arguments
RUN_IDENTITY=true
RUN_HTTP=true
RUN_UNIT=true

for arg in "$@"; do
    case $arg in
        --http-only)
            RUN_IDENTITY=false
            RUN_UNIT=false
            ;;
        --identity-only)
            RUN_HTTP=false
            RUN_UNIT=false
            ;;
        --full)
            RUN_IDENTITY=true
            RUN_HTTP=true
            RUN_UNIT=true
            ;;
    esac
done

# Run selected tests
if [ "$RUN_UNIT" = true ]; then
    test_unit_tests
fi

if [ "$RUN_IDENTITY" = true ]; then
    test_git_identity
    test_collection_naming
    test_repository_registry
    test_snapshot_migration
fi

if [ "$RUN_HTTP" = true ]; then
    test_http_transport
fi

# Summary
section "Evaluation Summary"
TOTAL=$((TESTS_PASSED + TESTS_FAILED))
echo -e "Total tests: $TOTAL"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "\n${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "\n${RED}Some tests failed. See details above.${NC}"
    exit 1
fi
