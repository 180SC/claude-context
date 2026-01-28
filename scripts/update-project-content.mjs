#!/usr/bin/env node
import { execSync } from "node:child_process";

const API_KEY = process.env.LINEAR_API_KEY;
const API_URL = "https://api.linear.app/graphql";
const PROJECT_ID = "0e0eb8be-ab87-4472-841b-6f57c8b324e2";

const content = `# Claude Implementation Guide

## Overview
Transform claude-context from a local MCP server into a network-accessible, multi-repo code search and intelligence platform.

**Repository:** https://github.com/180SC/claude-context
**Spec:** docs/project-plan-general-purpose-code-search-mcp.md

---

## Instructions for Claude

When working on this project, follow these guidelines:

### Before Starting Any Ticket
1. Read the full ticket description and acceptance criteria
2. Check the \`dependsOn\` links - complete dependencies first
3. Review the relevant sections in \`docs/project-plan-general-purpose-code-search-mcp.md\`
4. Understand existing code by searching the codebase before making changes

### Development Workflow
1. Create a feature branch: \`git checkout -b feat/<ticket-key>-<short-description>\`
2. Write tests FIRST (TDD) - use Jest, already a dev dependency
3. Implement the minimum code to pass tests
4. Run the full test suite: \`npm test\`
5. Run the build: \`npm run build\`
6. Commit with conventional commits: \`feat(scope): description\`
7. Push and create PR referencing the ticket

### Testing Requirements
- **Unit tests:** Required for all new functions/classes
- **Integration tests:** Required for API endpoints and tool handlers
- **Git fixtures:** Use \`fs.mkdtemp\` + \`child_process.execSync\` for temp repos
- **Vector DB:** Use Milvus Lite (embedded) or mock the interface
- **HTTP tests:** Start server in-process, use \`fetch()\`

### Phase Execution Order

**Phase 1: Foundation** (do first, in dependency order)
- TRA-60: Git repository identity detection
- TRA-61: Collection name migration
- TRA-62: Snapshot format v3
- TRA-63: Repository registry

**Phase 2: Network** (after Phase 1)
- TRA-64: HTTP transport layer
- TRA-65: Auth & rate limiting
- TRA-66: CLI flags

**Phase 3: Intelligence** (after Phase 2)
- TRA-67: Cross-repo search (search_all)
- TRA-68: List repositories tool
- TRA-69: Vector schema enhancement
- TRA-70: Pattern detection

**Phase 4: Advanced** (after Phase 3)
- TRA-71: Best practices audit
- TRA-72: Dependency mapping
- TRA-73: Branch-aware indexing
- TRA-74: Remote repo support
- TRA-75: Auto-discovery

**Phase 5: Polish** (final)
- TRA-76: Client config & Docker
- TRA-77: Integration test suite

### Code Quality Standards
- TypeScript strict mode
- No \`any\` types without justification
- Handle errors explicitly, no silent failures
- Keep functions small and focused
- Use existing patterns in the codebase

### When Complete
1. Mark ticket as "Done" in Linear
2. Update any documentation affected
3. Note any follow-up work needed in ticket comments
`;

const payload = JSON.stringify({
  query: `mutation($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project { id name }
    }
  }`,
  variables: {
    id: PROJECT_ID,
    input: { content }
  }
});

const result = execSync(
  `curl -sS -X POST "${API_URL}" -H "Content-Type: application/json" -H "Authorization: ${API_KEY}" -d @-`,
  { input: payload, encoding: "utf-8", timeout: 30000 }
);

const json = JSON.parse(result);
if (json.errors) {
  console.error("Error:", JSON.stringify(json.errors, null, 2));
  process.exit(1);
}

console.log("✓ Project content updated successfully");
console.log("  View at: https://linear.app/180sc/project/general-purpose-code-search-mcp-server-be4c398079ea");
