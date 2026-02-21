/**
 * Unit tests for snapshot v3 format migration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SnapshotManager } from '../snapshot';
import {
  CodebaseSnapshotV1,
  CodebaseSnapshotV2,
  CodebaseSnapshotV3,
  CodebaseInfoIndexed,
  RepoSnapshot,
} from '../config';

// Helper to create a temporary directory
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Helper to clean up a directory
function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

// Helper to run git commands (disables commit signing for test environments)
function git(cwd: string, ...args: string[]): string {
  const env = {
    ...process.env,
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
  };

  return execSync(`git -c commit.gpgsign=false -c user.name="Test User" -c user.email="test@example.com" ${args.join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  }).trim();
}

describe('SnapshotManager V3 Migration', () => {
  let tempDir: string;
  let snapshotDir: string;
  let snapshotFilePath: string;

  beforeEach(() => {
    tempDir = createTempDir('snapshot-v3-test-');
    snapshotDir = path.join(tempDir, '.context');
    snapshotFilePath = path.join(snapshotDir, 'mcp-codebase-snapshot.json');

    // Create the .context directory
    fs.mkdirSync(snapshotDir, { recursive: true });
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  // Helper to create a SnapshotManager with the test snapshot path
  function createManager(): SnapshotManager {
    return new SnapshotManager(snapshotFilePath);
  }

  describe('V1 to V3 Migration', () => {
    it('migrates v1 snapshot to v3 format', () => {
      // Create a test codebase directory
      const codebasePath = path.join(tempDir, 'test-codebase');
      fs.mkdirSync(codebasePath, { recursive: true });

      // Create a v1 snapshot
      const v1Snapshot: CodebaseSnapshotV1 = {
        indexedCodebases: [codebasePath],
        indexingCodebases: [],
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v1Snapshot, null, 2));

      // Load the snapshot (triggers migration)
      const manager = createManager();
      manager.loadCodebaseSnapshot();

      // Verify the snapshot was saved in v3 format
      const savedSnapshot = JSON.parse(fs.readFileSync(snapshotFilePath, 'utf-8'));
      expect(savedSnapshot.formatVersion).toBe('v3');
      expect(savedSnapshot.repositories).toBeDefined();
    });

    it('preserves indexed paths in v1 to v3 migration', () => {
      const codebasePath = path.join(tempDir, 'test-codebase-2');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v1Snapshot: CodebaseSnapshotV1 = {
        indexedCodebases: [codebasePath],
        indexingCodebases: [],
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v1Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      // Verify the path is preserved via backward-compat getIndexedCodebases()
      const indexedCodebases = manager.getIndexedCodebases();
      expect(indexedCodebases).toContain(codebasePath);
    });
  });

  describe('V2 to V3 Migration', () => {
    it('migrates v2 snapshot to v3 format', () => {
      const codebasePath = path.join(tempDir, 'test-codebase-v2');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v2Snapshot: CodebaseSnapshotV2 = {
        formatVersion: 'v2',
        codebases: {
          [codebasePath]: {
            status: 'indexed',
            indexedFiles: 100,
            totalChunks: 500,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString(),
          } as CodebaseInfoIndexed,
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v2Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      // Verify the snapshot was saved in v3 format
      const savedSnapshot = JSON.parse(fs.readFileSync(snapshotFilePath, 'utf-8'));
      expect(savedSnapshot.formatVersion).toBe('v3');
    });

    it('preserves codebase info in v2 to v3 migration', () => {
      const codebasePath = path.join(tempDir, 'test-codebase-v2-info');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v2Snapshot: CodebaseSnapshotV2 = {
        formatVersion: 'v2',
        codebases: {
          [codebasePath]: {
            status: 'indexed',
            indexedFiles: 150,
            totalChunks: 750,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString(),
          } as CodebaseInfoIndexed,
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v2Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      // Verify the info is preserved
      const info = manager.getCodebaseInfo(codebasePath);
      expect(info).toBeDefined();
      expect(info?.status).toBe('indexed');
      if (info?.status === 'indexed') {
        expect(info.indexedFiles).toBe(150);
        expect(info.totalChunks).toBe(750);
      }
    });
  });

  describe('V3 Direct Loading', () => {
    it('loads v3 snapshot directly', () => {
      const codebasePath = path.join(tempDir, 'test-codebase-v3');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v3Snapshot: CodebaseSnapshotV3 = {
        formatVersion: 'v3',
        repositories: {
          'test-canonical-id': {
            displayName: 'test-codebase',
            identitySource: 'path-hash',
            knownPaths: [codebasePath],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 200,
                totalChunks: 1000,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          } as RepoSnapshot,
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v3Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      // Verify the snapshot remains in v3 format
      const savedSnapshot = JSON.parse(fs.readFileSync(snapshotFilePath, 'utf-8'));
      expect(savedSnapshot.formatVersion).toBe('v3');

      // Verify backward-compat getIndexedCodebases() works
      const indexedCodebases = manager.getIndexedCodebases();
      expect(indexedCodebases).toContain(codebasePath);
    });
  });

  describe('Worktree Merging', () => {
    it('merges worktrees of same repo under one canonical ID', () => {
      // Create main repo
      const mainRepoPath = path.join(tempDir, 'main-repo');
      fs.mkdirSync(mainRepoPath, { recursive: true });
      git(mainRepoPath, 'init');
      fs.writeFileSync(path.join(mainRepoPath, 'file.txt'), 'content');
      git(mainRepoPath, 'add', '.');
      git(mainRepoPath, 'commit', '-m', '"init"');
      git(mainRepoPath, 'remote', 'add', 'origin', 'git@github.com:test/worktree-test.git');

      // Create worktree
      const worktreePath = path.join(tempDir, 'worktree');
      git(mainRepoPath, 'worktree', 'add', worktreePath, '-b', 'feature');

      // Create a v2 snapshot with both paths (as if they were indexed separately)
      const v2Snapshot: CodebaseSnapshotV2 = {
        formatVersion: 'v2',
        codebases: {
          [mainRepoPath]: {
            status: 'indexed',
            indexedFiles: 10,
            totalChunks: 50,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString(),
          } as CodebaseInfoIndexed,
          [worktreePath]: {
            status: 'indexed',
            indexedFiles: 10,
            totalChunks: 50,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString(),
          } as CodebaseInfoIndexed,
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v2Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      // Verify the snapshot was migrated to v3
      const savedSnapshot: CodebaseSnapshotV3 = JSON.parse(fs.readFileSync(snapshotFilePath, 'utf-8'));
      expect(savedSnapshot.formatVersion).toBe('v3');

      // Verify that both paths are merged under one canonical ID
      const repoEntries = Object.values(savedSnapshot.repositories);
      expect(repoEntries.length).toBe(1); // Should be merged into one repo

      const repo = repoEntries[0];
      expect(repo.knownPaths).toContain(mainRepoPath);
      expect(repo.knownPaths).toContain(worktreePath);
      expect(repo.remoteUrl).toBe('github.com/test/worktree-test');

      // Cleanup worktree
      try {
        git(mainRepoPath, 'worktree', 'remove', worktreePath, '--force');
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe('Backward Compatibility', () => {
    it('getIndexedCodebases() returns all paths from v3 format', () => {
      const path1 = path.join(tempDir, 'codebase-1');
      const path2 = path.join(tempDir, 'codebase-2');
      fs.mkdirSync(path1, { recursive: true });
      fs.mkdirSync(path2, { recursive: true });

      const v3Snapshot: CodebaseSnapshotV3 = {
        formatVersion: 'v3',
        repositories: {
          'repo-1': {
            displayName: 'codebase-1',
            identitySource: 'path-hash',
            knownPaths: [path1],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 100,
                totalChunks: 500,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          },
          'repo-2': {
            displayName: 'codebase-2',
            identitySource: 'path-hash',
            knownPaths: [path2],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 200,
                totalChunks: 1000,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v3Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      const indexedCodebases = manager.getIndexedCodebases();
      expect(indexedCodebases).toContain(path1);
      expect(indexedCodebases).toContain(path2);
      expect(indexedCodebases.length).toBe(2);
    });

    it('getCodebaseInfo() works with v3 format', () => {
      const codebasePath = path.join(tempDir, 'info-test');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v3Snapshot: CodebaseSnapshotV3 = {
        formatVersion: 'v3',
        repositories: {
          'test-repo': {
            displayName: 'info-test',
            identitySource: 'path-hash',
            knownPaths: [codebasePath],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 300,
                totalChunks: 1500,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v3Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      const info = manager.getCodebaseInfo(codebasePath);
      expect(info).toBeDefined();
      expect(info?.status).toBe('indexed');
      if (info?.status === 'indexed') {
        expect(info.indexedFiles).toBe(300);
        expect(info.totalChunks).toBe(1500);
      }
    });
  });

  describe('V3 API Methods', () => {
    it('getRepository() returns repo by canonical ID', () => {
      const codebasePath = path.join(tempDir, 'api-test');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v3Snapshot: CodebaseSnapshotV3 = {
        formatVersion: 'v3',
        repositories: {
          'my-canonical-id': {
            displayName: 'api-test',
            identitySource: 'path-hash',
            knownPaths: [codebasePath],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 100,
                totalChunks: 500,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v3Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      const repo = manager.getRepository('my-canonical-id');
      expect(repo).toBeDefined();
      expect(repo?.displayName).toBe('api-test');
    });

    it('getRepositoryByPath() returns repo for a path', () => {
      const codebasePath = path.join(tempDir, 'path-api-test');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v3Snapshot: CodebaseSnapshotV3 = {
        formatVersion: 'v3',
        repositories: {
          'path-canonical-id': {
            displayName: 'path-api-test',
            identitySource: 'path-hash',
            knownPaths: [codebasePath],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 100,
                totalChunks: 500,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v3Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      const repo = manager.getRepositoryByPath(codebasePath);
      expect(repo).toBeDefined();
      expect(repo?.displayName).toBe('path-api-test');
    });

    it('getCanonicalIdForPath() returns canonical ID for a path', () => {
      const codebasePath = path.join(tempDir, 'id-test');
      fs.mkdirSync(codebasePath, { recursive: true });

      const v3Snapshot: CodebaseSnapshotV3 = {
        formatVersion: 'v3',
        repositories: {
          'test-canonical-id-123': {
            displayName: 'id-test',
            identitySource: 'path-hash',
            knownPaths: [codebasePath],
            worktrees: [],
            branches: {
              default: {
                status: 'indexed',
                indexedFiles: 100,
                totalChunks: 500,
                lastIndexed: new Date().toISOString(),
              },
            },
            defaultBranch: 'default',
            lastIndexed: new Date().toISOString(),
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(snapshotFilePath, JSON.stringify(v3Snapshot, null, 2));

      const manager = createManager();
      manager.loadCodebaseSnapshot();

      const canonicalId = manager.getCanonicalIdForPath(codebasePath);
      expect(canonicalId).toBe('test-canonical-id-123');
    });
  });
});
