/**
 * Integration test: Reproduce git worktree path validation bug (180-118).
 *
 * Spins up the MCP server over HTTP, connects 3 simulated Claude Code clients,
 * and verifies that index_codebase / get_indexing_status / search_code / search_all
 * work for both normal git repos and git worktrees.
 *
 * Requirements:
 *   - MILVUS_TOKEN set (Zilliz Cloud)
 *   - OPENAI_API_KEY set (or other embedding provider env vars)
 *   - git installed
 */

import { ChildProcess, spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TEST_PORT = 14500 + Math.floor(Math.random() * 1000);
const AUTH_TOKEN = 'test-token-worktree-integration';
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const INDEXING_TIMEOUT_MS = 120_000;
const INDEXING_POLL_INTERVAL_MS = 3_000;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Parse a .env file into a key-value record (skips comments and blanks). */
function parseEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command in the given directory. */
function git(cwd: string, ...args: string[]): string {
  const env = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
  };
  return execSync(
    `git -c commit.gpgsign=false -c user.name="Test User" -c user.email="test@example.com" ${args.join(' ')}`,
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env },
  ).trim();
}

/** Wait until the health endpoint responds 200. */
async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

/** Create an MCP client connected to the server. */
async function createMcpClient(port: number, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      },
    },
  );
  await client.connect(transport);
  return client;
}

/** Call a tool on the MCP client and return the result. */
async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const result = await client.callTool({ name: toolName, arguments: args });
  return result as any;
}

/** Poll get_indexing_status until indexed or timeout. */
async function waitForIndexing(
  client: Client,
  codebasePath: string,
  timeoutMs: number = INDEXING_TIMEOUT_MS,
): Promise<{ indexed: boolean; lastStatus: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const result = await callTool(client, 'get_indexing_status', { path: codebasePath });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError) {
      return { indexed: false, lastStatus: `error: ${text}` };
    }
    if (text.toLowerCase().includes('"indexed"') || text.toLowerCase().includes('status: indexed')) {
      return { indexed: true, lastStatus: text };
    }
    lastStatus = text;
    await new Promise((r) => setTimeout(r, INDEXING_POLL_INTERVAL_MS));
  }
  return { indexed: false, lastStatus: `timeout after ${timeoutMs}ms — last: ${lastStatus}` };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('180-118: Git worktree path validation', () => {
  let tempDir: string;
  let repoAPath: string;
  let repoBMainPath: string;
  let repoBFeaturePath: string;
  let serverProcess: ChildProcess;
  let clients: Client[] = [];

  // ---------- setup ----------

  beforeAll(async () => {
    // 1. Create temp directory structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-worktree-test-'));

    // Repo A: normal git repo (baseline)
    repoAPath = path.join(tempDir, 'repo-a');
    fs.mkdirSync(path.join(repoAPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoAPath, 'src', 'example.ts'),
      `export function greetUser(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    );
    git(repoAPath, 'init');
    git(repoAPath, 'add', '.');
    git(repoAPath, 'commit', '-m', '"initial commit"');

    // Repo B: main worktree + linked worktree
    repoBMainPath = path.join(tempDir, 'repo-b', 'main');
    fs.mkdirSync(path.join(repoBMainPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoBMainPath, 'src', 'example.ts'),
      `export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    git(repoBMainPath, 'init');
    git(repoBMainPath, 'add', '.');
    git(repoBMainPath, 'commit', '-m', '"initial commit"');

    // Create linked worktree
    repoBFeaturePath = path.join(tempDir, 'repo-b', 'feature');
    git(repoBMainPath, 'worktree', 'add', repoBFeaturePath, '-b', 'feature');

    // Verify the worktree .git file exists (not directory)
    const worktreeGitPath = path.join(repoBFeaturePath, '.git');
    const stat = fs.statSync(worktreeGitPath);
    expect(stat.isFile()).toBe(true); // worktree uses .git FILE, not directory

    console.log('[TEST] Temp repos created:');
    console.log(`  repo-a (normal):          ${repoAPath}`);
    console.log(`  repo-b/main (worktree):   ${repoBMainPath}`);
    console.log(`  repo-b/feature (worktree): ${repoBFeaturePath}`);

    // 2. Spawn MCP server with isolated HOME
    const snapshotHome = path.join(tempDir, 'home');
    const contextDir = path.join(snapshotHome, '.context');
    fs.mkdirSync(contextDir, { recursive: true });

    // Load credentials from project root .env and/or ~/.context/.env
    const projectEnvVars = parseEnvFile(path.join(PROJECT_ROOT, '.env'));
    const homeEnvVars = parseEnvFile(path.join(os.homedir(), '.context', '.env'));

    // Also write .env into isolated HOME so envManager can find it
    const mergedEnvContent = Object.entries({ ...homeEnvVars, ...projectEnvVars })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(path.join(contextDir, '.env'), mergedEnvContent);

    console.log('[TEST] Env vars loaded from .env files:',
      Object.keys({ ...homeEnvVars, ...projectEnvVars }).join(', '));

    const serverEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...homeEnvVars,
      ...projectEnvVars,
      HOME: snapshotHome,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
    };

    // Find the tsx binary or use npx
    const tsxPath = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
    const serverScript = path.resolve(__dirname, '..', 'index.ts');

    console.log(`[TEST] Starting server on port ${TEST_PORT}...`);
    serverProcess = spawn(
      fs.existsSync(tsxPath) ? tsxPath : 'npx',
      fs.existsSync(tsxPath)
        ? [serverScript, '--transport', 'http', '--port', String(TEST_PORT)]
        : ['tsx', serverScript, '--transport', 'http', '--port', String(TEST_PORT)],
      {
        env: serverEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      },
    );

    // Pipe server stderr for debugging
    serverProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[SERVER] ${line}`);
    });
    serverProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[SERVER:stdout] ${line}`);
    });

    serverProcess.on('exit', (code) => {
      console.log(`[SERVER] Process exited with code ${code}`);
    });

    // Wait for server to be ready
    await waitForServer(TEST_PORT, SERVER_STARTUP_TIMEOUT_MS);
    console.log('[TEST] Server is ready');
  }, SERVER_STARTUP_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    // Close clients
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }

    // Kill server
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      // Wait a moment for graceful shutdown
      await new Promise((r) => setTimeout(r, 2000));
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }

    // Clean up worktree before removing temp dir
    try {
      git(repoBMainPath, 'worktree', 'remove', repoBFeaturePath, '--force');
    } catch {
      // ignore
    }

    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 15_000);

  // ---------- tests ----------

  it('connects 3 MCP clients', async () => {
    const clientA = await createMcpClient(TEST_PORT, 'client-a-normal-repo');
    const clientB = await createMcpClient(TEST_PORT, 'client-b-linked-worktree');
    const clientC = await createMcpClient(TEST_PORT, 'client-c-main-worktree');
    clients = [clientA, clientB, clientC];

    // Verify all clients can list tools
    for (const client of clients) {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain('index_codebase');
      expect(toolNames).toContain('search_code');
      expect(toolNames).toContain('search_all');
      expect(toolNames).toContain('get_indexing_status');
    }
  }, 30_000);

  describe('index_codebase', () => {
    it('Client A: indexes a normal git repo (baseline)', async () => {
      const result = await callTool(clients[0], 'index_codebase', { path: repoAPath });
      console.log('[TEST] Client A index_codebase result:', JSON.stringify(result, null, 2));
      expect(result.isError).toBeFalsy();
    }, 30_000);

    it('Client B: indexes a linked git worktree', async () => {
      const result = await callTool(clients[1], 'index_codebase', { path: repoBFeaturePath });
      console.log('[TEST] Client B index_codebase result:', JSON.stringify(result, null, 2));

      // THIS IS THE BUG: we expect this to fail with "Path does not exist"
      // When the bug is fixed, change this to expect(result.isError).toBeFalsy()
      if (result.isError) {
        console.log('[TEST] *** BUG REPRODUCED: Client B (linked worktree) got error ***');
        console.log(`[TEST] Error: ${result.content?.[0]?.text}`);
      } else {
        console.log('[TEST] Client B succeeded (bug may be fixed)');
      }
      // Record the actual behavior — don't assert pass/fail so we see the full picture
    }, 30_000);

    it('Client C: indexes a main worktree', async () => {
      const result = await callTool(clients[2], 'index_codebase', { path: repoBMainPath });
      console.log('[TEST] Client C index_codebase result:', JSON.stringify(result, null, 2));

      if (result.isError) {
        console.log('[TEST] *** BUG REPRODUCED: Client C (main worktree) got error ***');
        console.log(`[TEST] Error: ${result.content?.[0]?.text}`);
      } else {
        console.log('[TEST] Client C succeeded (bug may be fixed)');
      }
    }, 30_000);
  });

  describe('get_indexing_status', () => {
    it('Client A: status for normal repo', async () => {
      const result = await callTool(clients[0], 'get_indexing_status', { path: repoAPath });
      console.log('[TEST] Client A get_indexing_status:', JSON.stringify(result, null, 2));
      expect(result.isError).toBeFalsy();
    }, 15_000);

    it('Client B: status for linked worktree', async () => {
      const result = await callTool(clients[1], 'get_indexing_status', { path: repoBFeaturePath });
      console.log('[TEST] Client B get_indexing_status:', JSON.stringify(result, null, 2));

      if (result.isError) {
        console.log('[TEST] *** BUG REPRODUCED: Client B get_indexing_status error ***');
      }
    }, 15_000);

    it('Client C: status for main worktree', async () => {
      const result = await callTool(clients[2], 'get_indexing_status', { path: repoBMainPath });
      console.log('[TEST] Client C get_indexing_status:', JSON.stringify(result, null, 2));

      if (result.isError) {
        console.log('[TEST] *** BUG REPRODUCED: Client C get_indexing_status error ***');
      }
    }, 15_000);
  });

  describe('wait for indexing to complete', () => {
    it('Client A: waits for normal repo indexing', async () => {
      const { indexed, lastStatus } = await waitForIndexing(clients[0], repoAPath);
      console.log(`[TEST] Client A indexing complete: ${indexed}, status: ${lastStatus}`);
      expect(indexed).toBe(true);
    }, INDEXING_TIMEOUT_MS + 5_000);

    it('Client B: waits for linked worktree indexing', async () => {
      const { indexed, lastStatus } = await waitForIndexing(clients[1], repoBFeaturePath);
      console.log(`[TEST] Client B indexing complete: ${indexed}, status: ${lastStatus}`);
      // Don't assert — just observe behavior for bug reproduction
    }, INDEXING_TIMEOUT_MS + 5_000);

    it('Client C: waits for main worktree indexing', async () => {
      const { indexed, lastStatus } = await waitForIndexing(clients[2], repoBMainPath);
      console.log(`[TEST] Client C indexing complete: ${indexed}, status: ${lastStatus}`);
    }, INDEXING_TIMEOUT_MS + 5_000);
  });

  describe('search_code', () => {
    it('Client A: searches normal repo', async () => {
      const result = await callTool(clients[0], 'search_code', {
        path: repoAPath,
        query: 'function',
        limit: 5,
      });
      console.log('[TEST] Client A search_code result:', JSON.stringify(result, null, 2));
      expect(result.isError).toBeFalsy();
    }, 30_000);

    it('Client B: searches linked worktree', async () => {
      const result = await callTool(clients[1], 'search_code', {
        path: repoBFeaturePath,
        query: 'function',
        limit: 5,
      });
      console.log('[TEST] Client B search_code result:', JSON.stringify(result, null, 2));

      if (result.isError) {
        console.log('[TEST] *** BUG REPRODUCED: Client B search_code error ***');
      }
    }, 30_000);

    it('Client C: searches main worktree', async () => {
      const result = await callTool(clients[2], 'search_code', {
        path: repoBMainPath,
        query: 'function',
        limit: 5,
      });
      console.log('[TEST] Client C search_code result:', JSON.stringify(result, null, 2));

      if (result.isError) {
        console.log('[TEST] *** BUG REPRODUCED: Client C search_code error ***');
      }
    }, 30_000);
  });

  describe('search_all', () => {
    it('Client A: search_all returns results', async () => {
      const result = await callTool(clients[0], 'search_all', {
        query: 'function',
        limit: 10,
      });
      console.log('[TEST] Client A search_all result:', JSON.stringify(result, null, 2));
      expect(result.isError).toBeFalsy();
    }, 30_000);

    it('Client B: search_all returns results', async () => {
      const result = await callTool(clients[1], 'search_all', {
        query: 'function',
        limit: 10,
      });
      console.log('[TEST] Client B search_all result:', JSON.stringify(result, null, 2));
      expect(result.isError).toBeFalsy();
    }, 30_000);

    it('Client C: search_all returns results', async () => {
      const result = await callTool(clients[2], 'search_all', {
        query: 'function',
        limit: 10,
      });
      console.log('[TEST] Client C search_all result:', JSON.stringify(result, null, 2));
      expect(result.isError).toBeFalsy();
    }, 30_000);
  });

  describe('cleanup: clear_index', () => {
    it('clears indexed repos', async () => {
      // Only clear repos that were successfully indexed
      for (const [i, repoPath] of [repoAPath, repoBFeaturePath, repoBMainPath].entries()) {
        try {
          const result = await callTool(clients[i], 'clear_index', { path: repoPath });
          console.log(`[TEST] clear_index ${repoPath}: ${JSON.stringify(result)}`);
        } catch (err) {
          console.log(`[TEST] clear_index ${repoPath} failed (may not have been indexed): ${err}`);
        }
      }
    }, 30_000);
  });
});
