# Evaluation Ticket: Phase 1 & 2 Implementation Verification

## Ticket Details

| Field | Value |
|-------|-------|
| **Key** | EVAL-1 |
| **Title** | Evaluate Phase 1 (Foundation) and Phase 2 (Network) Implementation |
| **Priority** | High |
| **Epic** | Epic: DevEx |
| **Phase** | Phase 2: Network |
| **Estimate** | 2 points |
| **Depends On** | 2.2 (Authentication & rate limiting) |

---

## Overview

Comprehensive evaluation of the implemented Phase 1 and Phase 2 features to verify they meet the project requirements and work correctly together. This ticket documents all verification steps and provides a test matrix for sign-off.

---

## Context

The following tickets have been implemented:

**Phase 1: Foundation**
- [1.1] Git repository identity detection
- [1.2] Collection name migration to canonical identity
- [5.1] Snapshot format v3 with repository identity
- [1.3] Repository registry with path-to-identity resolution

**Phase 2: Network Access**
- [2.1] Streamable HTTP transport layer
- [2.2] Authentication & rate limiting for HTTP transport

This evaluation ticket validates all implemented features against their acceptance criteria.

---

## Requirements

- Execute all test cases in the evaluation guide
- Document any deviations from expected behavior
- Verify backward compatibility with existing stdio transport
- Test with real-world repositories
- Validate security of HTTP transport

---

## Key Files

- `docs/evaluation-guide.md` — Detailed step-by-step evaluation instructions
- `packages/core/src/identity/` — Repository identity module
- `packages/core/src/identity/__tests__/` — Identity module tests (79 tests)
- `packages/mcp/src/transports/http-transport.ts` — HTTP transport implementation
- `packages/mcp/src/middleware/` — Auth and rate limiting middleware
- `packages/mcp/src/__tests__/snapshot-v3.test.ts` — Snapshot migration tests

---

## Acceptance Criteria

### Phase 1: Foundation

- [ ] **1.1.1** Two paths pointing to same repo (worktrees) resolve to same canonical ID
- [ ] **1.1.2** SSH and HTTPS URLs for same repo normalize to same value
- [ ] **1.1.3** Non-git directories fall back to path-based identity (no crash)
- [ ] **1.2.1** New collections use 12-character canonical ID hash
- [ ] **1.2.2** Legacy 8-character collections are still queryable
- [ ] **1.3.1** Registry correctly tracks repositories by canonical ID
- [ ] **1.3.2** Registry detects when new path is same repo as existing entry
- [ ] **5.1.1** V1 snapshot migrates to V3 format on load
- [ ] **5.1.2** V2 snapshot migrates to V3 format on load
- [ ] **5.1.3** V3 snapshot loads directly without migration
- [ ] **5.1.4** Worktrees of same repo merge under single canonical ID in snapshot

### Phase 2: Network Access

- [ ] **2.1.1** Server starts with `--transport http` and listens on specified port
- [ ] **2.1.2** Health endpoint `/health` returns JSON status (no auth required)
- [ ] **2.1.3** MCP endpoint `/mcp` accepts Streamable HTTP requests
- [ ] **2.1.4** Dual mode `--transport both` runs stdio and HTTP simultaneously
- [ ] **2.2.1** HTTP server refuses to start without `MCP_AUTH_TOKEN` (exit code 2)
- [ ] **2.2.2** Request without `Authorization` header returns 401
- [ ] **2.2.3** Request with invalid token returns 401
- [ ] **2.2.4** Request with valid token proceeds to MCP handling
- [ ] **2.2.5** Rate limiting returns 429 when exceeded with `Retry-After` header
- [ ] **2.2.6** stdio transport works without any authentication required

### Integration

- [ ] **INT-1** All 79 core package tests pass (`pnpm test` in packages/core)
- [ ] **INT-2** All 11 MCP package tests pass (`pnpm test` in packages/mcp)
- [ ] **INT-3** TypeScript compiles without errors (`pnpm typecheck`)
- [ ] **INT-4** Server runs in each mode without crashing for 60 seconds

---

## How to Verify (Incremental Test Steps)

### Setup

1. Clone the repository and checkout `claude/code-search-mcp-server-y10ns` branch
2. Install dependencies: `pnpm install`
3. Build packages: `pnpm build`
4. Set required environment variables:
   ```bash
   export OPENAI_API_KEY="your-key"
   export MILVUS_ADDRESS="your-milvus-address"
   export MILVUS_TOKEN="your-milvus-token"
   ```

### Unit Tests

5. Run core package tests: `cd packages/core && pnpm test`
   - Expected: 79 tests pass (repo-identity: 37, collection-migrator: 22, repo-registry: 20)

6. Run MCP package tests: `cd packages/mcp && pnpm test`
   - Expected: 11 tests pass (snapshot-v3 migration tests)

7. Run type check: `pnpm typecheck`
   - Expected: No errors

### Git Identity Detection

8. Create test git repo with worktree:
   ```bash
   mkdir -p /tmp/eval-test && cd /tmp/eval-test
   git init main && cd main
   git config user.email "test@test.com" && git config user.name "Test"
   echo "test" > file.txt && git add . && git commit -m "init"
   git remote add origin https://github.com/test/repo.git
   git worktree add ../worktree -b feature
   ```

9. Verify identity resolution:
   ```bash
   cd /home/user/claude-context
   pnpm exec tsx -e "
   import { resolveIdentity } from './packages/core/src/identity/repo-identity.js';
   const m = await resolveIdentity('/tmp/eval-test/main');
   const w = await resolveIdentity('/tmp/eval-test/worktree');
   console.log('Same ID:', m.canonicalId === w.canonicalId);
   "
   ```
   - Expected: `Same ID: true`

### HTTP Transport

10. Test startup without auth token:
    ```bash
    timeout 5 pnpm start --transport http 2>&1 | grep -E "(ERROR|exit)"
    echo "Exit code: $?"
    ```
    - Expected: Error about missing MCP_AUTH_TOKEN, exit code 2

11. Start server with auth:
    ```bash
    MCP_AUTH_TOKEN=test123 pnpm start --transport http --port 3100 &
    SERVER_PID=$!
    sleep 5
    ```

12. Test health endpoint:
    ```bash
    curl -s http://localhost:3100/health
    ```
    - Expected: `{"status":"ok","version":"1.0.0",...}`

13. Test auth rejection:
    ```bash
    curl -s http://localhost:3100/mcp
    ```
    - Expected: `{"error":"Unauthorized",...}`

14. Test auth acceptance:
    ```bash
    curl -s http://localhost:3100/mcp -H "Authorization: Bearer test123"
    ```
    - Expected: Not 401 (may be 400 if no body, that's OK)

15. Cleanup: `kill $SERVER_PID`

### Stdio Transport (Backward Compatibility)

16. Verify stdio works without auth:
    ```bash
    timeout 5 pnpm start --transport stdio 2>&1 | grep -E "started|listening"
    ```
    - Expected: Server starts successfully

---

## Test Matrix

| Test ID | Description | Command/Action | Expected Result | Actual Result | Pass/Fail |
|---------|-------------|----------------|-----------------|---------------|-----------|
| 1.1.1 | Worktree same ID | resolveIdentity on both paths | Same canonicalId | | |
| 1.1.2 | SSH/HTTPS normalize | normalizeGitUrl | Same output | | |
| 1.1.3 | Non-git fallback | resolveIdentity on non-git | identitySource='path-hash' | | |
| 1.2.1 | Canonical hash length | generateCanonicalCollectionName | 12 char hash | | |
| 1.3.1 | Registry register | registry.register() | Entry created | | |
| 1.3.2 | Registry detect same | registry.resolve() on worktree | found=true, isNewPath=true | | |
| 5.1.1 | V1 migration | Load v1 snapshot | Migrates to v3 | | |
| 5.1.2 | V2 migration | Load v2 snapshot | Migrates to v3 | | |
| 2.1.1 | HTTP startup | --transport http | Listens on port | | |
| 2.1.2 | Health check | GET /health | 200 + JSON | | |
| 2.2.1 | No token fails | Start without MCP_AUTH_TOKEN | Exit code 2 | | |
| 2.2.2 | No auth header | Request without Authorization | 401 | | |
| 2.2.3 | Wrong token | Authorization: Bearer wrong | 401 | | |
| 2.2.4 | Correct token | Authorization: Bearer correct | Not 401 | | |
| 2.2.5 | Rate limit | 61+ requests in 1 min | 429 | | |
| 2.2.6 | stdio no auth | --transport stdio (no token) | Starts OK | | |

---

## Notes for LLM Implementation

This is an evaluation ticket, not an implementation ticket. The evaluator should:

1. Follow the evaluation guide at `docs/evaluation-guide.md`
2. Run all test cases methodically
3. Record results in the test matrix
4. Document any unexpected behavior
5. File follow-up issues for any failures

Do not modify code during evaluation unless a test setup requires it. Document observations rather than fixing issues inline.

---

_GitHub: https://github.com/180SC/claude-context_
